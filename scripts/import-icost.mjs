import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDatabase, closeDatabase } from '../shared/db/index.js';
import { loadConfig } from '../portal/src/config.js';
import { loadRbac, findUserByUsername, resolveUserPermissions } from '../portal/src/rbac.js';
import { canBookkeep } from '../portal/src/bookkeeping.js';
import { parseIcost } from '../portal/src/bookkeeping-import.js';
import { createBookkeepingStore } from '../portal/src/bookkeeping-store.js';

export async function importForUser({ username, file, accountsFile, dryRun = false }) {
  const config = loadConfig(), rbac = loadRbac(config), user = findUserByUsername(rbac, username);
  if (!user || user.enabled === false || (user.roleIds || []).includes('role_guest')) throw new Error('指定用户不存在、被禁用或属于游客');
  const session = { userId: user.id, permissions: resolveUserPermissions(rbac, user) };
  for (const permission of ['view', 'import:edit', 'accounts:edit']) if (!canBookkeep(session, permission)) throw new Error('指定用户缺少记账权限：' + permission);
  const parsed = await parseIcost(fs.readFileSync(file));
  if (parsed.errors.length) throw new Error('导入验证失败：' + JSON.stringify(parsed.errors.slice(0, 10)));
  const data = accountsFile ? JSON.parse(fs.readFileSync(accountsFile, 'utf8')) : [];
  const accounts = Array.isArray(data) ? data : data.accounts;
  if (!Array.isArray(accounts)) throw new Error('账户快照格式无效');
  if (dryRun) return { username, userId: user.id, rows: parsed.rows.length, accounts: accounts.length, warnings: parsed.warnings };
  const store = createBookkeepingStore(getDatabase());
  return { username, userId: user.id, ...store.importRows(user.id, parsed.rows, accounts) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = key => args[args.indexOf(key) + 1];
  try {
    if (!args.includes('--user') || !args.includes('--file')) throw new Error('用法：node scripts/import-icost.mjs --user <用户名> --file <xlsx> [--accounts <json>] [--dry-run]');
    console.log(JSON.stringify(await importForUser({ username: value('--user'), file: value('--file'), accountsFile: args.includes('--accounts') ? value('--accounts') : null, dryRun: args.includes('--dry-run') }), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; } finally { closeDatabase(); }
}
