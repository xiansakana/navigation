import express from 'express';
import path from 'node:path';
import XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';
import { loadConfig, createStore } from './storage.js';
import { createQuoteService } from './quotes.js';
import { parseImportBuffer } from './import-moomoo.js';
import {
  deriveHoldings,
  computePnl,
  computeSymbolSummaries,
  buildDailyCumulativeSeries,
  enrichHoldings,
  computeDailySummary,
  normalizeTrade,
  recalcCashFromTrades,
  roundMoney,
  applyCashDelta,
  undoCashDelta,
  cashUsdEquivalent,
  tradeCalendarDate,
  formatZonedDateTime
} from './trades.js';
import { inferMarket, normalizeSymbol } from './markets.js';
import { DEFAULT_USD_CNY_RATE } from '../../shared/db/portfolio-store.js';
import { analyzeCandles, DEFAULT_QUANT_CONFIG, normalizeQuantConfig } from './quant-analysis.js';

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
const app = express();

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));

function buildPortfolio(data, pnlOpts = {}) {
  const rate = Number(data.usdCnyRate) > 0 ? Number(data.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const fxOpts = { ...pnlOpts, usdCnyRate: rate };
  const holdings = deriveHoldings(data.trades);
  const cashState = {
    cashUsd: Number(data.cashUsd) || 0,
    cashCny: Number(data.cashCny) || 0,
    usdCnyRate: rate
  };
  const enriched = enrichHoldings(holdings, data.quotes, cashState, data.holdingsMeta);
  const pnl = computePnl(data.trades, fxOpts);
  const sparse = buildDailyCumulativeSeries(data.trades, fxOpts);
  const daily = computeDailySummary(enriched.rows, data.trades, fxOpts);
  const cashEq = cashUsdEquivalent(cashState.cashUsd, cashState.cashCny, rate);
  return {
    cash: cashEq,
    cashUsd: cashState.cashUsd,
    cashCny: cashState.cashCny,
    usdCnyRate: rate,
    trades: data.trades,
    quotes: data.quotes,
    holdingsMeta: data.holdingsMeta,
    holdings: enriched.rows,
    chartSparse: sparse,
    summary: {
      stockMv: enriched.stockMv,
      optionMv: enriched.optionMv,
      ashareMv: enriched.ashareMv,
      ashareMvNative: enriched.ashareMvNative,
      totalMv: enriched.totalMv,
      totalAssets: enriched.totalAssets,
      totalAssetsCny: enriched.totalAssetsCny,
      assetsUsd: enriched.assetsUsd,
      assetsCny: enriched.assetsCny,
      unrealized: enriched.unrealized,
      unrealizedUsd: enriched.unrealizedUsd,
      unrealizedCny: enriched.unrealizedCny,
      totalPnl: enriched.unrealized,
      totalPnlUsd: enriched.unrealizedUsd,
      totalPnlCny: enriched.unrealizedCny,
      cashUsdEq: cashEq,
      ...pnl,
      ...daily
    }
  };
}

function pnlOptsFromReq(req) {
  return {
    startDate: req.query?.start || undefined,
    endDate: req.query?.end || undefined
  };
}

function sendPortfolio(res, req) {
  res.json(buildPortfolio(store.read(), pnlOptsFromReq(req)));
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/portfolio', (req, res) => {
  sendPortfolio(res, req);
});

app.put('/api/cash', (req, res) => {
  const data = store.read();
  const body = req.body || {};
  let cashUsd = data.cashUsd;
  let cashCny = data.cashCny;
  let usdCnyRate = data.usdCnyRate;

  if ('cashUsd' in body || 'cashCny' in body || 'usdCnyRate' in body) {
    if ('cashUsd' in body) {
      cashUsd = roundMoney(Number(body.cashUsd));
      if (!Number.isFinite(cashUsd)) return res.status(400).json({ error: '无效美元现金' });
    }
    if ('cashCny' in body) {
      cashCny = roundMoney(Number(body.cashCny));
      if (!Number.isFinite(cashCny)) return res.status(400).json({ error: '无效人民币现金' });
    }
    if ('usdCnyRate' in body && body.usdCnyRate != null && body.usdCnyRate !== '') {
      usdCnyRate = Number(body.usdCnyRate);
      if (!Number.isFinite(usdCnyRate) || usdCnyRate <= 0) {
        return res.status(400).json({ error: '无效汇率' });
      }
    }
  } else if ('cash' in body) {
    cashUsd = roundMoney(Number(body.cash));
    if (!Number.isFinite(cashUsd)) return res.status(400).json({ error: '无效现金' });
  } else {
    return res.status(400).json({ error: '无效现金' });
  }

  data.cashUsd = cashUsd;
  data.cashCny = cashCny;
  data.usdCnyRate = usdCnyRate;
  data.cash = cashUsdEquivalent(cashUsd, cashCny, usdCnyRate);
  store.write(data);
  sendPortfolio(res, req);
});

app.put('/api/holdings-meta/:symbol', (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);
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
    else next.groupWith = normalizeSymbol(v);
  }
  data.holdingsMeta[symbol] = next;
  store.write(data);
  sendPortfolio(res, req);
});

