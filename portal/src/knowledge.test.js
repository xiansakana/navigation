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

test('reanalysis previews, queues once, reuses evidence, preserves old images and restores history without changing ownership', async () => fixture(async ({ call, store, db, root }) => {
  const token = store.rotateToken('a'), doc = store.create('a', upload()), directory = path.join(root, 'media', doc.id);
  fs.mkdirSync(directory, { recursive: true });
  const oldImage = Buffer.alloc(24, 1); oldImage[0] = 255; oldImage[1] = 216; oldImage[2] = 255;
  fs.writeFileSync(path.join(directory, 'frame-1.jpg'), oldImage);
  const original = result({ frames: [{ name: 'frame-1.jpg', time: 5 }] });
  db.prepare("UPDATE knowledge_documents SET status='ready',notes=?,transcript_json=?,frames_json=?,duration=90 WHERE id=?").run(original.notes, JSON.stringify(original.transcript), JSON.stringify(original.frames), doc.id);
  const prefix = '/documents/' + doc.id, revision = store.get('a', doc.id).revision;
  const preview = await call(prefix + '/reanalyze', { method: 'POST', data: { revision, mode: 'reuse', preview: true } });
  assert.equal(preview.payload.accepted, 1); assert.equal(store.get('a', doc.id).status, 'ready');
  assert.equal(store.reanalysis.list('a', doc.id).length, 0);
  const denied = { userId: 'a', permissions: ['knowledge:view', 'knowledge:notes:view', 'knowledge:process:edit'] };
  assert.equal((await call(prefix + '/reanalyze', { method: 'POST', data: { revision }, session: denied })).status, 403);
  assert.equal((await call(prefix + '/reanalyze', { method: 'POST', data: { revision }, session: member('b') })).status, 404);
  assert.equal((await call(prefix + '/reanalyze', { method: 'POST', data: { revision }, headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call(prefix + '/reanalyze', { method: 'POST', data: { revision } })).payload.accepted, 1);
  assert.equal((await call(prefix + '/reanalyze', { method: 'POST', data: { revision } })).payload.skipped, 1);
  assert.equal(store.get('a', doc.id).notes, original.notes);
  assert.equal((await call(prefix, { method: 'PUT', data: { ...upload(), notes: '不能覆盖排队中的重新分析', revision: store.get('a', doc.id).revision } })).status, 409);
  const oldWorker = { workerId: 'gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true }, pipeline: { version: 1 } } };
  store.heartbeatWorker('a', oldWorker); assert.equal(store.claim('a', ['codex'], 'gpu'), null);
  store.heartbeatWorker('a', { ...oldWorker, capabilities: { ...oldWorker.capabilities, reanalysis: { version: 1 } } });
  const job = store.claim('a', ['codex'], 'gpu'); assert.equal(job.reanalysis.mode, 'reuse');
  const evidence = await call('/worker/jobs/' + doc.id + '/evidence', { token, lease: job.lease });
  assert.deepEqual(evidence.payload.evidence.transcript.map(({ rawText, ...s }) => s), original.transcript);
  assert.equal(evidence.payload.evidence.transcript[0].rawText, original.transcript[0].text);
  assert.equal(evidence.payload.evidence.frames[0].data, oldImage.toString('base64'));
  let versions = (await call(prefix + '/versions')).payload.versions;
  assert.equal(versions.length, 1); assert.equal(versions[0].notes, original.notes); assert.equal(versions[0].transcript, undefined);
  assert.equal((await call(prefix + '/versions', { session: denied })).status, 403);
  assert.equal((await call(prefix + '/versions', { session: member('b') })).status, 404);
  assert.equal((await call(prefix + '/restore', { method: 'POST', data: { versionId: versions[0].id, revision: job.revision } })).status, 409);
  const completed = result({ notes: '# 新版完整笔记\n\n新规则把多个命盘分别识别，保留对应人物与性别，不把画面中的对比命盘合并为一个人。\n[截图](/api/knowledge/documents/' + doc.id + '/frames/frame-1.jpg)', frames: [{ name: 'frame-1.jpg', time: 5, data: oldImage.toString('base64') }] });
  assert.equal((await call('/worker/jobs/' + doc.id + '/complete', { method: 'POST', token, lease: job.lease, data: completed })).status, 200);
  const current = store.get('a', doc.id); assert.equal(current.status, 'ready'); assert.equal(current.reanalysis.state, 'done');
  assert.notEqual(current.frames[0].name, 'frame-1.jpg'); assert.match(current.notes, new RegExp(current.frames[0].name));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'frame-1.jpg')), oldImage);
  assert.equal((await call(prefix + '/restore', { method: 'POST', data: { versionId: versions[0].id, revision } })).status, 409);
  const restored = await call(prefix + '/restore', { method: 'POST', data: { versionId: versions[0].id, revision: current.revision } });
  assert.equal(restored.status, 200); assert.equal(restored.payload.document.notes, original.notes);
  assert.equal(restored.payload.document.frames[0].name, 'frame-1.jpg');
  assert.equal(store.reanalysis.list('a', doc.id).length, 2);
}));

