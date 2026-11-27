import { registerExecutionRoutes } from './execution-routes.js';
import { serveUiAsset } from '../../shared/ui-assets.js';
import { portfolioIdentityMiddleware, currentPortfolioUserId } from '../../shared/portfolio-user.js';
import { getDatabase } from '../../shared/db/index.js';
import { createPostgresPool } from '../../shared/db/postgres/pool.js';
import { verifyConfiguredPostgres } from '../../shared/db/postgres/readiness.js';
import { postgresUrlFor } from '../../shared/db/postgres/config.js';
import { createPortfolioBackend } from '../../shared/db/portfolio-runtime.js';
import { configurePortfolioBackend } from '../../shared/db/portfolio-bridge.js';
import { configureQuoteNetwork } from '../../shared/quote-network.js';
import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openStore } from './store-runtime.js';
import { createQuoteService } from './quotes.js';
import { createMonitor } from './monitor.js';
import { maskNotifyForClient } from './notify.js';
import { createInternalNotificationSettingsHandler } from './notification-settings.js';
import { marketStatus, latestCompletedSession } from './market-hours.js';
import { evaluate } from './playbook.js';
import { createDocService } from './docs.js';
import { watchCash } from './cash-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
console.info('行情网络策略:', JSON.stringify(configureQuoteNetwork()));

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const portfolioUrl = postgresUrlFor('portfolio');
const portfolioDatabase = portfolioUrl && createPostgresPool(pg.Pool, portfolioUrl, 'navigation-qqq-dip');
if (portfolioDatabase) await verifyConfiguredPostgres(portfolioDatabase);
const bookkeepingUrl = postgresUrlFor('bookkeeping');
const bookkeepingDatabase = bookkeepingUrl && createPostgresPool(pg.Pool, bookkeepingUrl, 'navigation-qqq-dip');
if (bookkeepingDatabase) await verifyConfiguredPostgres(bookkeepingDatabase);
const portfolioDb = portfolioDatabase && bookkeepingDatabase ? null : getDatabase({});
const portfolioBackend = await createPortfolioBackend({
  database: portfolioDatabase, sqlite: portfolioDb, bookkeepingDatabase
});
configurePortfolioBackend(portfolioBackend);

const store = await openStore(config);
// Repair the legacy use of a strategy instruction as the security name. Only
// metadata changes; preserve IDs, fills, cash and all user-authored trade names.
{
  const portfolio = await portfolioBackend.storeFor(await portfolioBackend.defaultUserId());
  const data = await portfolio.read();
  let changed = false;
  for (const trade of data.trades || []) {
    if (trade.source === 'qqq-dip' && trade.symbol === '159509'
      && /^(T[1-7]|R[12])\b/.test(trade.name || '')) {
      trade.note = [trade.note, trade.name].filter(Boolean).join('；');
      trade.name = '纳指科技ETF景顺';
      changed = true;
    }
  }
  if (changed) await portfolio.write(data);
}
const quotes = createQuoteService(config);
const docs = createDocService(PUBLIC);
const sseClients = new Map();

function hasDipPermission(req, feature, action = 'view') {
  let permissions;
  try { permissions = JSON.parse(Buffer.from(req.headers['x-portal-permissions'] || '', 'base64url').toString()); }
  catch { return false; }
  return Array.isArray(permissions) && (
    permissions.includes('*') || permissions.includes('service:qqq-dip:edit')
    || permissions.includes(`service:qqq-dip:${feature}:${action}`)
    || (action === 'view' && permissions.includes(`service:qqq-dip:${feature}:edit`))
  );
}

function requireDip(feature, action = 'view') {
  return (req, res, next) => hasDipPermission(req, feature, action)
    ? next() : res.status(403).json({ error: '无权使用该抄底监控功能' });
}

const canViewLots = req => hasDipPermission(req, 'lots') || hasDipPermission(req, 'lots-edit', 'edit');
const canViewActions = req => hasDipPermission(req, 'actions') || hasDipPermission(req, 'actions-note', 'edit');
const canViewFunds = req => hasDipPermission(req, 'cash');

function visibleActions(req, page) {
  if (!page?.items || hasDipPermission(req, 'qq-config')) return page;
  return {
    ...page,
    items: page.items.map(action => {
      if (action.type !== 'notify') return action;
      return { id: action.id, ts: action.ts, type: action.type, source: action.source, tier: action.tier, message: '通知事件' };
    })
  };
}

function visibleState(req, data) {
  const result = { ...data };
  if (!canViewFunds(req)) delete result.cash;
  if (!canViewLots(req)) delete result.lots;
  if (!canViewFunds(req) || !canViewLots(req)) {
    delete result.evaluation;
    delete result.round;
  }
  if (!canViewActions(req)) delete result.actions;
  else if (result.actions) result.actions = visibleActions(req, result.actions);
  if (!hasDipPermission(req, 'qq-config')) {
    delete result.notify;
    if (result.monitor) {
      result.monitor = { ...result.monitor };
      delete result.monitor.lastPush;
    }
  }
  return result;
}

