import express from 'express';
import path from 'node:path';
import XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';
import { loadConfig, createStore } from './storage.js';
import { createQuantStore, resetPaper } from './quant-store.js';
import { createQuantBacktestStore } from './quant-backtest-store.js';
import { createYoloStore } from './yolo-store.js';
import { createYoloCollector, isUsOptionMarketOpen } from './yolo-collector.js';
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
import { analyzeCandles, backtestCandles, DEFAULT_QUANT_CONFIG, normalizeQuantConfig } from './quant-analysis.js';
import { redactPortfolioCash } from './portfolio-visibility.js';

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
const quantStore = createQuantStore(config);
const quantBacktestStore = createQuantBacktestStore(config);
const quotes = createQuoteService(config);
const yoloStore = createYoloStore(config);
const yoloCollector = createYoloCollector({ store: yoloStore, quotes });
const app = express();

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));

function quantUserId(req) {
  const value = String(req.headers['x-portal-user-id'] || 'local').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'local';
}

function portalPermissions(req) {
  const encoded = String(req.headers['x-portal-permissions'] || '');
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasStockPermission(req, feature, action = 'view') {
  const permissions = portalPermissions(req);
  if (permissions === null) return true;
  const exact = `service:stock-manage:${feature}:${action}`;
  const edit = `service:stock-manage:${feature}:edit`;
  return permissions.includes('*')
    || permissions.includes('service:stock-manage:edit')
    || permissions.includes(exact)
    || (action === 'view' && permissions.includes(edit));
}

function hasQuantPermission(req, feature, action = 'view') {
  return hasStockPermission(req, feature, action);
}

function requireStockPermission(req, res, feature, action = 'view') {
  if (hasStockPermission(req, feature, action)) return true;
  res.status(403).json({ error: '无权使用该持仓功能' });
  return false;
}

function requireQuantPermission(req, res, feature, action = 'view') {
  if (hasQuantPermission(req, feature, action)) return true;
  res.status(403).json({ error: '无权使用该量化分析功能' });
  return false;
}

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

function portfolioForRequest(req, data = store.read()) {
  const portfolio = buildPortfolio(data, pnlOptsFromReq(req));
  return hasStockPermission(req, 'cash') ? { ...portfolio, cashVisible: true } : redactPortfolioCash(portfolio);
}

function sendPortfolio(res, req) {
  res.json(portfolioForRequest(req));
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/portfolio', (req, res) => {
  sendPortfolio(res, req);
});

app.put('/api/cash', (req, res) => {
  if (!requireStockPermission(req, res, 'cash', 'edit')) return;
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

async function analyzeQuantSymbols(rawSymbols, rawPeriod, rawConfig, userId = 'local') {
    const data = store.read();
    const holdings = deriveHoldings(data.trades);
    const holdingMap = new Map(holdings.map((holding) => [normalizeSymbol(holding.symbol), holding]));
    const saved = quantStore.read(userId).settings;
    const symbols = quantSymbols(rawSymbols, saved.symbols);
    const strategyConfig = typeof rawConfig === 'string' ? quantConfig(rawConfig) : normalizeQuantConfig(rawConfig || saved.config);
    const period = quantPeriod(rawPeriod || saved.period);

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
          config: strategyConfig
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
          config: strategyConfig
        });
      }
      return {
        ...analyzeCandles({
        symbol,
        name: quote.name && quote.name !== symbol ? quote.name : name,
        price: Number(quote.price),
        changePercent: Number(quote.changePercent),
        candles: historyResult.value.candles,
        config: strategyConfig,
        historySource: historyResult.value.source,
        quoteSource: quote.source || null
        }),
        adjustedForSplits: historyResult.value.adjustedForSplits === true
      };
    });

    signals.sort((a, b) => {
      const rank = (signal) => signal.signal === 'BUY'
        ? signal.strength + 100
        : signal.signal === 'HOLD' ? 0 : -signal.strength - 100;
      return rank(b) - rank(a);
    });
    return {
      signals,
      config: strategyConfig,
      period: period.key,
      days: period.days,
      timestamp: Date.now()
    };
}