test('batch reanalysis binds its preview revisions, respects search and raw evidence permissions, and skips missing sources', async () => fixture(async ({ call, store, db }) => {
  const docs = [];
  for (const title of ['目标课程', '其他课程']) {
    const d = store.create('a', upload({ title }));
    db.prepare("UPDATE knowledge_documents SET status='ready',notes=?,duration=90,transcript_json=? WHERE id=?").run(result().notes, JSON.stringify(result().transcript), d.id); docs.push(store.get('a', d.id));
  }
  const batch = (data, session) => call('/reanalysis', { method: 'POST', data, session });
  const preview = await batch({ preview: true, search: '目标', mode: 'reuse' });
  assert.equal(preview.payload.accepted, 1);
  const items = preview.payload.results.map(({ id, revision }) => ({ id, revision }));
  assert.equal((await batch({ items, mode: 'full' })).payload.skipped, 1);
  assert.equal((await batch({ items, mode: 'reuse' }, { userId: 'b', permissions: ['*'] })).payload.accepted, 0);
  assert.equal((await batch({ mode: 'reuse' })).status, 400);
  assert.equal((await batch({ items, mode: 'reuse' })).payload.accepted, 1);
  assert.equal((await batch({ items, mode: 'reuse' })).payload.skipped, 1);
  assert.equal(store.get('a', docs[1].id).status, 'ready');
  const restricted = { userId: 'a', permissions: ['knowledge:view', 'knowledge:notes:view', 'knowledge:process:edit', 'knowledge:reanalysis:edit', 'knowledge:reanalysis:batch:edit'] };
  assert.equal((await batch({ preview: true, search: '独有检索词' }, restricted)).payload.accepted, 0);
  for (let i = 0; i < 12; i++) {
    const d = store.get('a', docs[1].id); store.reanalysis.schedule('a', d.id, d.revision, 'reuse', store.settings('a'));
    db.prepare("UPDATE knowledge_documents SET status='ready' WHERE id=?").run(d.id);
  }
  assert.equal(store.reanalysis.list('a', docs[1].id).length, 10);
  store.remove('a', docs[1].id); assert.equal(store.reanalysis.list('a', docs[1].id).length, 0);
}));

