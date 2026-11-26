import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveDbPath, resolveRepoRoot } from './path.js';
import { initSchema } from './schema.js';
import { runMigrations } from './migrate.js';

const require = createRequire(import.meta.url);

let dbInstance = null;
let dbPathUsed = null;

function loadBetterSqlite3() {
  const root = resolveRepoRoot();
  const candidates = [
    path.join(root, 'portal', 'node_modules', 'better-sqlite3'),
    path.join(root, 'stock-manage', 'node_modules', 'better-sqlite3'),
    path.join(root, 'shared', 'node_modules', 'better-sqlite3'),
    'better-sqlite3'
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_) {
      // try next path
    }
  }
  return null;
}

export function getDatabase(options = {}) {
  const engine = process.env.NAVIGATION_DATABASE_ENGINE || 'sqlite';
  if (engine !== 'sqlite') {
    throw Object.assign(new Error('当前运行时尚未接入所选数据库引擎'), { status: 503, code: 'DATABASE_ENGINE_UNAVAILABLE' });
  }
  const dbPath = resolveDbPath(options.dbPath);
  if (dbInstance && dbPathUsed === dbPath) {
    return dbInstance;
  }

  const Database = loadBetterSqlite3();
  if (!Database) {
    throw new Error('better-sqlite3 未安装，请在 portal 与 stock-manage 目录执行 npm install');
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('busy_timeout = 5000');
  dbPathUsed = dbPath;
  initSchema(dbInstance);
  runMigrations(dbInstance, options);
  return dbInstance;
}

export function getDbPath() {
  return dbPathUsed || resolveDbPath();
}

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPathUsed = null;
  }
}
