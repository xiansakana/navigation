import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeStore, MAX_VIDEO_BYTES } from './knowledge-store.js';
import { createUploadQueue, runUploadQueue } from './knowledge-upload-queue.js';

test('115 archives have no cumulative byte quota; local storage and temporary upload limits remain enforced', async t => {
  t.mock.method(fs, 'statfs', async () => ({ bavail: 64 * 1024 ** 3, bsize: 1 }));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-quota-'));
  const previous = process.env.KNOWLEDGE_STORAGE_CONFIG;
  process.env.KNOWLEDGE_STORAGE_CONFIG = path.join(directory, 'storage.json');
  const db = new Database(':memory:');
  try {
    await fs.writeFile(process.env.KNOWLEDGE_STORAGE_CONFIG, JSON.stringify({ users: {
      cloud: { baseUrl: 'http://127.0.0.1:15244', token: 'test-only', rootPath: '/115/Knowledge' }
    } }));
    const store = createKnowledgeStore(db);
    const input = { title: '课程', bytes: MAX_VIDEO_BYTES, mimeType: 'video/mp4', originalName: 'lesson.mp4' };
    for (const uid of ['cloud', 'local']) {
      for (let i = 0; i < 20; i++) {
        const doc = store.create(uid, input);
        db.prepare("UPDATE knowledge_documents SET status='ready' WHERE id=?").run(doc.id);
      }
    }
    assert.throws(() => store.create('local', input), /服务器存储最多20GB/);
    assert.ok(store.create('cloud', input).id, 'local-file submissions can exceed 20GB when bound to 115');
    assert.throws(() => store.create('cloud', { ...input, bytes: MAX_VIDEO_BYTES + 1 }), /1GB/);

    const queue = createUploadQueue(db);
    const url = 'https://www.bilibili.com/video/BV1LTpi69Efh/';
    queue.add('cloud', { urls: [url] }, { backend: 'codex', quality: { quality: 80, strict: true }, modelSettings: {} });
    await runUploadQueue(db, id => path.join(directory, 'media', id), () => true, {
      inspect: async () => ({ sourceUrl: url, title: '链接视频', topic: '', tags: [] }),
      quality: async () => ({ canImport: true })
    });
    const entry = queue.list('cloud').entries[0];
    assert.equal(entry.state, 'submitted', entry.error);
    assert.equal(store.get('cloud', entry.documentId).storage.provider, '115');
    for (let i = 0; i < 3; i++) store.create('cloud', input);
    assert.throws(() => store.create('cloud', input), error => error.code === 'KNOWLEDGE_CAPACITY');
  } finally {
    db.close();
    if (previous === undefined) delete process.env.KNOWLEDGE_STORAGE_CONFIG;
    else process.env.KNOWLEDGE_STORAGE_CONFIG = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