app.get('/api/analysis', async (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-analysis-run', 'edit')) return;
  try {
    res.json(await analyzeQuantSymbols(req.query.symbols, req.query.period, req.query.config, quantUserId(req)));
  } catch (e) {
    res.status(500).json({ error: e.message || '量化分析失败' });
  }
});

app.get('/api/quant/settings', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-settings')) return;
  res.json(quantStore.read(quantUserId(req)).settings);
});

app.get('/api/quant/history/:symbol', async (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-history')) return;
  const symbol = quantSymbols(req.params.symbol)[0];
  if (!symbol || inferMarket(symbol) !== 'US') {
    return res.status(400).json({ error: 'K 线当前仅支持美股正股' });
  }
  try {
    const before = Number(req.query.before);
    const period = quantPeriod(req.query.period);
    const days = Number.isFinite(Number(req.query.days))
      ? Math.min(1825, Math.max(90, Number(req.query.days)))
      : period.days;
    const history = await quotes.getStockHistory(symbol, {
      days,
      endTimestamp: Number.isFinite(before) ? before - 86400000 : undefined
    });
    const candles = Number.isFinite(before)
      ? history.candles.filter((candle) => candle.timestamp < before)
      : history.candles;
    res.json({
      symbol,
      period: period.key,
      source: history.source,
      adjustedForSplits: history.adjustedForSplits === true,
      candles,
      hasMore: candles.length >= Math.floor(days * 0.35),
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(502).json({ error: error.message || '获取 K 线失败' });
  }
});

app.put('/api/quant/settings', (req, res) => {
  const scope = ['watchlist', 'config', 'paper'].includes(req.body?.scope) ? req.body.scope : 'watchlist';
  const scopeFeature = {
    watchlist: 'quant-watchlist',
    config: 'quant-config',
    paper: 'quant-paper-settings'
  }[scope];
  if (!requireQuantPermission(req, res, scopeFeature, 'edit')) return;
  const userId = quantUserId(req);
  const current = quantStore.read(userId);
  const body = req.body || {};
  if (scope === 'watchlist') {
    const rawSymbols = Array.isArray(body.symbols) ? body.symbols.join(',') : String(body.symbols || '');
    const symbols = quantSymbols(rawSymbols);
    if (!symbols.length) return res.status(400).json({ error: '请至少保存一个有效的美股代码' });
    current.settings.symbols = symbols;
    current.settings.period = quantPeriod(body.period).key;
  } else if (scope === 'config') {
    current.settings.config = normalizeQuantConfig(body.config || current.settings.config);
  } else {
    current.settings.paperInitialCapital = Math.max(1000, Math.min(100000000, Number(body.paperInitialCapital) || current.settings.paperInitialCapital));
    current.settings.paperPositionPct = Math.max(0.01, Math.min(1, Number(body.paperPositionPct) || current.settings.paperPositionPct));
  }
  res.json(quantStore.write(userId, current).settings);
});

app.get('/api/quant/backtests', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-backtest')) return;
  res.json({ items: quantBacktestStore.list(quantUserId(req), req.query.limit) });
});

app.get('/api/quant/backtests/:id', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-backtest')) return;
  const result = quantBacktestStore.get(quantUserId(req), req.params.id);
  if (!result) return res.status(404).json({ error: '回测记录不存在' });
  res.json(result);
});

app.delete('/api/quant/backtests/:id', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-backtest-delete', 'edit')) return;
  const removed = quantBacktestStore.remove(quantUserId(req), req.params.id);
  if (!removed) return res.status(404).json({ error: '回测记录不存在' });
  res.json({ ok: true });
});

