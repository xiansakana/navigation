const DEFAULT_USD_CNY_RATE = 7.2;

const EMPTY = {
  cashUsd: 0,
  cashCny: 0,
  usdCnyRate: DEFAULT_USD_CNY_RATE,
  cash: 0,
  trades: [],
  quotes: {},
  holdingsMeta: {}
};

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function normalizePortfolio(raw) {
  let cashUsd;
  let cashCny;
  if (raw && (raw.cashUsd != null || raw.cashCny != null)) {
    cashUsd = Number(raw.cashUsd);
    if (!Number.isFinite(cashUsd)) cashUsd = Number(raw.cash) || 0;
    cashCny = Number(raw.cashCny);
    if (!Number.isFinite(cashCny)) cashCny = 0;
  } else {
    cashUsd = Number(raw?.cash) || 0;
    cashCny = 0;
  }

  let usdCnyRate = Number(raw?.usdCnyRate);
  if (!Number.isFinite(usdCnyRate) || usdCnyRate <= 0) usdCnyRate = DEFAULT_USD_CNY_RATE;

  cashUsd = roundMoney(cashUsd);
  cashCny = roundMoney(cashCny);
  const cash = roundMoney(cashUsd + cashCny / usdCnyRate);

  return {
    cashUsd,
    cashCny,
    usdCnyRate,
    cash,
    trades: Array.isArray(raw?.trades) ? raw.trades : [],
    quotes: raw?.quotes && typeof raw.quotes === 'object' ? raw.quotes : {},
    holdingsMeta: raw?.holdingsMeta && typeof raw.holdingsMeta === 'object' ? raw.holdingsMeta : {}
  };
}

export function createPortfolioStore(db) {
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const allTrades = db.prepare("SELECT data FROM trades ORDER BY json_extract(data, '$.trade_date') ASC, id ASC");
  const upsertTrade = db.prepare('INSERT OR REPLACE INTO trades (id, data) VALUES (?, ?)');
  const clearTrades = db.prepare('DELETE FROM trades');
  const allQuotes = db.prepare('SELECT symbol, data FROM quotes');
  const upsertQuote = db.prepare('INSERT OR REPLACE INTO quotes (symbol, data) VALUES (?, ?)');
  const clearQuotes = db.prepare('DELETE FROM quotes');
  const allMeta = db.prepare('SELECT symbol, data FROM holdings_meta');
  const upsertMeta = db.prepare('INSERT OR REPLACE INTO holdings_meta (symbol, data) VALUES (?, ?)');
  const clearMeta = db.prepare('DELETE FROM holdings_meta');

  function metaNumber(key, fallback) {
    const row = getMeta.get(key);
    if (!row) return fallback;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : fallback;
  }

  function read() {
    const legacyCash = metaNumber('cash', null);
    const cashUsdRaw = getMeta.get('cashUsd');
    const cashCnyRaw = getMeta.get('cashCny');
    const rateRaw = getMeta.get('usdCnyRate');

    let cashUsd;
    let cashCny;
    if (cashUsdRaw || cashCnyRaw) {
      cashUsd = cashUsdRaw ? Number(cashUsdRaw.value) : 0;
      cashCny = cashCnyRaw ? Number(cashCnyRaw.value) : 0;
    } else {
      cashUsd = legacyCash != null ? legacyCash : 0;
      cashCny = 0;
    }
    let usdCnyRate = rateRaw ? Number(rateRaw.value) : DEFAULT_USD_CNY_RATE;
    if (!Number.isFinite(usdCnyRate) || usdCnyRate <= 0) usdCnyRate = DEFAULT_USD_CNY_RATE;

    const trades = allTrades.all().map(function(row) { return JSON.parse(row.data); });
    const quotes = {};
    allQuotes.all().forEach(function(row) { quotes[row.symbol] = JSON.parse(row.data); });
    const holdingsMeta = {};
    allMeta.all().forEach(function(row) { holdingsMeta[row.symbol] = JSON.parse(row.data); });

    return normalizePortfolio({
      cashUsd,
      cashCny,
      usdCnyRate,
      trades,
      quotes,
      holdingsMeta
    });
  }

  function write(data) {
    const payload = normalizePortfolio(data);
    const tx = db.transaction(function persistPortfolio() {
      setMeta.run('cashUsd', String(payload.cashUsd));
      setMeta.run('cashCny', String(payload.cashCny));
      setMeta.run('usdCnyRate', String(payload.usdCnyRate));
      // Keep legacy `cash` as USD-equivalent for older readers / JSON exports.
      setMeta.run('cash', String(payload.cash));
      clearTrades.run();
      payload.trades.forEach(function(t) {
        if (!t?.id) return;
        upsertTrade.run(t.id, JSON.stringify(t));
      });
      clearQuotes.run();
      Object.keys(payload.quotes).forEach(function(sym) {
        upsertQuote.run(sym, JSON.stringify(payload.quotes[sym]));
      });
      clearMeta.run();
      Object.keys(payload.holdingsMeta).forEach(function(sym) {
        upsertMeta.run(sym, JSON.stringify(payload.holdingsMeta[sym]));
      });
    });
    tx();
    return Object.assign({}, payload, { updatedAt: new Date().toISOString() });
  }

  return { read, write };
}

export { EMPTY, normalizePortfolio, DEFAULT_USD_CNY_RATE };
