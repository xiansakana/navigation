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
