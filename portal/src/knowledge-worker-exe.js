import fs from 'node:fs';
import crypto from 'node:crypto';
import { knowledgeWorkerPackage } from './knowledge-worker-package.js';

export function knowledgeWorkerExe(binding = null) {
  const template = fs.readFileSync(new URL('../assets/knowledge-worker/bootstrap.exe', import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(new URL('../assets/knowledge-worker/bootstrap.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../../scripts/windows-worker/Installer.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  if (sha(template) !== manifest.sha256 || sha(source) !== manifest.sourceSha256 || template.toString('ascii', 0, 2) !== 'MZ') throw new Error('安装程序校验失败');
  const pkg = knowledgeWorkerPackage();
  const metadata = Buffer.from(JSON.stringify({ sha256: pkg.sha256, binding }));
  const footer = Buffer.alloc(16); footer.writeUInt32LE(pkg.bytes, 0); footer.writeUInt32LE(metadata.length, 4); footer.write('NKWEXE01', 8, 'ascii');
  return Buffer.concat([template, pkg.buffer, metadata, footer]);
}
export function sendWorkerExe(res, binding) {
  const exe = knowledgeWorkerExe(binding);
  res.writeHead(200, { 'Content-Type': 'application/vnd.microsoft.portable-executable', 'Content-Disposition': 'attachment; filename="Navigation-Knowledge-Worker-Setup.exe"', 'Content-Length': exe.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(exe);
}
