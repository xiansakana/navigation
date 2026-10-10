import { fetchQuoteResource } from '../../shared/quote-network.js';
const CANDLE_CACHE = new Map();
const QUOTE_CACHE = new Map();
const QUOTE_CACHE_MS = 30000;
const CNY_EQUITY_PROXY_SYMBOL = '159509';

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

async function fetchJson(url, headers = {}) {
  return fetchQuoteResource(url, { headers, rateLimitDelayMs: 2000 });
}

async function fetchText(url, headers = {}, encoding = 'utf-8') {
  // FRED's edge currently stalls Node/browser user agents from ECS, while its
  // CSV endpoint consistently serves curl-style clients. Limit this workaround
  // to FRED; keep the shared hard deadline and retries in place.
  const fredHeaders = new URL(url).hostname === 'fred.stlouisfed.org'
    ? { 'User-Agent': 'curl/8.5.0' } : {};
  return fetchQuoteResource(url, { headers: { ...fredHeaders, ...headers }, encoding, json: false });
}

function mapQuote(sym, q) {
  return {
    symbol: sym,
    price: q.c,
    change: q.d ?? 0,
    changePercent: q.dp ?? 0,
    high: q.h ?? q.c,
    low: q.l ?? q.c,
    open: q.o ?? q.c,
    prevClose: q.pc ?? q.c,
    close: q.c
  };
}

