import {
  isAShareSymbol,
  ashareCode,
  ashareExchange,
  normalizeSymbol
} from './markets.js';

const FETCH_TIMEOUT_MS = 12000;
const FETCH_RETRIES = 2;
const RETRY_BASE_MS = 500;

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

function formatFetchError(err) {
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return `请求超时 (${FETCH_TIMEOUT_MS / 1000}s)`;
  }
  const parts = [];
  const msg = err?.message ? String(err.message) : '';
  if (msg && msg !== 'fetch failed') parts.push(msg);
  const cause = err?.cause;
  if (cause) {
    const code = cause.code || cause.errno;
    const cmsg = cause.message ? String(cause.message) : '';
    if (code) parts.push(String(code));
    if (cmsg && cmsg !== msg && cmsg !== 'fetch failed') parts.push(cmsg);
  }
  return parts.length ? parts.join(': ') : '网络请求失败';
}

function isRetryable(err, status) {
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return true;
  const blob = `${err?.message || ''} ${err?.cause?.code || ''} ${err?.cause?.message || ''} ${err?.code || ''}`;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR_|socket|network|timeout|aborted/i.test(blob);
}

async function fetchJson(url, headers = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ac.signal, headers });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        lastErr = err;
        if (attempt < FETCH_RETRIES && isRetryable(err, res.status)) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
          continue;
        }
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < FETCH_RETRIES && isRetryable(e, e.status)) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
        continue;
      }
      throw new Error(formatFetchError(e));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(formatFetchError(lastErr));
}

async function fetchText(url, headers = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ac.signal, headers });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        lastErr = err;
        if (attempt < FETCH_RETRIES && isRetryable(err, res.status)) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
          continue;
        }
        throw err;
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < FETCH_RETRIES && isRetryable(e, e.status)) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
        continue;
      }
      throw new Error(formatFetchError(e));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(formatFetchError(lastErr));
}

function ymdUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function ymdDaysAgo(days) {
  return ymdUTC(Date.now() - days * 86400000);
}

export function createQuoteService(config) {
  const finnhubKey = config.finnhubApiKey;
  const polygonKey = config.polygonApiKey;

  if (!finnhubKey) {
    console.warn('stock-manage: finnhubApiKey 未配置，美股行情不可用');
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
    return {
      symbol: sym,
      name: sym,
      price: q.c,
      change: q.d ?? 0,
      changePercent: q.dp ?? 0,
      currency: 'USD',
      source: 'finnhub'
    };
  }

  async function getYahooQuote(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const data = await fetchJson(url, { 'User-Agent': 'Mozilla/5.0' });
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    const price = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Yahoo 无有效价');
    const prev = Number(meta?.chartPreviousClose || meta?.previousClose) || price;
    return {
      symbol,
      price,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      prevClose: prev,
      source: 'yahoo'
    };
  }

  async function getAShareFromTencent(code) {
    const ex = ashareExchange(code);
    const text = await fetchText(`https://qt.gtimg.cn/q=${ex}${code}`, {
      'User-Agent': 'Mozilla/5.0'
    });
    const m = text.match(/="([^"]*)"/);
    if (!m) throw new Error('腾讯无行情');
    const parts = m[1].split('~');
    const price = Number(parts[3]);
    const prev = Number(parts[4]) || price;
    if (!Number.isFinite(price) || price <= 0) throw new Error('腾讯无有效价');
    return {
      symbol: code,
      name: parts[1] || code,
      price,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      prevClose: prev,
      currency: 'CNY',
      source: 'tencent'
    };
  }

  async function getAShareFromSina(code) {
    const ex = ashareExchange(code);
    const text = await fetchText(`https://hq.sinajs.cn/list=${ex}${code}`, {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://finance.sina.com.cn'
    });
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
        name: code,
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

  async function getStock(symbol) {
    if (isAShareSymbol(symbol)) return getAShareQuote(symbol);
    return getStockFromFinnhub(symbol);
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

  async function getOption(symbol) {
    if (!polygonKey) throw new Error('未配置 Polygon API Key');
    const upper = String(symbol).toUpperCase();
    const parsed = parseOptionSymbol(upper);
    if (!parsed) throw new Error('期权代码格式错误');
    const polygonSymbol = toPolygonOptionSymbol(upper);

    let quote = null;
    let snapErr = null;
    try {
      quote = await getOptionFromSnapshot(polygonSymbol, parsed.underlying);
    } catch (e) {
      snapErr = e;
      try {
        quote = await getOptionFromDailyBars(polygonSymbol);
      } catch (e2) {
        throw new Error(
          `Polygon 期权价格不可用（snapshot: ${snapErr.message}; daily: ${e2.message}）`
        );
      }
    }

    let name;
    const details = quote.details || {};
    if (details.expiration_date || details.strike_price) {
      name = `${parsed.underlying} ${details.expiration_date || parsed.expiration} ${details.contract_type || parsed.type} $${details.strike_price || parsed.strike}`;
    } else {
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

  async function search(q) {
    const query = String(q || '').trim();
    if (query.length < 1) return [];
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

  async function getQuote(symbol) {
    const sym = normalizeSymbol(symbol);
    if (/^[A-Z]+\d{6}[CP]\d/i.test(sym)) return getOption(sym);
    if (isAShareSymbol(sym)) return getAShareQuote(sym);
    return getStockFromFinnhub(sym);
  }

  return { getStock, getOption, getQuote, getAShareQuote, getUsdCny, search };
}
