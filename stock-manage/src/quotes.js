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

export function createQuoteService(config) {
  const finnhubKey = config.finnhubApiKey;
  const polygonKey = config.polygonApiKey;

  async function getStock(symbol) {
    const sym = String(symbol).toUpperCase();
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Finnhub HTTP ' + res.status);
    const q = await res.json();
    if (!q.c && q.c !== 0) throw new Error('无效代码');
    return { symbol: sym, name: sym, price: q.c, change: q.d, changePercent: q.dp };
  }

  async function getOption(symbol) {
    const upper = String(symbol).toUpperCase();
    const parsed = parseOptionSymbol(upper);
    if (!parsed) throw new Error('期权代码格式错误');
    const poly = toPolygonOptionSymbol(upper);
    const url = `https://api.polygon.io/v3/snapshot/options/${parsed.underlying}/${poly}?apiKey=${polygonKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Polygon HTTP ' + res.status);
    const data = await res.json();
    const result = data.results;
    if (!result) throw new Error('无期权行情');
    const day = result.day || {};
    const last = result.last_quote || {};
    const price = day.close || last.ask || last.bid || 0;
    return {
      symbol: upper,
      name: upper,
      price,
      change: day.change || 0,
      changePercent: day.change_percent || 0
    };
  }

  async function search(q) {
    const query = String(q || '').trim();
    if (query.length < 1) return [];
    const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${finnhubKey}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
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
