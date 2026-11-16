export function fundCode(symbol) {
  return /^(\d{6})\.OF$/i.exec(String(symbol || '').trim())?.[1] || '';
}

export function fundTradeOrder(t) {
  if (t.openingFund) return -1;
  if (!fundCode(t.symbol)) return 0;
  return t.type === 'sell' ? 2 : 1;
}

export function openingFundTrades(funds) {
  return funds.map(fund => ({
    id: `fund-opening:${fund.account_id}:${fund.code}`, openingFund: true,
    symbol: `${fund.code}.OF`, name: fund.name, account_id: fund.account_id,
    type: 'buy', currency: 'CNY', shares: fund.shares, price: fund.cost / fund.shares,
    total_amount: fund.cost, commission: 0, trade_date: '1970-01-01T00:00:00Z'
  }));
}

export function fundValuation(quote, opening) {
  if (quote?.price > 0 && (!opening || String(quote.asOf || '') >= opening.nav_date)) return quote;
  return opening ? { price: opening.nav, asOf: opening.nav_date } : undefined;
}

export function ensureFundHoldings(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS fund_holdings (
    user_id TEXT NOT NULL, account_id TEXT NOT NULL, code TEXT NOT NULL,
    name TEXT NOT NULL, shares REAL NOT NULL, cost REAL NOT NULL,
    nav REAL NOT NULL, nav_date TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id, code)
  )`);
}

export function fundHoldings(db, userId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fund_holdings'").get()) return [];
  return db.prepare('SELECT * FROM fund_holdings WHERE user_id=? ORDER BY account_id,code').all(userId);
}
