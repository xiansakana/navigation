import test from 'node:test';
import assert from 'node:assert/strict';
import { initSchema } from '../../shared/db/schema.js';
import { addMedia, blogAccess, changePost, createPost, getImage, listPosts, validateContent } from './blog.js';
import { isPortalApi, resolveRoute } from './router.js';

test('blog permissions and media route are enforced', function() {
    const reader = { userId: 'reader', permissions: ['blog:feed:view'], isGuest: false };
    const writer = { userId: 'writer', permissions: ['blog:post:edit'], isGuest: false };
    const guest = { userId: 'guest', permissions: ['blog:post:edit'], isGuest: true };
    assert.deepEqual(blogAccess(reader), { canView: true, canPost: false, canManage: false });
    assert.deepEqual(blogAccess(writer), { canView: true, canPost: true, canManage: false });
    assert.deepEqual(blogAccess(guest), { canView: false, canPost: false, canManage: false });
    const route = '/api/blog/posts/' + '0'.repeat(32) + '/media';
    assert.equal(isPortalApi(route, 'POST'), true);
    assert.equal(resolveRoute([], route, 'POST').kind, 'portal-api');
    assert.equal(isPortalApi(route, 'GET'), false);
});

test('blog stores unlimited media metadata with ownership and keeps legacy images readable', async function(t) {
    const sqlite = await import('node:sqlite').catch(() => null);
    if (!sqlite) return t.skip('node:sqlite requires Node 22 or newer');
    const db = new sqlite.DatabaseSync(':memory:');
    try {
        initSchema(db);
        const author = { userId: 'author', username: '作者', permissions: ['blog:post:edit'], isGuest: false };
        const other = { userId: 'other', username: '他人', permissions: ['blog:post:edit'], isGuest: false };
        const manager = { userId: 'manager', username: '管理员', permissions: ['blog:manage:edit'], isGuest: false };
        const id = createPost(db, author, '', true);
        assert.equal(addMedia(db, id, other, { kind: 'image', mimeType: 'image/jpeg', url: 'https://example.test/x.jpg', storageKey: 'x.jpg' }).status, 403);
        const ids = [];
        for (let i = 0; i < 6; i++) {
            const item = addMedia(db, id, author, { kind: i === 5 ? 'video' : 'image',
                mimeType: i === 5 ? 'video/mp4' : 'image/jpeg',
                url: `https://example.test/${i}`, storageKey: String(i) });
            ids.push(item.id);
        }
        assert.equal(listPosts(db)[0].images.length, 5);
        assert.equal(listPosts(db)[0].videos.length, 1);
        assert.equal(changePost(db, id, other, '篡改').status, 403);
        assert.throws(() => changePost(db, id, author, '', false, { keepMediaIds: ['0'.repeat(32)] }), /参数无效/);
        assert.equal(changePost(db, id, manager, '更新', false, { keepMediaIds: ids.slice(0, 2) }).status, 200);
        assert.equal(listPosts(db)[0].images.length, 2);
        assert.equal(listPosts(db)[0].videos.length, 0);
        const legacyId = 'f'.repeat(32);
        db.prepare('INSERT INTO blog_images (id, post_id, author_id, mime_type, image_data, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(legacyId, id, author.userId, 'image/png', Buffer.from([1, 2]), 0, new Date().toISOString());
        assert.equal(getImage(db, legacyId).mimeType, 'image/png');
        assert.equal(listPosts(db)[0].images.length, 3);
        assert.equal(changePost(db, id, manager, null, true).status, 200);
        assert.equal(listPosts(db).length, 0);
        assert.throws(() => validateContent(' '.repeat(10)), /请输入/);
        assert.throws(() => validateContent('字'.repeat(10001)), /最多/);
    } finally { db.close(); }
});