export function createQuoteService(config) {
  const finnhubKey = config.finnhubApiKey;
  const polygonKey = config.polygonApiKey;

  async function getStockFromFinnhub(sym) {
    if (!finnhubKey) throw new Error('未配置 Finnhub API Key');
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`;
    let q;
    try {
      q = await fetchJson(url);
    } catch (e) {
      throw new Error(e.message);
    }
    if (q.error) throw new Error(String(q.error));
    if (!q.c && q.c !== 0) throw new Error('无效代码或无行情');
    if (q.c === 0 && q.pc === 0) throw new Error('无效代码或无行情');
    return mapQuote(sym, q);
  }

  async function getStockFromPolygon(sym) {
    if (!polygonKey) throw new Error('未配置 Polygon API Key');
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?adjusted=true&apiKey=${polygonKey}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      throw new Error(`Polygon ${e.message}`);
    }
    const r = data?.results?.[0];
    if (!r?.c) throw new Error(`无行情 ${sym}`);
    const price = r.c;
    const prev = r.o ?? price;
    return {
      symbol: sym,
      price,
      close: price,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      high: r.h ?? price,
      low: r.l ?? price,
      open: r.o ?? price,
      prevClose: prev
    };
  }

  async function getStock(symbol) {
    const sym = String(symbol).toUpperCase();
    const cached = QUOTE_CACHE.get(sym);
    if (cached && Date.now() - cached.at < QUOTE_CACHE_MS) return cached.quote;

    let quote;
    if (finnhubKey) {
      try {
        quote = await getStockFromFinnhub(sym);
      } catch (e) {
        if (!polygonKey) throw new Error(`Finnhub ${e.message}`);
        try {
          quote = await getStockFromPolygon(sym);
        } catch (e2) {
          throw new Error(`Finnhub ${e.message}; ${e2.message}`);
        }
      }
    } else if (polygonKey) {
      quote = await getStockFromPolygon(sym);
    } else {
      throw new Error('未配置行情 API Key');
    }
    QUOTE_CACHE.set(sym, { at: Date.now(), quote });
    return quote;
  }

  async function getCandlesFromPolygon(symbol, days = 90) {
    if (!polygonKey) throw new Error('未配置 Polygon API Key');
    const sym = String(symbol).toUpperCase();
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&limit=${days}&apiKey=${polygonKey}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      throw new Error(`Polygon K线 ${e.message}`);
    }
    const rows = data?.results;
    if (!Array.isArray(rows) || !rows.length) {
      throw new Error(`无日线 ${sym}`);
    }
    return rows.map((r) => ({
      t: Math.floor(r.t / 1000),
      o: r.o,
      h: r.h,
      l: r.l,
      c: r.c,
      v: r.v
    }));
  }

  async function getCandlesFromFinnhub(symbol, days = 90) {
    if (!finnhubKey) throw new Error('未配置 Finnhub API Key');
    const sym = String(symbol).toUpperCase();
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=D&from=${from}&to=${to}&token=${finnhubKey}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      throw new Error(`Finnhub K线 ${e.message}`);
    }
    if (data.s !== 'ok' || !Array.isArray(data.t)) {
      throw new Error(`无日线 ${sym}`);
    }
    return data.t.map((t, i) => ({
      t,
      o: data.o[i],
      h: data.h[i],
      l: data.l[i],
      c: data.c[i],
      v: data.v?.[i]
    }));
  }

  async function getCandles(symbol, days = 90) {
    const sym = String(symbol).toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `${sym}:${days}`;
    const cached = CANDLE_CACHE.get(cacheKey);
    if (cached?.date === today) return cached.candles;

    let candles;
    if (polygonKey) {
      candles = await getCandlesFromPolygon(sym, days);
    } else {
      candles = await getCandlesFromFinnhub(sym, days);
    }
    CANDLE_CACHE.set(cacheKey, { date: today, candles });
    return candles;
  }

  async function getYahooQuote(yahooSymbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;
    const data = await fetchJson(url, { 'User-Agent': 'Mozilla/5.0' });
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice) throw new Error('Yahoo 无行情');
    const closes = result.indicators?.quote?.[0]?.close || [];
    const last = closes.filter((x) => x != null).pop();
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || last;
    return {
      symbol: yahooSymbol,
      price,
      close: price,
      prevClose: prev,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      high: meta.regularMarketDayHigh || price,
      low: meta.regularMarketDayLow || price
    };
  }

  async function getVxnFromFred() {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const text = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=VXNCLS&cosd=${from}`);
    const lines = text.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 1; i--) {
      const [date, raw] = lines[i].split(',');
      const price = Number(raw);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(price) && price > 0) {
        return {
          symbol: 'VXN',
          price,
          close: price,
          prevClose: price,
          change: 0,
          changePercent: 0,
          high: price,
          low: price,
          source: 'fred',
          asOf: date
        };
      }
    }
    throw new Error('无有效收盘数据');
  }

  let vxnCache = null;
  let vxnRetryAt = 0;
  let vxnFailure = '';

  async function getVxn(previous = null) {
    const now = Date.now();
    const fallback = vxnCache?.quote || previous;
    const fallbackDate = Date.parse(fallback?.asOf || fallback?.fetchedAt || '');
    const usableFallback = Number(fallback?.price) > 0 && Number.isFinite(fallbackDate)
      && fallbackDate <= now && now - fallbackDate <= 7 * 86400000;
    if (vxnCache && now - vxnCache.at < 60 * 60 * 1000) return vxnCache.quote;
    if (usableFallback && now < vxnRetryAt) {
      return { ...fallback, stale: true, warning: vxnFailure };
    }
    const remember = (quote) => {
      const observedAt = Date.parse(quote.asOf || new Date().toISOString());
      if (!Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > 7 * 86400000) {
        throw new Error('VXN 数据日期无效或已超过 7 天');
      }
      const value = { ...quote, fetchedAt: new Date().toISOString(), stale: false };
      vxnCache = { at: Date.now(), quote: value };
      vxnRetryAt = 0;
      vxnFailure = '';
      return value;
    };
    const errors = [];
    try {
      return remember(await getVxnFromFred());
    } catch (e) {
      errors.push(`FRED: ${e.message}`);
    }
    try {
      const q = await getYahooQuote('^VXN');
      return remember({ ...q, symbol: 'VXN', source: 'yahoo' });
    } catch (e) {
      errors.push(`Yahoo: ${e.message}`);
      vxnFailure = `VXN 不可用（${errors.join('; ')}）`;
      vxnRetryAt = Date.now() + 60000;
      if (usableFallback) return { ...fallback, stale: true, warning: vxnFailure };
      throw new Error(vxnFailure);
    }
  }

  async function getUsdCnyFromFred() {
    const text = await fetchText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXCHUS');
    const lines = text.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 1; i--) {
      const [date, raw] = lines[i].split(',');
      const rate = Number(raw);
      if (date && Number.isFinite(rate) && rate > 0) {
        return { rate, source: 'fred', asOf: date };
      }
    }
    throw new Error('无有效收盘数据');
  }

  let usdCnyCache = { rate: null, source: null, at: 0 };
  const USD_CNY_CACHE_MS = 60 * 1000;

  async function getUsdCny() {
    if (usdCnyCache.rate && Date.now() - usdCnyCache.at < USD_CNY_CACHE_MS) {
      return { rate: usdCnyCache.rate, source: usdCnyCache.source };
    }
    const errors = [];
    if (finnhubKey) {
      try {
        const url = `https://finnhub.io/api/v1/forex/rates?base=USD&token=${finnhubKey}`;
        const data = await fetchJson(url);
        const rate = data?.quote?.CNY || data?.quote?.CNH;
        if (rate) {
          const out = { rate: Number(rate), source: 'finnhub' };
          usdCnyCache = { rate: out.rate, source: out.source, at: Date.now() };
          return out;
        }
      } catch (e) {
        errors.push(`Finnhub: ${e.message}`);
      }
    }
    try {
      const fx = await getUsdCnyFromFred();
      usdCnyCache = { rate: fx.rate, source: fx.source, at: Date.now() };
      return fx;
    } catch (e) {
      errors.push(`FRED: ${e.message}`);
    }
    try {
      const q = await getYahooQuote('USDCNY=X');
      const out = { rate: q.price, source: 'yahoo' };
      usdCnyCache = { rate: out.rate, source: out.source, at: Date.now() };
      return out;
    } catch (e) {
      errors.push(`Yahoo: ${e.message}`);
      throw new Error(`USD/CNY 不可用（${errors.join('; ')}）`);
    }
  }

  async function getOptionSnapshot(symbol) {
    if (!polygonKey) throw new Error('未配置 Polygon API Key');
    const upper = String(symbol).toUpperCase();
    const parsed = parseOptionSymbol(upper);
    if (!parsed) throw new Error('期权代码格式错误');
    const polygonSymbol = toPolygonOptionSymbol(upper);
    const url = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(parsed.underlying)}/${encodeURIComponent(polygonSymbol)}?apiKey=${polygonKey}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      throw new Error(`Polygon snapshot ${e.message}`);
    }
    const r = data?.results;
    if (!r) throw new Error('期权无快照');
    const day = r.day || {};
    const last = r.last_quote || r.last_trade || {};
    const price = last.midpoint || last.price || day.close || 0;
    const prev = day.close || price;
    return {
      symbol: upper,
      name: `${parsed.underlying} ${r.details?.expiration_date || parsed.expiration} ${parsed.type} $${parsed.strike}`,
      price,
      change: day.change || 0,
      changePercent: day.change_percent || 0,
      prevClose: prev,
      strike: r.details?.strike_price || Number(parsed.strike),
      expiry: r.details?.expiration_date,
      openInterest: r.open_interest,
      volume: day.volume
    };
  }

  async function searchLeapCalls(underlying, strikeLow, strikeHigh, expiryGte, expiryLte) {
    if (!polygonKey) return [];
    const u = String(underlying).toUpperCase();
    const params = new URLSearchParams({
      underlying_ticker: u,
      contract_type: 'call',
      expired: 'false',
      limit: '50',
      sort: 'strike_price',
      order: 'asc',
      'strike_price.gte': String(strikeLow),
      'strike_price.lte': String(strikeHigh),
      'expiration_date.gte': expiryGte,
      'expiration_date.lte': expiryLte,
      apiKey: polygonKey
    });
    const url = `https://api.polygon.io/v3/reference/options/contracts?${params}`;
    try {
      const data = await fetchJson(url);
      return (data.results || []).slice(0, 12).map((c) => ({
        ticker: c.ticker,
        strike: c.strike_price,
        expiry: c.expiration_date,
        underlying: c.underlying_ticker
      }));
    } catch {
      return [];
    }
  }

  async function getCnyProxyFromEastMoney() {
    // Shenzhen ETF: secid=0.XXXXXX; fltt=2 returns yuan prices directly.
    const url = 'https://push2.eastmoney.com/api/qt/stock/get?invt=2&fltt=2&fields=f43,f44,f45,f46,f57,f58,f60,f169,f170&secid=0.159509';
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
      symbol: CNY_EQUITY_PROXY_SYMBOL,
      name: d?.f58 || '纳指科技ETF景顺',
      price,
      close: price,
      prevClose: prev,
      change,
      changePercent,
      high: Number(d?.f44) || price,
      low: Number(d?.f45) || price,
      source: 'eastmoney',
      candles: []
    };
  }

  async function getCnyProxyFromTencent() {
    const text = await fetchText('https://qt.gtimg.cn/q=sz159509', {
      'User-Agent': 'Mozilla/5.0'
    }, 'gbk');
    const m = text.match(/="([^"]*)"/);
    if (!m) throw new Error('腾讯无行情');
    const parts = m[1].split('~');
    // 1 name, 2 code, 3 price, 4 prevClose, 5 open, 33 high, 34 low (approx common layout)
    const price = Number(parts[3]);
    const prev = Number(parts[4]) || price;
    if (!Number.isFinite(price) || price <= 0) throw new Error('腾讯无有效价');
    return {
      symbol: CNY_EQUITY_PROXY_SYMBOL,
      name: parts[1] || '纳指科技ETF景顺',
      price,
      close: price,
      prevClose: prev,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      high: Number(parts[33]) || price,
      low: Number(parts[34]) || price,
      source: 'tencent',
      candles: []
    };
  }

  async function getCnyProxyFromSina() {
    const text = await fetchText('https://hq.sinajs.cn/list=sz159509', {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://finance.sina.com.cn'
    }, 'gbk');
    const m = text.match(/="([^"]*)"/);
    if (!m || !m[1]) throw new Error('新浪无行情');
    const parts = m[1].split(',');
    // 1 open, 2 prevClose, 3 price, 4 high, 5 low
    const price = Number(parts[3]);
    const prev = Number(parts[2]) || price;
    if (!Number.isFinite(price) || price <= 0) throw new Error('新浪无有效价');
    return {
      symbol: CNY_EQUITY_PROXY_SYMBOL,
      name: parts[0] || '纳指科技ETF景顺',
      price,
      close: price,
      prevClose: prev,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      high: Number(parts[4]) || price,
      low: Number(parts[5]) || price,
      source: 'sina',
      candles: []
    };
  }

  async function getCnyProxyQuote() {
    // Prefer Tencent/Sina on CN cloud hosts; East Money push2 often empty there.
    const errors = [];
    for (const [label, fn] of [
      ['腾讯', getCnyProxyFromTencent],
      ['新浪', getCnyProxyFromSina],
      ['东方财富', getCnyProxyFromEastMoney]
    ]) {
      try {
        return await fn();
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
      }
    }
    try {
      const q = await getYahooQuote('159509.SZ');
      return {
        symbol: CNY_EQUITY_PROXY_SYMBOL,
        price: q.price,
        close: q.close ?? q.price,
        prevClose: q.prevClose,
        change: q.change,
        changePercent: q.changePercent,
        high: q.high,
        low: q.low,
        source: 'yahoo',
        candles: []
      };
    } catch (e) {
      errors.push(`Yahoo: ${e.message}`);
      throw new Error(`159509 不可用（${errors.join('; ')}）`);
    }
  }

  async function getMarketBundle(symbols, { previousVxn = null } = {}) {
    const out = {};
    const errors = {};
    for (const symbol of symbols) {
      try {
        const quote = await getStock(symbol);
        const candles = await getCandles(symbol, 90);
        out[symbol] = { ...quote, candles };
      } catch (e) {
        errors[symbol] = e.message;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      out.VXN = await getVxn(previousVxn);
      if (out.VXN.stale) errors.VXN = `${out.VXN.warning}；保留最近有效值，仅供参考`;
    } catch (e) {
      errors.VXN = e.message;
    }
    try {
      out[CNY_EQUITY_PROXY_SYMBOL] = await getCnyProxyQuote();
    } catch (e) {
      errors[CNY_EQUITY_PROXY_SYMBOL] = e.message;
    }
    return { markets: out, errors };
  }

  return {
    getStock,
    getCandles,
    getVxn,
    getUsdCny,
    getCnyProxyQuote,
    getOptionSnapshot,
    searchLeapCalls,
    getMarketBundle,
    parseOptionSymbol,
    toPolygonOptionSymbol
  };
}
