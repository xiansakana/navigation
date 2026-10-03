import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../../shared/db/schema.js';
import { VIDEO_CHUNK_BYTES, validateVideoUpload, validateVideoPart, findVideoUpload, completedVideoParts, forgetVideoUpload, startVideoUpload, writeVideoPart, abortVideoUpload } from './blog-video-upload.js';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import { joinVideoParts, uploadDirectory } from './blog-media-process.js';
import { isPortalApi } from './router.js';

test('multipart videos accept over 50MB and enforce actual part lengths, file signature and complete ordered parts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchema(db); initSchema(db);
    const size = 70 * 1024 * 1024;
    validateVideoUpload(size, 'video/webm');
    assert.throws(() => validateVideoUpload(size, 'image/jpeg'));
    const id = 'a'.repeat(32);
    db.prepare('INSERT INTO blog_video_uploads (id, post_id, user_id, mime_type, byte_size, storage_key, multipart_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'post', 'owner', 'video/webm', size, 'key', 'multipart', new Date().toISOString());
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

test('video staging keeps original data off B2, joins parallel parts in order and removes cancelled files', async () => {
  const db = new DatabaseSync(':memory:');
  let upload;
  try {
    initSchema(db);
    const size = VIDEO_CHUNK_BYTES + 20;
    const result = await startVideoUpload(db, 'post', 'owner', size, 'video/webm', 7);
    upload = findVideoUpload(db, result.id, { userId: 'owner' });
    assert.equal(upload.multipart_id, 'local'); assert.equal(upload.position, 7); assert.match(upload.storage_key, /\.mp4$/);
    const first = Buffer.alloc(VIDEO_CHUNK_BYTES, 1); first.set([0x1a, 0x45, 0xdf, 0xa3]);
    const last = Buffer.alloc(20, 2);
    await Promise.all([writeVideoPart(db, upload, 2, Readable.from([last])), writeVideoPart(db, upload, 1, Readable.from([first]))]);
    const input = await joinVideoParts(upload, completedVideoParts(db, upload));
    const bytes = await fsp.readFile(input);
    assert.equal(bytes.length, size); assert.ok(bytes.subarray(0, first.length).equals(first)); assert.ok(bytes.subarray(first.length).equals(last));
    await assert.rejects(writeVideoPart(db, { ...upload, state: 'compressing' }, 2, Readable.from([last])), /已经开始/);
    await abortVideoUpload(db, upload);
    assert.equal(findVideoUpload(db, upload.id, { userId: 'owner' }), null);
    await assert.rejects(fsp.stat(uploadDirectory(upload.id)), { code: 'ENOENT' });
    assert.equal(isPortalApi('/api/blog/video-uploads/' + result.id, 'GET'), true);
  } finally { if (upload) await abortVideoUpload(db, upload); db.close(); }
});
