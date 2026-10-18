import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { createKnowledgeStore } from './knowledge-store.js';
import { startLocalInputServer, localDocuments, verifyLocalInput, pruneLocalInputs } from './knowledge-local-input.js';
import { sendLocalInput } from '../public/knowledge/local-input.js';

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const upload = { title: 'local upload', originalName: 'test.mp4', bytes: 12, mimeType: 'video/mp4', backend: 'codex' };
test('idle cleanup removes only expired local caches inside the configured root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-local-prune-'));
  try {
    for (const name of ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'unrelated']) await fs.mkdir(path.join(root, name));
    const old = path.join(root, 'a'.repeat(32), 'local-input.json');
    await fs.writeFile(old, '{}'); await fs.utimes(old, new Date(0), new Date(0));
    await fs.writeFile(path.join(root, 'b'.repeat(32), 'local-input.json'), '{}');
    await pruneLocalInputs(root);
    assert.deepEqual((await fs.readdir(root)).sort(), ['b'.repeat(32), 'c'.repeat(32), 'unrelated']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('only the matching owner/device and complete SHA256 can process before archive; archive failure preserves notes', () => {
  const db = new Database(':memory:');
  try {
    const store = createKnowledgeStore(db), id = 'a'.repeat(32), cpu = 'b'.repeat(32);
    store.heartbeatWorker('owner', { workerId: id, capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } });
    const doc = store.create('owner', upload); store.sources.add('owner', doc.id, '/115/test/path');
    assert.throws(() => store.localInputs.offer('other', doc.id, id));
    const { ticket } = store.localInputs.offer('owner', doc.id, id);
    assert.throws(() => store.localInputs.verify('other', doc.id, id, ticket));
    assert.throws(() => store.localInputs.verify('owner', doc.id, cpu, ticket));
    assert.throws(() => store.localInputs.verify('owner', doc.id, id, 'wrong'));
    store.localInputs.verify('owner', doc.id, id, ticket, digest('data'));
    assert.throws(() => store.localInputs.verify('owner', doc.id, id, ticket), /失效/);
    store.enqueue('owner', doc.id, digest('other file'));
    assert.equal(store.claim('owner', ['codex'], id, [doc.id]), null);
    db.prepare('UPDATE knowledge_documents SET source_sha256=? WHERE id=?').run(digest('data'), doc.id);
    assert.equal(store.claim('owner', ['codex'], cpu, [doc.id]), null);
    assert.equal(store.claim('owner', ['codex'], id), null);
    const job = store.claim('owner', ['codex'], id, [doc.id]);
    assert.equal(job.localInput, true); assert.equal(job.storage.state, 'pending');
    assert.equal(store.claim('owner', ['codex'], id, [doc.id]), null);
    store.finish('owner', doc.id, job.lease, { duration: 3, language: 'zh', notes: 'done', transcript: [], frames: [], provenance: {} });
    db.prepare("UPDATE knowledge_sources SET state='failed' WHERE document_id=?").run(doc.id);
    assert.equal(store.get('owner', doc.id).status, 'ready');
    assert.equal(store.get('owner', doc.id).storage.state, 'failed');
    store.remove('owner', doc.id); assert.equal(store.localInputs.get('owner', doc.id), undefined);
  } finally { db.close(); }
});

test('loopback receiver rejects hostile origins/hosts/tickets and stores only complete verified files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-loopback-'));
  const origin = 'https://portal.example', workerId = 'c'.repeat(32), id = 'd'.repeat(32), ticket = 'e'.repeat(64);
  const calls = [];
  const server = await startLocalInputServer({ portalOrigin: origin, workerId, workRoot: root, port: 0, ready: () => true,
    authorize: async data => { if (data.ticket !== ticket) throw new Error('bad ticket'); calls.push(data); return { bytes: 4 }; } });
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(url + '/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const badHost = await new Promise((resolve, reject) => {
      const req = http.get(url + '/health', { headers: { Origin: origin, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
    });
    assert.equal(badHost, 403);
    const health = await fetch(url + '/health', { headers: { Origin: origin } }); assert.equal((await health.json()).workerId, workerId);
    const preflight = await fetch(url + '/inputs/' + id, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    const post = (body, token = ticket) => fetch(url + '/inputs/' + id, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + token }, body });
    assert.equal((await post('data', 'f'.repeat(64))).status, 400);
    assert.equal((await post('bad')).status, 400);
    assert.equal((await fs.readdir(root)).length, 1);
    assert.equal((await post('data')).status, 200);
    assert.equal(calls.at(-1).sha256, digest('data'));
    assert.deepEqual(await localDocuments(root), [id]);
    assert.ok(await verifyLocalInput(root, { id, bytes: 4, sourceSha256: digest('data') }));
    await fs.writeFile(path.join(root, id, 'source'), 'fake');
    assert.equal(await verifyLocalInput(root, { id, bytes: 4, sourceSha256: digest('data') }), false);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('browser direct delivery uses a scoped grant and failures fall back without throwing', async () => {
  const calls = [], statuses = [];
  let fail = false;
  const options = { file: new Blob(['data']), documentId: 'a'.repeat(32), status: text => statuses.push(text),
    send: async (url, method, body) => { calls.push(body); return { ticket: 'x' }; },
    fetcher: async url => { if (fail && url.includes('/inputs/')) throw new Error('offline'); return { ok: true, json: async () => ({ ok: true, workerId: 'b'.repeat(32) }) }; } };
  assert.equal(await sendLocalInput(options), true);
  fail = true; assert.equal(await sendLocalInput(options), false);
  assert.equal(calls.at(-1).cancel, true);
  assert.match(statuses.at(-1), /服务器流程/);
});
