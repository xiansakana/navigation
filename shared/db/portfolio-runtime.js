import { currentPortfolioUserId, requirePortfolioUserId } from '../portfolio-user.js';
import { getDatabase } from './connection.js';
import {
  createPortfolioStore,
  ensureUserPortfolioSchema,
  legacyPortfolioOwner
} from './portfolio-store.js';
import {
  createPostgresPortfolioStore
} from './portfolio-postgres.js';
import {
  ensureFundHoldings,
  fundHoldings as sqliteFundHoldings
} from '../fund-holdings.js';
import {
  dipCashFunds as sqliteDipFunds,
  setDipCashReserve as sqliteSetDipReserve
} from '../dip-cash-funds.js';
import {
  investmentRows as sqliteInvestmentRows,
  projectInvestments as sqliteProjectInvestments,
  saveInvestmentAccount as sqliteSaveInvestmentAccount,
  unlinkInvestmentAccount as sqliteUnlinkInvestmentAccount
} from '../investment-accounts.js';

function createSqliteBackend(db, options = {}) {
  const defaultUserId = () => legacyPortfolioOwner(db);
  const resolve = (userId) => requirePortfolioUserId(userId ?? currentPortfolioUserId() ?? defaultUserId());
  function storeFor(userId) {
    const user = resolve(userId);
    return {
      userId: user,
      read: () => createPortfolioStore(db, user).read(),
      write: (data, writeOptions) => createPortfolioStore(db, user).write(data, writeOptions)
    };
  }
  return {
    mode: 'sqlite',
    db,
    storeFor,
    defaultUserId,
    read: (userId) => storeFor(userId).read(),
    readRaw(userId) {
      const user = resolve(userId);
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portfolio_users'").get()) return {};
      const row = db.prepare('SELECT data FROM portfolio_users WHERE user_id=?').get(user);
      try { return row ? JSON.parse(row.data) : {}; } catch { return {}; }
    },
    write: (data, writeOptions, userId) => storeFor(userId).write(data, writeOptions),
    investmentRows: (userId) => sqliteInvestmentRows(db, resolve(userId)),
    project: (userId, raw) => sqliteProjectInvestments(db, resolve(userId), raw),
    saveInvestmentAccount: (userId, input, id) => sqliteSaveInvestmentAccount(db, resolve(userId), input, id),
    unlinkInvestmentAccount: (userId, accountId) => sqliteUnlinkInvestmentAccount(db, resolve(userId), accountId),
    fundHoldings: (userId) => sqliteFundHoldings(db, resolve(userId)),
    saveFundHolding(userId, accountId, code, input) {
      return db.prepare(`INSERT OR IGNORE INTO fund_holdings
        (user_id,account_id,code,name,shares,cost,nav,nav_date) VALUES(?,?,?,?,?,?,?,?)`)
        .run(resolve(userId), accountId, code, input.name, input.shares, input.cost, input.nav, input.navDate).changes > 0;
    },
    updateFundHolding(userId, accountId, code, input) {
      return db.prepare('UPDATE fund_holdings SET name=?,shares=?,cost=? WHERE user_id=? AND account_id=? AND code=?')
        .run(input.name, input.shares, input.cost, resolve(userId), accountId, code).changes > 0;
    },
    removeFundHolding(userId, accountId, code) {
      db.prepare('DELETE FROM fund_holdings WHERE user_id=? AND account_id=? AND code=?')
        .run(resolve(userId), accountId, code);
    },
    dipFunds: (userId, portfolio) => sqliteDipFunds(db, resolve(userId), portfolio),
    setDipReserve: (userId, accountId, amount) => sqliteSetDipReserve(db, resolve(userId), accountId, amount),
    orderedAccountIds(userId) {
      const row = db.prepare('SELECT value FROM portfolio_user_meta WHERE user_id=? AND key=?')
        .get(resolve(userId), 'investment_account_order');
      return row ? JSON.parse(row.value) : null;
    },
    saveAccountOrder(userId, ids) {
      const user = resolve(userId);
      ensureUserPortfolioSchema(db);
      return db.transaction(() => {
        const owned = new Set(sqliteInvestmentRows(db, user).map(account => account.id));
        if (owned.size !== ids.length || ids.some(id => !owned.has(id))) return false;
        db.prepare(`INSERT INTO portfolio_user_meta(user_id,key,value) VALUES(?,?,?)
          ON CONFLICT (user_id,key) DO UPDATE SET value = excluded.value`)
          .run(user, 'investment_account_order', JSON.stringify(ids));
        return true;
      }).immediate();
    },
    meta(userId, key) {
      ensureUserPortfolioSchema(db);
      return db.prepare('SELECT value FROM portfolio_user_meta WHERE user_id=? AND key=?')
        .get(resolve(userId), key)?.value ?? null;
    },
    setMeta(userId, key, value) {
      ensureUserPortfolioSchema(db);
      db.prepare(`INSERT INTO portfolio_user_meta(user_id,key,value) VALUES(?,?,?)
        ON CONFLICT (user_id,key) DO UPDATE SET value = excluded.value`)
        .run(resolve(userId), key, value == null ? '' : String(value));
    }
  };
}

