import fs from 'node:fs';
import { defaultPortfolioJsonPath, defaultRbacJsonPath } from './path.js';

function normalizePortfolio(raw) {
  return {
    cash: Number(raw?.cash) || 0,
    trades: Array.isArray(raw?.trades) ? raw.trades : [],
    quotes: raw?.quotes && typeof raw.quotes === 'object' ? raw.quotes : {},
    holdingsMeta: raw.holdingsMeta && typeof raw.holdingsMeta === 'object' ? raw.holdingsMeta : {}
  };
}

function readPortfolioJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizePortfolio(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

export function importPortfolioJson(db, jsonPath) {
  const raw = readPortfolioJson(jsonPath);
  if (!raw) return false;

  const tx = db.transaction(function importPortfolio(data) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('cash', ?)").run(String(data.cash));
    db.prepare('DELETE FROM trades').run();
    db.prepare('DELETE FROM quotes').run();
    db.prepare('DELETE FROM holdings_meta').run();

    const insTrade = db.prepare('INSERT INTO trades (id, data) VALUES (?, ?)');
    data.trades.forEach(function(t) {
      if (!t?.id) return;
      insTrade.run(t.id, JSON.stringify(t));
    });

    const insQuote = db.prepare('INSERT INTO quotes (symbol, data) VALUES (?, ?)');
    Object.keys(data.quotes || {}).forEach(function(sym) {
      insQuote.run(sym, JSON.stringify(data.quotes[sym]));
    });

    const insMeta = db.prepare('INSERT INTO holdings_meta (symbol, data) VALUES (?, ?)');
    Object.keys(data.holdingsMeta || {}).forEach(function(sym) {
      insMeta.run(sym, JSON.stringify(data.holdingsMeta[sym]));
    });
  });
  tx(raw);
  return true;
}

export function runMigrations(db, options = {}) {
  const rbacJson = options.rbacJsonPath || defaultRbacJsonPath();
  const portfolioJson = options.portfolioJsonPath || options.legacyJsonPath || defaultPortfolioJsonPath();

  const hasRbac = db.prepare('SELECT 1 AS ok FROM rbac_snapshot WHERE id = 1').get();
  if (!hasRbac && fs.existsSync(rbacJson)) {
    const payload = fs.readFileSync(rbacJson, 'utf8');
    JSON.parse(payload);
    db.prepare('INSERT INTO rbac_snapshot (id, payload) VALUES (1, ?)').run(payload);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_rbac_from', ?)").run(rbacJson);
    console.log('[navigation.db] migrated RBAC from', rbacJson);
  }

  const tradeCount = db.prepare('SELECT COUNT(*) AS c FROM trades').get().c;
  if (tradeCount === 0 && fs.existsSync(portfolioJson)) {
    if (importPortfolioJson(db, portfolioJson)) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_portfolio_from', ?)").run(portfolioJson);
      console.log('[navigation.db] migrated portfolio from', portfolioJson);
    }
  }
}
