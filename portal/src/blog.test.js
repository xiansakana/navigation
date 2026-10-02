import test from 'node:test';
import assert from 'node:assert/strict';
import { initSchema } from '../../shared/db/schema.js';
import { blogAccess, changePost, createPost, decodeImages, getImage, listPosts, validateContent } from './blog.js';
import { isPortalApi, resolveRoute } from './router.js';

test('blog permissions separate reading, posting and managing', function() {
    const reader = { userId: 'reader', permissions: ['blog:feed:view'], isGuest: false };
    const writer = { userId: 'writer', permissions: ['blog:post:edit'], isGuest: false };
    const guest = { userId: 'guest', permissions: ['blog:post:edit'], isGuest: true };
    assert.deepEqual(blogAccess(reader), { canView: true, canPost: false, canManage: false });
    assert.deepEqual(blogAccess(writer), { canView: true, canPost: true, canManage: false });
    assert.deepEqual(blogAccess(guest), { canView: false, canPost: false, canManage: false });
    assert.equal(isPortalApi('/api/blog/posts', 'POST'), true);
    assert.equal(resolveRoute([], '/api/blog/posts', 'POST').kind, 'portal-api');
    assert.equal(resolveRoute([], '/api/blog/images/0123456789abcdef0123456789abcdef', 'GET').kind, 'portal-api');
});

test('blog persistence enforces ownership and content limits', async function(t) {
    const sqlite = await import('node:sqlite').catch(function() { return null; });
    if (!sqlite) return t.skip('node:sqlite requires Node 22 or newer');
    const DatabaseSync = sqlite.DatabaseSync;
    const db = new DatabaseSync(':memory:');
    try {
        initSchema(db);
        const author = { userId: 'author', username: '作者', permissions: ['blog:post:edit'], isGuest: false };
        const other = { userId: 'other', username: '他人', permissions: ['blog:post:edit'], isGuest: false };
        const manager = { userId: 'manager', username: '管理员', permissions: ['blog:manage:edit'], isGuest: false };
        const png = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==' };
        const id = createPost(db, author, ' 第一篇 ');
        assert.equal(listPosts(db)[0].content, '第一篇');
        assert.equal(changePost(db, id, other, '篡改').status, 403);
        assert.equal(changePost(db, id, author, '更新').status, 200);
        assert.equal(listPosts(db)[0].content, '更新');
        assert.equal(changePost(db, id, other, '', false, { images: [png] }).status, 403);
        assert.equal(changePost(db, id, author, '', false, { images: [png], keepImageIds: [] }).status, 200);
        const imageId = listPosts(db)[0].images[0].id;
        assert.equal(listPosts(db)[0].content, '');
        assert.equal(getImage(db, imageId).mimeType, 'image/png');
        assert.throws(() => changePost(db, id, author, '', false, { keepImageIds: ['0'.repeat(32)] }), /参数无效/);
        assert.equal(changePost(db, id, manager, '管理员更新', false, { keepImageIds: [] }).status, 200);
        assert.equal(getImage(db, imageId), undefined);
        const imageOnlyId = createPost(db, author, '', [png]);
        assert.equal(listPosts(db).find(function(post) { return post.id === imageOnlyId; }).images.length, 1);
        assert.equal(changePost(db, imageOnlyId, author, null, true).status, 200);
        assert.equal(changePost(db, id, manager, null, true).status, 200);
        assert.equal(listPosts(db).length, 0);
        assert.throws(() => validateContent(' '.repeat(10)), /请输入/);
        assert.throws(() => validateContent('字'.repeat(10001)), /最多/);
        assert.throws(() => decodeImages([{ mime: 'image/svg+xml', data: png.data }]), /格式无效/);
        assert.throws(() => decodeImages([{ mime: 'image/png', data: Buffer.from('not png').toString('base64') }]), /图片无效/);
        assert.throws(() => decodeImages([png, png, png, png, png]), /最多上传/);
    } finally {
        db.close();
    }
});
