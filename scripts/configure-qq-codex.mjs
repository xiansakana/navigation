import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, loadRbacBlob, closeDatabase } from '../shared/db/index.js';
import { hasPermission, resolveUserPermissions } from '../portal/src/rbac.js';
import { runCommand, syncProject } from '../qq-bot/src/codex-runner.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux') throw new Error('此初始配置脚本仅在ECS运行');
const file = path.join(repo, 'qq-bot/config.json'), original = await fs.readFile(file, 'utf8'), config = JSON.parse(original);
if (config.codex?.enabled) throw new Error('QQ Codex已配置，请直接检查现有配置；未覆盖');
if (config.defaultTarget?.type !== 'private' || !/^\d{5,20}$/.test(String(config.defaultTarget.userId || ''))) throw new Error('请先配置所有者的默认私聊QQ目标');
const db = getDatabase(), binding = db.prepare('SELECT user_id,qq_id FROM bookkeeping_qq_bindings WHERE qq_id=?').get(String(config.defaultTarget.userId));
const rbac = loadRbacBlob(db), user = rbac?.users?.find(u => u.id === binding?.user_id);
if (!user || user.enabled === false || user.username === 'guest' || !hasPermission(resolveUserPermissions(rbac, user), 'admin:access')) throw new Error('默认私聊目标必须已经绑定启用的Portal管理员，未自动授权其他账号');
const remote = await runCommand('git', ['remote', 'get-url', 'origin'], { cwd: repo });
const project = { directory: '/var/lib/qq-codex/projects/navigation', remote, branch: 'main' };
await syncProject(project);
await runCommand('git', ['config', 'user.name', 'QQ Codex'], { cwd: project.directory });
await runCommand('git', ['config', 'user.email', 'qq-codex@localhost'], { cwd: project.directory });
const backup = path.join(repo, 'qq-bot/data/codex');
await fs.mkdir(backup, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(backup, 'config-before-' + Date.now() + '.json'), original, { mode: 0o600 });
config.codex = { enabled: true, binary: '/usr/bin/codex', proxyUrl: 'http://127.0.0.1:17890', sandbox: 'danger-full-access',
  defaultProject: 'navigation', timeoutMs: 7200000, logDirectory: '/var/lib/qq-codex/logs',
  allowedUsers: [{ userId: user.id, qqId: binding.qq_id, projects: ['navigation'] }], projects: { navigation: project } };
await fs.writeFile(file + '.tmp', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
await fs.rename(file + '.tmp', file); await fs.chmod(file, 0o600);
closeDatabase();
console.log('已为现有绑定的管理员启用QQ Codex；Git代码和AGENTS.md同步完成，未显示凭据或发送消息。');
