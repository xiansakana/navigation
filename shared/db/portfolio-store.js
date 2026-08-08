const EMPTY = { cash: 0, trades: [], quotes: {}, holdingsMeta: {} };

function normalizePortfolio(raw) {
  return {
    cash: Number(raw?.cash) || 0,
    trades: Array.isArray(raw?.trades) ? raw.trades : [],
    quotes: raw?.quotes && typeof raw.quotes === 'object' ? raw.quotes : {},
    holdingsMeta: raw?.holdingsMeta && typeof raw.holdingsMeta === 'object' ? raw.holdingsMeta : {}
  };
}

export function createPortfolioStore(db) {
  const getCash = db.prepare("SELECT value FROM meta WHERE key = 'cash'");
  const setCash = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('cash', ?)");
  const allTrades = db.prepare("SELECT data FROM trades ORDER BY json_extract(data, '$.trade_date') ASC, id ASC");
  const upsertTrade = db.prepare('INSERT OR REPLACE INTO trades (id, data) VALUES (?, ?)');
  const clearTrades = db.prepare('DELETE FROM trades');
  const allQuotes = db.prepare('SELECT symbol, data FROM quotes');
  const upsertQuote = db.prepare('INSERT OR REPLACE INTO quotes (symbol, data) VALUES (?, ?)');
  const clearQuotes = db.prepare('DELETE FROM quotes');
  const allMeta = db.prepare('SELECT symbol, data FROM holdings_meta');
  const upsertMeta = db.prepare('INSERT OR REPLACE INTO holdings_meta (symbol, data) VALUES (?, ?)');
  const clearMeta = db.prepare('DELETE FROM holdings_meta');

  function read() {
    const cashRow = getCash.get();
    const trades = allTrades.all().map(function(row) { return JSON.parse(row.data); });
    const quotes = {};
    allQuotes.all().forEach(function(row) { quotes[row.symbol] = JSON.parse(row.data); });
    const holdingsMeta = {};
    allMeta.all().forEach(function(row) { holdingsMeta[row.symbol] = JSON.parse(row.data); });
    return normalizePortfolio({
      cash: cashRow ? Number(cashRow.value) : 0,
      trades: trades,
      quotes: quotes,
      holdingsMeta: holdingsMeta
    });
  }

  function write(data) {
    const payload = normalizePortfolio(data);
    const tx = db.transaction(function persistPortfolio() {
      setCash.run(String(payload.cash));
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

export { EMPTY, normalizePortfolio };