function createPostgresBackend(db, options = {}) {
  const stores = new Map();
  let defaultUser;
  const defaultUserId = async () => {
    if (defaultUser !== undefined) return defaultUser;
    try {
      const { rows: [row] } = await db.query("SELECT value FROM navigation.meta WHERE key='portfolio_legacy_owner'");
      defaultUser = row?.value || null;
    } catch {
      defaultUser = null;
    }
    return defaultUser;
  };
  const resolve = async (userId) => requirePortfolioUserId(userId ?? currentPortfolioUserId() ?? await defaultUserId());
  function storeFor(userId) {
    const user = requirePortfolioUserId(userId);
    if (!stores.has(user)) stores.set(user, createPostgresPortfolioStore(db, user, options));
    return stores.get(user);
  }
  return {
    mode: 'postgres',
    db,
    storeFor,
    defaultUserId,
    read: async (userId) => storeFor(await resolve(userId)).read(),
    readRaw: async (userId) => storeFor(await resolve(userId)).readRaw(),
    write: async (data, writeOptions, userId) => storeFor(await resolve(userId)).write(data, writeOptions),
    investmentRows: async (userId) => storeFor(await resolve(userId)).investmentRows(),
    project: async (userId, raw) => storeFor(await resolve(userId)).project(undefined, raw),
    saveInvestmentAccount: async (userId, input, id) => storeFor(await resolve(userId)).saveInvestmentAccount(await resolve(userId), input, id),
    unlinkInvestmentAccount: async (userId, accountId) => storeFor(await resolve(userId)).unlinkInvestmentAccount(await resolve(userId), accountId),
    fundHoldings: async (userId) => storeFor(await resolve(userId)).fundHoldings(),
    saveFundHolding: async (userId, accountId, code, input) => storeFor(await resolve(userId)).saveFundHolding(await resolve(userId), accountId, code, input),
    updateFundHolding: async (userId, accountId, code, input) => storeFor(await resolve(userId)).updateFundHolding(await resolve(userId), accountId, code, input),
    removeFundHolding: async (userId, accountId, code) => storeFor(await resolve(userId)).removeFundHolding(await resolve(userId), accountId, code),
    dipFunds: async (userId, portfolio) => storeFor(await resolve(userId)).dipFunds(await resolve(userId), portfolio),
    setDipReserve: async (userId, accountId, amount) => storeFor(await resolve(userId)).setDipReserve(await resolve(userId), accountId, amount),
    orderedAccountIds: async (userId) => storeFor(await resolve(userId)).orderedAccountIds(await resolve(userId)),
    saveAccountOrder: async (userId, ids) => storeFor(await resolve(userId)).saveAccountOrder(await resolve(userId), ids),
    meta: async (userId, key) => storeFor(await resolve(userId)).meta(await resolve(userId), key),
    setMeta: async (userId, key, value) => storeFor(await resolve(userId)).setMeta(await resolve(userId), key, value)
  };
}

export async function createPortfolioBackend({ dbPath, database = null, sqlite = null, bookkeepingDatabase = null } = {}) {
  if (database) return createPostgresBackend(database, { sqlite, bookkeepingDatabase });
  const sqliteDb = sqlite || getDatabase({ dbPath });
  return createSqliteBackend(sqliteDb);
}
