import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../../shared/db/schema.js';
import { createPost, changePost, listPosts, listVisibleTags, addMedia, getVisibleMedia, getImage } from './blog.js';
import { normalizeVisibility, canViewPost } from './blog-visibility.js';
import { isPortalApi } from './router.js';
import { createComment, listComments } from './blog-comments.js';

const writer = { userId: 'author', username: '作者', permissions: ['blog:post:edit'] };
const member = { userId: 'reader', permissions: ['blog:feed:view'] };
const guest = { userId: 'author', isGuest: true, permissions: ['blog:feed:view'] };
const manager = { userId: 'admin', permissions: ['blog:manage:edit'] };

test('blog managers see every audience while ordinary members and guests remain restricted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchema(db);
    const publicId = createPost(db, writer, '公开');
    const membersId = createPost(db, writer, '登录', false, { visibility: { audience: 'members' } });
    const privateId = createPost(db, writer, '隐私关键词', false, { tags: ['私密标签'], visibility: { audience: 'self' } });
    const media = addMedia(db, privateId, writer, { kind: 'image', mimeType: 'image/jpeg', url: 'https://assets.example/private.jpg', storageKey: 'private.jpg' });
    db.prepare('INSERT INTO blog_images VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy', privateId, writer.userId, 'image/jpeg', Buffer.from([1, 2]), 0, new Date().toISOString());
    const ids = session => listPosts(db, null, 20, '', '', session).map(p => p.id).sort();
    assert.deepEqual(ids(guest), [publicId]);
    assert.deepEqual(ids(member), [publicId, membersId].sort());
    assert.deepEqual(ids(manager), [publicId, membersId, privateId].sort());
    assert.equal(ids(writer).length, 3);
    assert.equal(listPosts(db, null, 20, '', '隐私关键词', member).length, 0);
    assert.equal(listPosts(db, null, 20, '私密标签', '', member).length, 0);
    assert.equal(listVisibleTags(db, member).length, 0);
    assert.equal(listVisibleTags(db, writer)[0].tag, '私密标签');
    for (const session of [member, guest, { ...manager, isGuest: true }, { permissions: manager.permissions }]) {
      assert.equal(canViewPost(db, privateId, session), false);
      assert.equal(getVisibleMedia(db, media.id, session), undefined);
      assert.equal(getImage(db, 'legacy', session), undefined);
    }
    assert.ok(getVisibleMedia(db, media.id, writer));
    assert.ok(getImage(db, 'legacy', writer));
    assert.ok(getVisibleMedia(db, media.id, manager));
    assert.ok(getVisibleMedia(db, media.id, manager, undefined, true));
    assert.ok(getImage(db, 'legacy', manager));
    assert.equal(listPosts(db, null, 20, '', '隐私关键词', manager)[0].id, privateId);
    assert.equal(listPosts(db, null, 20, '私密标签', '', manager)[0].id, privateId);
    assert.equal(listVisibleTags(db, manager)[0].tag, '私密标签');
    assert.equal(createComment(db, privateId, writer, '私密评论').status, 201);
    assert.equal(listComments(db, privateId, manager).comments[0].content, '私密评论');
    assert.equal(listComments(db, privateId, member).status, 404);
    assert.match(listPosts(db, null, 20, '', '隐私关键词', writer)[0].images[1].url, /^\/api\/blog\/media\//);
    assert.equal(isPortalApi('/api/blog/media/' + media.id, 'GET'), true);
    assert.equal(changePost(db, privateId, member, '公开', false, { visibility: {} }).status, 403);
  } finally { db.close(); }
});

test('custom time uses inclusive start, exclusive end; author retains access, edits preserve window and original publish time', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchema(db);
    const startsAt = '2026-10-04T01:00:00.000Z', endsAt = '2026-10-04T02:00:00.000Z';
    const id = createPost(db, writer, '定时', false, { tags: ['定时标签'], visibility: { period: 'custom', startsAt, endsAt } });
    const created = db.prepare('SELECT created_at FROM blog_posts WHERE id = ?').get(id).created_at;
    const count = (session, now) => listPosts(db, null, 20, '', '', session, now).length;
    assert.equal(count(member, '2026-10-04T00:59:59.999Z'), 0);
    assert.equal(count(member, startsAt), 1);
    assert.equal(count(member, endsAt), 0);
    assert.equal(count(writer, endsAt), 1);
    assert.equal(count(manager, '2026-10-04T00:59:59.999Z'), 1);
    assert.equal(count(manager, endsAt), 1);
    assert.equal(listVisibleTags(db, member, endsAt).length, 0);
    changePost(db, id, writer, '修改正文');
    const post = listPosts(db, null, 20, '', '', writer)[0];
    assert.equal(post.visibility.endsAt, endsAt);
    assert.equal(post.createdAt, created);
    changePost(db, id, writer, '三天后隐藏', false, { visibility: { period: '3d' } });
    assert.equal(listPosts(db, null, 20, '', '', writer)[0].visibility.endsAt, new Date(Date.parse(created) + 3 * 86400000).toISOString());
    changePost(db, id, writer, '无限期公开', false, { visibility: { audience: 'public', period: 'always' } });
    assert.equal(count(member, endsAt), 1);
  } finally { db.close(); }
});

test('mixed private posts do not shorten pages; migration preserves old public content and times', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE blog_posts (id TEXT PRIMARY KEY, author_id TEXT, author_name TEXT, content TEXT, created_at TEXT, updated_at TEXT)');
    db.prepare('INSERT INTO blog_posts VALUES (?, ?, ?, ?, ?, ?)').run('old', 'oldAuthor', '旧作者', '旧动态', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    initSchema(db); initSchema(db);
    for (let i = 0; i < 23; i++) {
      createPost(db, writer, '分页关键词 ' + i, false, { tags: ['分页'] });
      createPost(db, writer, '分页关键词 私密 ' + i, false, { tags: ['分页'], visibility: { audience: 'self' } });
    }
    const first = listPosts(db, null, 20, '分页', '分页关键词', member);
    const second = listPosts(db, first.at(-1).id, 20, '分页', '分页关键词', member);
    assert.equal(first.length, 20); assert.equal(second.length, 3);
    assert.equal(new Set([...first, ...second].map(p => p.id)).size, 23);
    assert.equal(listVisibleTags(db, member)[0].count, 23);
    const old = listPosts(db, null, 20, '', '旧动态', guest)[0];
    assert.deepEqual(old.visibility, { audience: 'public', period: 'always', startsAt: null, endsAt: null });
    assert.equal(old.updatedAt, '2020-01-01T00:00:00.000Z');
  } finally { db.close(); }
});

test('visibility validates dates, enums and order and normalizes explicit timezone', () => {
  assert.equal(normalizeVisibility({ period: 'custom', endsAt: '2026-10-04T10:00:00+08:00' }).endsAt, '2026-10-04T02:00:00.000Z');
  for (const value of [null, [], 'self', { audience: 'everyone' }, { period: 'custom' }, { period: 'custom', endsAt: '2026-10-04T10:00' },
    { period: 'custom', startsAt: '2026-10-04T02:00:00Z', endsAt: '2026-10-04T01:00:00Z' }]) assert.throws(() => normalizeVisibility(value));
});
