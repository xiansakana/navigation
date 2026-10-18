import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const workerPackageFiles = [
  'scripts/knowledge-worker.mjs', 'scripts/start-knowledge-worker.ps1', 'scripts/install-knowledge-worker.ps1',
  'scripts/setup-knowledge-worker.ps1', 'scripts/knowledge-worker-launcher.mjs', 'scripts/knowledge-worker-pair.mjs',
  'scripts/knowledge-worker-setup.cmd', 'portal/src/knowledge-model.js', 'portal/src/knowledge-visual-evidence.js', 'portal/src/knowledge-download.js',
  'portal/workers/video_evidence.py', 'portal/workers/video_runtime.py', 'portal/workers/requirements.txt'
];
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Deterministic uncompressed ZIP: no archiver executable, dependencies or private files.
export function zipFiles(entries) {
  const chunks = [], central = []; let offset = 0;
  for (const [name, contents] of entries) {
    if (!/^[\w./-]+$/.test(name) || name.includes('..') || name.startsWith('/')) throw new Error('Invalid package path');
    const filename = Buffer.from(name), data = Buffer.from(contents), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(33, 14);
    index.writeUInt32LE(crc, 16); index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24); index.writeUInt16LE(filename.length, 28); index.writeUInt32LE(offset, 42);
    chunks.push(header, filename, data); central.push(index, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
let cached;
export function knowledgeWorkerPackage(binding = null) {
  const stamp = workerPackageFiles.map(f => fs.statSync(path.join(root, f)).mtimeMs).join(':');
  if (!binding && cached?.stamp === stamp) return cached;
  const entries = workerPackageFiles.map(f => [f, fs.readFileSync(path.join(root, f))]);
  entries.push(['package.json', JSON.stringify({ type: 'module', private: true })]);
  const version = crypto.createHash('sha256').update(Buffer.concat(entries.map(([, b]) => Buffer.from(b)))).digest('hex');
  entries.push(['worker-version.json', JSON.stringify({ version })]);
  if (binding) entries.push(['worker-pairing.json', JSON.stringify(binding)]);
  entries.push(['README.txt', 'Windows x64: extract this ZIP, then double-click scripts/knowledge-worker-setup.cmd.\r\nDependencies are installed per user. NVIDIA GPU is used when available.\r\nConfirm the pairing code in your knowledge library. Codex may require a separate login.\r\n']);
  const buffer = zipFiles(entries);
  const result = { stamp, buffer, version, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
  if (!binding) cached = result;
  return result;
}
export function sendWorkerPackage(res, binding = null) {
  const p = knowledgeWorkerPackage(binding);
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': p.bytes, 'Content-Disposition': 'attachment; filename="Navigation-Knowledge-Worker-Windows.zip"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(p.buffer);
}