test('worker failures retain interruption stage even for older workers reporting only terminated', async () => fixture(async ({ call, store }) => {
  const token = store.rotateToken('a'), doc = store.create('a', upload()); store.enqueue('a', doc.id);
  store.heartbeatWorker('a', { workerId: 'gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } });
  const job = store.claim('a', ['codex'], 'gpu');
  store.progress('a', doc.id, job.lease, '下载视频', 2);
  const failed = await call('/worker/jobs/' + doc.id + '/fail', { method: 'POST', token, lease: job.lease, data: { error: 'terminated' } });
  assert.equal(failed.status, 200);
  assert.match(store.get('a', doc.id).error, /下载视频/);
  assert.match(store.get('a', doc.id).error, /网络连接在传输完成前中断/);
}));

test('bulk retry only requeues owned failures, enforces permissions and is safe to repeat', async () => fixture(async ({ call, store, db }) => {
  const ids = [];
  for (let i = 0; i < 33; i++) {
    const doc = store.create('a', upload()); ids.push(doc.id);
    db.prepare("UPDATE knowledge_documents SET status='failed',error='terminated' WHERE id=?").run(doc.id);
  }
  const other = store.create('b', upload());
  db.prepare("UPDATE knowledge_documents SET status='failed' WHERE id=?").run(other.id);
  const ready = store.create('a', upload());
  db.prepare("UPDATE knowledge_documents SET status='ready' WHERE id=?").run(ready.id);
  const route = '/documents/retry-failed';
  const permissions = ['knowledge:view', 'knowledge:notes:view', 'knowledge:process:edit'];
  assert.equal((await call(route, { method: 'POST', data: {}, session: { userId: 'a', permissions } })).status, 403);
  assert.equal((await call(route, { method: 'POST', data: {}, headers: { Origin: 'https://evil.test' } })).status, 403);
  const response = await call(route, { method: 'POST', data: {} });
  assert.equal(response.status, 202); assert.equal(response.payload.accepted, 33); assert.equal(response.payload.skipped, 0);
  for (const id of ids) { assert.equal(store.get('a', id).status, 'queued'); assert.equal(store.get('a', id).error, ''); }
  assert.equal(store.get('b', other.id).status, 'failed'); assert.equal(store.get('a', ready.id).status, 'ready');
  assert.equal((await call(route, { method: 'POST', data: {} })).payload.accepted, 0);
}));

test('bulk retry reports import failures without changing them when permissions or capacity prevent retry', async () => fixture(async ({ call, store, db }) => {
  const doc = store.create('a', upload()); store.imports.add('a', doc.id, 'https://www.bilibili.com/video/BV1LTpi69Efh/');
  db.prepare("UPDATE knowledge_documents SET status='failed' WHERE id=?").run(doc.id);
  db.prepare("UPDATE knowledge_imports SET state='failed' WHERE document_id=?").run(doc.id);
  const before = store.imports.get('a', doc.id).settings_json;
  const permissions = ['knowledge:view', 'knowledge:notes:view', 'knowledge:process:edit', 'knowledge:process:batch:edit'];
  const denied = await call('/documents/retry-failed', { method: 'POST', data: {}, session: { userId: 'a', permissions } });
  assert.equal(denied.payload.accepted, 0); assert.equal(denied.payload.skipped, 1); assert.match(denied.payload.results[0].error, /权限/);
  for (let i = 0; i < 5; i++) store.create('a', upload());
  const full = await call('/documents/retry-failed', { method: 'POST', data: {} });
  assert.equal(full.payload.accepted, 0); assert.match(full.payload.results[0].error, /5/);
  assert.equal(store.get('a', doc.id).status, 'failed'); assert.equal(store.imports.get('a', doc.id).settings_json, before);
}));

test('document status counts span pages and selected statuses but respect owner, search, topic and deletion', async () => fixture(async ({ call, store, db }) => {
  for (const [status, topic, title] of [['ready', '课程', '甲'], ['ready', '课程', '乙'], ['failed', '课程', '甲'], ['queued', '其他', '甲'], ['deleting', '课程', '甲']]) {
    const item = store.create('a', upload({ topic, title }));
    db.prepare('UPDATE knowledge_documents SET status=? WHERE id=?').run(status, item.id);
  }
  store.create('b', upload());
  const all = await call('/documents?status=ready&offset=1');
  assert.equal(all.payload.total, 2); assert.equal(all.payload.documents.length, 1);
  assert.deepEqual(all.payload.statusCounts, { ready: 2, failed: 1, queued: 1 });
  const filtered = await call('/documents?status=ready&topic=' + encodeURIComponent('课程') + '&search=' + encodeURIComponent('甲'));
  assert.equal(filtered.payload.total, 1);
  assert.deepEqual(filtered.payload.statusCounts, { ready: 1, failed: 1 });
  const empty = await call('/documents?search=unmatched');
  assert.deepEqual(empty.payload.statusCounts, {});
  const other = await call('/documents', { session: member('b') });
  assert.deepEqual(other.payload.statusCounts, { uploading: 1 });
}));

test('source duplicates are blocked across preview, legacy import and file upload before network or disk checks, without leaking another owner', async () => fixture(async ({ call, store, db }) => {
  const sourceUrl = 'http://m.bilibili.com/video/BV1LTpi69Efh?p=1&share_source=copy';
  const saved = store.create('a', upload({ sourceUrl }));
  db.prepare("UPDATE knowledge_documents SET status='ready' WHERE id=?").run(saved.id);
  const canonical = 'https://www.bilibili.com/video/BV1LTpi69Efh/?spm_id_from=share#t=30';
  const original = globalThis.fetch;
  globalThis.fetch = (url, options) => { if (String(url).startsWith('https://api.bilibili.com/')) assert.fail('existing sources do not need Bilibili API calls'); return original(url, options); };
  try {
    for (const route of ['/imports/preview', '/imports', '/documents']) {
      const response = await call(route, { method: 'POST', data: route === '/documents' ? upload({ sourceUrl: canonical }) : { url: canonical } });
      assert.equal(response.status, 409); assert.equal(response.payload.code, 'KNOWLEDGE_DUPLICATE_SOURCE');
      assert.equal(response.payload.duplicate.documentId, saved.id);
    }
    const denied = await call('/imports/preview', { method: 'POST', data: { url: canonical }, session: { userId: 'a', permissions: ['knowledge:view', 'knowledge:import:edit', 'knowledge:upload:edit', 'knowledge:process:edit'] } });
    assert.equal(denied.status, 409); assert.equal(denied.payload.duplicate, undefined);
    const queued = await call('/upload-queue', { method: 'POST', data: { urls: [canonical] } });
    assert.equal(queued.payload.accepted, 0); assert.equal(queued.payload.results[0].documentId, saved.id);
    const other = await call('/documents', { method: 'POST', data: upload({ sourceUrl: canonical }), session: member('b') });
    assert.equal(other.status, 201); assert.notEqual(other.payload.document.id, saved.id);
    const second = 'https://www.bilibili.com/video/BV1LTpi69Efh/?p=2';
    const concurrent = await Promise.all([call('/documents', { method: 'POST', data: upload({ sourceUrl: second }) }), call('/documents', { method: 'POST', data: upload({ sourceUrl: second + '&share_source=copy' }) })]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [201, 409]);
    assert.equal(store.list('a').total, 2);
  } finally { globalThis.fetch = original; }
}));

test('persistent upload queue accepts more than five links without resolving them and enforces owner, CSRF and action permissions', async () => fixture(async ({ call, store }) => {
  const urls = Array.from({ length: 7 }, (_, i) => 'https://www.bilibili.com/video/BV1LTpi69Efh/' + (i ? '?p=' + (i + 1) : ''));
  const data = { urls };
  assert.equal((await call('/upload-queue', { method: 'POST', data, headers: { 'X-Knowledge-Owner': 'different-user' } })).payload.code, 'KNOWLEDGE_ACCOUNT_CHANGED');
  assert.equal((await call('/upload-queue', { session: { userId: 'a', permissions: ['knowledge:view'] } })).status, 403);
  assert.equal((await call('/upload-queue', { method: 'POST', data, session: { userId: 'a', permissions: ['knowledge:view', 'knowledge:queue:edit'] } })).status, 403);
  assert.equal((await call('/upload-queue', { method: 'POST', data, headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call('/upload-queue', { method: 'POST', data: { urls: Array(101).fill(urls[0]) } })).status, 400);
  for (let i = 0; i < 5; i++) store.create('a', upload());
  const response = await call('/upload-queue', { method: 'POST', data });
  assert.equal(response.status, 202); assert.equal(response.payload.accepted, 7);
  assert.equal((await call('/upload-queue')).payload.counts.pending, 7);
  assert.equal((await call('/upload-queue', { session: member('b') })).payload.total, 0);
  const id = response.payload.results[0].id;
  assert.equal((await call('/upload-queue/' + id + '/cancel', { method: 'POST', session: member('b') })).status, 404);
  assert.equal((await call('/upload-queue/' + id + '/cancel', { method: 'POST', session: { userId: 'a', permissions: ['knowledge:view', 'knowledge:queue:view'] } })).status, 403);
  assert.equal((await call('/upload-queue/' + id + '/cancel', { method: 'POST', session: { userId: 'a', permissions: ['knowledge:view', 'knowledge:queue:manage'] } })).status, 200);
  assert.equal((await call('/upload-queue/' + id + '/retry', { method: 'POST' })).status, 409);
  assert.equal((await call('/documents', { method: 'POST', data: upload() })).payload.code, 'KNOWLEDGE_CAPACITY');
}));

test('SQLite writer contention returns retryable 503 rather than marking valid worker requests as HTTP 400', async () => fixture(async ({ call, store, db }) => {
  const token = store.rotateToken('a'), item = store.create('a', upload()); store.enqueue('a', item.id);
  const writer = new db.constructor(db.name);
  db.pragma('busy_timeout = 10');
  try {
    writer.exec('BEGIN IMMEDIATE');
    for (const route of ['/worker/heartbeat', '/worker/claim']) {
      const response = await call(route, { method: 'POST', token, data: { workerId: 'gpu', backends: ['codex'] } });
      assert.equal(response.status, 503); assert.equal(response.payload.code, 'KNOWLEDGE_BUSY');
      assert.equal(response.payload.retryable, true); assert.equal(response.headers.get('retry-after'), '1');
    }
    assert.equal(store.get('a', item.id).status, 'queued');
    writer.exec('ROLLBACK');
    assert.equal((await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } } })).status, 200);
    assert.equal((await call('/worker/claim', { method: 'POST', token, data: { workerId: 'gpu', backends: ['codex'] } })).payload.job.id, item.id);
  } finally { if (writer.inTransaction) writer.exec('ROLLBACK'); writer.close(); db.pragma('busy_timeout = 5000'); }
}));

