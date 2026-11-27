import { getDatabase } from '../../shared/db/index.js';
import { postgresUrlFor } from '../../shared/db/postgres/config.js';
import { verifyConfiguredPostgres } from '../../shared/db/postgres/readiness.js';
import { createPortfolioBackend } from '../../shared/db/portfolio-runtime.js';
import { portalPostgresDatabase } from './postgres.js';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { createAssetHistory, startAssetHistory } from './bookkeeping-asset-history.js';
import { historicalFx } from './bookkeeping-historical-fx.js';
import { securityHistory, queueSavedTradeHistory } from './bookkeeping-security-history.js';
import { tradeHistoryReturns } from './bookkeeping-trade-history.js';
import { createQqBookkeeping } from './bookkeeping-qq.js';
import { reviewIcostImport } from './bookkeeping-import-review.js';
import { createPostgresBookkeepingStore } from './bookkeeping-postgres.js';
import { createPostgresQqBookkeeping } from './bookkeeping-qq-postgres.js';
import {
  createPostgresAssetHistory,
  createPostgresHistoricalFx,
  createPostgresTradeHistoryReturns,
  postgresSecurityHistory,
  queueSavedTradeHistoryPg,
  startPostgresAssetHistory
} from './bookkeeping-history-postgres.js';
import { reviewIcostImportPostgres } from './bookkeeping-import-review-postgres.js';

let portfolioBackend, portfolioKey;
let bookkeepingBackend, bookkeepingKey;

export async function getPortalPortfolioBackend() {
  const url = postgresUrlFor('portfolio') || '';
  const key = url + '|' + (process.env.NAVIGATION_DB_PATH || '');
  if (portfolioBackend && portfolioKey === key) return portfolioBackend;
  const sqlite = url ? null : getDatabase({});
  const database = url ? portalPostgresDatabase(url) : null;
  if (database) await verifyConfiguredPostgres(database);
  portfolioKey = key;
  portfolioBackend = await createPortfolioBackend({ database, sqlite });
  return portfolioBackend;
}

export async function getBookkeepingBackend() {
  const portfolio = await getPortalPortfolioBackend();
  const url = postgresUrlFor('bookkeeping');
  const db = url ? null : getDatabase({});
  const key = (url || '') + '|' + (process.env.NAVIGATION_DB_PATH || '') + '|' + (postgresUrlFor('portfolio') || '');
  if (bookkeepingBackend && bookkeepingKey === key) return bookkeepingBackend;
  bookkeepingKey = key;
  if (!url) {
    const store = createBookkeepingStore(db);
    const assetHistory = createAssetHistory(db);
    const fx = historicalFx(db);
    const security = securityHistory(db);
    bookkeepingBackend = {
      mode: 'sqlite', db, store, portfolio, fx, security,
      assetHistory: {
        capture: (...args) => assetHistory.capture(...args),
        read: (...args) => assetHistory.read(...args),
        returns: (...args) => assetHistory.returns(...args)
      },
      tradeHistoryReturns: (userId, filter, today, accounts, excluded, options) =>
        tradeHistoryReturns(db, userId, filter, today, accounts, excluded, options),
      createQq: resolveUser => createQqBookkeeping(db, { resolveUser }),
      reviewImport: (uid, rows, snapshots, selected, options) =>
        reviewIcostImport(db, store, uid, rows, snapshots, selected, options),
      queueSavedTrades: (userId, trades, today) => queueSavedTradeHistory(db, userId, trades, today),
      startAssetHistory: options => startAssetHistory(db, options)
    };
    return bookkeepingBackend;
  }
  const database = portalPostgresDatabase(url);
  await verifyConfiguredPostgres(database);
  const portfolioUrl = postgresUrlFor('portfolio');
  const portfolioForStore = portfolioUrl
    ? await createPortfolioBackend({ database: portalPostgresDatabase(portfolioUrl), sqlite: db, bookkeepingDatabase: database })
    : portfolio;
  const store = createPostgresBookkeepingStore(database, { portfolio: portfolioForStore });
  const fx = createPostgresHistoricalFx(database);
  const security = postgresSecurityHistory(database);
  const assetHistory = createPostgresAssetHistory(database, { portfolio: portfolioForStore });
  bookkeepingBackend = {
    mode: 'postgres', db: database, store, portfolio: portfolioForStore, fx, security,
    assetHistory: {
      capture: (...args) => assetHistory.capture(...args),
      read: (...args) => assetHistory.read(...args),
      returns: (...args) => assetHistory.returns(...args)
    },
    tradeHistoryReturns: (userId, filter, today, accounts, excluded, options) =>
      createPostgresTradeHistoryReturns(database, userId, filter, today, accounts, excluded,
        { portfolio: portfolioForStore, history: security, fx, ...options }),
    createQq: resolveUser => createPostgresQqBookkeeping(database, store, { resolveUser }),
    reviewImport: (uid, rows, snapshots, selected, options) =>
      reviewIcostImportPostgres(database, portfolioForStore, uid, rows, snapshots, selected, options),
    queueSavedTrades: (userId, trades, today) => queueSavedTradeHistoryPg(database, userId, trades, today),
    startAssetHistory: options => startPostgresAssetHistory(database, { portfolio: portfolioForStore, store, fx, history: assetHistory, ...options })
  };
  return bookkeepingBackend;
}
