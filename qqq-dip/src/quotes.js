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

  async function getStock(symbol) {
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
    return mapQuote(sym, q);
  }

  async function getCandles(symbol, days = 90) {
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

  async function getVxn() {
    const errors = [];
    if (finnhubKey) {
      for (const sym of ['VXN', '^VXN']) {
        try {
          return { ...(await getStock(sym)), symbol: 'VXN' };
        } catch (e) {
          errors.push(`${sym}: ${e.message}`);
        }
      }
    }
    try {
      const q = await getYahooQuote('^VXN');
      return { ...q, symbol: 'VXN' };
    } catch (e) {
      errors.push(`Yahoo: ${e.message}`);
      throw new Error(`VXN 不可用（${errors.join('; ')}）`);
    }
  }

  async function getUsdCny() {
    if (finnhubKey) {
      try {
        const url = `https://finnhub.io/api/v1/forex/rates?base=USD&token=${finnhubKey}`;
        const data = await fetchJson(url);
        const rate = data?.quote?.CNY || data?.quote?.CNH;
        if (rate) return { rate: Number(rate), source: 'finnhub' };
      } catch {
        /* fall through */
      }
    }
    const q = await getYahooQuote('USDCNY=X');
    return { rate: q.price, source: 'yahoo' };
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

  async function getMarketBundle(symbols) {
    const out = {};
    const errors = {};
    for (const symbol of symbols) {
      try {
        const [quote, candles] = await Promise.all([getStock(symbol), getCandles(symbol, 90)]);
        out[symbol] = { ...quote, candles };
      } catch (e) {
        errors[symbol] = e.message;
      }
    }
    try {
      out.VXN = await getVxn();
    } catch (e) {
      errors.VXN = e.message;
    }
    return { markets: out, errors };
  }

  return {
    getStock,
    getCandles,
    getVxn,
    getUsdCny,
    getOptionSnapshot,
    searchLeapCalls,
    getMarketBundle,
    parseOptionSymbol,
    toPolygonOptionSymbol
  };
}