test('batch publication is atomic, versioned, account isolated and permission protected', async () => fixture(async ({ call, store, db }) => {
  const a = store.create('a', upload()), b = store.create('a', upload()), foreign = store.create('b', upload());
  db.prepare("UPDATE knowledge_documents SET status='ready',notes='test notes' WHERE id IN (?,?)").run(a.id, b.id);
  const batch = (documents, visibility = 'public', options = {}) => call('/documents/visibility', { method: 'PUT', data: { documents, visibility }, ...options });
  const docs = [a, b].map(d => ({ id: d.id, revision: d.revision }));
  assert.equal((await batch(docs, 'public', { session: { userId: 'a', permissions: ['knowledge:view', 'knowledge:notes:view', 'knowledge:publish:edit'] } })).status, 403);
  assert.equal((await batch(docs, 'public', { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await batch([docs[0], { id: foreign.id, revision: foreign.revision }])).status, 404);
  assert.equal(store.get('a', a.id).visibility, 'private');
  assert.equal((await batch([docs[0], { ...docs[1], revision: 99 }])).status, 409);
  assert.equal(store.get('a', a.id).visibility, 'private');
  db.prepare("UPDATE knowledge_documents SET status='processing' WHERE id=?").run(b.id);
  assert.equal((await batch(docs)).status, 409);
  db.prepare("UPDATE knowledge_documents SET status='ready' WHERE id=?").run(b.id);
  for (const invalid of [[], [docs[0], docs[0]], Array(101).fill(docs[0]), [{ id: 'bad', revision: 0 }]]) assert.equal((await batch(invalid)).status, 400);
  assert.equal((await batch(docs, 'invalid')).status, 400);
  const response = await batch(docs); assert.equal(response.status, 200); assert.equal(response.payload.count, 2);
  assert.ok(store.list('a').documents.every(d => d.visibility === 'public'), 'list includes the stored visibility');
  const published = await call('/public/documents'); assert.equal(published.payload.total, 2);
  assert.equal(published.payload.documents[0].transcript, undefined);
  assert.equal((await batch(docs, 'private')).status, 409, 'stale selection cannot overwrite newer changes');
  assert.equal((await batch(docs.map(d => ({ ...d, revision: d.revision + 1 })), 'private')).status, 200);
  assert.equal((await call('/public/documents')).payload.total, 0);
  assert.equal(store.get('a', a.id).notes, 'test notes');
}));

test('pipeline settings validate limits, persist by owner and enforce their action permission', async () => fixture(async ({ call, store }) => {
  assert.equal(store.settings('a').mediaConcurrency, 1); assert.equal(store.settings('a').summaryConcurrency, 2);
  const limited = { userId: 'a', permissions: ['knowledge:view', 'knowledge:settings:edit'] };
  assert.equal((await call('/settings', { method: 'PUT', session: limited, data: { mediaConcurrency: 2 } })).status, 403);
  for (const data of [{ mediaConcurrency: 0 }, { mediaConcurrency: 3 }, { mediaConcurrency: '2' }, { summaryConcurrency: 5 }, { summaryConcurrency: 1.5 }])
    assert.equal((await call('/settings', { method: 'PUT', data })).status, 400);
  assert.equal((await call('/settings', { method: 'PUT', data: { mediaConcurrency: 2, summaryConcurrency: 3 } })).status, 200);
  store.saveSettings('a', { codexModel: 'gpt-6-luna' });
  assert.equal(store.settings('a').summaryConcurrency, 3); assert.equal(store.settings('a').mediaConcurrency, 2);
  assert.equal(store.settings('b').mediaConcurrency, 1);
  const token = store.rotateToken('a');
  const heartbeat = await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'gpu', capabilities: { pipeline: { version: 1 } } } });
  assert.deepEqual(heartbeat.payload.pipeline, { mediaConcurrency: 2, summaryConcurrency: 3 });
}));

test('pipeline releases media before summary, enforces stage slots, supports independent workers and protects leases', async () => fixture(async ({ call, store }) => {
  const token = store.rotateToken('a'), otherToken = store.rotateToken('b');
  const caps = { pipeline: { version: 1 }, media: { ready: true, detail: 'cuda' }, codex: { ready: true } };
  store.heartbeatWorker('a', { workerId: 'gpu', capabilities: caps });
  const ids = [];
  for (let i = 0; i < 5; i++) { const d = store.create('a', upload()); store.enqueue('a', d.id); ids.push(d.id); }
  const first = store.claim('a', ['codex'], 'gpu');
  assert.equal(store.claim('a', ['codex'], 'gpu'), null, 'one media slot by default');
  const phase = (job, value, options = {}) => call('/worker/jobs/' + job.id + '/phase', { method: 'POST', token, lease: job.lease, data: { phase: value }, ...options });
  assert.equal((await phase(first, 'summary_wait', { token: otherToken })).status, 409);
  assert.equal((await phase(first, 'summary_wait', { lease: 'wrong' })).status, 409);
  assert.equal((await phase(first, 'summary')).status, 409, 'cannot skip the persisted handoff');
  assert.equal((await phase(first, 'invented')).status, 400);
  assert.equal((await phase(first, 'summary_wait')).payload.accepted, true);
  assert.equal((await phase(first, 'summary')).payload.accepted, true);
  const second = store.claim('a', ['codex'], 'gpu'); assert.ok(second);
  await phase(second, 'summary_wait'); await phase(second, 'summary');
  const third = store.claim('a', ['codex'], 'gpu'); assert.ok(third);
  await phase(third, 'summary_wait');
  assert.equal((await phase(third, 'summary')).payload.accepted, false, 'only two simultaneous summaries');
  assert.equal(store.claim('a', ['codex'], 'gpu'), null, 'bounded prefetch even when media slot is free');
  store.heartbeatWorker('a', { workerId: 'other-gpu', capabilities: caps });
  const independent = store.claim('a', ['codex'], 'other-gpu'); assert.ok(independent); assert.notEqual(independent.id, third.id);
  assert.equal(store.get('a', first.id).processingPhase, 'summary');
  assert.equal(store.list('a').documents.find(d => d.id === third.id).processingPhase, 'summary_wait');
  store.saveSettings('a', { summaryConcurrency: 1 });
  store.fail('a', first.id, first.lease, 'test failure');
  assert.equal((await phase(third, 'summary')).payload.accepted, false, 'lower limit drains active work');
  assert.ok(store.finish('a', second.id, second.lease, result()));
  assert.equal((await phase(third, 'summary')).payload.accepted, true);
  assert.equal((await phase(third, 'summary_wait')).status, 409, 'cannot return to an earlier stage');
  assert.equal(store.get('a', independent.id).status, 'processing', 'one failure does not cancel other workers');
}));

