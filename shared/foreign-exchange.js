import { fetchQuoteResource } from './quote-network.js';

export const FX_CURRENCIES = ['CNY', 'USD', 'HKD', 'JPY', 'MYR', 'EUR', 'GBP', 'SGD'];
const FRED_SERIES = { USD: ['DEXCHUS', false], HKD: ['DEXHKUS', false], JPY: ['DEXJPUS', false],
  MYR: ['DEXMAUS', false], EUR: ['DEXUSEU', true], GBP: ['DEXUSUK', true], SGD: ['DEXSIUS', false] };
const valid = n => Number.isFinite(Number(n)) && Number(n) > 0 && Number(n) < 1e6;

export function parseFredRates(csv) {
  const lines = String(csv).trim().split(/\r?\n/), headers = lines[0].split(','), rates = {};
  for (let i = lines.length - 1; i >= 1; i--) {
    const fields = lines[i].split(','), date = fields[0], cny = Number(fields[headers.indexOf('DEXCHUS')]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !valid(cny)) continue;
    for (const [currency, [series, usdPerUnit]] of Object.entries(FRED_SERIES)) {
      if (rates[currency]) continue;
      const value = Number(fields[headers.indexOf(series)]);
      if (!valid(value)) continue;
      // Cross rates always use observations from the same date.
      const rate = currency === 'USD' ? cny : usdPerUnit ? cny * value : cny / value;
      if (valid(rate)) rates[currency] = { rate, source: 'fred', asOf: date };
    }
  }
  return rates;
}

export function createForeignExchangeService({ finnhubApiKey = '', request = fetchQuoteResource,
  yahooQuote = null, clock = Date.now, cacheMs = 60000, requestOptions = {} } = {}) {
  const cache = new Map(), lastAttempt = new Map(); let pending = null;
  const fetchResource = (url, options = {}) => request(url, { ...requestOptions, ...options });
  async function retrieve(needed) {
    const now = clock();
    if (!needed.length) return;
    needed.forEach(c => lastAttempt.set(c, now));
    const found = {};
    if (finnhubApiKey) {
      try {
        const data = await fetchResource('https://finnhub.io/api/v1/forex/rates?base=USD&token=' + encodeURIComponent(finnhubApiKey));
        const quotes = data?.quote || {}, cny = Number(quotes.CNY || quotes.CNH);
        for (const currency of needed) {
          const denominator = currency === 'USD' ? 1 : Number(quotes[currency]);
          if (valid(cny) && valid(denominator) && valid(cny / denominator)) found[currency] = {
            rate: cny / denominator, source: 'finnhub', asOf: /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : null };
        }
      } catch { /* Continue to the same public fallbacks used by stock management. */ }
    }
    if (needed.some(c => !found[c])) {
      try {
        const series = [...new Set(['DEXCHUS', ...needed.map(c => FRED_SERIES[c][0])])].join(',');
        const since = new Date(now - 120 * 86400000).toISOString().slice(0, 10);
        const fred = parseFredRates(await fetchResource('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + series + '&cosd=' + since, { json: false }));
        for (const c of needed) if (!found[c] && fred[c]) found[c] = fred[c];
      } catch { /* Yahoo is the final fallback. */ }
    }
    const missing = needed.filter(c => !found[c]);
    // Bound parallel Yahoo requests rather than issuing one request for each page reader.
    for (let i = 0; i < missing.length; i += 3) {
      await Promise.all(missing.slice(i, i + 3).map(async c => {
        try {
          const symbol = c + 'CNY=X';
          let quote;
          if (yahooQuote) quote = await yahooQuote(symbol);
          else {
            const data = await fetchResource('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const meta = data?.chart?.result?.[0]?.meta;
            if (meta?.currency && meta.currency !== 'CNY') throw new Error('Wrong currency');
            quote = { price: meta?.regularMarketPrice, asOf: Number.isFinite(meta?.regularMarketTime) ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : null };
          }
          if (valid(quote.price)) found[c] = { rate: Number(quote.price), source: 'yahoo', asOf: quote.asOf || null };
        } catch { /* One unavailable currency must not discard valid currencies. */ }
      }));
    }
    for (const [c, quote] of Object.entries(found)) cache.set(c, { ...quote, at: clock(), fetchedAt: new Date(clock()).toISOString() });
  }
  async function getRates(requested = FX_CURRENCIES) {
    if (!Array.isArray(requested) || requested.some(c => !FX_CURRENCIES.includes(c))) throw new Error('不支持该货币');
    if (pending) await pending;
    const needed = [...new Set(requested)].filter(c => c !== 'CNY' && (!cache.has(c) || clock() - cache.get(c).at >= cacheMs) && clock() - (lastAttempt.get(c) ?? -Infinity) >= cacheMs);
    if (needed.length) {
      pending = retrieve(needed);
      try { await pending; } finally { pending = null; }
    }
    const quotes = { CNY: { rate: 1, source: 'fixed', asOf: null, fetchedAt: null, stale: false } }, errors = [];
    for (const c of requested.filter(c => c !== 'CNY')) {
      const cached = cache.get(c);
      if (cached) { const { at, ...quote } = cached; quotes[c] = { ...quote, stale: clock() - at >= cacheMs }; }
      if (!cached || quotes[c].stale) errors.push(c + ' 汇率暂时无法更新');
    }
    return { quotes, errors };
  }
  async function getRate(currency) {
    if (!FX_CURRENCIES.includes(currency)) throw new Error('不支持该货币');
    const result = await getRates([currency]), quote = result.quotes[currency];
    if (!quote || quote.stale) throw new Error(currency + '/CNY 汇率不可用');
    return { rate: quote.rate, source: quote.source, asOf: quote.asOf, fetchedAt: quote.fetchedAt };
  }
  return { getRates, getRate };
}
