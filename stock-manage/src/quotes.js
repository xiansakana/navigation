import {
  isAShareSymbol,
  ashareCode,
  ashareExchange,
  hkCode,
  normalizeSymbol
} from './markets.js';
import { dateTimeFormatter } from './date-formatters.js';
import { fetchQuoteResource } from '../../shared/quote-network.js';
import { createForeignExchangeService } from '../../shared/foreign-exchange.js';
import { fundCode, hongKongFundIsin } from '../../shared/fund-holdings.js';
import { getHkFundQuote, hkFundInfo } from './hk-fund-nav.js';
import { findMainlandInstruments, getFundNav } from './fund-nav.js';

function parseOptionSymbol(symbol) {
  const m = String(symbol).toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { underlying: m[1], expiration: m[2], type: m[3], strike: m[4] };
}

function toPolygonOptionSymbol(symbol) {
  const p = parseOptionSymbol(symbol);
  if (!p) return '';
  const strikeInt = Math.round(parseFloat(p.strike) * 1000);
  return `O:${p.underlying}${p.expiration}${p.type}${String(strikeInt).padStart(8, '0')}`;
}

async function fetchJson(url, headers = {}, options = {}) {
  return fetchQuoteResource(url, { headers, ...options });
}

const newYorkClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function easternClock(now) {
  const clock = Object.fromEntries(newYorkClock.formatToParts(now).map(part => [part.type, part.value]));
  return { weekday: clock.weekday, minute: Number(clock.hour) * 60 + Number(clock.minute), date: `${clock.year}-${clock.month}-${clock.day}` };
}

function extendedWindow(session) {
  const noon = Date.parse(session.date + 'T12:00:00Z');
  const midnight = noon - easternClock(new Date(noon)).minute * 60000;
  const minutes = { premarket: [240, 570], afterhours: [960, 1200], overnight: [1200, 1680] }[session.kind];
  return minutes.map(minute => midnight + minute * 60000);
}

function usExtendedSession(now) {
  const { weekday, minute, date } = easternClock(now);
  const workday = weekday !== 'Sat' && weekday !== 'Sun';
  if (workday && minute >= 960 && minute < 1200) return { date, minute, kind: 'afterhours' };
  if ((minute >= 1200 && weekday !== 'Fri' && weekday !== 'Sat') || (minute < 240 && workday)) {
    const evening = minute >= 1200 ? date : ymdUTC(Date.parse(date) - 86400000);
    return { date: evening, minute, kind: 'overnight' };
  }
  return workday && minute >= 240 && minute < 570 ? { date, minute, kind: 'premarket' } : null;
}

const nasdaqHeaders = {
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
  'User-Agent': 'Mozilla/5.0'
};
const extendedRequest = { retries: 0, timeoutMs: 5000 };
const quoteNumber = value => {
  const raw = String(value ?? '').replace(/[$,%+,]/g, '').trim();
  return raw ? Number(raw) : NaN;
};

function extendedMovement(quote, baseline, sessionClose = baseline) {
  const change = baseline > 0 ? quote.price - baseline : null;
  return {
    ...quote, change, changePercent: change == null ? null : change / baseline * 100,
    prevClose: baseline ?? null,
    sessionChangePercent: sessionClose > 0 ? (quote.price / sessionClose - 1) * 100 : null
  };
}

function regularMovementFallback(quote, session, label) {
  if (quote.regularSessionDate === session.date && quote.prevClose > 0) {
    return { ...extendedMovement(quote, quote.prevClose, null), session: label };
  }
  return { ...quote, change: null, changePercent: null, session: label };
}

function validPremarketTimestamp(timestamp, session) {
  const match = String(timestamp || '').match(/^([A-Za-z]{3} \d{1,2}, \d{4}) (\d{1,2}):(\d{2}) (AM|PM) ET$/);
  if (!match || match[4] !== 'AM') return false;
  const date = new Date(match[1] + ' GMT');
  const hour = Number(match[2]);
  const minutes = Number(match[3]);
  const minute = hour * 60 + minutes;
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === session.date
    && minutes < 60 && minute >= 240 && minute <= session.minute;
}

async function fetchText(url, headers = {}, encoding = 'utf-8') {
  return fetchQuoteResource(url, { headers, encoding, json: false });
}

function ymdUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function ymdDaysAgo(days, endTimestamp = Date.now()) {
  return ymdUTC(endTimestamp - days * 86400000);
}

const COMMON_SPLIT_RATIOS = [1.5, 2, 3, 4, 5, 7, 8, 10, 20, 25, 50, 100];

function splitPriceFactor(priceRatio) {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return 1;
  let best = { factor: 1, error: Infinity };
  for (const ratio of COMMON_SPLIT_RATIOS) {
    for (const factor of [ratio, 1 / ratio]) {
      const error = Math.abs(priceRatio / factor - 1);
      if (error < best.error) best = { factor, error };
    }
  }
  return best.error <= 0.12 ? best.factor : 1;
}

