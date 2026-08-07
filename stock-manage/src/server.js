import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, createStore, resolveDataPath } from './storage.js';
import { createQuoteService } from './quotes.js';
import { parseImportBuffer } from './import-moomoo.js';
import {
  deriveHoldings,
  computePnl,
  enrichHoldings,
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

function sendPortfolio(res) {
  const data = store.read();
  const holdings = deriveHoldings(data.trades);
  const enriched = enrichHoldings(holdings, data.quotes, data.cash);
  const pnl = computePnl(data.trades);
  res.json({
    cash: data.cash,
    trades: data.trades,
    quotes: data.quotes,
    holdings: enriched.rows,
    summary: {
      stockMv: enriched.stockMv,
      optionMv: enriched.optionMv,
      totalMv: enriched.totalMv,
      totalAssets: enriched.totalAssets,
      unrealized: enriched.unrealized,
      ...pnl
    }
  });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/portfolio', (_req, res) => sendPortfolio(res));

app.put('/api/cash', (req, res) => {
  const cash = roundMoney(req.body?.cash);
  if (!Number.isFinite(cash)) return res.status(400).json({ error: '无效现金' });
  const data = store.read();
  data.cash = cash;
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

app.post('/api/quotes/refresh', async (_req, res) => {
  const data = store.read();
  const symbols = [...new Set(deriveHoldings(data.trades).map((h) => h.symbol))];
  const updated = { ...data.quotes };
  const errors = [];
  for (const sym of symbols) {
    try {
      updated[sym] = await quotes.getQuote(sym);
    } catch (e) {
      errors.push({ symbol: sym, error: e.message });
    }
  }
  data.quotes = updated;
  store.write(data);
  sendPortfolio(res);
});

app.use(express.static(PUBLIC));
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

const { host, port } = config.server;
app.listen(port, host, () => {
  console.log(`stock-manage http://${host}:${port}`);
});
