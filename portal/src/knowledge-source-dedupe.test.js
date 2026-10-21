import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createKnowledgeStore } from './knowledge-store.js';
import { createUploadQueue, runUploadQueue } from './knowledge-upload-queue.js';
import { sourceKey } from './knowledge-source-dedupe.js';

const canonical = 'https://www.bilibili.com/video/BV1LTpi69Efh/';
const variants = [canonical, canonical + '?p=1&spm_id_from=share#t=30', 'http://m.bilibili.com/video/BV1LTpi69Efh?p=01&share_source=copy'];
const upload = sourceUrl => ({ title: '已有视频', sourceUrl, bytes: 24, originalName: 'video.mp4', mimeType: 'video/mp4' });
const defaults = { backend: 'codex', quality: { quality: 80, strict: true }, modelSettings: {} };

test('source identity ignores Bilibili sharing variations but preserves video case, parts and unrelated URL parameters', () => {
  for (const url of variants) assert.equal(sourceKey(url), sourceKey(canonical));
  assert.notEqual(sourceKey(canonical + '?p=2'), sourceKey(canonical));
  assert.notEqual(sourceKey(canonical.toLowerCase()), sourceKey(canonical));
  assert.notEqual(sourceKey('https://example.com/watch?id=1'), sourceKey('https://example.com/watch?id=2'));
  assert.equal(sourceKey('http://b23.tv/TestAlias/?share_source=copy'), sourceKey('https://b23.tv/TestAlias'));
  assert.equal(sourceKey(''), ''); assert.equal(sourceKey('not a URL'), '');
});

test('old upload sources, original import URLs and queue entries prevent another document, scoped to its owner', () => {
  const db = new Database(':memory:');
  try {
    const store = createKnowledgeStore(db), queue = createUploadQueue(db), saved = store.create('a', upload(variants[2]));
    db.prepare("UPDATE knowledge_documents SET status='ready' WHERE id=?").run(saved.id);
    for (const url of variants) {
      assert.throws(() => store.create('a', upload(url)), error => error.code === 'KNOWLEDGE_DUPLICATE_SOURCE' && error.duplicate.documentId === saved.id);
      const batch = queue.add('a', { urls: [url] }, defaults);
      assert.equal(batch.accepted, 0); assert.equal(batch.results[0].documentId, saved.id);
    }
    assert.ok(store.create('b', upload(canonical)).id, 'other users retain their own independent library');
    store.imports.add('a', saved.id, canonical);
    store.edit('a', saved.id, { title: saved.title, sourceUrl: 'https://example.com/corrected', revision: 0 });
    assert.equal(store.duplicateSource('a', canonical).document_id, saved.id, 'editing display source does not bypass original import identity');
    const second = store.create('a', upload(canonical + '?p=2'));
    assert.throws(() => store.edit('a', second.id, { title: second.title, sourceUrl: variants[1], revision: 0 }), /不能重复导入/);
    assert.ok(store.edit('a', second.id, { title: '修改标题', sourceUrl: canonical + '?p=2&share_source=test', revision: 0 }));
    const pending = queue.add('a', { urls: [canonical + '?p=3', canonical + '?p=3&spm_id_from=share'] }, defaults);
    assert.equal(pending.accepted, 1); assert.equal(pending.results[1].status, 'duplicate');
    assert.throws(() => store.create('a', upload(canonical + '?p=3')), error => error.code === 'KNOWLEDGE_DUPLICATE_SOURCE' && error.duplicate.queueId === pending.results[0].id);
    store.remove('a', saved.id);
    assert.ok(store.create('a', upload(canonical)).id, 'deleted notes no longer reserve their source');
  } finally { db.close(); }
});

test('short-link resolution detects legacy duplicates before quality checks, downloads or new model tasks', async () => {
  const db = new Database(':memory:');
  try {
    const store = createKnowledgeStore(db), queue = createUploadQueue(db), saved = store.create('a', upload(variants[1]));
    db.prepare("UPDATE knowledge_documents SET status='ready' WHERE id=?").run(saved.id);
    const entry = queue.add('a', { urls: ['https://b23.tv/TestAlias'] }, defaults).results[0];
    await runUploadQueue(db, () => assert.fail('no media directory needed'), () => true, {
      inspect: async () => ({ sourceUrl: canonical, title: '视频' }),
      quality: async () => assert.fail('duplicate must be rejected before playback inspection')
    });
    assert.equal(queue.get('a', entry.id).state, 'duplicate'); assert.equal(queue.get('a', entry.id).document_id, saved.id);
    assert.equal(store.list('a').total, 1);
  } finally { db.close(); }
});
