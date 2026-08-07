import express from 'express';
import path from 'node:path';
import XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';
import { loadConfig, createStore, resolveDataPath } from './storage.js';
import { createQuoteService } from './quotes.js';
import { parseImportBuffer } from './import-moomoo.js';
import {
  deriveHoldings,
  computePnl,
  computeSymbolSummaries,
  buildDailyCumulativeSeries,
  expandDailySeries,
  sliceSeries,
  enrichHoldings,
  computeDailySummary,
  normalizeTrade,
  recalcCashFromTrades,
  roundMoney,
  cashDelta
} from './trades.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const store = createStore(resolveDataPath(config));
const quotes = createQuoteService(config);
const app = express();

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));

function buildPortfolio(data, pnlOpts = {}) {
  const holdings = deriveHoldings(data.trades);
  const enriched = enrichHoldings(holdings, data.quotes, data.cash, data.holdingsMeta);
  const pnl = computePnl(data.trades, pnlOpts);
  const sparse = buildDailyCumulativeSeries(data.trades);
  const expanded = expandDailySeries(sparse);
  const chartSeries = sliceSeries(expanded, pnlOpts.startDate, pnlOpts.endDate);
  const daily = computeDailySummary(enriched.rows, data.trades);
  return {
    cash: data.cash,
    trades: data.trades,
    quotes: data.quotes,
    holdingsMeta: data.holdingsMeta,
    holdings: enriched.rows,
    chartSparse: sparse,
    chartExpandedFull: expanded,
    summary: {
      stockMv: enriched.stockMv,
      optionMv: enriched.optionMv,
      totalMv: enriched.totalMv,
      totalAssets: enriched.totalAssets,
      unrealized: enriched.unrealized,
      totalPnl: enriched.unrealized,
      ...pnl,
      ...daily
    },
    chartSeries
  };
}

function sendPortfolio(res, pnlOpts = {}) {
  res.json(buildPortfolio(store.read(), pnlOpts));
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/portfolio', (req, res) => {
  sendPortfolio(res, { startDate: req.query.start, endDate: req.query.end });
});

app.put('/api/cash', (req, res) => {
  const cash = roundMoney(req.body?.cash);
  if (!Number.isFinite(cash)) return res.status(400).json({ error: '无效现金' });
  const data = store.read();
  data.cash = cash;
  store.write(data);
  sendPortfolio(res);
});

app.put('/api/holdings-meta/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: '无效代码' });
  const data = store.read();
  if (!data.holdingsMeta) data.holdingsMeta = {};
  const prev = data.holdingsMeta[symbol] || {};
  const next = { ...prev };
  if ('targetPrice' in req.body) {
    const v = req.body.targetPrice;
    next.targetPrice = v === '' || v == null ? '' : roundMoney(Number(v));
  }
  if ('signal' in req.body) {
    next.signal = String(req.body.signal || '');
  }
  if ('groupWith' in req.body) {
    const v = req.body.groupWith;
    if (v === '' || v == null) delete next.groupWith;
    else next.groupWith = String(v).trim().toUpperCase();
  }
  data.holdingsMeta[symbol] = next;
  store.write(data);
  sendPortfolio(res);
});

