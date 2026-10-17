import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { handleKnowledgeApi, handleKnowledgeWorkerApi, validateKnowledgeResult } from './knowledge.js';
import { createKnowledgeStore, CHUNK_BYTES, MAX_VIDEO_BYTES } from './knowledge-store.js';
import { SYSTEM_PERMISSIONS, buildMenusFromServices, getVisibleMenus } from './rbac.js';
import { resolveLoggedInPermissions } from './auth.js';
import { canonicalPortalPagePath, resolveRoute } from './router.js';

const member = uid => ({ userId: uid, permissions: resolveLoggedInPermissions({ roles: [] }, { id: uid, username: uid }) });
const upload = overrides => ({ title: '课程 %_ 笔记', topic: '课程', tags: ['学习'], bytes: 24, mimeType: 'video/mp4', originalName: 'lesson.mp4', backend: 'codex', ...overrides });
const video = size => { const data = Buffer.alloc(size, 1); data.write('ftyp', 4); return data; };
const result = overrides => ({ duration: 90, language: 'zh', notes: '# 详细笔记\n\n这是依据视频转写和课件形成的完整学习笔记，区分作者观点与案例事实，含适用条件和时间导航。',
  transcript: [{ start: 1, end: 8, text: '仅在转写中的独有检索词' }], frames: [], provenance: { backend: 'codex', model: 'test-model', vision: true }, ...overrides });
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
  const previous = { db: process.env.NAVIGATION_DB_PATH, dir: process.env.KNOWLEDGE_DATA_DIR };
  process.env.NAVIGATION_DB_PATH = path.join(root, 'db.sqlite'); process.env.KNOWLEDGE_DATA_DIR = path.join(root, 'media');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host), json = (r, status, value) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(value)); };
    const session = req.headers['x-test-session'] ? JSON.parse(req.headers['x-test-session']) : member('a');
    const work = url.pathname.startsWith('/api/knowledge/worker/')
      ? handleKnowledgeWorkerApi(req, res, url, json, uid => uid !== 'revoked') : handleKnowledgeApi(req, res, url, session, json);
    work.catch(e => { res.writeHead(500); res.end(e.message); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const call = async (route, { method = 'GET', data, session, token, lease, headers = {}, binary } = {}) => {
    const response = await fetch(origin + '/api/knowledge' + route, { method, headers: { ...(session ? { 'X-Test-Session': JSON.stringify(session) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(lease ? { 'X-Knowledge-Lease': lease } : {}), ...headers }, body: binary || (data === undefined ? undefined : JSON.stringify(data)) });
    const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, payload, headers: response.headers };
  };
  try { await fn({ call, store: createKnowledgeStore(getDatabase()), db: getDatabase(), root, origin, server }); }
  finally {
    await new Promise(resolve => server.close(resolve)); closeDatabase();
    for (const [key, value] of [['NAVIGATION_DB_PATH', previous.db], ['KNOWLEDGE_DATA_DIR', previous.dir]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true });
  }
}

test('knowledge routes, per-action permissions, default member grants and guest isolation', async () => {
  const permissions = SYSTEM_PERMISSIONS.filter(p => p.id.startsWith('knowledge:'));
  assert.ok(permissions.length >= 12);
  for (const p of permissions) { assert.deepEqual(p.permissionPath.slice(0, 2), ['首页', '知识库']); assert.ok(member('a').permissions.includes(p.id)); }
  const menus = buildMenusFromServices([]);
  assert.equal(getVisibleMenus({ menus }, member('a').permissions).find(m => m.serviceId === 'knowledge').path, '/knowledge/');
  assert.ok(!getVisibleMenus({ menus }, []).some(m => m.serviceId === 'knowledge'));
  for (const route of ['/knowledge', '/knowledge/', '/knowledge/index.html']) {
    assert.equal(canonicalPortalPagePath(route), '/knowledge/');
    assert.equal(resolveRoute([], route, 'GET', '', { referer: 'https://site/napcat/' }).kind, 'pass');
  }
  assert.equal(resolveRoute([], '/api/knowledge/documents', 'GET', '', { referer: 'https://site/napcat/' }).kind, 'portal-api');
  await fixture(async ({ call }) => {
    for (const session of [{}, { userId: 'a', permissions: [] }, { ...member('a'), isGuest: true, permissions: ['*'] }]) assert.equal((await call('/documents', { session })).status, 403);
    assert.equal((await call('/documents', { session: { userId: 'a', permissions: ['knowledge:view'] } })).status, 403);
    assert.equal((await call('/documents', { method: 'POST', data: upload(), headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/documents', { method: 'POST', data: upload(), headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  });
});

test('115 source status is private to owner and archive retry enforces its own permission', async () => fixture(async ({ call, store }) => {
  const item = store.create('a', upload());
  store.sources.add('a', item.id, '/115/private/object', 'pending');
  const source = store.sources.claim();
  store.sources.update(source, { state: 'failed', error: 'safe error' }); store.sources.release(source);
  const route = '/documents/' + item.id;
  assert.equal((await call(route, { session: member('b') })).status, 404);
  const publicDocument = (await call(route)).payload.document;
  assert.equal(publicDocument.storage.provider, '115');
  assert.ok(!JSON.stringify(publicDocument).includes('/115/private'));
  assert.equal((await call(route + '/storage-retry', { method: 'POST', session: { userId: 'a', permissions: ['knowledge:view', 'knowledge:upload:edit'] } })).status, 403);
  assert.equal((await call(route + '/storage-retry', { method: 'POST', session: member('b') })).status, 404);
  assert.equal((await call(route + '/storage-retry', { method: 'POST' })).status, 202);
  assert.equal(store.sources.get('a', item.id).state, 'pending');
  assert.equal((await call(route + '/storage-retry', { method: 'POST' })).status, 409);
}));

test('upload, range playback, durable jobs, owner isolation, worker leases, edits and deletion', async () => fixture(async ({ call, store, db }) => {
  const created = await call('/documents', { method: 'POST', data: upload({ userId: 'b', bytes: CHUNK_BYTES + 24 }) });
  assert.equal(created.status, 201); const id = created.payload.document.id;
  const data = video(CHUNK_BYTES + 24);
  const prefix = '/documents/' + id;
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await call(prefix, { method, session: member('b'), ...(method === 'PUT' ? { data: {} } : {}) })).status, 404);
  assert.equal((await call(prefix, { session: { userId: 'other-admin', permissions: ['*'] } })).status, 404);
  assert.equal((await call(prefix + '/parts/1', { method: 'PUT', binary: data.subarray(0, CHUNK_BYTES) })).status, 200);
  assert.equal((await call(prefix + '/complete', { method: 'POST', data: {} })).status, 400);
  assert.equal((await call(prefix + '/parts/2', { method: 'PUT', binary: data.subarray(CHUNK_BYTES) })).status, 200);
  assert.equal((await call(prefix + '/parts')).payload.parts.length, 2);
  assert.equal((await call(prefix + '/complete', { method: 'POST', data: {} })).status, 202);
  assert.equal((await call(prefix + '/complete', { method: 'POST', data: {} })).status, 409);
  const playback = await call(prefix + '/source'); assert.deepEqual(playback.payload, data);
  const range = await call(prefix + '/source', { headers: { Range: 'bytes=4-7' } }); assert.equal(range.status, 206); assert.equal(range.payload.toString(), 'ftyp');
  assert.equal((await call(prefix + '/source', { headers: { Range: 'bytes=99999999-' } })).status, 416);
  const token = (await call('/worker-token', { method: 'POST', data: {} })).payload.token;
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM knowledge_workers').all()).includes(token));
  assert.equal((await call('/worker/claim', { method: 'POST', data: {} })).status, 401);
  const bToken = store.rotateToken('b');
  assert.equal((await call('/worker/claim', { method: 'POST', token: bToken, data: { backends: ['codex'] } })).payload.job, null);
  const claimed = await call('/worker/claim', { method: 'POST', token, data: { backends: ['codex'] } }); const job = claimed.payload.job;
  assert.equal(job.id, id); assert.ok(job.lease);
  assert.equal((await call('/worker/claim', { method: 'POST', token, data: { backends: ['codex'] } })).payload.job, null);
  assert.equal((await call('/worker/jobs/' + id + '/complete', { method: 'POST', token: bToken, lease: job.lease, data: result() })).status, 409);
  assert.equal((await call('/worker/jobs/' + id + '/complete', { method: 'POST', token, lease: 'wrong', data: result() })).status, 409);
  assert.equal((await call('/worker/jobs/' + id + '/source', { token, lease: job.lease })).payload.length, data.length);
  assert.equal((await call(prefix, { method: 'PUT', data: { title: '修改', revision: 0 } })).status, 409);
  assert.equal((await call('/worker/jobs/' + id + '/complete', { method: 'POST', token, lease: job.lease, data: result() })).status, 200);
  const ready = (await call(prefix)).payload.document; assert.equal(ready.status, 'ready'); assert.equal(ready.revision, 1);
  assert.equal((await call('/documents?search=' + encodeURIComponent('独有检索词'))).payload.total, 1);
  const limited = { userId: 'a', permissions: ['knowledge:view', 'knowledge:notes:view'] };
  assert.equal((await call('/documents?search=' + encodeURIComponent('独有检索词'), { session: limited })).payload.total, 0);
  assert.deepEqual((await call(prefix, { session: limited })).payload.document.transcript, []);
  assert.equal((await call(prefix + '/source', { session: limited })).status, 403);
  assert.equal((await call('/documents?search=' + encodeURIComponent('%_'))).payload.total, 1);
  assert.equal((await call('/documents', { session: member('b') })).payload.total, 0);
  assert.equal((await call(prefix + '/export')).headers.get('content-type'), 'text/markdown; charset=utf-8');
  const edited = await call(prefix, { method: 'PUT', data: { title: '已校正', topic: '研究', tags: ['复习'], notes: ready.notes + '\n已核对', revision: 1 } });
  assert.equal(edited.status, 200); assert.equal(edited.payload.document.revision, 2);
  assert.equal((await call(prefix, { method: 'PUT', data: { title: '过时', revision: 1 } })).status, 409);
  assert.equal((await call(prefix, { method: 'DELETE' })).status, 200);
  assert.equal((await call(prefix)).status, 404); assert.equal((await call(prefix + '/source')).status, 404);
}));

test('expired and revoked worker leases cannot overwrite retried or deleted documents', async () => fixture(async ({ store, db, call }) => {
  const d = store.create('a', upload()); store.enqueue('a', d.id);
  const old = store.claim('a', ['codex']);
  db.prepare('UPDATE knowledge_documents SET heartbeat=? WHERE id=?').run('2000-01-01T00:00:00Z', d.id);
  store.expire('a'); assert.equal(store.get('a', d.id).status, 'failed');
  assert.ok(store.retry('a', d.id, 'openai'));
  assert.equal(store.claim('a', ['codex']), null);
  const current = store.claim('a', ['openai']); assert.notEqual(current.lease, old.lease);
  assert.equal(store.finish('a', d.id, old.lease, result()), false);
  store.rotateToken('a'); assert.equal(store.get('a', d.id).status, 'failed');
  assert.equal(store.progress('a', d.id, current.lease, '迟到进度', 80), false);
  const token = store.rotateToken('revoked');
  assert.equal((await call('/worker/heartbeat', { method: 'POST', data: {}, token })).status, 403);
}));

test('a slow chunk body does not block another chunk and merged playback remains byte-identical', async () => fixture(async ({ call, origin, server }) => {
  const created = await call('/documents', { method: 'POST', data: upload({ bytes: CHUNK_BYTES + 24 }) });
  assert.equal(created.status, 201);
  const route = '/documents/' + created.payload.document.id, data = video(CHUNK_BYTES + 24);
  const arrived = new Promise(resolve => server.once('request', req => req.once('data', resolve)));
  const slow = http.request(origin + '/api/knowledge' + route + '/parts/1', { method: 'PUT', headers: { 'Content-Length': CHUNK_BYTES } });
  const completed = new Promise((resolve, reject) => { slow.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); slow.on('error', reject); });
  slow.write(data.subarray(0, 8));
  await arrived;
  try {
    const second = await fetch(origin + '/api/knowledge' + route + '/parts/2', { method: 'PUT', body: data.subarray(CHUNK_BYTES), signal: AbortSignal.timeout(3000) });
    assert.equal(second.status, 200); await second.arrayBuffer();
  } finally { slow.end(data.subarray(8, CHUNK_BYTES)); }
  assert.equal(await completed, 200);
  assert.equal((await call(route + '/complete', { method: 'POST', data: {} })).status, 202);
  assert.deepEqual((await call(route + '/source')).payload, data);
}));

test('GPU heartbeat reserves queued work, CPU fallback resumes after 90 seconds without taking active leases', async () => fixture(async ({ store, db, call }) => {
  const token = store.rotateToken('a');
  const caps = device => ({ media: { ready: true, detail: device }, codex: { ready: true }, openai: { ready: false } });
  await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'gpu', label: '本机 GPU', capabilities: caps('cuda') } });
  await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'cpu', label: 'ECS', capabilities: caps('cpu') } });
  assert.equal(store.worker('a').label, '本机 GPU');
  assert.equal(store.worker('a').workers.length, 2);
  const d = store.create('a', upload()); store.enqueue('a', d.id);
  assert.equal(store.claim('a', ['codex'], 'cpu'), null);
  assert.equal(store.claim('a', ['codex']), null, 'old CPU clients also yield to the GPU');
  const claimed = await call('/worker/claim', { method: 'POST', token, data: { workerId: 'gpu', backends: ['codex'] } });
  assert.equal(claimed.payload.job.id, d.id);
  db.prepare('UPDATE knowledge_worker_instances SET last_seen=? WHERE worker_id=?').run(new Date(Date.now() - 91000).toISOString(), 'gpu');
  assert.equal(store.claim('a', ['codex'], 'cpu'), null, 'an active lease is never transferred');
  assert.ok(store.finish('a', d.id, claimed.payload.job.lease, result()));
  const next = store.create('a', upload()); store.enqueue('a', next.id);
  assert.equal(store.claim('a', ['codex'], 'cpu').id, next.id);
  store.rotateToken('a');
  assert.equal(store.worker('a').workers.length, 0);
}));

