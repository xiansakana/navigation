import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createQuoteService } from './quotes.js';
import { createMonitor } from './monitor.js';
import { maskNotifyForClient, testDipNotify } from './notify.js';
import { marketStatus } from './market-hours.js';
import { evaluate } from './playbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const store = createStore(config);
const quotes = createQuoteService(config);
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => client.write(payload));
}

const monitor = createMonitor({
  store,
  quotes,
  onSnapshot(snap) {
    broadcast('state', snap);
  }
});

const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC));

function liveEval() {
  const cash = store.getCash();
  const settings = store.getSettings();
  const markets = store.getQuotes();
  return evaluate({
    cashUsd: cash.cashUsd,
    cashCny: cash.cashCny,
    usdCnyRate: cash.usdCnyRate,
    variant: settings.variant,
    soxlEnabled: settings.soxlEnabled,
    round: store.getRound(),
    rth: marketStatus().rth,
    qqq: markets.QQQ,
    tqqq: markets.TQQQ,
    soxl: markets.SOXL,
    spy: markets.SPY,
    vxn: markets.VXN,
    lots: store.getLots()
  });
}

function snapshot() {
  const snap = monitor.buildSnapshot();
  if (!snap.evaluation) snap.evaluation = liveEval();
  snap.market = marketStatus();
  snap.notify = maskNotifyForClient(store.getNotify());
  snap.actions = store.listActionRows({ limit: 80 });
  return snap;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'qqq-dip' }));

app.get('/api/state', (_req, res) => {
  res.json(snapshot());
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.put('/api/cash', (req, res) => {
  const cash = store.setCash(req.body || {});
  store.addAction({
    type: 'cash',
    source: 'user',
    message: `现金更新：USD ${cash.cashUsd} / CNY ${cash.cashCny} / 汇率 ${cash.usdCnyRate}`
  });
  res.json({ ok: true, cash, evaluation: liveEval(), actions: store.listActionRows({ limit: 80 }) });
});

app.put('/api/settings', (req, res) => {
  const settings = store.setSettings(req.body || {});
  res.json({ ok: true, settings, evaluation: liveEval() });
});

app.put('/api/notify', (req, res) => {
  const notify = store.setNotify(req.body || {});
  res.json({ ok: true, notify: maskNotifyForClient(notify) });
});

app.post('/api/notify/test', async (_req, res) => {
  try {
    const result = await testDipNotify(store.getNotify());
    store.addAction({
      type: 'notify',
      source: 'user',
      message: `测试通知成功：${result.targets.join('，')}`
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
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

app.get('/api/actions', (req, res) => {
  res.json(store.listActionRows({
    limit: Number(req.query.limit) || 80,
    offset: Number(req.query.offset) || 0
  }));
});

app.post('/api/actions', (req, res) => {
  const body = req.body || {};
  if (body.type === 'execute' && body.tier) {
    store.markExecuted(body.tier, { usd: body.usd, note: body.note });
  }
  const row = store.addAction({
    type: body.type || 'note',
    source: 'user',
    tier: body.tier || null,
    symbol: body.symbol || null,
    message: body.message || '手动记录',
    payload: body.payload || { usd: body.usd, qty: body.qty, price: body.price, note: body.note }
  });
  res.json({ ok: true, action: row, round: store.getRound(), evaluation: liveEval(), actions: store.listActionRows({ limit: 80 }) });
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
  res.json({ ok: true, lot, evaluation: liveEval() });
});

app.put('/api/lots/:id', (req, res) => {
  const lot = store.saveLot({ ...(req.body || {}), id: req.params.id });
  res.json({ ok: true, lot, evaluation: liveEval() });
});

app.delete('/api/lots/:id', (req, res) => {
  store.removeLot(req.params.id);
  res.json({ ok: true, evaluation: liveEval() });
});

app.post('/api/round/reset', (_req, res) => {
  const prev = store.getRound();
  store.setRound({
    ...prev,
    triggered: {},
    firedAlerts: {},
    hasSeenMinus22: false,
    hasSeenMinus30: false,
    r1At: null,
    r1SwingLow: null,
    r2Frozen: false,
    fakeRight: false,
    lastResetAt: new Date().toISOString()
  });
  store.addAction({ type: 'note', source: 'user', message: '手动重置本轮未触发档' });
  res.json({ ok: true, round: store.getRound(), evaluation: liveEval() });
});

const { host, port } = config.server;
app.listen(port, host, () => {
  console.log(`qqq-dip http://${host}:${port}`);
  if (store.getSettings().autoStart) {
    monitor.start();
    console.log('qqq-dip autoStart: 监听已启动');
  }
});
