import { serveUiAsset } from '../../shared/ui-assets.js';
import { portfolioIdentityMiddleware, currentPortfolioUserId } from '../../shared/portfolio-user.js';
import { legacyPortfolioOwner } from '../../shared/db/portfolio-store.js';
import { getDatabase } from '../../shared/db/index.js';
import { configureQuoteNetwork } from '../../shared/quote-network.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createQuoteService } from './quotes.js';
import { createMonitor } from './monitor.js';
import { maskNotifyForClient } from './notify.js';
import { createInternalNotificationSettingsHandler } from './notification-settings.js';
import { marketStatus } from './market-hours.js';
import { evaluate, resetRound } from './playbook.js';
import { createDocService } from './docs.js';
import { watchCash } from './cash-sync.js';
import { prepareExecution, canExecutePlan, canSpendDipFunds, commitExecution } from './execution-plan.js';
import {
  legsToTradeInputs,
  getPortfolioStore,
  appendTradesDeductFormCash,
  appendTradesApplyCash
} from '../../shared/db/portfolio-bridge.js';

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

const store = createStore(config);
const quotes = createQuoteService(config);
const docs = createDocService(PUBLIC);
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => client.write(payload));
}

const FX_STALE_MS = 6 * 60 * 60 * 1000;

async function maybeRefreshFx() {
  const cash = store.getCash();
  const updatedAt = cash.fxUpdatedAt ? Date.parse(cash.fxUpdatedAt) : 0;
  if (updatedAt && Date.now() - updatedAt < FX_STALE_MS) return;
  try {
    const fx = await quotes.getUsdCny();
    if (!fx?.rate || fx.rate <= 0) return;
    store.setCash({
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
app.use((req, res, next) => {
  // The existing monitoring round/lots/notifications are a single-owner service.
  // Until those are multi-user too, never expose them or their cash bridge to others.
  if (req.path.startsWith('/api/') && req.path !== '/api/health'
      && currentPortfolioUserId() !== legacyPortfolioOwner(getDatabase())) {
    return res.status(403).json({ error: '该抄底监控属于原账户，暂不支持其他用户访问' });
  }
  next();
});
app.use(express.static(PUBLIC));

function liveEval() {
  const cash = store.getCash();
  const settings = store.getSettings();
  const markets = store.getQuotes();
  const prev = monitor.getEvaluation() || {};
  return evaluate({
    cashUsd: cash.strategyCashUsd ?? cash.cashUsd,
    cashCny: cash.strategyCashCny ?? cash.cashCny,
    usdCnyRate: cash.usdCnyRate,
    variant: settings.variant,
    soxlEnabled: settings.soxlEnabled,
    round: store.getRound(),
    rth: marketStatus().rth,
    sessionDate: marketStatus().ymd,
    qqq: markets.QQQ,
    tqqq: markets.TQQQ,
    soxl: markets.SOXL,
    spy: markets.SPY,
    vxn: markets.VXN,
    cnyProxy: markets['159509'],
    lots: store.getLots(),
    suggestedContracts: prev.suggestedContracts || []
  });
}

function refreshEvaluation() {
  const evaluation = liveEval();
  monitor.setEvaluation(evaluation);
  return evaluation;
}

function snapshot() {
  const snap = monitor.buildSnapshot();
  snap.evaluation = liveEval();
  snap.market = marketStatus();
  snap.notify = maskNotifyForClient(store.getNotify());
  snap.actions = store.listActionRows({ limit: 20 });
  return snap;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'qqq-dip' }));

app.get('/api/notification-settings', (_req, res) => {
  res.json({ ok: true, notify: maskNotifyForClient(store.getNotify()), monitor: monitor.status() });
});

app.get('/api/state', async (_req, res) => {
  void maybeRefreshFx();
  res.json(snapshot());
});

app.get('/api/events', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  void maybeRefreshFx();
  const initial = snapshot();
  res.write(`event: state\ndata: ${JSON.stringify(initial)}\n\n`);
  sseClients.add(res);
  const stopCash = watchCash({ initialCash: initial.cash, read: () => store.getCash(), send: (cash) => {
    res.write(`event: cash\ndata: ${JSON.stringify({ cash, evaluation: liveEval() })}\n\n`);
  } });
  req.on('close', () => { stopCash(); sseClients.delete(res); });
});

app.put('/api/cash', (req, res) => {
  const prev = store.getCash();
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
  const cash = store.setCash(next);
  store.addAction({
    type: 'cash',
    source: 'user',
    message: `现金更新：USD ${cash.cashUsd} / CNY ${cash.cashCny} / 汇率 ${cash.usdCnyRate}`
  });
  res.json({
    ok: true,
    cash,
    evaluation: refreshEvaluation(),
    actions: store.listActionRows({ limit: 20 }),
    monitor: monitor.status()
  });
});

app.put('/api/settings', (req, res) => {
  const settings = store.setSettings(req.body || {});
  res.json({
    ok: true,
    settings,
    evaluation: refreshEvaluation(),
    monitor: monitor.status()
  });
});

app.put('/api/notify', (req, res) => {
  res.status(410).json({ ok: false, error: '提醒配置已迁移至通知管理页面' });
});

app.post('/api/notify/test', async (_req, res) => {
  res.status(410).json({ ok: false, error: '请在通知管理页面测试提醒' });
});

app.post('/api/monitor/start', (_req, res) => {
  res.json({ ok: true, monitor: monitor.start() });
});

app.post('/api/monitor/stop', (_req, res) => {
  res.json({ ok: true, monitor: monitor.stop() });
});

app.post('/api/quotes/refresh', async (_req, res) => {
  try {
    const ev = await monitor.tick({ silent: false });
    res.json({ ok: true, evaluation: ev, monitor: monitor.status() });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, monitor: monitor.status() });
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

app.get('/api/docs', (_req, res) => {
  res.json({ ok: true, docs: docs.listDocs() });
});

app.get('/api/docs/:id', (req, res) => {
  const doc = docs.getDoc(req.params.id);
  if (!doc) return res.status(404).json({ ok: false, error: '文档不存在' });
  res.json({ ok: true, doc });
});

app.get('/api/actions', (req, res) => {
  res.json(store.listActionRows({
    limit: Number(req.query.limit) || 20,
    offset: Number(req.query.offset) || 0,
    source: String(req.query.source || 'all')
  }));
});

app.post('/api/actions', (req, res) => {
  const body = req.body || {};
  let syncedTrades = [];

  if (body.type === 'execute' && !canExecutePlan(req.headers['x-portal-permissions'])) {
    return res.status(403).json({ error: '无档位成交登记权限' });
  }
  if (body.type === 'execute' && body.operation === 'cancel') {
    const round = store.getRound();
    const plan = round.executionPlans?.[body.tier];
    if (!plan || plan.id !== body.planId || plan.inFlight) return res.status(409).json({ error: '计划不存在或写入待核对' });
    plan.cancelled = true;
    store.setRound(round);
    store.addAction({ type: 'note', source: 'user', tier: body.tier, message: '取消未成交计划；已成交持仓及扣款不撤销' });
    return res.json({ ok: true, evaluation: refreshEvaluation() });
  }

  if (body.type === 'execute' && body.tier) {
    if (!canSpendDipFunds(req.headers['x-portal-permissions'])) return res.status(403).json({ error: '无抄底专用资金成交权限' });
    let prepared;
    const executionRound = store.getRound();
    try {
      prepared = prepareExecution(executionRound.executionPlans?.[body.tier], body, liveEval(), store.getCash());
    } catch (error) { return res.status(409).json({ error: error.message }); }
    if (prepared.duplicate) return res.json({ ok: true, duplicate: true, evaluation: refreshEvaluation() });
    const fund = store.getCash().strategyFunds?.find((f) => f.accountId === body.accountId);
    if (!fund || fund.deficit > 0 || prepared.legs.some((leg) => leg.currency !== fund.currency)
      || (prepared.cashUsd + prepared.cashCny) > fund.strategyAvailable + 0.01) {
      return res.status(409).json({ error: '请选择同币种、有足额抄底预留且无缺口的证券账户，每次仅登记同一账户的成交' });
    }
    const { cashUsd, cashCny, legs } = prepared;
    const tradeInputs = legsToTradeInputs(legs, {
      tier: body.tier,
      note: body.note || '',
      trade_date: prepared.filledAt
    });
    const buyInputs = tradeInputs.filter((t) => t.type !== 'sell');
    const sellInputs = tradeInputs.filter((t) => t.type === 'sell');
    if (buyInputs.length !== legs.length || sellInputs.length) return res.status(409).json({ error: '成交明细无效，不扣现金' });

    try {
      const result = commitExecution(store, body, prepared, () => appendTradesApplyCash(
        buyInputs.map((trade) => ({ ...trade, account_id: body.accountId })), { strategyFundId: body.accountId }));
      syncedTrades = syncedTrades.concat(result.trades);
    } catch (error) { return res.status(409).json({ error: `成交同步未完成，请核对账本后处理：${error.message}` }); }
    body.legs = legs;
    body.cashUsd = cashUsd;
    body.cashCny = cashCny;
    body.usd = prepared.usd;
  } else if (body.type === 'sell') {
    const symbol = String(body.symbol || '').trim();
    const shares = Number(body.shares);
    const price = Number(body.price);
    if (symbol && shares > 0 && price > 0) {
      const result = appendTradesApplyCash([{
        type: 'sell',
        symbol,
        name: body.name || symbol,
        currency: body.currency,
        shares,
        price,
        commission: Number(body.commission) || 0,
        trade_date: body.trade_date || new Date().toISOString(),
        source: 'qqq-dip',
        note: body.note || body.message || ''
      }]);
      syncedTrades = result.trades;
    }
  } else if (Array.isArray(body.legs) && body.legs.some((l) => String(l?.side || '').toLowerCase() === 'sell')) {
    const tradeInputs = legsToTradeInputs(body.legs, {
      note: body.note || body.message || '',
      trade_date: new Date().toISOString()
    });
    const sellInputs = tradeInputs.filter((t) => t.type === 'sell');
    if (sellInputs.length) {
      const result = appendTradesApplyCash(sellInputs);
      syncedTrades = result.trades;
    }
  }

  const cash = store.getCash();
  const row = store.addAction({
    type: body.type || 'note',
    source: 'user',
    tier: body.tier || null,
    symbol: body.symbol || null,
    message: body.message || '手动记录',
    payload: body.payload || {
      usd: body.usd,
      cashUsd: body.cashUsd,
      cashCny: body.cashCny,
      qty: body.qty,
      price: body.price,
      shares: body.shares,
      currency: body.currency,
      note: body.note,
      legs: body.legs,
      syncedTradeIds: syncedTrades.map((t) => t.id)
    }
  });
  res.json({
    ok: true,
    action: row,
    cash,
    round: store.getRound(),
    evaluation: refreshEvaluation(),
    actions: store.listActionRows({ limit: 20 }),
    syncedTrades
  });
});

app.put('/api/actions/:id', (req, res) => {
  const row = store.patchAction(req.params.id, req.body || {});
  if (!row) return res.status(404).json({ error: '记录不存在' });
  res.json({ ok: true, action: row });
});

app.get('/api/lots', (_req, res) => res.json({ lots: store.getLots() }));

app.post('/api/lots', (req, res) => {
  const lot = store.saveLot(req.body || {});
  store.addAction({
    type: 'note',
    source: 'user',
    symbol: lot.symbol,
    message: `登记抄底仓位 ${lot.symbol || lot.id}`
  });
  res.json({ ok: true, lot, evaluation: refreshEvaluation() });
});

app.put('/api/lots/:id', (req, res) => {
  const lot = store.saveLot({ ...(req.body || {}), id: req.params.id });
  res.json({ ok: true, lot, evaluation: refreshEvaluation() });
});

app.delete('/api/lots/:id', (req, res) => {
  store.removeLot(req.params.id);
  res.json({ ok: true, evaluation: refreshEvaluation() });
});

app.post('/api/round/reset', (_req, res) => {
  const prev = store.getRound();
  store.setRound(resetRound(prev));
  store.addAction({ type: 'note', source: 'user', message: '手动结束本轮，清空档位状态；保留真实持仓、现金和历史操作' });
  res.json({ ok: true, round: store.getRound(), evaluation: refreshEvaluation() });
});

const { host, port } = config.server;
app.listen(port, host, () => {
  console.log(`qqq-dip http://${host}:${port}`);
  if (store.getSettings().autoStart) {
    monitor.start();
    console.log('qqq-dip autoStart: 监听已启动');
  }
});
