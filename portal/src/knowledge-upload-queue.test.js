import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUploadQueue, runUploadQueue } from './knowledge-upload-queue.js';
import { createKnowledgeStore } from './knowledge-store.js';
import { createFileQueue } from '../public/knowledge/file-queue.js';
import { parseBatchLinks } from '../public/knowledge/queue.js';

const url = i => 'https://www.bilibili.com/video/BV1LTpi69Efh/' + (i > 1 ? '?p=' + i : '');
const defaults = { backend: 'codex', quality: { quality: 80, strict: true }, modelSettings: { codexModel: 'gpt-6-luna', codexEffort: 'high', apiModel: '', apiEffort: '' } };
const metadata = async link => ({ sourceUrl: link, title: '视频 ' + link, topic: '命理', tags: ['自动标签'] });
async function fixture(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-submission-'));
  const db = new Database(path.join(directory, 'test.sqlite')), store = createKnowledgeStore(db), queue = createUploadQueue(db);
  const run = (options = {}, authorize = () => true) => runUploadQueue(db, id => path.join(directory, 'media', id), authorize, { inspect: metadata, quality: async () => ({ canImport: true }), ...options });
  try { await fn({ db, store, queue, directory, run }); }
  finally { db.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('batch submissions persist beyond five slots; FIFO promotion resumes and preserves metadata/model/quality snapshots', async () => fixture(async ({ db, store, queue, run }) => {
  const result = queue.add('a', { urls: Array.from({ length: 8 }, (_, i) => url(i + 1)), tags: ['共同标签'] }, defaults);
  assert.equal(result.accepted, 8);
  store.saveSettings('a', { codexModel: 'changed-model', codexEffort: 'low' });
  for (let i = 0; i < 5; i++) assert.equal(await run(), true);
  assert.equal(await run(), false);
  assert.equal(queue.list('a').active, 5); assert.equal(queue.list('a').counts.pending, 3);
  const first = store.list('a').documents.find(d => d.sourceUrl === url(1));
  assert.deepEqual(first.tags, ['共同标签', '自动标签']); assert.equal(first.topic, '命理');
  assert.equal(first.modelSettings.codexModel, 'gpt-6-luna');
  assert.equal(JSON.parse(store.imports.get('a', first.id).settings_json).strict, true);
  db.prepare("UPDATE knowledge_documents SET status='ready',byte_size=24 WHERE id=?").run(first.id);
  assert.equal(await run(), true);
  assert.equal(queue.list('a').counts.pending, 2); assert.equal(queue.list('a').active, 5);
  const reopened = createUploadQueue(db); assert.equal(reopened.list('a').total, 8);
  assert.equal(reopened.list('b').total, 0);
}));

test('validation, canonical duplicate detection, stale-lease recovery, scoped cancellation and retries', async () => fixture(async ({ db, queue, run }) => {
  const added = queue.add('a', { urls: [url(1), url(1) + '?spm_id_from=test', 'https://evil.test/video', url(2)] }, defaults);
  assert.deepEqual(added.results.map(r => r.status), ['accepted', 'duplicate', 'invalid', 'accepted']);
  assert.throws(() => queue.add('a', { urls: Array(101).fill(url(1)) }, defaults));
  const first = queue.claim(); assert.equal(first.url, url(1));
  assert.equal(queue.change('b', first.id, 'cancel'), false);
  db.prepare('UPDATE knowledge_upload_queue SET expires=0 WHERE id=?').run(first.id);
  const current = queue.claim(); assert.equal(current.id, first.id); assert.notEqual(current.lease, first.lease);
  assert.equal(queue.settle(first, 'submitted'), false);
  assert.equal(queue.change('a', current.id, 'cancel'), true);
  assert.equal(queue.settle(current, 'submitted'), false, 'cancelled resolution cannot create a document');
  await run({ inspect: async () => { throw new Error('unavailable'); } });
  const failed = queue.list('a').entries.find(e => e.state === 'failed'); assert.ok(failed);
  assert.equal(queue.change('a', failed.id, 'retry'), true);
  await run(); assert.equal(queue.get('a', failed.id).state, 'submitted');
  assert.equal(queue.change('a', failed.id, 'cancel'), false);
}));

test('failure of one video, revoked permission, cancellation while resolving and short aliases do not affect other entries', async () => fixture(async ({ queue, store, run }) => {
  const added = queue.add('a', { urls: [url(1), url(2), 'https://b23.tv/alias'] }, defaults);
  await run({ quality: async () => ({ canImport: false, reason: '需要1080p' }) });
  assert.equal(queue.get('a', added.results[0].id).state, 'failed');
  await run(); assert.equal(queue.get('a', added.results[1].id).state, 'submitted');
  await run({ inspect: async () => metadata(url(2)) });
  assert.equal(queue.get('a', added.results[2].id).state, 'duplicate');
  assert.equal(store.list('a').total, 1);
  const cancelled = queue.add('a', { urls: [url(3)] }, defaults).results[0];
  await run({ inspect: async link => { queue.change('a', cancelled.id, 'cancel'); return metadata(link); } });
  assert.equal(store.list('a').total, 1);
  const denied = queue.add('a', { urls: [url(4)] }, defaults).results[0];
  await run({}, () => false); assert.match(queue.get('a', denied.id).error, /权限/);
}));

test('single-link queue preserves edited title/source and cancelled links can be submitted again', async () => fixture(async ({ queue, store, run }) => {
  const first = queue.add('a', { urls: [url(1)] }, defaults).results[0]; queue.change('a', first.id, 'cancel');
  assert.equal(queue.add('a', { urls: [url(1)], title: '我的标题', sourceUrl: 'https://example.com/source', topic: '自定义' }, defaults).accepted, 1);
  await run(); const item = store.list('a').documents[0];
  assert.equal(item.title, '我的标题'); assert.equal(item.sourceUrl, 'https://example.com/source'); assert.equal(item.topic, '自定义');
  assert.deepEqual(item.tags, [], 'single-link edits do not silently restore removed tags');
}));

test('local file queue waits for capacity, uploads sequentially, isolates failures and supports retry/cancel without losing resume', async () => {
  let free = false, wake, attempts = 0, complete;
  const done = new Promise(resolve => { complete = resolve; });
  const queue = createFileQueue({ capacity: async () => ({ active: free ? 0 : 5, capacity: 5 }), wait: () => new Promise(resolve => { wake = resolve; }),
    upload: async entry => { attempts++; if (entry.name === 'a.mp4' && attempts === 1) { entry.resume = { id: 'partial' }; throw new Error('network'); } },
    changed: () => { if (queue.entries.length === 3 && queue.entries[1].state === 'submitted') complete(); } });
  queue.add([{ name: 'a.mp4' }, { name: 'b.mp4' }, { name: 'c.mp4' }], { title: 'ignored shared title' });
  assert.equal(queue.add([{ name: 'a.mp4' }], { title: 'duplicate' }), 0);
  await Promise.resolve(); await Promise.resolve(); assert.equal(attempts, 0); assert.ok(queue.pending());
  queue.cancel('3'); free = true; wake(); await done;
  assert.equal(queue.entries[0].state, 'failed'); assert.equal(queue.entries[0].resume.id, 'partial');
  assert.equal(queue.entries[1].metadata.title, 'b'); assert.equal(queue.entries[2].state, 'cancelled');
  queue.retry('1'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.entries[0].state, 'submitted'); assert.equal(queue.pending(), false);
});

test('batch share parsing keeps every URL and retains malformed lines for validation feedback', () => {
  assert.deepEqual(parseBatchLinks('分享 ' + url(1) + ' ' + url(2) + '\n bad-input\n\n'), [url(1), url(2), 'bad-input']);
});