function broadcast(event, data) {
  sseClients.forEach((req, client) => {
    client.write(`event: ${event}\ndata: ${JSON.stringify(visibleState(req, data))}\n\n`);
  });
}

const FX_STALE_MS = 6 * 60 * 60 * 1000;

async function maybeRefreshFx() {
  const cash = await store.getCash();
  const updatedAt = cash.fxUpdatedAt ? Date.parse(cash.fxUpdatedAt) : 0;
  if (updatedAt && Date.now() - updatedAt < FX_STALE_MS) return;
  try {
    const fx = await quotes.getUsdCny();
    if (!fx?.rate || fx.rate <= 0) return;
    await store.setCash({
      ...cash,
      usdCnyRate: fx.rate,
      fxSource: fx.source,
      fxUpdatedAt: new Date().toISOString()
    });
  } catch {
    /* keep previous rate */
  }
}

const monitor = createMonitor({
  store,
  quotes,
  refreshFx: maybeRefreshFx,
  onSnapshot(snap) {
    broadcast('state', snap);
  }
});

const app = express();
app.use((req, res, next) => { if (!serveUiAsset(req, res)) next(); });
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.get('/api/internal/notification-settings', createInternalNotificationSettingsHandler({
  getToken: () => config.notify.qq.token,
  getNotify: () => store.getNotify(),
  getStatus: () => monitor.status()
}));
app.use(portfolioIdentityMiddleware);
app.use(async (req, res, next) => {
  // The existing monitoring round/lots/notifications are a single-owner service.
  // Until those are multi-user too, never expose them or their cash bridge to others.
  if (req.path.startsWith('/api/') && req.path !== '/api/health'
      && currentPortfolioUserId() !== await portfolioBackend.defaultUserId()) {
    return res.status(403).json({ error: '该抄底监控属于原账户，暂不支持其他用户访问' });
  }
  next();
});
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
  if (!hasDipPermission(req, 'tab-monitor') && !hasDipPermission(req, 'tab-qq')) {
    return res.status(403).json({ error: '无权进入抄底监控' });
  }
  const send = res.json.bind(res);
  res.json = data => send(data && typeof data === 'object' && !Array.isArray(data) ? visibleState(req, data) : data);
  return next();
});
app.use(express.static(PUBLIC));

async function liveEval() {
  const now = new Date();
  const market = marketStatus(now);
  const cash = await store.getCash();
  const settings = await store.getSettings();
  const markets = await store.getQuotes();
  const prev = monitor.getEvaluation() || {};
  return evaluate({
    cashUsd: cash.strategyCashUsd ?? cash.cashUsd,
    cashCny: cash.strategyCashCny ?? cash.cashCny,
    usdCnyRate: cash.usdCnyRate,
    variant: settings.variant,
    soxlEnabled: settings.soxlEnabled,
    round: await store.getRound(),
    now,
    rth: market.rth,
    sessionDate: market.ymd,
    expectedCloseDate: latestCompletedSession(now),
    qqq: markets.QQQ,
    tqqq: markets.TQQQ,
    soxl: markets.SOXL,
    spy: markets.SPY,
    vxn: markets.VXN,
    sentiment: markets.sentiment,
    cnyProxy: markets['159509'],
    qqqOvernight: markets.qqqOvernight || null,
    cnyFunds: Object.fromEntries(['159509', '513850', '161128'].map((s) => [s, markets[s]])),
    lots: await store.getLots(),
    suggestedContracts: prev.suggestedContracts || []
  });
}

async function refreshEvaluation() {
  const evaluation = await liveEval();
  await monitor.setEvaluation(evaluation);
  return evaluation;
}

async function snapshot() {
  const snap = await monitor.buildSnapshot();
  snap.evaluation = await liveEval();
  snap.evaluation.quoteErrors = monitor.getEvaluation()?.quoteErrors || {};
  snap.market = marketStatus();
  snap.notify = maskNotifyForClient(store.getNotify());
  snap.actions = await store.listActionRows({ limit: 20 });
  return snap;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'qqq-dip' }));

app.get('/api/notification-settings', requireDip('qq-config'), async (_req, res) => {
  res.json({ ok: true, notify: maskNotifyForClient(store.getNotify()), monitor: await monitor.status() });
});

app.get('/api/state', async (_req, res) => {
  void maybeRefreshFx();
  res.json(await snapshot());
});