test('legacy GPU workers stay serial and CPU fallback stays disabled while GPUs are busy or offline', async () => fixture(async ({ store, db }) => {
  const caps = { media: { ready: true, detail: 'cuda' }, codex: { ready: true } };
  store.heartbeatWorker('a', { workerId: 'gpu', capabilities: caps });
  for (let i = 0; i < 3; i++) { const d = store.create('a', upload()); store.enqueue('a', d.id); }
  const gpu = store.claim('a', ['codex'], 'gpu'); assert.ok(gpu);
  assert.equal(gpu.processingPhase, '', 'legacy stage labels remain accurate until runtime upgrades');
  assert.equal(store.claim('a', ['codex'], 'gpu'), null);
  assert.equal(store.claim('a', ['codex'], 'cpu'), null, 'GPU work must not exhaust a small ECS host with concurrent CPU ASR');
  db.prepare('UPDATE knowledge_worker_instances SET last_seen=? WHERE worker_id=?').run(new Date(Date.now() - 91000).toISOString(), 'gpu');
  assert.equal(store.claim('a', ['codex'], 'cpu'), null, 'GPU disconnection never enables CPU fallback');
  assert.equal(store.claim('a', ['codex'], 'cpu'), null);
  assert.ok(store.leased('a', gpu.id, gpu.lease));
}));

test('knowledge routes, per-action permissions, default member grants and guest isolation', async () => {
  const permissions = SYSTEM_PERMISSIONS.filter(p => p.id.startsWith('knowledge:'));
  assert.ok(permissions.length >= 12);
  for (const p of permissions) { assert.deepEqual(p.permissionPath.slice(0, 2), ['首页', '知识库']); assert.ok(member('a').permissions.includes(p.id)); }
  const menus = buildMenusFromServices([]);
  assert.equal(getVisibleMenus({ menus }, member('a').permissions).find(m => m.serviceId === 'knowledge').path, '/knowledge/');
  assert.ok(getVisibleMenus({ menus }, []).some(m => m.serviceId === 'knowledge'));
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

test('link preview and creation require import, upload and process grants and reject cross-site requests', async () => fixture(async ({ call }) => {
  for (const route of ['/imports/preview', '/imports']) {
    for (const permissions of [['knowledge:view'], ['knowledge:view', 'knowledge:import:edit'], ['knowledge:view', 'knowledge:upload:edit', 'knowledge:process:edit']]) {
      assert.equal((await call(route, { method: 'POST', data: { url: 'http://127.0.0.1/' }, session: { userId: 'a', permissions } })).status, 403);
    }
    assert.equal((await call(route, { method: 'POST', data: { url: 'http://127.0.0.1/' }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(route, { method: 'POST', data: { url: 'http://127.0.0.1/' } })).status, 400);
  }
}));

test('Bilibili account and quality endpoints enforce separate grants, ownership and cross-site write protection', async () => fixture(async ({ call }) => {
  for (const [route, method] of [['/bilibili', 'GET'], ['/bilibili', 'DELETE'], ['/bilibili/login/start', 'POST'], ['/bilibili/login/poll', 'POST'], ['/bilibili/settings', 'PUT']]) {
    assert.equal((await call(route, { method, data: method === 'GET' ? undefined : {}, session: { userId: 'a', permissions: ['knowledge:view'] } })).status, 403);
    if (method !== 'GET') assert.equal((await call(route, { method, data: {}, headers: { origin: 'https://evil.example' } })).status, 403);
  }
  const saved = await call('/bilibili/settings', { method: 'PUT', data: { quality: 64, strict: false } });
  assert.deepEqual(saved.payload.settings, { quality: 64, strict: false });
  assert.equal((await call('/bilibili')).payload.account.quality, 64);
  assert.equal((await call('/bilibili', { session: member('b') })).payload.account.quality, 80);
  assert.equal((await call('/bilibili/check', { method: 'POST' })).payload.account.bound, false);
  assert.doesNotMatch(JSON.stringify((await call('/bilibili')).payload), /cipher|SESSDATA|qrcode_key/);
}));

test('link metadata fills defaults, user edits survive, and imports expose cache while storage is pending', async () => fixture(async ({ call, store, root, db }) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.bilibili.com/')) {
      return new Response(JSON.stringify({ code: 0, data: String(url).includes('/tags?') ? [{ tag_name: '八字' }] :
        String(url).includes('/playurl?') ? { dash: { video: [{ id: 80, height: 1080, codecid: 7, baseUrl: 'https://test.bilivideo.com/v' }], audio: [{ baseUrl: 'https://test.bilivideo.com/a' }] } } :
        { bvid: 'BV1LTpi69Efh', title: '八字学习', duration: 30, owner: { name: '作者' }, pages: [{ page: 1, cid: 42, duration: 30 }] } }));
    }
    return originalFetch(url, options);
  };
  try {
    const preview = await call('/imports/preview', { method: 'POST', data: { url: 'https://www.bilibili.com/video/BV1LTpi69Efh/' } });
    assert.equal(preview.payload.metadata.topic, '命理'); assert.deepEqual(preview.payload.metadata.tags, ['八字']);
    const result = await call('/imports', { method: 'POST', data: { url: preview.payload.metadata.sourceUrl, title: '我的课程', topic: '自定义分类', tags: ['已编辑'] } });
    assert.equal(result.status, 202);
    const doc = result.payload.document; assert.equal(doc.title, '我的课程'); assert.equal(doc.topic, '自定义分类'); assert.deepEqual(doc.tags, ['已编辑']);
    assert.equal(doc.status, 'importing'); assert.equal(doc.importState, 'pending');
    assert.equal((await call('/documents/' + doc.id, { session: member('b') })).status, 404);
    store.sources.add('a', doc.id, '/115/test/source.mp4');
    const job = store.imports.claim(); store.imports.done(job);
    const directory = path.join(root, 'media', doc.id); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'source'), video(24));
    db.prepare("UPDATE knowledge_documents SET status='uploading',byte_size=24 WHERE id=?").run(doc.id); store.enqueue('a', doc.id);
    const source = await call('/documents/' + doc.id + '/source'); assert.equal(source.status, 200); assert.deepEqual(source.payload, video(24));
    assert.equal(store.sources.get('a', doc.id).state, 'pending');
  } finally { globalThis.fetch = originalFetch; }
}));

