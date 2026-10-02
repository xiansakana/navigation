import test from 'node:test';
import assert from 'node:assert/strict';
import { initSchema } from '../../shared/db/schema.js';
import { blogAccess, changePost, createPost, listPosts, validateContent } from './blog.js';
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
        const id = createPost(db, author, ' 第一篇 ');
        assert.equal(listPosts(db)[0].content, '第一篇');
        assert.equal(changePost(db, id, other, '篡改').status, 403);
        assert.equal(changePost(db, id, author, '更新').status, 200);
        assert.equal(listPosts(db)[0].content, '更新');
        assert.equal(changePost(db, id, manager, null, true).status, 200);
        assert.equal(listPosts(db).length, 0);
        assert.throws(() => validateContent(' '.repeat(10)), /请输入/);
        assert.throws(() => validateContent('字'.repeat(10001)), /最多/);
    } finally {
        db.close();
    }
});