app.post('/api/quant/backtest', async (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-backtest-run', 'edit')) return;
  try {
    const userId = quantUserId(req);
    const savedState = quantStore.read(userId);
    const saved = savedState.settings;
    const rawSymbols = Array.isArray(req.body?.symbols) ? req.body.symbols.join(',') : String(req.body?.symbols || '');
    const symbols = quantSymbols(rawSymbols, saved.symbols);
    if (!symbols.length) return res.status(400).json({ error: '请选择回测标的' });
    const period = quantPeriod(req.body?.period || saved.period);
    const strategyConfig = normalizeQuantConfig(req.body?.config || saved.config);
    const initialCapital = Math.max(1000, Math.min(100000000, Number(req.body?.initialCapital) || 100000));
    saved.backtestPeriod = period.key === '3m' ? '6m' : period.key;
    saved.backtestInitialCapital = initialCapital;
    quantStore.write(userId, savedState);
    const allocation = initialCapital / symbols.length;
    const backtestStart = Date.now() - period.days * 86400000;
    const results = await mapWithConcurrency(symbols, 2, async (symbol) => {
      try {
        const history = await quotes.getStockHistory(symbol, { days: period.days + 120 });
        return {
          ...backtestCandles({ symbol, candles: history.candles, config: strategyConfig, initialCapital: allocation, startTimestamp: backtestStart }),
          historySource: history.source,
          adjustedForSplits: history.adjustedForSplits === true
        };
      } catch (error) {
        return { symbol, status: 'error', message: error.message || '获取历史行情失败' };
      }
    });
    const valid = results.filter((item) => item.status === 'ok');
    if (!valid.length) return res.status(502).json({ error: '没有可用于回测的历史行情', results });
    const allocatedCapital = allocation * valid.length;
    const finalEquity = valid.reduce((sum, item) => sum + item.finalEquity, 0);
    const completedTrades = valid.reduce((sum, item) => sum + item.completedTrades, 0);
    const weightedWins = valid.reduce((sum, item) => sum + item.winRate * item.completedTrades, 0);
    const curveMaps = valid.map((item) => new Map(item.equityCurve.map((point) => [point.timestamp, point])));
    const commonTimestamps = valid[0].equityCurve
      .map((point) => point.timestamp)
      .filter((timestamp) => curveMaps.every((map) => map.has(timestamp)));
    const equityCurve = commonTimestamps.map((timestamp) => {
      const points = curveMaps.map((map) => map.get(timestamp));
      const strategyEquity = points.reduce((sum, point) => sum + point.equity, 0);
      const buyHoldEquity = points.reduce((sum, point) => sum + point.buyHoldEquity, 0);
      return {
        timestamp,
        strategyEquity,
        buyHoldEquity,
        strategyReturn: (strategyEquity - allocatedCapital) / allocatedCapital,
        buyHoldReturn: (buyHoldEquity - allocatedCapital) / allocatedCapital
      };
    });
    const response = {
      period: period.key,
      initialCapital: allocatedCapital,
      finalEquity,
      totalReturn: (finalEquity - allocatedCapital) / allocatedCapital,
      buyHoldReturn: valid.reduce((sum, item) => sum + item.buyHoldReturn, 0) / valid.length,
      maxDrawdown: Math.max(...valid.map((item) => item.maxDrawdown)),
      winRate: completedTrades ? weightedWins / completedTrades : 0,
      completedTrades,
      equityCurve,
      results,
      from: equityCurve[0]?.timestamp || null,
      to: equityCurve.at(-1)?.timestamp || null,
      timestamp: Date.now()
    };
    res.json(quantBacktestStore.save(userId, response));
  } catch (error) {
    res.status(500).json({ error: error.message || '回测失败' });
  }
});

function paperView(saved, signals = []) {
  const signalMap = new Map(signals.map((signal) => [signal.symbol, signal]));
  const holdings = Object.entries(saved.paper.holdings).map(([symbol, holding]) => {
    const latest = signalMap.get(symbol);
    const price = Number(latest?.price) > 0 ? Number(latest.price) : Number(holding.lastPrice) || Number(holding.avgCost);
    return {
      symbol,
      shares: Number(holding.shares),
      avgCost: Number(holding.avgCost),
      price,
      marketValue: Number(holding.shares) * price,
      pnl: Number(holding.shares) * (price - Number(holding.avgCost)),
      signal: latest?.signal || 'HOLD'
    };
  });
  const holdingsValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);
  return {
    ...saved.paper,
    holdings,
    holdingsValue,
    totalEquity: saved.paper.cash + holdingsValue,
    totalReturn: (saved.paper.cash + holdingsValue - saved.paper.initialCapital) / saved.paper.initialCapital
  };
}

app.get('/api/quant/paper', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-paper')) return;
  res.json(paperView(quantStore.read(quantUserId(req))));
});

