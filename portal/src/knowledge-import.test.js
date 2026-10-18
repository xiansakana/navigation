import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeStore, MAX_VIDEO_BYTES } from './knowledge-store.js';
import { runKnowledgeImport } from './knowledge-import.js';

async function fixture(fn) {
  const db = new Database(':memory:'), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'link-queue-'));
  const store = createKnowledgeStore(db);
  const add = (uid = 'a') => db.transaction(() => {
    const d = store.create(uid, { title: '自动标题', topic: '命理', tags: ['八字'], sourceUrl: 'https://www.bilibili.com/video/BV1LTpi69Efh/', bytes: MAX_VIDEO_BYTES, mimeType: 'video/mp4', originalName: 'video.mp4' });
    store.imports.add(uid, d.id, d.sourceUrl);
    db.prepare("UPDATE knowledge_documents SET status='importing' WHERE id=?").run(d.id); return d;
  })();
  try { await fn({ db, store, directory, add }); }
  finally { db.close(); await fs.rm(directory, { recursive: true, force: true }); }
}
test('durable link import becomes a hashed queued source; worker can read before 115 archive completes', async () => fixture(async ({ db, store, directory, add }) => {
  const d = add(); store.sources.add('a', d.id, '/115/test/source.mp4');
  store.saveSettings('a', { codexModel: 'gpt-6-luna', codexEffort: 'high' });
  const originalSettings = store.get('a', d.id).modelSettings;
  await runKnowledgeImport(db, () => directory, () => true, { async download(url, dir, { progress }) {
    progress(32); const file = path.join(dir, 'test.mp4'); await fs.writeFile(file, Buffer.alloc(32)); return { file, bytes: 32,
      media: { requestedQuality: 80, quality: 80, width: 1920, height: 1080, strict: true, downgraded: false }, cleanup: async () => {} };
  } });
  const item = store.get('a', d.id);
  assert.equal(item.status, 'queued'); assert.equal(item.bytes, 32); assert.equal(item.importState, 'done');
  assert.deepEqual(item.modelSettings, originalSettings); assert.equal(item.storage.state, 'pending');
  assert.equal(item.sourceMedia.width, 1920); assert.equal(item.sourceMedia.quality, 80);
  assert.match(store.getRow('a', d.id).source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(store.get('b', d.id), null);
  assert.equal(store.claim('b', ['codex']), null);
  assert.equal(store.claim('a', ['codex']).id, d.id);
}));
test('import failures and revoked authorization do not reach processing; retry re-enters download, not model queue', async () => fixture(async ({ db, store, directory, add }) => {
  const d = add();
  await runKnowledgeImport(db, () => directory, () => false, { download() { assert.fail('must not download'); } });
  assert.equal(store.get('a', d.id).status, 'failed'); assert.equal(store.claim('a', ['codex']), null);
  assert.equal(store.retry('a', d.id, 'codex'), true); assert.equal(store.get('a', d.id).status, 'importing');
  await runKnowledgeImport(db, () => directory, () => true, { download() { throw new Error('video unavailable'); } });
  assert.equal(store.get('a', d.id).error, 'video unavailable');
  store.remove('a', d.id); assert.equal(store.imports.get('a', d.id), undefined);
}));
test('stale download leases resume after restart; previous owner cannot commit or heartbeat', async () => fixture(async ({ db, store, add }) => {
  const d = add(), old = store.imports.claim();
  assert.equal(store.imports.claim(), null);
  db.prepare('UPDATE knowledge_imports SET heartbeat=0 WHERE document_id=?').run(d.id);
  const next = store.imports.claim(); assert.notEqual(next.lease, old.lease);
  assert.equal(store.imports.done(old), false); assert.equal(store.imports.touch(old), false); assert.equal(store.imports.done(next), true);
}));
