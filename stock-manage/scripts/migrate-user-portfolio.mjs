import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/storage.js';
import { getDatabase } from '../../shared/db/index.js';
import { createLegacyPortfolioStore, migrateLegacyPortfolio, legacyPortfolioOwner } from '../../shared/db/portfolio-store.js';
import { portfolioCliUserId } from '../../shared/portfolio-user.js';

const userId = portfolioCliUserId();
const config = loadConfig();
const db = getDatabase({ dbPath: config.dbPath });
const users = JSON.parse(db.prepare('SELECT payload FROM rbac_snapshot WHERE id=1').get()?.payload || '{}').users || [];
if (!users.some((u) => u.id === userId && u.enabled !== false && u.id !== 'usr_guest')) throw new Error('目标用户不存在、已停用或为游客');
const snapshot = createLegacyPortfolioStore(db).read();
// The legacy tables are retained read-only. Keep a small private rollback snapshot,
// rather than duplicating gigabytes of unrelated option-chain history.
const owner = legacyPortfolioOwner(db);
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'preview', userId, currentOwner: owner, trades: snapshot.trades.length }));
} else {
  if (!owner) {
    const directory = path.resolve('data/backups');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, `portfolio-before-user-isolation-${Date.now()}.json`), JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(migrateLegacyPortfolio(db, userId)));
}
