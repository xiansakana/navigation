import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../../shared/db/schema.js';
import { createPost, addMedia, changePost, listPosts } from './blog.js';
import { enqueueMediaCleanup, drainMediaCleanup } from './blog-media-cleanup.js';
import { deleteMediaVersions } from './blog-media-storage.js';

test('editing queues removed media atomically, keeps shared files and retries failures across worker restarts', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchema(db);
    const user = { userId: 'owner', username: '作者', permissions: ['blog:post:edit'] };
    const first = createPost(db, user, '正文');
    const second = createPost(db, user, '另一个博客');
    const media = key => ({ kind: 'image', url: 'https://assets.example/' + key, mimeType: 'image/jpeg', storageKey: key });
    const keep = addMedia(db, first, user, media('keep.jpg'), 3);
    addMedia(db, first, user, media('remove.jpg'), 2);
    addMedia(db, first, user, media('shared.jpg'), 1);
    addMedia(db, second, user, media('shared.jpg'));
    changePost(db, first, user, '文字修改');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_media_cleanup').get().n, 0);
    changePost(db, first, user, '移除图片', false, { keepMediaIds: [keep.id] });
    assert.equal(listPosts(db, null, 20, '', '移除图片')[0].images[0].id, keep.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_media_cleanup').get().n, 2);
    const removed = [];
    await drainMediaCleanup(db, { remove: async items => { removed.push(items[0].storageKey); throw new Error('临时网络故障'); } });
    assert.deepEqual(removed, ['remove.jpg']);
    const job = db.prepare('SELECT * FROM blog_media_cleanup').get();
    assert.equal(job.attempts, 1); assert.match(job.last_error, /网络/);
    await drainMediaCleanup(db, { remove: async () => assert.fail('not due yet') });
    await drainMediaCleanup(db, { remove: async items => removed.push(items[0].storageKey) }, new Date(Date.parse(job.next_at) + 1));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_media_cleanup').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_media WHERE storage_key = ?').get('shared.jpg').n, 1);
    db.prepare('INSERT INTO blog_video_uploads (id, post_id, user_id, mime_type, byte_size, storage_key, multipart_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('unfinished', first, user.userId, 'video/webm', 100, 'unfinished.webm', 'b2-upload', new Date().toISOString());
    changePost(db, first, user, null, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_video_uploads').get().n, 0);
    const aborted = [];
    await drainMediaCleanup(db, { remove: async () => {}, abort: async item => aborted.push(item.multipartId) });
    assert.deepEqual(aborted, ['b2-upload']);
    assert.throws(() => enqueueMediaCleanup(db, [{ storageKey: '../other' }], user.userId));
  } finally { db.close(); }
});

test('permanent deletion paginates exact-key versions and deletes hide markers after file versions', async () => {
  const commands = [];
  let pages = 0;
  const client = { send: async command => {
    commands.push(command);
    if (command.constructor.name === 'ListObjectVersionsCommand') {
      return pages++ === 0 ? { Versions: [{ Key: 'blog.jpg', VersionId: 'v1' }, { Key: 'blog.jpg.other', VersionId: 'unrelated' }], IsTruncated: true, NextKeyMarker: 'blog.jpg', NextVersionIdMarker: 'v1' }
        : { Versions: [{ Key: 'blog.jpg', VersionId: 'v2' }], DeleteMarkers: [{ Key: 'blog.jpg', VersionId: 'hidden' }] };
    }
    return {};
  } };
  await deleteMediaVersions(client, 'bucket', 'blog.jpg');
  const deleted = commands.filter(c => c.constructor.name === 'DeleteObjectCommand').map(c => c.input);
  assert.deepEqual(deleted.map(c => c.VersionId), ['v1', 'v2', 'hidden']);
  assert.ok(deleted.every(c => c.Key === 'blog.jpg'));
  commands.length = 0;
  await deleteMediaVersions(client, 'bucket', 'blog.jpg', () => false);
  assert.equal(commands.length, 0);
});
