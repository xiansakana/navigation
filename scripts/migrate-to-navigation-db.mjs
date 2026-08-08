#!/usr/bin/env node
/**
 * 手动将 portal/data/rbac.json 与 stock-manage/data/portfolio.json 导入 data/navigation.db。
 * 若 DB 中已有对应数据则跳过（不会覆盖）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDatabase,
  resolveDbPath,
  defaultRbacJsonPath,
  defaultPortfolioJsonPath,
  hasRbacData,
  importPortfolioJson,
  loadRbacBlob,
  saveRbacBlob
} from '../shared/db/index.js';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const dbPath = resolveDbPath(process.argv[2] || undefined);
const db = getDatabase({ dbPath });

let changed = false;

if (!hasRbacData(db)) {
  const rbacJson = defaultRbacJsonPath();
  if (fs.existsSync(rbacJson)) {
    const payload = fs.readFileSync(rbacJson, 'utf8');
    saveRbacBlob(db, JSON.parse(payload));
    console.log('imported RBAC from', rbacJson);
    changed = true;
  } else {
    console.log('skip RBAC: no existing', rbacJson);
  }
} else {
  console.log('skip RBAC: already in DB');
}

const tradeCount = db.prepare('SELECT COUNT(*) AS c FROM trades').get().c;
if (tradeCount === 0) {
  const portfolioJson = defaultPortfolioJsonPath();
  if (importPortfolioJson(db, portfolioJson)) {
    console.log('imported portfolio from', portfolioJson);
    changed = true;
  } else {
    console.log('skip portfolio: no existing', portfolioJson);
  }
} else {
  console.log('skip portfolio: already in DB (', tradeCount, 'trades)');
}

if (!changed) {
  console.log('nothing to migrate');
} else {
  console.log('done ->', dbPath);
}
