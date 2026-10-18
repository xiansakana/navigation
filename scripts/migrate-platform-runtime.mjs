import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDatabase, loadRbacBlob } from '../shared/db/index.js';
import { verifyPassword } from '../portal/src/rbac.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.existsSync(path.join(root, file)) ? JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) : {};
const portal = read('portal/config.json'), bot = read('qq-bot/config.json'), stock = read('stock-manage/config.json');
const db = getDatabase(), rbac = loadRbacBlob(db);
const admin = rbac?.users?.find(user => user.username === portal.auth?.username);
if (!admin?.enabled || !admin.salt || !admin.passwordHash) throw new Error('请先验证数据库管理员账号，再迁移认证配置');
if (portal.auth?.password && !verifyPassword(portal.auth.password, admin)) {
  throw new Error('配置密码与数据库管理员密码不同；请先核实管理员的数据库密码，避免移除旧登录回退后无法登录');
}
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
const active = (table, column, states) => tables.has(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${states.map(() => '?').join(',')})`).get(...states).n : 0;
const running = active('qq_codex_jobs', 'state', ['running']) + active('blog_video_uploads', 'state', ['compressing', 'storing']);
if (running) throw new Error('存在执行中的 Codex 或媒体任务；待任务结束后再切换执行进程');

function write(file, data) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + '.platform-migration.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
}
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ ok: true, adminReady: true, runningJobs: running, mode: 'check' }));
} else {
  const oldSource = fs.readFileSync(path.join(root, 'stock-manage/src/storage.js'), 'utf8');
  // One-time migration of old defaults; normal runtime no longer parses another service's source.
  const legacy = name => oldSource.match(new RegExp(name + "\\s*=\\s*'([^']+)'"))?.[1] || '';
  const integrations = read('data/integrations.json');
  integrations.finnhubApiKey ||= stock.finnhubApiKey || legacy('defaultFinnhub');
  integrations.polygonApiKey ||= stock.polygonApiKey || legacy('defaultPolygon');
  integrations.notifyToken ||= bot.server?.notifyToken || '';
  write('data/integrations.json', integrations);
  const codex = read('data/codex.json');
  const execution = Object.keys(codex).length ? codex : bot.codex || {};
  execution.externalExecutor = true;
  write('data/codex.json', execution);
  portal.auth ||= {};
  const oldSecret = portal.auth.sessionSecret;
  if (!oldSecret || oldSecret.length < 32 || /change-me|example|replace-me/i.test(oldSecret) || oldSecret === portal.auth.password) portal.auth.sessionSecret = crypto.randomBytes(48).toString('hex');
  portal.auth.secureCookies = true;
  portal.runtime = { ...portal.runtime, externalWorkers: true };
  write('portal/config.json', portal);
  write('data/platform-runtime-v1.json', {version:1,migratedAt:new Date().toISOString()});
  console.log(JSON.stringify({ ok: true, mode: 'applied', sessionKeyRotated: oldSecret !== portal.auth.sessionSecret }));
}
