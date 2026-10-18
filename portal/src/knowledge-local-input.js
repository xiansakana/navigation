import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function localDocuments(root) {
  const found = [];
  for (const name of await fsp.readdir(root)) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    try {
      const dir = path.join(root, name), info = JSON.parse(await fsp.readFile(path.join(dir, 'local-input.json'), 'utf8'));
      if ((await fsp.stat(path.join(dir, 'source'))).size === info.bytes && /^[a-f0-9]{64}$/.test(info.sha256)) found.push(name);
    } catch { /* Incomplete/deleted caches aren't advertised. */ }
    if (found.length >= 200) break;
  }
  return found;
}

export async function verifyLocalInput(root, job) {
  const file = path.join(root, job.id, 'source');
  try {
    if (!/^[a-f0-9]{64}$/.test(job.sourceSha256) || (await fsp.stat(file)).size !== job.bytes) return false;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === job.sourceSha256;
  } catch { return false; }
}

export async function pruneLocalInputs(root) {
  const base = path.resolve(root);
  for (const entry of await fsp.readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = path.resolve(base, entry.name);
    if (!directory.startsWith(base + path.sep)) continue;
    try {
      const info = await fsp.stat(path.join(directory, 'local-input.json'));
      if (Date.now() - info.mtimeMs > 86400000) await fsp.rm(directory, { recursive: true, force: true });
    } catch { /* Only local input caches are eligible, never unrelated folders. */ }
  }
}

export async function startLocalInputServer({ portalOrigin, workerId, workRoot, authorize, ready, port = 17891 }) {
  let receiving = false;
  const server = http.createServer(async (req, res) => {
    const answer = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
    if (req.headers.origin !== portalOrigin || !['127.0.0.1', '127.0.0.1:' + server.address().port].includes(req.headers.host)) return answer(403, { ok: false });
    res.setHeader('Access-Control-Allow-Origin', portalOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && req.url === '/health') return answer(200, { ok: ready(), workerId });
    const match = /^\/inputs\/([a-f0-9]{32})$/.exec(req.url || '');
    const ticket = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    if (req.method !== 'POST' || !match || !ticket) return answer(403, { ok: false });
    if (receiving || !ready()) return answer(409, { ok: false, error: '本机工作器暂不可接收' });
    receiving = true;
    const documentId = match[1], directory = path.join(workRoot, documentId), temp = path.join(directory, 'local-source.tmp');
    let committed = false, prepared = false;
    try {
      const info = await authorize({ documentId, ticket });
      if (!Number.isSafeInteger(info.bytes) || info.bytes <= 0 || info.bytes > 1024 ** 3) throw new Error('视频大小无效');
      const disk = await fsp.statfs(workRoot);
      if (disk.bavail * disk.bsize < info.bytes + 2 * 1024 ** 3) throw new Error('本机缓存空间不足');
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 }); prepared = true;
      let count = 0; const hash = crypto.createHash('sha256');
      const check = new Transform({ transform(chunk, _, cb) { count += chunk.length; if (count > info.bytes) return cb(new Error('视频大小不符')); hash.update(chunk); cb(null, chunk); } });
      await pipeline(req, check, fs.createWriteStream(temp, { mode: 0o600 }));
      if (count !== info.bytes) throw new Error('本机视频未接收完整');
      const sha256 = hash.digest('hex');
      await fsp.rename(temp, path.join(directory, 'source'));
      await fsp.writeFile(path.join(directory, 'local-input.json'), JSON.stringify({ sha256, bytes: count }), { mode: 0o600 });
      await authorize({ documentId, ticket, sha256 }); committed = true;
      answer(200, { ok: true });
    } catch (e) {
      if (prepared && !committed) {
        for (const name of ['local-source.tmp', 'local-input.json', 'source']) await fsp.rm(path.join(directory, name), { force: true }).catch(() => {});
      }
      answer(400, { ok: false, error: '本机视频接收失败，将使用服务器流程' });
    } finally { receiving = false; }
  });
  server.requestTimeout = 300000;
  server.isReceiving = () => receiving;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