test('model settings are scoped, permission-checked, validated, and snapshotted for upload/retry', async () => fixture(async ({ call, store }) => {
  const baseline = store.settings('a'); assert.equal(baseline.codexModel, '');
  const limited = { userId: 'a', permissions: ['knowledge:view', 'knowledge:settings:edit'] };
  assert.equal((await call('/settings', { method: 'PUT', session: limited, data: { codexModel: 'gpt-6-luna' } })).status, 403);
  assert.equal((await call('/settings', { method: 'PUT', data: { codexModel: 'bad model\n-c' } })).status, 400);
  assert.equal((await call('/settings', { method: 'PUT', data: { codexEffort: 'invented' } })).status, 400);
  assert.equal((await call('/settings', { method: 'PUT', data: { codexModel: 'gpt-6-luna', codexEffort: 'ultra' } })).status, 400);
  assert.equal((await call('/settings', { method: 'PUT', data: { codexModel: 'gpt-6-luna', codexEffort: 'low', apiModel: 'custom', apiEffort: 'medium' } })).status, 200);
  assert.equal(store.settings('b').codexModel, '');
  const doc = store.create('a', upload()); store.enqueue('a', doc.id);
  store.saveSettings('a', { codexModel: 'gpt-6.1-sol', codexEffort: 'medium' });
  store.heartbeatWorker('a', { workerId: 'test-gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true }, openai: { ready: true } } });
  const job = store.claim('a', ['codex'], 'test-gpu');
  assert.equal(job.modelSettings.codexModel, 'gpt-6-luna'); assert.equal(job.modelSettings.codexEffort, 'low');
  assert.equal(job.modelSettings.apiModel, 'custom');
  store.fail('a', doc.id, job.lease, 'test'); store.retry('a', doc.id, 'codex');
  assert.equal(store.get('a', doc.id).modelSettings.codexModel, 'gpt-6.1-sol');
  store.saveSettings('a', 'openai'); assert.equal(store.settings('a').apiModel, 'custom');
  assert.equal((await call('/documents/' + doc.id)).payload.document.modelSettings.codexEffort, 'medium');
}));

test('local delivery API scopes tickets to upload/process permissions and verifies the merged file hash', async () => fixture(async ({ call, store }) => {
  const token = store.rotateToken('a'), workerId = 'a'.repeat(32), file = video(24);
  store.heartbeatWorker('a', { workerId, capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } });
  const created = await call('/documents', { method: 'POST', data: upload({ bytes: file.length }) });
  const id = created.payload.document.id;
  const route = '/documents/' + id + '/local-input';
  const readonly = { userId: 'a', permissions: ['knowledge:view', 'knowledge:upload:edit', 'knowledge:process:edit'] };
  assert.equal((await call(route, { method: 'POST', session: readonly, data: { workerId } })).status, 403);
  assert.equal((await call(route, { method: 'POST', session: member('b'), data: { workerId } })).status, 404);
  const grant = await call(route, { method: 'POST', data: { workerId } });
  assert.equal(grant.status, 200);
  assert.equal((await call('/worker/local-input', { method: 'POST', token, data: { workerId: 'b'.repeat(32), documentId: id, ticket: grant.payload.ticket } })).status, 400);
  const accepted = await call('/worker/local-input', { method: 'POST', token, data: { workerId, documentId: id, ticket: grant.payload.ticket, sha256: crypto.createHash('sha256').update(file).digest('hex') } });
  assert.equal(accepted.status, 200);
  await call('/documents/' + id + '/parts/1', { method: 'PUT', binary: file });
  assert.equal((await call('/documents/' + id + '/complete', { method: 'POST' })).status, 202);
  const job = (await call('/worker/claim', { method: 'POST', token, data: { workerId, backends: ['codex'], localDocuments: [id] } })).payload.job;
  assert.equal(job.localInput, true);
  assert.equal(job.sourceSha256, crypto.createHash('sha256').update(file).digest('hex'));
}));

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
  await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } } });
  const claimed = await call('/worker/claim', { method: 'POST', token, data: { workerId: 'gpu', backends: ['codex'] } }); const job = claimed.payload.job;
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
  store.heartbeatWorker('a', { workerId: 'test-gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true }, openai: { ready: true } } });
  const old = store.claim('a', ['codex'], 'test-gpu');
  db.prepare('UPDATE knowledge_documents SET heartbeat=? WHERE id=?').run('2000-01-01T00:00:00Z', d.id);
  store.expire('a'); assert.equal(store.get('a', d.id).status, 'queued');
  assert.equal(store.get('a', d.id).stage, '等待GPU工作器恢复');
  const current = store.claim('a', ['codex'], 'test-gpu'); assert.notEqual(current.lease, old.lease);
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

test('GPU-only scheduling waits through disconnection, never hands work to CPU and resumes after GPU reconnects', async () => fixture(async ({ store, db, call }) => {
  const token = store.rotateToken('a');
  const caps = device => ({ media: { ready: true, detail: device }, codex: { ready: true }, openai: { ready: false } });
  await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'gpu', label: '本机 GPU', capabilities: caps('cuda') } });
  await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'cpu', label: 'ECS', capabilities: caps('cpu') } });
  assert.equal(store.worker('a').label, '本机 GPU');
  assert.equal(store.worker('a').workers.length, 2);
  const d = store.create('a', upload()); store.enqueue('a', d.id);
  assert.equal(store.claim('a', ['codex'], 'cpu'), null);
  assert.equal(store.claim('a', ['codex']), null, 'unannounced workers cannot bypass the GPU requirement');
  const claimed = await call('/worker/claim', { method: 'POST', token, data: { workerId: 'gpu', backends: ['codex'] } });
  assert.equal(claimed.payload.job.id, d.id);
  db.prepare('UPDATE knowledge_worker_instances SET last_seen=? WHERE worker_id=?').run(new Date(Date.now() - 91000).toISOString(), 'gpu');
  assert.equal(store.claim('a', ['codex'], 'cpu'), null, 'an active lease is never transferred');
  assert.ok(store.finish('a', d.id, claimed.payload.job.lease, result()));
  const next = store.create('a', upload()); store.enqueue('a', next.id);
  assert.equal(store.claim('a', ['codex'], 'cpu'), null);
  assert.equal(store.get('a', next.id).status, 'queued');
  assert.equal(store.worker('a').online, false);
  assert.equal(store.worker('a').scheduling, 'gpu-only');
  await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'gpu', capabilities: caps('cuda') } });
  assert.equal(store.claim('a', ['codex'], 'gpu').id, next.id);
  store.rotateToken('a');
  assert.equal(store.worker('a').workers.length, 0);
}));

