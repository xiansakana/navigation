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

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ac.signal });
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

export function createQuoteService(config) {
  const finnhubKey = config.finnhubApiKey;
  const polygonKey = config.polygonApiKey;

  if (!finnhubKey) {
    console.warn('stock-manage: finnhubApiKey 未配置，股票行情不可用');
  }
  if (!polygonKey) {
    console.warn('stock-manage: polygonApiKey 未配置，期权行情不可用');
  }

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
    return { symbol: sym, name: sym, price: q.c, change: q.d ?? 0, changePercent: q.dp ?? 0 };
  }

  async function getOption(symbol) {
    if (!polygonKey) throw new Error('未配置 Polygon API Key');
    const upper = String(symbol).toUpperCase();
    const parsed = parseOptionSymbol(upper);
    if (!parsed) throw new Error('期权代码格式错误');
    const polygonSymbol = toPolygonOptionSymbol(upper);

    const contractUrl = `https://api.polygon.io/v3/reference/options/contracts/${encodeURIComponent(polygonSymbol)}?apiKey=${polygonKey}`;
    let contractData;
    try {
      contractData = await fetchJson(contractUrl);
    } catch (e) {
      throw new Error(`Polygon ${e.message}`);
    }
    if (contractData.status !== 'OK' || !contractData.results) {
      throw new Error('期权不存在或已过期');
    }

    const priceUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(polygonSymbol)}/prev?adjusted=true&apiKey=${polygonKey}`;
    let priceData;
    try {
      priceData = await fetchJson(priceUrl);
    } catch (e) {
      throw new Error(`Polygon 价格 ${e.message}`);
    }

    let price = 0;
    let change = 0;
    let changePercent = 0;
    if (priceData.status === 'OK' && priceData.results?.length) {
      const r = priceData.results[0];
      price = r.c || r.vw || 0;
      change = r.c && r.o ? r.c - r.o : 0;
      changePercent = r.c && r.o ? ((r.c - r.o) / r.o) * 100 : 0;
    }

    const c = contractData.results;
    return {
      symbol: upper,
      name: `${parsed.underlying} ${c.expiration_date} ${c.contract_type} $${c.strike_price}`,
      price,
      change,
      changePercent
    };
  }

  async function search(q) {
    if (!finnhubKey) return [];
    const query = String(q || '').trim();
    if (query.length < 1) return [];
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
    if (/^[A-Z]+\d{6}[CP]\d/i.test(symbol)) return getOption(symbol);
    return getStock(symbol);
  }

  return { getStock, getOption, getQuote, search };
}
