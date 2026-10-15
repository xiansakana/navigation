import { correctDividendTaxPortfolio } from '../dividend-tax.js';
import { requirePortfolioUserId } from '../portfolio-user.js';

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

export function createLegacyPortfolioStore(db) {
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
    if (db.prepare("SELECT value FROM meta WHERE key='portfolio_legacy_owner'").get()) throw new Error('旧全局股票数据已迁移，禁止继续写入');
    const payload = correctDividendTaxPortfolio(normalizePortfolio(data));
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

export function ensureUserPortfolioSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS portfolio_users (
    user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS portfolio_user_meta (
    user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,key)
  );`);
}

export function createPortfolioStore(db, userId) {
  requirePortfolioUserId(userId);
  ensureUserPortfolioSchema(db);
  const select = db.prepare('SELECT data FROM portfolio_users WHERE user_id=?');
  const upsert = db.prepare('INSERT INTO portfolio_users(user_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at');
  return {
    userId,
    read() { return normalizePortfolio(JSON.parse(select.get(userId)?.data || '{}')); },
    write(input) {
      const payload = correctDividendTaxPortfolio(normalizePortfolio(input));
      const updatedAt = new Date().toISOString();
      upsert.run(userId, JSON.stringify(payload), updatedAt);
      return { ...payload, updatedAt };
    }
  };
}

export function legacyPortfolioOwner(db) {
  return db.prepare("SELECT value FROM meta WHERE key='portfolio_legacy_owner'").get()?.value || null;
}

export function migrateLegacyPortfolio(db, userId) {
  requirePortfolioUserId(userId);
  ensureUserPortfolioSchema(db);
  return db.transaction(() => {
    const owner = legacyPortfolioOwner(db);
    if (owner) {
      if (owner !== userId) throw new Error('旧数据已归属其他用户，禁止再次分配');
      return { migrated: false, userId };
    }
    if (db.prepare('SELECT 1 FROM portfolio_users WHERE user_id=?').get(userId)) throw new Error('目标用户已有股票数据，禁止覆盖');
    const before = createLegacyPortfolioStore(db).read();
    const store = createPortfolioStore(db, userId);
    // Preserve amounts exactly; this migration changes ownership only.
    db.prepare('INSERT INTO portfolio_users(user_id,data,updated_at) VALUES(?,?,?)').run(userId, JSON.stringify(before), new Date().toISOString());
    for (const key of ['fxSource', 'fxUpdatedAt', 'dip_cash_migrated']) {
      const value = db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
      if (value != null) db.prepare('INSERT INTO portfolio_user_meta(user_id,key,value) VALUES(?,?,?)').run(userId, key, value);
    }
    // The migrated portfolio snapshot is authoritative, including zero balances.
    db.prepare("INSERT OR REPLACE INTO portfolio_user_meta(user_id,key,value) VALUES(?,'dip_cash_migrated','1')").run(userId);
    db.prepare("INSERT INTO meta(key,value) VALUES('portfolio_legacy_owner',?)").run(userId);
    const after = store.read();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('迁移核对失败');
    return { migrated: true, userId, trades: after.trades.length, quoteCount: Object.keys(after.quotes).length, metadataCount: Object.keys(after.holdingsMeta).length };
  }).immediate();
}
