import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../../shared/db/schema.js';
import { VIDEO_CHUNK_BYTES, validateVideoUpload, validateVideoPart, findVideoUpload, completedVideoParts, forgetVideoUpload } from './blog-video-upload.js';
import { isPortalApi } from './router.js';

test('multipart videos accept over 50MB and enforce actual part lengths, file signature and complete ordered parts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchema(db); initSchema(db);
    const size = 70 * 1024 * 1024;
    validateVideoUpload(size, 'video/webm');
    assert.throws(() => validateVideoUpload(size, 'image/jpeg'));
    const id = 'a'.repeat(32);
    db.prepare('INSERT INTO blog_video_uploads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'post', 'owner', 'video/webm', size, 'key', 'multipart', new Date().toISOString());
    const upload = findVideoUpload(db, id, { userId: 'owner' });
    assert.ok(upload);
    assert.equal(findVideoUpload(db, id, { userId: 'other' }), null);
    assert.equal(findVideoUpload(db, id, { userId: 'owner', isGuest: true }), null);
    const first = Buffer.alloc(VIDEO_CHUNK_BYTES);
    first.set([0x1a, 0x45, 0xdf, 0xa3]);
    validateVideoPart(upload, 1, first);
    assert.throws(() => validateVideoPart(upload, 1, Buffer.alloc(VIDEO_CHUNK_BYTES)), /格式/);
    assert.throws(() => validateVideoPart(upload, 0, first), /编号/);
    assert.throws(() => validateVideoPart(upload, 10, first), /编号/);
    assert.throws(() => validateVideoPart(upload, 2, first.subarray(0, 12)), /大小/);
    assert.throws(() => completedVideoParts(db, upload), /尚未/);
    for (let part = 9; part >= 1; part--) {
      const bytes = part === 9 ? size - 8 * VIDEO_CHUNK_BYTES : VIDEO_CHUNK_BYTES;
      db.prepare('INSERT INTO blog_video_parts VALUES (?, ?, ?, ?)').run(id, part, 'etag-' + part, bytes);
    }
    const parts = completedVideoParts(db, upload);
    assert.equal(parts.length, 9); assert.equal(parts[0].PartNumber, 1); assert.equal(parts.at(-1).ETag, 'etag-9');
    assert.equal(isPortalApi('/api/blog/posts/' + id + '/video-uploads', 'POST'), true);
    assert.equal(isPortalApi('/api/blog/video-uploads/' + id + '/parts/1', 'PUT'), true);
    assert.equal(isPortalApi('/api/blog/video-uploads/' + id, 'DELETE'), true);
    forgetVideoUpload(db, id);
    assert.equal(findVideoUpload(db, id, { userId: 'owner' }), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM blog_video_parts').get().count, 0);
  } finally { db.close(); }
});
