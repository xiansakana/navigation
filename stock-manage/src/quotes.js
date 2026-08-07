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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const q = await res.json();
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
    const contractRes = await fetch(contractUrl);
    if (!contractRes.ok) throw new Error(`Polygon HTTP ${contractRes.status}`);
    const contractData = await contractRes.json();
    if (contractData.status !== 'OK' || !contractData.results) {
      throw new Error('期权不存在或已过期');
    }

    const priceUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(polygonSymbol)}/prev?adjusted=true&apiKey=${polygonKey}`;
    const priceRes = await fetch(priceUrl);
    if (!priceRes.ok) throw new Error(`Polygon 价格 HTTP ${priceRes.status}`);
    const priceData = await priceRes.json();

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