app.post('/api/trades', (req, res) => {
  try {
    const trade = normalizeTrade(req.body || {});
    const data = store.read();
    data.trades.push(trade);
    Object.assign(data, applyCashDelta(data, trade));
    store.write(data);
    sendPortfolio(res, req);
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
    Object.assign(data, applyCashDelta(undoCashDelta(data, old), trade));
    store.write(data);
    sendPortfolio(res, req);
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
  Object.assign(data, undoCashDelta(data, old));
  store.write(data);
  sendPortfolio(res, req);
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
    const recalc = recalcCashFromTrades(data.trades, {
      cashUsd: 0,
      cashCny: 0,
      usdCnyRate: data.usdCnyRate || DEFAULT_USD_CNY_RATE
    });
    Object.assign(data, recalc);
    store.write(data);
    sendPortfolio(res, req);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/pnl', (req, res) => {
  const data = store.read();
  res.json(computePnl(data.trades, {
    startDate: req.query.start || undefined,
    endDate: req.query.end || undefined,
    usdCnyRate: data.usdCnyRate
  }));
});

app.get('/api/trades/summary', (req, res) => {
  const data = store.read();
  res.json(computeSymbolSummaries(data.trades, {
    startDate: req.query.start || undefined,
    endDate: req.query.end || undefined,
    usdCnyRate: data.usdCnyRate
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
  if (start) trades = trades.filter((t) => (tradeCalendarDate(t.trade_date) || '') >= start);
  if (end) trades = trades.filter((t) => (tradeCalendarDate(t.trade_date) || '') <= end);

  const rows = trades.map((t) => ({
    时间: formatZonedDateTime(t.trade_date),
    类型: t.type === 'buy' ? '买入' : t.type === 'sell' ? '卖出' : '其它',
    其它类别: t.other_category || '',
    代码: t.symbol,
    名称: t.name || '',
    币种: t.currency || 'USD',
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

function quantSymbols(raw, fallback = []) {
  const source = typeof raw === 'string' && raw.trim() ? raw.split(',') : fallback;
  return [...new Set(source
    .map((symbol) => normalizeSymbol(symbol))
    .filter((symbol) => /^[A-Z0-9][A-Z0-9.-]{0,23}$/.test(symbol)))]
    .slice(0, 30);
}

function quantPeriod(raw) {
  const periods = {
    '3m': 120,
    '6m': 220,
    '1y': 370,
    '2y': 740,
    '5y': 1825
  };
  const key = Object.hasOwn(periods, raw) ? raw : '1y';
  return { key, days: periods[key] };
}

function quantConfig(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ...DEFAULT_QUANT_CONFIG };
  try {
    return normalizeQuantConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_QUANT_CONFIG };
  }
}

function unavailableQuantSignal({ symbol, name, price, changePercent, status, message, config }) {
  return {
    ...analyzeCandles({ symbol, name, price, changePercent, candles: [], config }),
    status,
    message
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

app.get('/api/analysis', async (req, res) => {
  try {
    const data = store.read();
    const holdings = deriveHoldings(data.trades);
    const holdingMap = new Map(holdings.map((holding) => [normalizeSymbol(holding.symbol), holding]));
    const defaultSymbols = holdings
      .filter((holding) => inferMarket(holding.symbol) === 'US')
      .map((holding) => holding.symbol);
    const symbols = quantSymbols(req.query.symbols, defaultSymbols);
    const config = quantConfig(req.query.config);
    const period = quantPeriod(req.query.period);

    const signals = await mapWithConcurrency(symbols, 4, async (symbol) => {
      const holding = holdingMap.get(symbol);
      const storedQuote = data.quotes?.[symbol] || {};
      const name = holding?.name || storedQuote.name || symbol;
      if (inferMarket(symbol) !== 'US') {
        return unavailableQuantSignal({
          symbol,
          name,
          price: Number(storedQuote.price),
          changePercent: Number(storedQuote.changePercent),
          status: 'unsupported',
          message: '当前仅支持美股正股，A 股与期权暂不参与量化分析',
          config
        });
      }

      const [quoteResult, historyResult] = await Promise.allSettled([
        quotes.getStock(symbol),
        quotes.getStockHistory(symbol, { days: period.days })
      ]);
      const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : storedQuote;
      if (historyResult.status === 'rejected') {
        return unavailableQuantSignal({
          symbol,
          name: quote.name || name,
          price: Number(quote.price),
          changePercent: Number(quote.changePercent),
          status: 'error',
          message: historyResult.reason?.message || '获取历史行情失败',
          config
        });
      }
      return analyzeCandles({
        symbol,
        name: quote.name && quote.name !== symbol ? quote.name : name,
        price: Number(quote.price),
        changePercent: Number(quote.changePercent),
        candles: historyResult.value.candles,
        config,
        historySource: historyResult.value.source,
        quoteSource: quote.source || null
      });
    });

    signals.sort((a, b) => {
      const rank = (signal) => signal.signal === 'BUY'
        ? signal.strength + 100
        : signal.signal === 'HOLD' ? 0 : -signal.strength - 100;
      return rank(b) - rank(a);
    });
    res.json({
      signals,
      config,
      period: period.key,
      days: period.days,
      timestamp: Date.now()
    });
  } catch (e) {
    res.status(500).json({ error: e.message || '量化分析失败' });
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
    ? [normalizeSymbol(symbol)]
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
  try {
    const fx = await quotes.getUsdCny();
    if (fx?.rate > 0) data.usdCnyRate = fx.rate;
  } catch (e) {
    errors.push({ symbol: 'USDCNY', error: e.message || '汇率失败' });
  }
  data.quotes = updated;
  data.cash = cashUsdEquivalent(data.cashUsd, data.cashCny, data.usdCnyRate);
  store.write(data);
  const payload = buildPortfolio(data, pnlOptsFromReq(req));
  payload.refresh = { ok, failed: errors.length, errors };
  if (!ok && errors.length) {
    return res.status(502).json({ error: '行情刷新全部失败', ...payload });
  }
  res.json(payload);
});

app.get('/vendor/echarts.min.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js'));
});
app.use(express.static(PUBLIC));
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

const { host, port } = config.server;
app.listen(port, host, () => {
  console.log(`stock-manage http://${host}:${port}`);
});