export function adjustCandlesForSplits(candles) {
  const raw = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({ ...candle }))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const adjusted = new Array(raw.length);
  let cumulativeFactor = 1;
  let splitCount = 0;
  for (let index = raw.length - 1; index >= 0; index--) {
    if (index < raw.length - 1) {
      const transition = Number(raw[index + 1].close) / Number(raw[index].close);
      const factor = splitPriceFactor(transition);
      if (factor !== 1) {
        cumulativeFactor *= factor;
        splitCount += 1;
      }
    }
    adjusted[index] = {
      ...raw[index],
      open: Number(raw[index].open) * cumulativeFactor,
      high: Number(raw[index].high) * cumulativeFactor,
      low: Number(raw[index].low) * cumulativeFactor,
      close: Number(raw[index].close) * cumulativeFactor,
      volume: cumulativeFactor ? (Number(raw[index].volume) || 0) / cumulativeFactor : Number(raw[index].volume) || 0
    };
  }
  return { candles: adjusted, splitCount };
}

export function createQuoteService(config) {
  const finnhubKey = config.finnhubApiKey;
  const polygonKey = config.polygonApiKey;
  const stockHistoryCache = new Map();
  const stockHistoryCacheMs = 5 * 60 * 1000;

  if (!finnhubKey) {
    console.warn('stock-manage: finnhubApiKey 未配置，美股行情将回退 Yahoo 延时行情');
  }
  if (!polygonKey) {
    console.warn('stock-manage: polygonApiKey 未配置，期权行情不可用');
  }

  async function getStockFromFinnhub(symbol) {
    if (!finnhubKey) throw new Error('未配置 Finnhub API Key');
    const sym = String(symbol).toUpperCase();
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`;
    let q;
    try {
      q = await fetchJson(url);
    } catch (e) {
      throw new Error(`Finnhub ${e.message}`);
    }
    if (q.error) throw new Error(String(q.error));
    if (!q.c && q.c !== 0) throw new Error('无效代码或无行情');
    if (q.c === 0 && q.pc === 0) throw new Error('无效代码或无行情');
    const clock = Number(q.t) > 0 ? easternClock(new Date(Number(q.t) * 1000)) : null;
    const regular = clock && clock.minute >= 570 && clock.minute <= 960;
    return {
      symbol: sym,
      name: sym,
      price: q.c,
      change: q.d ?? 0,
      changePercent: q.dp ?? 0,
      ...(Number(q.pc) > 0 ? { prevClose: Number(q.pc) } : {}),
      ...(regular ? { regularSessionDate: clock.date,
        asOf: `${clock.date} ${String(Math.floor(clock.minute / 60)).padStart(2, '0')}:${String(clock.minute % 60).padStart(2, '0')} ET` } : {}),
      currency: 'USD',
      source: 'finnhub'
    };
  }

  async function getStockHistoryFromPolygon(symbol, days, endTimestamp = Date.now()) {
    if (!polygonKey) throw new Error('未配置 Polygon API Key');
    const url =
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}` +
      `/range/1/day/${ymdDaysAgo(days, endTimestamp)}/${ymdUTC(endTimestamp)}` +
      `?adjusted=true&sort=asc&limit=50000&apiKey=${polygonKey}`;
    let data;
    try {
      data = await fetchJson(url, {}, { retries: 0 });
    } catch (e) {
      throw new Error(`Polygon ${e.message}`);
    }
    if (!Array.isArray(data.results)) {
      throw new Error(data.error || data.message || 'Polygon 无历史行情');
    }
    const candles = data.results
      .map((bar) => ({
        timestamp: Number(bar.t),
        open: Number(bar.o),
        high: Number(bar.h),
        low: Number(bar.l),
        close: Number(bar.c),
        volume: Number(bar.v) || 0
      }))
      .filter((bar) => [bar.timestamp, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (!candles.length) throw new Error('Polygon 无历史行情');
    return { candles, source: 'polygon', adjustedForSplits: true };
  }

  async function getStockHistoryFromYahoo(symbol, days, endTimestamp = Date.now()) {
    const period1 = Math.floor((endTimestamp - days * 86400000) / 1000);
    const period2 = Math.floor(endTimestamp / 1000) + 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?period1=${period1}&period2=${period2}&interval=1d&events=splits`;
    let data;
    try {
      data = await fetchJson(url, { 'User-Agent': 'Mozilla/5.0' });
    } catch (e) {
      throw new Error(`Yahoo ${e.message}`);
    }
    const error = data?.chart?.error;
    if (error) throw new Error(error.description || error.code || 'Yahoo 无历史行情');
    const result = data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!Array.isArray(result?.timestamp) || !quote) throw new Error('Yahoo 无历史行情');
    const candles = result.timestamp.map((timestamp, index) => ({
      timestamp: Number(timestamp) * 1000,
      open: Number(quote.open?.[index]),
      high: Number(quote.high?.[index]),
      low: Number(quote.low?.[index]),
      close: Number(quote.close?.[index]),
      volume: Number(quote.volume?.[index]) || 0
    })).filter((bar) => [bar.timestamp, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
    if (!candles.length) throw new Error('Yahoo 无历史行情');
    return {
      candles: candles.sort((a, b) => a.timestamp - b.timestamp),
      source: 'yahoo',
      adjustedForSplits: true,
      splitCount: Object.keys(result.events?.splits || {}).length
    };
  }

  async function getStockHistoryFromSina(symbol, days, endTimestamp = Date.now()) {
    const url =
      'https://stock.finance.sina.com.cn/usstock/api/json.php/' +
      `US_MinKService.getDailyK?symbol=${encodeURIComponent(symbol)}&___qn=3`;
    let data;
    try {
      data = await fetchJson(url, {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.sina.com.cn/'
      });
    } catch (e) {
      throw new Error(`新浪财经 ${e.message}`);
    }
    const rows = Array.isArray(data) ? data : data?.result?.data;
    if (!Array.isArray(rows)) throw new Error('新浪财经无历史行情');
    const from = endTimestamp - days * 86400000;
    const rawCandles = rows
      .map((row) => ({
        timestamp: Date.parse(`${row.d}T00:00:00Z`),
        open: Number(row.o),
        high: Number(row.h),
        low: Number(row.l),
        close: Number(row.c),
        volume: Number(row.v) || 0
      }))
      .filter((bar) => [bar.timestamp, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
      .sort((a, b) => a.timestamp - b.timestamp);
    const normalized = adjustCandlesForSplits(rawCandles);
    const candles = normalized.candles.filter((bar) => bar.timestamp >= from && bar.timestamp <= endTimestamp);
    if (!candles.length) throw new Error('新浪财经无历史行情');
    return { candles, source: 'sina', adjustedForSplits: true, splitCount: normalized.splitCount };
  }

  async function getStockHistoryFromFinnhub(symbol, days, endTimestamp = Date.now()) {
    if (!finnhubKey) throw new Error('未配置 Finnhub API Key');
    const to = Math.floor(endTimestamp / 1000);
    const from = to - Math.round(days * 86400);
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${finnhubKey}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      throw new Error(`Finnhub ${e.message}`);
    }
    if (data.error) throw new Error(String(data.error));
    if (data.s !== 'ok' || !Array.isArray(data.t)) throw new Error('Finnhub 无历史行情');
    const candles = data.t.map((timestamp, index) => ({
      timestamp: Number(timestamp) * 1000,
      open: Number(data.o?.[index]),
      high: Number(data.h?.[index]),
      low: Number(data.l?.[index]),
      close: Number(data.c?.[index]),
      volume: Number(data.v?.[index]) || 0
    })).filter((bar) => [bar.timestamp, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
    if (!candles.length) throw new Error('Finnhub 无历史行情');
    const normalized = adjustCandlesForSplits(candles);
    return { candles: normalized.candles, source: 'finnhub', adjustedForSplits: true, splitCount: normalized.splitCount };
  }

  async function getStockHistory(symbol, options = {}) {
    const sym = normalizeSymbol(symbol);
    if (!sym || isAShareSymbol(sym) || hkCode(sym) || parseOptionSymbol(sym)) {
      throw new Error('历史量化行情当前仅支持美股正股');
    }
    const days = Math.min(2190, Math.max(90, Number(options.days) || 365));
    const requestedEnd = Number(options.endTimestamp);
    const endTimestamp = Number.isFinite(requestedEnd)
      ? Math.min(Date.now(), Math.max(Date.UTC(1990, 0, 1), requestedEnd))
      : Date.now();
    const endDay = ymdUTC(endTimestamp);
    const cacheKey = `${sym}:${days}:${endDay}`;
    const cached = stockHistoryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < stockHistoryCacheMs) return cached.value;
    const errors = [];
    let bestPartial = null;
    const requestedStart = endTimestamp - days * 86400000;
    const coverageTolerance = Math.max(45, Math.round(days * 0.05)) * 86400000;
    for (const [provider, loader, enabled] of [
      ['Polygon', getStockHistoryFromPolygon, polygonKey],
      ['Yahoo', getStockHistoryFromYahoo, true],
      ['新浪财经', getStockHistoryFromSina, true],
      ['Finnhub', getStockHistoryFromFinnhub, finnhubKey]
    ]) {
      if (!enabled) {
        errors.push(`${provider}: 未配置 API Key`);
        continue;
      }
      try {
        const value = await loader(sym, days, endTimestamp);
        const firstTimestamp = Number(value.candles[0]?.timestamp);
        const coversRange = value.candles.length < 30
          || firstTimestamp <= requestedStart + coverageTolerance;
        if (coversRange) {
          stockHistoryCache.set(cacheKey, { value, at: Date.now() });
          return value;
        }
        errors.push(`${provider}: 仅返回 ${value.candles.length} 根，未覆盖请求区间`);
        if (!bestPartial || firstTimestamp < Number(bestPartial.candles[0]?.timestamp)) {
          bestPartial = value;
        }
      } catch (e) {
        errors.push(`${provider}: ${e.message}`);
      }
    }
    if (bestPartial) {
      stockHistoryCache.set(cacheKey, { value: bestPartial, at: Date.now() });
      return bestPartial;
    }
    throw new Error(`历史行情不可用（${errors.join('; ')}）`);
  }

  async function getYahooQuote(symbol, expectedCurrency) {
    const sym = String(symbol).toUpperCase();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const data = await fetchJson(url, { 'User-Agent': 'Mozilla/5.0' });
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (expectedCurrency && meta?.currency !== expectedCurrency) throw new Error('Yahoo 报价币种不匹配');
    const price = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Yahoo 无有效价');
    const prev = Number(meta?.chartPreviousClose || meta?.previousClose) || price;
    return {
      symbol: sym,
      price,
      name: meta?.longName || meta?.shortName || sym,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      prevClose: prev,
      currency: expectedCurrency || 'USD',
      source: 'yahoo',
      delayed: true
    };
  }

  async function getNasdaqQuote(symbol, premarket, assetClass = 'stocks') {
    const sym = String(symbol).toUpperCase();
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=${assetClass}`;
    const data = await fetchJson(url, nasdaqHeaders, premarket ? extendedRequest : {});
    if (assetClass === 'stocks' && data?.status?.bCodeMessage?.some?.(entry => Number(entry.code) === 1001)) {
      return getNasdaqQuote(sym, premarket, 'etf');
    }
    const quote = data?.data?.primaryData;
    const parseNumber = quoteNumber;
    const price = parseNumber(quote?.lastSalePrice);
    const change = parseNumber(quote?.netChange);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Nasdaq 无有效价');
    if (premarket && (data?.data?.marketStatus !== 'Pre-Market'
      || !validPremarketTimestamp(quote.lastTradeTimestamp, premarket)
      || !Number.isFinite(change) || !(price - change > 0))) throw new Error('Nasdaq 暂无当天盘前报价');
    const delta = Number.isFinite(change) ? change : 0;
    return {
      symbol: sym,
      name: data?.data?.companyName || sym,
      price,
      change: delta,
      changePercent: premarket ? delta / (price - delta) * 100
        : Number.isFinite(parseNumber(quote?.percentageChange)) ? parseNumber(quote?.percentageChange) : 0,
      prevClose: price - delta,
      currency: 'USD',
      source: 'nasdaq',
      delayed: premarket ? quote.isRealTime !== true : true,
      ...(premarket ? { session: 'premarket', asOf: quote.lastTradeTimestamp } : {})
    };
  }

  async function getNasdaqAfterHours(symbol, session, assetClass = 'stocks') {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/extended-trading?assetclass=${assetClass}&markettype=post`;
    const result = await fetchJson(url, nasdaqHeaders, extendedRequest);
    const data = result?.data;
    if (!data?.tradeDetailTable?.rows?.length && assetClass === 'stocks') {
      return getNasdaqAfterHours(symbol, session, 'etf');
    }
    const stamp = data?.lastUpdateInfo?.map(line => line.match(/([A-Za-z]{3} \d{1,2}, \d{4}) \d{1,2}:\d{2} [AP]M ET/))
      .find(Boolean);
    const date = stamp ? Date.parse(stamp[1] + ' GMT') : NaN;
    const trade = data?.tradeDetailTable?.rows?.[0];
    const time = String(trade?.time || '').match(/^(\d{2}):([0-5]\d):([0-5]\d)$/);
    const minute = time ? Number(time[1]) * 60 + Number(time[2]) : NaN;
    const price = quoteNumber(trade?.price);
    if (!Number.isFinite(date) || ymdUTC(date) !== session.date || !(minute >= 960 && minute < 1200 && minute <= session.minute)
      || !(price > 0)) throw new Error('Nasdaq 暂无当天盘后成交');
    return { symbol, price, assetClass, currency: 'USD', source: 'nasdaq', delayed: true,
      session: 'afterhours', asOf: `${session.date} ${trade.time} ET` };
  }

  async function getRegularCloses(symbol, throughDate, assetClass = 'stocks') {
    const fromDate = ymdUTC(Date.parse(throughDate) - 10 * 86400000);
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetClass}&fromdate=${fromDate}&todate=${throughDate}&limit=10`;
    const data = await fetchJson(url, nasdaqHeaders, extendedRequest);
    const rows = data?.data?.tradesTable?.rows;
    if (!rows?.length && assetClass === 'stocks') return getRegularCloses(symbol, throughDate, 'etf');
    return (rows || []).flatMap(row => {
      const date = String(row.date || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return date ? [{ date: `${date[3]}-${date[1]}-${date[2]}`, price: quoteNumber(row.close) }] : [];
    }).filter(row => row.date >= fromDate && row.date <= throughDate && row.price > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async function getAfterHoursWithMovement(symbol, session, now) {
    let quote, assetClass;
    try {
      ({ assetClass, ...quote } = await getNasdaqAfterHours(symbol, session));
    } catch {
      quote = await getAlpacaExtended(symbol, session, now);
    }
    // The extended-trading "Market Close" caption can lag by one session.
    const closes = await getRegularCloses(symbol, session.date, assetClass).catch(() => []);
    return applyExtendedBaseline(symbol, quote, session, closes);
  }

  async function applyExtendedBaseline(symbol, quote, session, closes) {
    const sameDay = closes.find(row => row.date === session.date)?.price;
    const previous = closes.find(row => row.date < session.date)?.price;
    if (session.kind === 'premarket') return extendedMovement(quote, previous);
    if (session.kind === 'overnight' ? sameDay : sameDay && previous) {
      return extendedMovement(quote, session.kind === 'overnight' ? sameDay : previous, sameDay);
    }
    const regular = await getStockFromFinnhub(symbol).catch(() => null);
    const verified = regular?.regularSessionDate === session.date ? regular : null;
    const close = sameDay ?? verified?.price;
    const base = session.kind === 'overnight' ? close : previous ?? verified?.prevClose;
    return extendedMovement(quote, base, close ?? null);
  }

  const extendedCache = new Map();
  async function getAlpacaExtended(symbol, session, now) {
    if (!config.alpacaApiKeyId || !config.alpacaApiSecretKey) throw new Error('未配置 Alpaca 行情');
    const night = session.kind === 'overnight';
    const feed = night ? (config.alpacaOvernightFeed === 'boats' ? 'boats' : 'overnight') : 'delayed_sip';
    const [start, end] = extendedWindow(session);
    const headers = {
      'APCA-API-KEY-ID': config.alpacaApiKeyId,
      'APCA-API-SECRET-KEY': config.alpacaApiSecretKey
    };
    const cacheKey = `${symbol}:${session.kind}`;
    const cached = extendedCache.get(cacheKey);
    const cutoff = now.getTime();
    const read = (raw, source) => {
      const at = Date.parse(raw?.t);
      const price = Number(raw?.p ?? raw?.c);
      if (!Number.isFinite(price) || !(price > 0) || !(at >= start && at < end && at <= cutoff)) {
        throw new Error('Alpaca 暂无对应时段的有效成交');
      }
      const { date, minute } = easternClock(new Date(at));
      const hhmm = [Math.floor(minute / 60), minute % 60].map(part => String(part).padStart(2, '0')).join(':');
      const delayed = feed !== 'boats' || source === 'alpaca-minute-bar';
      return { at, quote: { symbol, price, currency: 'USD', source, delayed,
        session: session.kind, asOf: `${date} ${hhmm} ET` } };
    };
    const params = new URLSearchParams({ symbols: symbol, feed });
    let result;
    try {
      const data = await fetchJson(`https://data.alpaca.markets/v2/stocks/trades/latest?${params}`, headers, extendedRequest);
      result = read(data?.trades?.[symbol], 'alpaca');
    } catch (error) {
      try {
        // A complete delayed minute must end before the subscription's 15-minute cutoff.
        const lastMinute = Math.min(end - 60000, Math.floor(cutoff / 60000) * 60000 - 16 * 60000);
        if (lastMinute < start) throw error;
        const query = new URLSearchParams({ feed: night ? 'boats' : 'sip', timeframe: '1Min', limit: '1', sort: 'desc',
          start: new Date(start).toISOString(), end: new Date(lastMinute).toISOString() });
        const data = await fetchJson(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${query}`, headers, extendedRequest);
        const bar = data?.bars?.[0];
        if (!(Date.parse(bar?.t) <= lastMinute)) throw error;
        result = read(bar, 'alpaca-minute-bar');
      } catch {
        if (cached?.date === session.date && cached.at <= cutoff && Date.now() - cached.fetchedAt < 5 * 60000) {
          return { ...cached.quote, delayed: true };
        }
        throw error;
      }
    }
    if (cached?.date === session.date && cached.at <= cutoff && cached.at > result.at) return { ...cached.quote, delayed: true };
    if (extendedCache.size >= 150 && !extendedCache.has(cacheKey)) extendedCache.delete(extendedCache.keys().next().value);
    extendedCache.set(cacheKey, { ...result, date: session.date, fetchedAt: Date.now() });
    return result.quote;
  }

  async function getUsStockQuote(symbol) {
    const sym = String(symbol).toUpperCase();
    const errors = [];
    if (finnhubKey) {
      try {
        return await getStockFromFinnhub(sym);
      } catch (e) {
        errors.push(`Finnhub: ${e.message}`);
      }
    } else {
      errors.push('Finnhub: 未配置 API Key');
    }
    try {
      return await getYahooQuote(sym);
    } catch (e) {
      errors.push(`Yahoo: ${e.message}`);
    }
    try {
      return await getNasdaqQuote(sym);
    } catch (e) {
      errors.push(`Nasdaq: ${e.message}`);
    }
    throw new Error(`${sym} 行情不可用（${errors.join('; ')}）`);
  }

  async function getAShareFromTencent(code) {
    const ex = ashareExchange(code);
    // 腾讯行情正文为 GBK
    const text = await fetchText(`https://qt.gtimg.cn/q=${ex}${code}`, {
      'User-Agent': 'Mozilla/5.0'
    }, 'gbk');
    const m = text.match(/="([^"]*)"/);
    if (!m) throw new Error('腾讯无行情');
    const parts = m[1].split('~');
    const price = Number(parts[3]);
    const prev = Number(parts[4]) || price;
    if (!Number.isFinite(price) || price <= 0) throw new Error('腾讯无有效价');
    const fundType = parts[61];
    const reference = Number(parts[fundType === 'LOF' ? 81 : 78]);
    const stamp = parts[30]?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    const time = stamp ? Date.parse(`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}+08:00`) : NaN;
    return {
      symbol: code,
      name: parts[1] || code,
      price,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      prevClose: prev,
      currency: 'CNY',
      source: 'tencent',
      ...(['ETF', 'LOF'].includes(fundType) && Number.isFinite(reference) && reference > 0 ? {
        etfPremiumPct: (price / reference - 1) * 100,
        fundPremiumBasis: fundType === 'LOF' ? '单位净值' : 'IOPV',
        etfPremiumAsOf: Number.isFinite(time) ? new Date(time).toISOString() : null
      } : {})
    };
  }

  async function getAShareFromSina(code) {
    const ex = ashareExchange(code);
    // 新浪 hq.sinajs.cn 正文为 GBK
    const text = await fetchText(`https://hq.sinajs.cn/list=${ex}${code}`, {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://finance.sina.com.cn'
    }, 'gbk');
    const m = text.match(/="([^"]*)"/);
    if (!m || !m[1]) throw new Error('新浪无行情');
    const parts = m[1].split(',');
    const price = Number(parts[3]);
    const prev = Number(parts[2]) || price;
    if (!Number.isFinite(price) || price <= 0) throw new Error('新浪无有效价');
    return {
      symbol: code,
      name: parts[0] || code,
      price,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      prevClose: prev,
      currency: 'CNY',
      source: 'sina'
    };
  }

  async function getAShareFromEastMoney(code) {
    const ex = ashareExchange(code);
    const secid = `${ex === 'sh' ? 1 : 0}.${code}`;
    const url = `https://push2.eastmoney.com/api/qt/stock/get?invt=2&fltt=2&fields=f43,f44,f45,f46,f57,f58,f60,f169,f170&secid=${secid}`;
    const data = await fetchJson(url, {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://quote.eastmoney.com/'
    });
    const d = data?.data;
    const price = Number(d?.f43);
    if (!Number.isFinite(price) || price <= 0) throw new Error('东方财富无行情');
    const prev = Number(d?.f60) || price;
    const change = Number.isFinite(Number(d?.f169)) ? Number(d.f169) : price - prev;
    const changePercent = Number.isFinite(Number(d?.f170))
      ? Number(d.f170)
      : (prev ? ((price - prev) / prev) * 100 : 0);
    return {
      symbol: code,
      name: d?.f58 || code,
      price,
      change,
      changePercent,
      prevClose: prev,
      currency: 'CNY',
      source: 'eastmoney'
    };
  }

  async function getAShareQuote(symbol) {
    const code = ashareCode(symbol);
    if (!code) throw new Error('无效 A 股代码');
    const errors = [];
    for (const [label, fn] of [
      ['腾讯', getAShareFromTencent],
      ['新浪', getAShareFromSina],
      ['东方财富', getAShareFromEastMoney]
    ]) {
      try {
        return await fn(code);
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
      }
    }
    try {
      const ex = ashareExchange(code);
      const yahooSym = `${code}.${ex === 'sh' ? 'SS' : 'SZ'}`;
      const q = await getYahooQuote(yahooSym);
      return {
        symbol: code,
        name: q.name || code,
        price: q.price,
        change: q.change,
        changePercent: q.changePercent,
        prevClose: q.prevClose,
        currency: 'CNY',
        source: 'yahoo'
      };
    } catch (e) {
      errors.push(`Yahoo: ${e.message}`);
      throw new Error(`${code} 不可用（${errors.join('; ')}）`);
    }
  }

  const foreignExchange = createForeignExchangeService({ finnhubApiKey: finnhubKey, yahooQuote: getYahooQuote });

  async function getUsdCny() {
    return foreignExchange.getRate('USD');
  }

  async function getUsdHkd() {
    const { quotes } = await foreignExchange.getRates(['USD', 'HKD']);
    if (!quotes.USD || !quotes.HKD || quotes.USD.stale || quotes.HKD.stale) throw new Error('USD/HKD 汇率不可用');
    return { rate: quotes.USD.rate / quotes.HKD.rate };
  }

  async function getHongKongQuote(code) {
    const symbol = `${code}.HK`;
    try {
      const body = await fetchText(`https://qt.gtimg.cn/q=hk${code}`, { 'User-Agent': 'Mozilla/5.0' }, 'gbk');
      const parts = body.match(/="([^"]*)"/)?.[1].split('~') || [];
      const price = Number(parts[3]);
      const prevClose = Number(parts[4]);
      if (parts[2] !== code || !parts.includes('HKD') || !(price > 0) || !(prevClose > 0)) throw new Error('腾讯无有效港币报价');
      const stamp = parts[30]?.replace(/\//g, '-').replace(' ', 'T');
      const time = Date.parse(`${stamp}+08:00`);
      return { symbol, name: parts[1] || symbol, price, prevClose, change: price - prevClose,
        changePercent: (price / prevClose - 1) * 100, currency: 'HKD', source: 'tencent',
        asOf: Number.isFinite(time) ? new Date(time).toISOString() : null };
    } catch {
      const yahooSymbol = `${String(Number(code)).padStart(4, '0')}.HK`;
      return { ...await getYahooQuote(yahooSymbol, 'HKD'), symbol };
    }
  }

  async function getStock(symbol) {
    if (hkCode(symbol)) return getHongKongQuote(hkCode(symbol));
    if (isAShareSymbol(symbol)) return getAShareQuote(symbol);
    return getUsStockQuote(symbol);
  }

  function pickOptionPrice(snap) {
    const lastTrade = snap?.last_trade || {};
    const lastQuote = snap?.last_quote || {};
    const day = snap?.day || {};
    if (Number.isFinite(lastTrade.price) && lastTrade.price > 0) return Number(lastTrade.price);
    if (Number.isFinite(lastQuote.midpoint) && lastQuote.midpoint > 0) return Number(lastQuote.midpoint);
    const bid = Number(lastQuote.bid);
    const ask = Number(lastQuote.ask);
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    if (Number.isFinite(day.close) && day.close > 0) return Number(day.close);
    return 0;
  }

  async function getOptionDailyBars(polygonSymbol) {
    const url =
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(polygonSymbol)}` +
      `/range/1/day/${ymdDaysAgo(25)}/${ymdUTC(Date.now())}` +
      `?adjusted=true&sort=asc&limit=30&apiKey=${polygonKey}`;
    const data = await fetchJson(url);
    return Array.isArray(data.results) ? data.results : [];
  }

  async function getOptionFromSnapshot(polygonSymbol, underlying) {
    const snapUrl =
      `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(underlying)}/` +
      `${encodeURIComponent(polygonSymbol)}?apiKey=${polygonKey}`;
    const data = await fetchJson(snapUrl);
    const snap = data?.results;
    if (!snap) throw new Error(data?.error || data?.message || '无快照');
    const price = pickOptionPrice(snap);
    if (!(price > 0)) throw new Error('快照无有效价格');
    const day = snap.day || {};
    let prevClose = Number(day.previous_close) || Number(snap.prev_day?.close) || 0;
    let change = Number(day.change);
    let changePercent = Number(day.change_percent);
    if (!(prevClose > 0)) {
      try {
        const bars = await getOptionDailyBars(polygonSymbol);
        if (bars.length >= 2) prevClose = Number(bars[bars.length - 2].c) || 0;
        else if (bars.length === 1) prevClose = Number(bars[0].o) || 0;
      } catch {
        /* ignore */
      }
    }
    if (prevClose > 0 && (!Number.isFinite(change) || (Math.abs(change) < 1e-12 && Math.abs(price - prevClose) > 1e-9))) {
      change = price - prevClose;
      changePercent = (change / prevClose) * 100;
    }
    if (!Number.isFinite(change)) change = 0;
    if (!Number.isFinite(changePercent)) changePercent = 0;
    const details = snap.details || {};
    return {
      price,
      change,
      changePercent,
      prevClose: prevClose || undefined,
      delayed: false,
      source: 'polygon-snapshot',
      asOf: null,
      details
    };
  }

  async function getOptionFromDailyBars(polygonSymbol) {
    const bars = await getOptionDailyBars(polygonSymbol);
    if (!bars.length) throw new Error('无日线数据');
    const last = bars[bars.length - 1];
    const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
    const price = Number(last.c) || Number(last.vw) || 0;
    if (!(price > 0)) throw new Error('日线无有效收盘价');
    let prevClose = prev ? Number(prev.c) || 0 : 0;
    if (!(prevClose > 0)) prevClose = Number(last.o) || 0;
    const change = prevClose > 0 ? price - prevClose : 0;
    const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
    return {
      price,
      change,
      changePercent,
      prevClose: prevClose || undefined,
      delayed: true,
      source: 'polygon-daily-delayed',
      asOf: last.t ? ymdUTC(last.t) : null,
      details: null
    };
  }

  let cboeOptionCache = null;
  let cboeOptionPending = null;
  async function getCboeOption(upper, parsed) {
    if (parsed.underlying !== 'QQQ') throw new Error('Cboe 备用期权行情目前仅支持 QQQ');
    if (!cboeOptionCache || Date.now() - cboeOptionCache.at >= 60000) {
      if (!cboeOptionPending) cboeOptionPending = (async () => {
        const data = await fetchJson('https://cdn.cboe.com/api/global/delayed_quotes/options/QQQ.json');
        const asOf = cboeUtcTimestampToIso(data?.timestamp);
        if (!asOf) throw new Error('Cboe 行情缺少有效报价时间');
        const prices = new Map((data?.data?.options || []).map(row => [row.option, {
          bid: row.bid, ask: row.ask, prevClose: row.prev_day_close
        }]));
        cboeOptionCache = { at: Date.now(), asOf, prices };
      })().finally(() => { cboeOptionPending = null; });
      await cboeOptionPending;
    }
    const row = cboeOptionCache.prices.get(toPolygonOptionSymbol(upper).slice(2));
    if (!row) throw new Error(`Cboe 未找到合约 ${upper}`);
    const bid = row.bid == null ? NaN : Number(row.bid);
    const ask = row.ask == null ? NaN : Number(row.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask < bid || !(ask > 0)) throw new Error(`Cboe 合约 ${upper} 无有效买卖报价`);
    const price = (bid + ask) / 2;
    const prevClose = Number(row.prevClose) > 0 ? Number(row.prevClose) : undefined;
    return { price, prevClose, change: prevClose ? price - prevClose : 0,
      changePercent: prevClose ? (price / prevClose - 1) * 100 : 0,
      delayed: true, asOf: cboeOptionCache.asOf, source: 'cboe-delayed-midpoint', details: {} };
  }

  async function getOption(symbol) {
    const upper = String(symbol).toUpperCase();
    const parsed = parseOptionSymbol(upper);
    if (!parsed) throw new Error('期权代码格式错误');
    const polygonSymbol = toPolygonOptionSymbol(upper);

    let quote = null;
    let snapErr = null;
    try {
      if (!polygonKey) throw new Error('未配置 Polygon API Key');
      quote = await getOptionFromSnapshot(polygonSymbol, parsed.underlying);
    } catch (e) {
      snapErr = e;
      try {
        if (!polygonKey) throw new Error('未配置 Polygon API Key');
        quote = await getOptionFromDailyBars(polygonSymbol);
      } catch (e2) {
        try { quote = await getCboeOption(upper, parsed); }
        catch (fallback) { throw new Error(`期权行情不可用（Polygon: ${snapErr.message}; daily: ${e2.message}; Cboe: ${fallback.message}）`); }
      }
    }

    let name;
    const details = quote.details || {};
    if (details.expiration_date || details.strike_price) {
      name = `${parsed.underlying} ${details.expiration_date || parsed.expiration} ${details.contract_type || parsed.type} $${details.strike_price || parsed.strike}`;
    } else if (polygonKey && quote.source !== 'cboe-delayed-midpoint') {
      try {
        const contractUrl =
          `https://api.polygon.io/v3/reference/options/contracts/${encodeURIComponent(polygonSymbol)}` +
          `?apiKey=${polygonKey}`;
        const contractData = await fetchJson(contractUrl);
        const c = contractData?.results;
        if (!c) throw new Error('期权不存在或已过期');
        name = `${parsed.underlying} ${c.expiration_date} ${c.contract_type} $${c.strike_price}`;
      } catch {
        name = `${parsed.underlying} ${parsed.expiration} ${parsed.type} $${parsed.strike}`;
      }
    } else {
      name = `${parsed.underlying} ${parsed.expiration} ${parsed.type} $${parsed.strike}`;
    }

    return {
      symbol: upper,
      name,
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      prevClose: quote.prevClose,
      delayed: !!quote.delayed,
      asOf: quote.asOf || undefined,
      source: quote.source,
      currency: 'USD'
    };
  }

  function cboeUtcTimestampToIso(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!match) return null;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6]))).toISOString();
  }

  async function search(q) {
    const query = String(q || '').trim();
    if (query.length < 1) return [];
    if (hkCode(query)) {
      const symbol = normalizeSymbol(query);
      try { return [{ symbol, name: (await getHongKongQuote(hkCode(query))).name }]; }
      catch { return [{ symbol, name: symbol }]; }
    }
    if (isAShareSymbol(query)) {
      const code = ashareCode(query);
      try {
        const quote = await getAShareQuote(code);
        return [{ symbol: code, name: quote.name || code }];
      } catch {
        return [{ symbol: code, name: code }];
      }
    }
    if (!finnhubKey) return [];
    const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${finnhubKey}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch {
      return [];
    }
    return (data.result || [])
      .filter((r) => r.symbol && (!r.type || String(r.type).includes('Common') || r.type === 'ETP'))
      .slice(0, 12)
      .map((r) => ({ symbol: r.symbol, name: r.description || r.symbol }));
  }

  async function getQuote(symbol, now = new Date()) {
    const sym = normalizeSymbol(symbol);
    if (hongKongFundIsin(sym)) return getHkFundQuote(sym);
    const code = fundCode(sym);
    if (code) {
      const { nav, date, ...movement } = await getFundNav(code);
      return { symbol: sym, price: nav, asOf: date, ...movement, currency: 'CNY', source: 'eastmoney-fund-nav' };
    }
    if (/^[A-Z]+\d{6}[CP]\d/i.test(sym)) return getOption(sym);
    const session = !isAShareSymbol(sym) && !hkCode(sym) ? usExtendedSession(now) : null;
    if (!session) return getStock(sym);
    if (session.kind === 'afterhours') {
      try {
        return await getAfterHoursWithMovement(sym, session, now);
      } catch {
        return regularMovementFallback(await getStock(sym), session, 'no-afterhours');
      }
    }
    if (session.kind === 'overnight') {
      if (config.alpacaApiKeyId && config.alpacaApiSecretKey) {
        try {
          const quote = await getAlpacaExtended(sym, session, now);
          const closes = await getRegularCloses(sym, session.date).catch(() => []);
          return await applyExtendedBaseline(sym, quote, session, closes);
        } catch { /* Fall back to the previous session without labeling it as overnight. */ }
      }
      const post = await getAfterHoursWithMovement(sym, { ...session, minute: 1200, kind: 'afterhours' }, now).catch(() => null);
      if (post) return { ...post, session: 'no-overnight-afterhours' };
      return regularMovementFallback(await getStock(sym), session, 'no-overnight');
    }
    try {
      return await getNasdaqQuote(sym, session);
    } catch {
      const trade = await getAlpacaExtended(sym, session, now).catch(() => null);
      if (trade) {
        const closes = await getRegularCloses(sym, session.date).catch(() => []);
        return applyExtendedBaseline(sym, trade, session, closes);
      }
      const fallback = await getStock(sym);
      return { ...fallback, change: null, changePercent: null, session: 'no-premarket' };
    }
  }

  async function getInstrumentName(symbol) {
    const sym = normalizeSymbol(symbol);
    if (hongKongFundIsin(sym)) return hkFundInfo(sym)?.name || '';
    const code = fundCode(sym);
    if (code) return (await findMainlandInstruments(code)).fund?.name || '';
    const realName = (value) => {
      const name = String(value || '').trim();
      return name && name.toUpperCase() !== sym ? name : '';
    };
    if (!isAShareSymbol(sym) && !hkCode(sym) && !parseOptionSymbol(sym)) {
      const matches = await search(sym);
      const match = matches.find((item) => normalizeSymbol(item.symbol) === sym);
      const name = realName(match?.name);
      if (name) return name;
      // Finnhub quote responses contain prices only; use company metadata.
      for (const provider of [getYahooQuote, getNasdaqQuote]) {
        try {
          const quote = await provider(sym);
          const resolved = realName(quote.name);
          if (resolved) return resolved;
        } catch { /* Try the next name provider. */ }
      }
      return '';
    }
    return realName((await getQuote(sym)).name);
  }

  return { getStock, getOption, getQuote, getInstrumentName, getStockHistory, getAShareQuote, getUsdCny, getUsdHkd, search };
}