test('GPU priority respects account isolation, readiness and backend compatibility', async () => fixture(async ({ store }) => {
  store.rotateToken('a'); store.rotateToken('b');
  store.heartbeatWorker('a', { workerId: 'gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } });
  const other = store.create('b', upload()); store.enqueue('b', other.id);
  assert.equal(store.claim('b', ['codex'], 'cpu').id, other.id);
  const api = store.create('a', upload({ backend: 'openai' })); store.enqueue('a', api.id);
  assert.equal(store.claim('a', ['openai'], 'cpu').id, api.id, 'GPU without this backend cannot reserve it');
  store.rotateToken('a');
  store.heartbeatWorker('a', { workerId: 'gpu', capabilities: { media: { ready: false, detail: 'cuda' }, codex: { ready: true } } });
  const d = store.create('a', upload()); store.enqueue('a', d.id);
  assert.equal(store.claim('a', ['codex'], 'cpu').id, d.id, 'an unhealthy GPU does not block CPU');
}));

test('validation rejects bad formats, excessive video sizes and fabricated timestamps', () => {
  assert.throws(() => validateKnowledgeResult(result({ transcript: [{ start: -1, end: 2, text: 'x' }] })));
  assert.throws(() => validateKnowledgeResult(result({ transcript: [{ start: 4, end: 95, text: 'x' }] })));
  assert.throws(() => validateKnowledgeResult(result({ notes: '' })));
  assert.throws(() => validateKnowledgeResult(result({ frames: [{ time: 2, data: Buffer.from('not-jpeg').toString('base64') }] })));
  assert.equal(validateKnowledgeResult(result()).provenance.backend, 'codex');
  assert.equal(MAX_VIDEO_BYTES, 1024 ** 3);
  assert.equal(crypto.createHash('sha256').update('token').digest('hex').length, 64);
});