app.post('/api/trades', (req, res) => {
  try {
    const trade = normalizeTrade(req.body || {});
    const data = store.read();
    data.trades.push(trade);
    data.cash = roundMoney(data.cash + cashDelta(trade));
    store.write(data);
    sendPortfolio(res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/trades/:id', (req, res) => {
  try {
    const trade = normalizeTrade({ ...req.body, id: req.params.id });
    const data = store.read();
    const i = data.trades.findIndex((t) => t.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: '未找到' });
    const old = data.trades[i];
    data.trades[i] = { ...trade, id: req.params.id, created_at: old.created_at || trade.created_at };
    data.cash = roundMoney(data.cash - cashDelta(old) + cashDelta(trade));
    store.write(data);
    sendPortfolio(res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/trades/:id', (req, res) => {
  const data = store.read();
  const i = data.trades.findIndex((t) => t.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '未找到' });
  const old = data.trades[i];
  data.trades.splice(i, 1);
  data.cash = roundMoney(data.cash - cashDelta(old));
  store.write(data);
  sendPortfolio(res);
});

app.post('/api/trades/import/preview', express.raw({
  type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: '20mb'
}), (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  if (!buf.length) return res.status(400).json({ error: '空文件' });
  try {
    const trades = parseImportBuffer(buf);
    if (!trades.length) return res.status(400).json({ error: '未解析到有效记录' });
    res.json({ count: trades.length, trades: trades.slice(0, 5), preview: trades.slice(0, 5) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/trades/import', express.raw({
  type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: '20mb'
}), (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  if (!buf.length) return res.status(400).json({ error: '空文件' });
  try {
    const imported = parseImportBuffer(buf);
    if (!imported.length) return res.status(400).json({ error: '未解析到有效记录' });
    const data = store.read();
    const mode = String(req.query.mode || 'merge');
    if (mode === 'replace') data.trades = imported;
    else data.trades = data.trades.concat(imported);
    data.cash = recalcCashFromTrades(data.trades, 0);
    store.write(data);
    sendPortfolio(res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/pnl', (req, res) => {
  const data = store.read();
  res.json(computePnl(data.trades, {
    startDate: req.query.start || undefined,
    endDate: req.query.end || undefined
  }));
});

app.get('/api/trades/summary', (req, res) => {
  const data = store.read();
  res.json(computeSymbolSummaries(data.trades, {
    startDate: req.query.start || undefined,
    endDate: req.query.end || undefined
  }));
});

app.get('/api/trades/export', (req, res) => {
  const data = store.read();
  let trades = [...data.trades].sort((a, b) => new Date(b.trade_date) - new Date(a.trade_date));
  const sym = String(req.query.symbol || '').trim().toUpperCase();
  const type = req.query.type;
  const start = req.query.start;
  const end = req.query.end;
  if (sym) trades = trades.filter((t) => t.symbol.toUpperCase().includes(sym));
  if (type && type !== 'all') trades = trades.filter((t) => t.type === type);
  if (start) trades = trades.filter((t) => t.trade_date.slice(0, 10) >= start);
  if (end) trades = trades.filter((t) => t.trade_date.slice(0, 10) <= end);

  const rows = trades.map((t) => ({
    时间: t.trade_date,
    类型: t.type === 'buy' ? '买入' : t.type === 'sell' ? '卖出' : '其它',
    其它类别: t.other_category || '',
    代码: t.symbol,
    名称: t.name || '',
    股数: t.type === 'other' ? '' : t.shares,
    价格: t.type === 'other' ? '' : t.price,
    金额: t.total_amount,
    手续费: t.commission
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '交易记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=trades.xlsx');
  res.send(buf);
});

app.get('/api/search', async (req, res) => {
  try {
    res.json(await quotes.search(req.query.q));
  } catch {
    res.json([]);
  }
});

app.get('/api/stock/:symbol', async (req, res) => {
  try {
    res.json(await quotes.getStock(req.params.symbol));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/option/:symbol', async (req, res) => {
  try {
    res.json(await quotes.getOption(req.params.symbol));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/quotes/refresh', async (req, res) => {
  const data = store.read();
  const symbol = req.body?.symbol;
  const symbols = symbol
    ? [String(symbol).toUpperCase()]
    : [...new Set(deriveHoldings(data.trades).map((h) => h.symbol))];
  if (!symbols.length) {
    return res.status(400).json({ error: '暂无持仓可刷新' });
  }
  const updated = { ...data.quotes };
  const errors = [];
  let ok = 0;
  for (const sym of symbols) {
    try {
      updated[sym] = await quotes.getQuote(sym);
      ok += 1;
      if (!symbol) await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      errors.push({ symbol: sym, error: e.message || '失败' });
    }
  }
  data.quotes = updated;
  store.write(data);
  const payload = buildPortfolio(data, {
    startDate: req.query?.start,
    endDate: req.query?.end
  });
  payload.refresh = { ok, failed: errors.length, errors };
  if (!ok && errors.length) {
    return res.status(502).json({ error: '行情刷新全部失败', ...payload });
  }
  res.json(payload);
});

app.use(express.static(PUBLIC));
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

const { host, port } = config.server;
app.listen(port, host, () => {
  console.log(`stock-manage http://${host}:${port}`);
});