app.post('/api/quant/paper/reset', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-paper-reset', 'edit')) return;
  const userId = quantUserId(req);
  const saved = quantStore.read(userId);
  if (Number(req.body?.initialCapital) >= 1000) saved.settings.paperInitialCapital = Number(req.body.initialCapital);
  saved.paper = resetPaper(saved.settings);
  res.json(paperView(quantStore.write(userId, saved)));
});

app.post('/api/quant/paper/sync', async (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-paper-sync', 'edit')) return;
  try {
    const userId = quantUserId(req);
    const saved = quantStore.read(userId);
    const analysis = await analyzeQuantSymbols(saved.settings.symbols.join(','), saved.settings.period, saved.settings.config, userId);
    const now = Date.now();
    const trades = [];
    for (const signal of analysis.signals) {
      if (signal.status !== 'ok' || !(Number(signal.price) > 0)) continue;
      const holding = saved.paper.holdings[signal.symbol];
      if (holding) holding.lastPrice = Number(signal.price);
      const signalKey = `${signal.asOf || now}:${signal.signal}`;
      if (saved.paper.processedSignals[signal.symbol] === signalKey) continue;
      if (signal.signal === 'BUY' && !holding) {
        const current = paperView(saved, analysis.signals);
        const budget = Math.min(saved.paper.cash, current.totalEquity * saved.settings.paperPositionPct);
        const shares = Math.floor((budget / Number(signal.price)) * 10000) / 10000;
        if (shares > 0) {
          const cost = shares * Number(signal.price);
          saved.paper.cash -= cost;
          saved.paper.holdings[signal.symbol] = { shares, avgCost: Number(signal.price), lastPrice: Number(signal.price) };
          trades.push({ timestamp: now, symbol: signal.symbol, side: 'BUY', shares, price: Number(signal.price), amount: cost });
        }
      } else if (signal.signal === 'SELL' && holding) {
        const amount = Number(holding.shares) * Number(signal.price);
        saved.paper.cash += amount;
        trades.push({
          timestamp: now,
          symbol: signal.symbol,
          side: 'SELL',
          shares: Number(holding.shares),
          price: Number(signal.price),
          amount,
          pnl: Number(holding.shares) * (Number(signal.price) - Number(holding.avgCost))
        });
        delete saved.paper.holdings[signal.symbol];
      }
      saved.paper.processedSignals[signal.symbol] = signalKey;
    }
    saved.paper.trades = saved.paper.trades.concat(trades).slice(-500);
    saved.paper.updatedAt = now;
    quantStore.write(userId, saved);
    res.json({ ...paperView(saved, analysis.signals), executed: trades, signals: analysis.signals });
  } catch (error) {
    res.status(500).json({ error: error.message || '模拟盘同步失败' });
  }
});

app.get('/api/option/:symbol', async (req, res) => {
  try {
    res.json(await quotes.getOption(req.params.symbol));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/yolo/status', (req, res) => {
  if (!requireQuantPermission(req, res, 'yolo-dashboard')) return;
  const userId = quantUserId(req);
  yoloStore.ensure(userId);
  res.json({ ...yoloStore.status(userId), marketOpen: isUsOptionMarketOpen(), collectorRunning: yoloCollector.isRunning() });
});

app.put('/api/yolo/settings', (req, res) => {
  if (!requireQuantPermission(req, res, 'yolo-control', 'edit')) return;
  const settings = yoloStore.updateSettings(quantUserId(req), req.body || {});
  res.json(settings);
});

app.post('/api/yolo/capture', async (req, res) => {
  if (!requireQuantPermission(req, res, 'yolo-control', 'edit')) return;
  try {
    const snapshot = await yoloCollector.captureNow(quantUserId(req));
    res.json({ ok: true, capturedAt: snapshot?.capturedAt || null, contracts: snapshot?.contracts?.length || 0,
      status: yoloStore.status(quantUserId(req)) });
  } catch (error) {
    res.status(502).json({ error: error.message || '期权链采集失败', status: yoloStore.status(quantUserId(req)) });
  }
});

app.post('/api/yolo/backtest', (req, res) => {
  if (!requireQuantPermission(req, res, 'yolo-backtest-run', 'edit')) return;
  try {
    res.json(yoloStore.backtest(quantUserId(req), req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message || '梭哈回测失败' });
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
  const payload = portfolioForRequest(req, data);
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
  yoloCollector.start();
});