test('GPU-only admission respects account isolation, readiness and backend compatibility', async () => fixture(async ({ store }) => {
  store.rotateToken('a'); store.rotateToken('b');
  store.heartbeatWorker('a', { workerId: 'gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } });
  const other = store.create('b', upload()); store.enqueue('b', other.id);
  assert.equal(store.claim('b', ['codex'], 'cpu'), null, 'another account GPU cannot enable processing');
  const api = store.create('a', upload({ backend: 'openai' })); store.enqueue('a', api.id);
  assert.equal(store.claim('a', ['openai'], 'cpu'), null);
  assert.equal(store.claim('a', ['openai'], 'gpu'), null, 'GPU must support the selected backend');
  store.rotateToken('a');
  store.heartbeatWorker('a', { workerId: 'gpu', capabilities: { media: { ready: false, detail: 'cuda' }, codex: { ready: true } } });
  const d = store.create('a', upload()); store.enqueue('a', d.id);
  assert.equal(store.claim('a', ['codex'], 'cpu'), null);
  assert.equal(store.claim('a', ['codex'], 'gpu'), null, 'unhealthy GPU keeps work queued');
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

test('device APIs enforce permissions, CSRF, authenticated pairing, and per-device identity', async () => fixture(async ({ call, store }) => {
  const started = await call('/worker/pair/start', { method: 'POST', data: { label: 'QA Laptop' } });
  assert.equal(started.status, 200); const pair = started.payload;
  assert.equal((await call('/device-pair?code=' + pair.userCode, { session: { userId: 'a', permissions: ['knowledge:view'] } })).status, 403);
  assert.equal((await call('/device-pair', { method: 'POST', data: { code: pair.userCode }, headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call('/device-pair', { method: 'POST', data: { code: pair.userCode } })).status, 200);
  const polled = await call('/worker/pair/poll', { method: 'POST', data: { deviceCode: pair.deviceCode } });
  assert.equal(polled.payload.status, 'approved'); const { token, deviceId } = polled.payload;
  await call('/worker/heartbeat', { method: 'POST', token, data: { workerId: 'spoof-other-device', label: 'spoof', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } } });
  assert.equal(store.worker('a').workers[0].id, deviceId);
  assert.equal((await call('/devices', { session: member('b') })).payload.devices.length, 0);
  assert.equal((await call('/devices/' + deviceId, { method: 'DELETE', session: member('b') })).status, 404);
  assert.equal((await call('/worker/release', { token })).status, 200);
  assert.equal((await call('/worker-install', { method: 'POST', data: {}, session: { userId: 'a', permissions: ['knowledge:view', 'knowledge:devices:install'] } })).status, 403);
  const installer = await call('/worker-install', { method: 'POST', data: {} });
  assert.equal(installer.status, 200); assert.equal(installer.headers.get('content-type'), 'application/vnd.microsoft.portable-executable');
  assert.equal(installer.payload.toString('ascii', 0, 2), 'MZ');
  assert.equal(installer.payload.toString('ascii', installer.payload.length - 8), 'NKWEXE01');
  assert.ok(!installer.payload.includes(Buffer.from(token)), 'download does not contain an existing device credential');
  assert.equal((await call('/devices/' + deviceId, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/worker/heartbeat', { method: 'POST', token, data: {} })).status, 401);
}));


test('ZIP setup download has separate permission and a one-use automatic pairing grant, never an existing token', async () => fixture(async ({ call, store, root }) => {
  const session = { userId: 'a', permissions: ['knowledge:view', 'knowledge:devices:install', 'knowledge:devices:edit', 'knowledge:process:edit'] };
  assert.equal((await call('/worker-install', { method: 'POST', data: { format: 'zip' }, session })).status, 403);
  assert.equal((await call('/worker-install', { method: 'POST', data: { format: 'bad' } })).status, 400);
  assert.equal((await call('/worker-install', { method: 'POST', data: { format: 'zip' }, headers: { origin: 'https://evil.example' } })).status, 403);
  const existing = store.rotateToken('a');
  const response = await call('/worker-install', { method: 'POST', data: { format: 'zip' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.ok(!response.payload.includes(Buffer.from(existing)));
  // The auto-updater deliberately rejects installer grants; read this ordinary
  // uncompressed ZIP without weakening its public-runtime allowlist.
  const entries = new Map(); let offset = 0;
  while (response.payload.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(response.payload.readUInt16LE(offset + 8), 0);
    const size = response.payload.readUInt32LE(offset + 18), length = response.payload.readUInt16LE(offset + 26), extra = response.payload.readUInt16LE(offset + 28);
    const name = response.payload.subarray(offset + 30, offset + 30 + length).toString('utf8'), start = offset + 30 + length + extra;
    entries.set(name, response.payload.subarray(start, start + size)); offset = start + size;
  }
  const grant = JSON.parse(entries.get('worker-pairing.json').toString('utf8'));
  assert.match(entries.get('scripts/setup-knowledge-worker.ps1').toString('utf8'), /Get-WorkerNodeMajor/);
  assert.ok(grant.expiresAt > Date.now()); assert.ok(grant.expiresAt <= Date.now() + 600000);
  const paired = await call('/worker/pair/poll', { method: 'POST', data: { deviceCode: grant.deviceCode, label: 'ZIP device' } });
  assert.equal(paired.payload.status, 'approved'); assert.equal(store.workerUser(paired.payload.token), 'a');
  assert.equal((await call('/worker/pair/poll', { method: 'POST', data: { deviceCode: grant.deviceCode } })).payload.status, 'expired');
}));

test('worker Codex call reporting requires its own current lease and cannot spoof ownership or modify finished turns',async()=>fixture(async({call,store,db})=>{
  const token=store.rotateToken('a'),other=store.rotateToken('b'),d=store.create('a',upload());store.enqueue('a',d.id);store.heartbeatWorker('a',{workerId:'test-gpu',capabilities:{media:{ready:true,detail:'cuda'},codex:{ready:true}}});const job=store.claim('a',['codex'],'test-gpu');
  const route='/worker/jobs/'+d.id+'/codex',data={id:crypto.randomUUID(),prompt:'Quoted transcript',result:'',state:'running',model:'test',sessionId:''};
  assert.equal((await call(route,{method:'POST',token:other,lease:job.lease,data})).status,409);
  assert.equal((await call(route,{method:'POST',token,lease:'bad',data})).status,409);
  assert.equal((await call(route,{method:'POST',token,lease:job.lease,data:{...data,user_id:'b'}})).status,400);
  assert.equal((await call(route,{method:'POST',token,lease:job.lease,data})).status,200);
  assert.equal((await call(route,{method:'POST',token,lease:job.lease,data:{...data,state:'succeeded',result:'Answer'}})).status,200);
  assert.equal((await call(route,{method:'POST',token,lease:job.lease,data})).status,200);
  const row=db.prepare('SELECT * FROM knowledge_codex_calls').get();assert.equal(row.user_id,'a');assert.equal(row.result,'Answer');assert.equal(row.state,'succeeded');
  store.fail('a',d.id,job.lease,'done');assert.equal((await call(route,{method:'POST',token,lease:job.lease,data})).status,409);
}));


test('ASR settings are isolated, validated and permission-checked; retries take the current snapshot', async () => fixture(async ({ call, store }) => {
  assert.equal(store.settings('a').asrModel, 'turbo');
  const limited = { userId: 'a', permissions: ['knowledge:view', 'knowledge:settings:edit'] };
  assert.equal((await call('/settings', { method: 'PUT', session: limited, data: { asrModel: 'turbo' } })).status, 403);
  const noSettings = { userId: 'a', permissions: ['knowledge:view', 'knowledge:asr:edit'] };
  assert.equal((await call('/settings', { method: 'PUT', session: noSettings, data: { asrModel: 'turbo' } })).status, 403);
  for (const data of [{ asrModel: '../../model' }, { asrLanguage: 'invalid' }, { asrProfile: 'invented' }, { asrHotwords: {} }, { asrHotwords: 'x'.repeat(121) }, { asrHotwords: 'a\nb' }]) {
    assert.equal((await call('/settings', { method: 'PUT', data })).status, 400);
  }
  const chosen = { asrModel: 'turbo', asrLanguage: 'zh', asrProfile: 'bazi', asrHotwords: '印绶，禄神' };
  assert.equal((await call('/settings', { method: 'PUT', data: chosen })).status, 200);
  assert.equal(store.settings('b').asrHotwords, '');
  const doc = store.create('a', upload()); store.enqueue('a', doc.id);
  store.saveSettings('a', { asrModel: 'large-v3' });
  assert.equal(store.get('a', doc.id).modelSettings.asrModel, 'turbo');
  store.heartbeatWorker('a', { workerId: 'gpu', capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } });
  const job = store.claim('a', ['codex'], 'gpu');
  assert.equal(job.modelSettings.asrHotwords, chosen.asrHotwords);
  store.fail('a', doc.id, job.lease, 'test'); store.retry('a', doc.id, 'codex');
  assert.equal(store.get('a', doc.id).modelSettings.asrModel, 'large-v3');
}));

test('existing raw transcripts display in simplified Chinese without modifying evidence or timestamps, and respect permissions', async () => fixture(async ({ call, store, db }) => {
  const doc = store.create('a', upload());
  const original = [{ start: 1.125, end: 8.75, text: '乾造與坤造，正印護身，官殺與財星。' }];
  db.prepare("UPDATE knowledge_documents SET status='ready',transcript_json=?,duration=90 WHERE id=?").run(JSON.stringify(original), doc.id);
  const prefix = '/documents/' + doc.id;
  const response = await call(prefix), s = response.payload.document.transcript[0];
  assert.equal(s.text, '乾造与坤造，正印护身，官杀与财星。');
  assert.equal(s.rawText, original[0].text); assert.equal(s.start, 1.125); assert.equal(s.end, 8.75);
  assert.deepEqual(JSON.parse(store.getRow('a', doc.id).transcript_json), original);
  const session = { userId: 'a', permissions: ['knowledge:view', 'knowledge:notes:view', 'knowledge:transcript:view'] };
  assert.equal((await call(prefix, { session })).payload.document.transcript[0].rawText, undefined);
  session.permissions.pop(); assert.deepEqual((await call(prefix, { session })).payload.document.transcript, []);
  assert.equal((await call(prefix, { session: member('b') })).status, 404);
  const reused = validateKnowledgeResult(result({ transcript: [s] }));
  assert.deepEqual(reused.transcript, original);
  assert.throws(() => validateKnowledgeResult(result({ transcript: [{ ...s, rawText: {} }] })));
}));