app.get('/api/events', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  void maybeRefreshFx();
  const initial = await snapshot();
  res.write(`event: state\ndata: ${JSON.stringify(visibleState(req, initial))}\n\n`);
  sseClients.set(res, req);
  const stopCash = canViewFunds(req) ? watchCash({ initialCash: initial.cash, read: () => store.getCash(), send: async (cash) => {
    res.write(`event: cash\ndata: ${JSON.stringify(visibleState(req, { cash, evaluation: await liveEval() }))}\n\n`);
  } }) : () => {};
  // Reconnect through Portal so an open stream cannot keep revoked permissions indefinitely.
  const recheck = setTimeout(() => res.end(), 30000);
  res.on('close', () => { clearTimeout(recheck); stopCash(); sseClients.delete(res); });
});

app.put('/api/cash', requireDip('cash', 'edit'), async (req, res) => {
  const prev = await store.getCash();
  const body = req.body || {};
  if ('cashUsd' in body || 'cashCny' in body) return res.status(400).json({ error: '抄底现金来自专用预留，请在账户管理中划拨或释放，不能在此改写账户现金' });
  const next = {
    cashUsd: body.cashUsd != null ? Number(body.cashUsd) || 0 : prev.cashUsd,
    cashCny: body.cashCny != null ? Number(body.cashCny) || 0 : prev.cashCny,
    usdCnyRate: body.usdCnyRate != null ? Number(body.usdCnyRate) : prev.usdCnyRate,
    fxSource: prev.fxSource,
    fxUpdatedAt: prev.fxUpdatedAt
  };
  if (Number(next.usdCnyRate) <= 0) next.usdCnyRate = prev.usdCnyRate;
  const rateChanged = body.usdCnyRate != null && Number(body.usdCnyRate) !== Number(prev.usdCnyRate);
  if (rateChanged) {
    next.fxSource = body.fxSource || 'manual';
    next.fxUpdatedAt = body.fxUpdatedAt || new Date().toISOString();
  }
  const cash = await store.setCash(next);
  await store.addAction({
    type: 'cash',
    source: 'user',
    message: `现金更新：USD ${cash.cashUsd} / CNY ${cash.cashCny} / 汇率 ${cash.usdCnyRate}`
  });
  res.json({
    ok: true,
    cash,
    evaluation: await refreshEvaluation(),
    actions: await store.listActionRows({ limit: 20 }),
    monitor: await monitor.status()
  });
});

app.put('/api/settings', requireDip('settings', 'edit'), async (req, res) => {
  const settings = await store.setSettings(req.body || {});
  res.json({
    ok: true,
    settings,
    evaluation: await refreshEvaluation(),
    monitor: await monitor.status()
  });
});

app.put('/api/notify', (req, res) => {
  res.status(410).json({ ok: false, error: '提醒配置已迁移至通知管理页面' });
});

app.post('/api/notify/test', async (_req, res) => {
  res.status(410).json({ ok: false, error: '请在通知管理页面测试提醒' });
});

function requireMonitorControl(req, res, next) {
  if (hasDipPermission(req, 'monitor-control', 'edit') || hasDipPermission(req, 'qq-monitor', 'edit')) return next();
  return res.status(403).json({ error: '无权控制抄底监听' });
}

app.post('/api/monitor/start', requireMonitorControl, async (_req, res) => {
  res.json({ ok: true, monitor: await monitor.start() });
});

app.post('/api/monitor/stop', requireMonitorControl, async (_req, res) => {
  res.json({ ok: true, monitor: await monitor.stop() });
});

app.post('/api/quotes/refresh', requireDip('refresh', 'edit'), async (_req, res) => {
  try {
    const ev = await monitor.tick({ silent: false });
    res.json({ ok: true, evaluation: ev, monitor: await monitor.status() });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, monitor: await monitor.status() });
  }
});

app.get('/api/fx', async (_req, res) => {
  try {
    const fx = await quotes.getUsdCny();
    res.json({ ok: true, ...fx });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/docs', requireDip('docs'), (_req, res) => {
  res.json({ ok: true, docs: docs.listDocs() });
});

app.get('/api/docs/:id', requireDip('docs'), (req, res) => {
  const doc = docs.getDoc(req.params.id);
  if (!doc) return res.status(404).json({ ok: false, error: '文档不存在' });
  res.json({ ok: true, doc });
});

registerExecutionRoutes(app, {
  store, quotes, liveEval, refreshEvaluation, hasDipPermission, requireDip,
  canViewActions, visibleActions, canViewFunds, canViewLots
});

const { host, port } = config.server;
app.listen(port, host, () => {
  console.log(`qqq-dip http://${host}:${port}`);
  if (store.getSettings().autoStart) {
    void monitor.start().then(() => console.log('qqq-dip autoStart: 监听已启动'));
  }
});
