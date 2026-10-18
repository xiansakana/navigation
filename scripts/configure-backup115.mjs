import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'data/backup115.json');
if (!fs.existsSync(target)) {
  const source = JSON.parse(fs.readFileSync(process.env.KNOWLEDGE_STORAGE_CONFIG || path.join(root, 'portal/data/knowledge-storage.json'), 'utf8'));
  const users = Object.keys(source.users || {});
  if (users.length !== 1) throw new Error('请在 data/backup115.json 明确选择备份使用的115账号');
  fs.writeFileSync(target, JSON.stringify({ userId: users[0], rootPath: '/115/Navigation-Backups' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log('115备份配置已就绪；凭据未输出');
