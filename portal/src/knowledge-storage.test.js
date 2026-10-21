import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { createKnowledgeStore } from './knowledge-store.js';
import { OpenListStorage, archiveSource, hashFile, proxySource, sourcePath } from './knowledge-storage.js';
import { downloadVideo } from './knowledge-download.js';

const document = { title: 'test', bytes: 1024 * 1024 + 17, mimeType: 'video/mp4', originalName: 'private.mp4' };
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-cloud-'));
  const db = new Database(':memory:'), store = createKnowledgeStore(db);
  const item = store.create('owner', document), file = path.join(root, 'source');
  const data = crypto.randomBytes(item.bytes); await fs.writeFile(file, data);
  store.sources.add('owner', item.id, sourcePath({ rootPath: '/115/Library' }, 'owner', item), 'pending');
  const remote = new Map(); let corrupt = false, uploads = 0, failDelete = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/raw') {
      assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['user-agent'], 'NavigationKnowledge/1.0');
      let bytes = remote.values().next().value || Buffer.alloc(0);
      if (corrupt) bytes = Buffer.alloc(bytes.length);
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (match) { const start = +match[1], end = match[2] ? +match[2] : bytes.length - 1; res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 }); res.end(bytes.subarray(start, end + 1)); }
      else { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
      return;
    }
    assert.equal(req.headers.authorization, 'private-admin-token');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); let payload;
    if (req.url === '/api/fs/put') {
      const key = decodeURIComponent(req.headers['file-path']);
      assert.equal(req.headers['x-file-sha1'], crypto.createHash('sha1').update(body).digest('hex'));
      uploads++; remote.set(key, body);
    } else {
      const input = JSON.parse(body.toString());
      if (req.url === '/api/fs/list') {
        const entries = new Map();
        for (const [key, value] of remote) {
          if (!key.startsWith(input.path + '/')) continue;
          const relative = key.slice(input.path.length + 1), name = relative.split('/')[0];
          entries.set(name, { name, size: value.length, is_dir: relative.includes('/') });
        }
        payload = { content: [...entries.values()] };
      }
      if (req.url === '/api/fs/get') payload = { raw_url: `http://127.0.0.1:${server.address().port}/raw` };
      if (req.url === '/api/fs/remove') { if (failDelete) { res.end(JSON.stringify({ code: 500, message: 'private diagnostic' })); return; } remote.clear(); }
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: payload }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'private-admin-token', rootPath: '/115/Library' };
  try { await fn({ root, db, store, item, file, data, remote, storage: new OpenListStorage(config), config, corrupt: value => { corrupt = value; }, uploads: () => uploads, failDelete: value => { failDelete = value; } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); await fs.rm(root, { recursive: true, force: true }); }
}

test('cloud queue waits for verified source, protects owner, and survives lease expiry', async () => fixture(async ({ db, store, item }) => {
  store.enqueue('owner', item.id);
  store.heartbeatWorker('owner', { workerId: 'test-gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } });
  assert.equal(store.claim('owner', ['codex'], 'test-gpu'), null);
  assert.equal(store.sources.get('other', item.id), undefined);
  assert.equal(store.sources.retry('other', item.id), false);
  const s = store.sources.claim(); assert.ok(s.lease); assert.equal(store.sources.claim(), null);
  assert.throws(() => store.sources.deleting('owner', item.id), /稍后删除/);
  db.prepare('UPDATE knowledge_sources SET heartbeat=0').run();
  const resumed = store.sources.claim(); assert.notEqual(s.lease, resumed.lease);
  assert.equal(store.sources.update(s, { state: 'ready' }), false);
  store.sources.update(resumed, { state: 'ready', sha256: 'a'.repeat(64) }); store.sources.release(resumed);
  assert.equal(store.claim('owner', ['codex'], 'test-gpu').sourceSha256, 'a'.repeat(64));
}));

test('streamed upload requires full SHA256 verification before local cleanup; retries reuse remote object', async () => fixture(async ({ store, item, file, data, storage, corrupt, uploads }) => {
  let s = store.sources.claim(); corrupt(true);
  await assert.rejects(archiveSource(storage, store.sources, s, file), /完整性校验失败/);
  assert.deepEqual(await fs.readFile(file), data);
  store.sources.release(s); corrupt(false);
  s = store.sources.claim(); await archiveSource(storage, store.sources, s, file); store.sources.release(s);
  assert.equal(uploads(), 1); await assert.rejects(fs.access(file));
  const source = store.sources.get('owner', item.id); assert.equal(source.state, 'ready'); assert.ok(source.verified_at);
  assert.deepEqual(Object.keys(store.get('owner', item.id).storage).sort(), ['error', 'provider', 'state', 'timings', 'verifiedAt']);
  assert.ok(source.upload_started_at > 0 && source.verification_started_at > 0);
  assert.ok(source.upload_ms >= 0 && source.verification_ms >= 0);
  assert.deepEqual(store.get('owner', item.id).storage.timings, { uploadMs: source.upload_ms, verificationMs: source.verification_ms });
}));

test('verified checkpoint recovers cleanup after process restart without original', async () => fixture(async ({ store, item, file, data, storage, remote }) => {
  const hashes = await hashFile(file); let s = store.sources.claim();
  store.sources.update(s, { ...hashes, state: 'verified' }); store.sources.release(s);
  remote.set(s.object_path, data); await fs.rm(file);
  s = store.sources.claim(); await archiveSource(storage, store.sources, s, file);
  assert.equal(store.sources.get('owner', item.id).state, 'ready');
}));

test('cloud deletion tombstone hides document while retaining durable cleanup state', async () => fixture(async ({ store, item }) => {
  assert.equal(store.sources.deleting('other', item.id), false);
  assert.equal(store.sources.deleting('owner', item.id), true);
  assert.equal(store.get('owner', item.id), null); assert.equal(store.list('owner').total, 0);
  const s = store.sources.claim(); assert.equal(s.state, 'deleting');
  store.sources.update(s, { error: 'retry', next_retry: Date.now() + 60000 }); store.sources.release(s);
  assert.equal(store.sources.claim(), null); assert.ok(store.getRow('owner', item.id));
  store.remove('owner', item.id); assert.equal(store.sources.get('owner', item.id), undefined);
}));

test('worker resumes partial downloads, validates range and checks full source hash', async () => fixture(async ({ item, root, data }) => {
  const target = path.join(root, 'download'), split = 17000;
  await fs.writeFile(target + '.tmp', data.subarray(0, split));
  const job = { ...item, sourceSha256: crypto.createHash('sha256').update(data).digest('hex') };
  await downloadVideo(job, target, async range => {
    assert.equal(range, 'bytes=' + split + '-');
    return new Response(data.subarray(split), { status: 206, headers: { 'Content-Range': `bytes ${split}-${data.length - 1}/${data.length}` } });
  });
  assert.deepEqual(await fs.readFile(target), data);
  await fs.writeFile(target, Buffer.alloc(data.length));
  await assert.rejects(downloadVideo(job, target, async () => new Response(Buffer.alloc(data.length))), /完整性校验失败/);
  await fs.writeFile(target + '.tmp', data.subarray(0, split));
  await assert.rejects(downloadVideo(job, target, async () => new Response(data.subarray(split), { status: 206, headers: { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` } })), /续传范围无效/);
}));

test('source object names cannot escape owner or document directories', () => {
  const config = { rootPath: '/115/Library' }, doc = { id: 'a'.repeat(32), mimeType: 'video/mp4', originalName: '../../other.mp4' };
  assert.match(sourcePath(config, 'owner', doc), /^\/115\/Library\/[a-f0-9]{24}\/[a-f0-9]{32}\/source.mp4$/);
  assert.notEqual(sourcePath(config, 'owner', doc), sourcePath(config, 'other', doc));
  const storage = new OpenListStorage(config);
  assert.throws(() => storage.validatePath('/115/Library/../../other'), /路径无效/);
});

test('failed cloud deletion keeps object and can retry without broad directory removal', async () => fixture(async ({ store, item, storage, remote, data, failDelete }) => {
  const source = store.sources.get('owner', item.id); remote.set(source.object_path, data);
  failDelete(true); await assert.rejects(storage.remove(source.object_path), /115暂时不可用/); assert.equal(remote.size, 1);
  failDelete(false); await storage.remove(source.object_path); assert.equal(remote.size, 0);
  await storage.remove(source.object_path); assert.equal(remote.size, 0);
}));

test('terminated video transfers retry from saved bytes and stop after bounded attempts', async () => fixture(async ({ root, data, item }) => {
  const target = path.join(root, 'automatic-resume'), split = 13007;
  const job = { ...item, sourceSha256: crypto.createHash('sha256').update(data).digest('hex') };
  await fs.writeFile(target + '.tmp', data.subarray(0, split));
  let calls = 0;
  await downloadVideo(job, target, async range => {
    calls++; assert.equal(range, 'bytes=' + split + '-');
    if (calls === 1) throw new TypeError('terminated');
    return new Response(data.subarray(split), { status: 206, headers: { 'Content-Range': `bytes ${split}-${data.length - 1}/${data.length}` } });
  });
  assert.equal(calls, 2); assert.deepEqual(await fs.readFile(target), data);
  calls = 0;
  await assert.rejects(downloadVideo(job, target + '-failed', async () => { calls++; throw new TypeError('terminated'); }), /已自动续传重试2次/);
  assert.equal(calls, 3);
  calls = 0;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadVideo(job, target + '-aborted', async () => { calls++; throw new TypeError('terminated'); }, controller.signal), /terminated/);
  assert.equal(calls, 1);
}));

test('interrupted download leaves reusable bytes and handles servers ignoring Range', async () => fixture(async ({ root, data, item }) => {
  const target = path.join(root, 'interrupted'), split = 13007;
  const job = { ...item, sourceSha256: crypto.createHash('sha256').update(data).digest('hex') };
  await assert.rejects(downloadVideo(job, target, async () => new Response(data.subarray(0, split))), /下载不完整/);
  assert.equal((await fs.stat(target + '.tmp')).size, split);
  await downloadVideo(job, target, async range => { assert.equal(range, 'bytes=' + split + '-'); return new Response(data); });
  assert.deepEqual(await fs.readFile(target), data);
}));

test('authenticated proxy preserves byte ranges and never exposes cloud credentials or redirects', async () => fixture(async ({ root, config, store, item, remote, data }) => {
  const previous = process.env.KNOWLEDGE_STORAGE_CONFIG;
  const file = path.join(root, 'storage.json');
  await fs.writeFile(file, JSON.stringify({ users: { owner: config } })); process.env.KNOWLEDGE_STORAGE_CONFIG = file;
  const source = store.sources.get('owner', item.id); remote.set(source.object_path, data);
  const proxy = http.createServer((req, res) => proxySource(req, res, 'owner', source, 'video/mp4'));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}`, { headers: { Range: 'bytes=123-999' } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes 123-999/${data.length}`);
    assert.equal(response.headers.get('location'), null); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(123, 1000));
  } finally {
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    if (previous === undefined) delete process.env.KNOWLEDGE_STORAGE_CONFIG; else process.env.KNOWLEDGE_STORAGE_CONFIG = previous;
  }
}));
