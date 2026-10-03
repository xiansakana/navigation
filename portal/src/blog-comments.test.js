import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../../shared/db/schema.js';
import { createPost, changePost, listPosts, addMedia, getVisibleMedia } from './blog.js';
import { createComment, listComments, deleteComment, commentAccess } from './blog-comments.js';
import { isPortalApi } from './router.js';

test('comments and thumbnails follow post audience and expiry, enforce roles and cascade deletion', () => {
  const db = new DatabaseSync(':memory:');
  const author = { userId: 'author', username: '作者', permissions: ['blog:post:edit', 'blog:comment:edit'] };
  const reader = { userId: 'reader', username: '读者', permissions: ['blog:feed:view'] };
  const moderator = { userId: 'moderator', permissions: ['blog:feed:view', 'blog:comment-manage:edit'] };
  try {
    initSchema(db); initSchema(db);
    const post = createPost(db, author, '私密', false, { visibility: { audience: 'self' } });
    const media = addMedia(db, post, author, { kind: 'image', mimeType: 'image/jpeg', url: 'https://example.test/a.jpg', storageKey: 'a.jpg', thumbnailData: Buffer.from([0xff, 0xd8]) });
    assert.equal(getVisibleMedia(db, media.id, reader, undefined, true), undefined);
    assert.deepEqual(Buffer.from(getVisibleMedia(db, media.id, author, undefined, true).thumbnailData), Buffer.from([0xff, 0xd8]));
    assert.equal(listPosts(db, null, 20, '', '', author)[0].images[0].thumbnailUrl, '/api/blog/media/' + media.id + '?thumbnail=1');
    const markdown = '**加粗**\n\n- 列表\n\n`代码`\n\n[链接](https://example.com)\n\n<script>bad()</script>\n\n[危险](javascript:alert(1))';
    const comment = createComment(db, post, author, markdown);
    assert.equal(comment.status, 201);
    assert.equal(createComment(db, post, author, 'too fast').status, 429);
    assert.equal(createComment(db, post, reader, 'hidden').status, 404);
    assert.equal(listComments(db, post, reader).status, 404);
    assert.equal(deleteComment(db, comment.id, moderator).status, 404);
    assert.equal(commentAccess({ ...author, isGuest: true }).canComment, false);
    assert.equal(commentAccess({ permissions: ['blog:comment:edit'] }).canComment, false);
    assert.equal(createComment(db, post, { ...reader, isGuest: true }, 'guest').status, 403);
    changePost(db, post, author, '公开', false, { visibility: { audience: 'public' } });
    const rendered = listComments(db, post, reader).comments[0];
    assert.equal(rendered.content, markdown);
    assert.equal(rendered.contentFormat, 'markdown');
    assert.match(rendered.contentHtml, /<strong>加粗<\/strong>/);
    assert.match(rendered.contentHtml, /<ul>/);
    assert.match(rendered.contentHtml, /<code>代码<\/code>/);
    assert.match(rendered.contentHtml, /href="https:\/\/example.com"/);
    assert.doesNotMatch(rendered.contentHtml, /<script|javascript:/i);
    assert.equal(listComments(db, post, reader).comments[0].canDelete, false);
    assert.equal(deleteComment(db, comment.id, reader).status, 403);
    assert.equal(deleteComment(db, comment.id, moderator).status, 200);
    assert.equal(commentAccess(reader).canComment, true);
    const own = createComment(db, post, reader, 'hello'); assert.equal(own.status, 201);
    assert.equal(listComments(db, post, author).comments[0].canDelete, true);
    changePost(db, post, author, '过期', false, { visibility: { period: 'custom', endsAt: '2020-01-01T00:00:00Z' } });
    assert.equal(listComments(db, post, reader).status, 404);
    assert.equal(deleteComment(db, own.id, reader).status, 404);
    assert.equal(listComments(db, post, author).comments.length, 1);
    changePost(db, post, author, null, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_comments').get().n, 0);
    assert.equal(isPortalApi('/api/blog/posts/' + post + '/comments', 'POST'), true);
    assert.equal(isPortalApi('/api/blog/comments/' + own.id, 'DELETE'), true);
  } finally { db.close(); }
});

test('comment pagination visits all entries once and validates text', () => {
  const db = new DatabaseSync(':memory:');
  const author = { userId: 'author', username: '作者', permissions: ['blog:post:edit', 'blog:comment:edit'] };
  try {
    initSchema(db); const post = createPost(db, author, '文章');
    for (let i = 0; i < 43; i++) db.prepare('INSERT INTO blog_comments (id,post_id,author_id,author_name,content,created_at) VALUES (?, ?, ?, ?, ?, ?)').run(String(i).padStart(32, '0'), post, 'other', '读者', String(i), '2026-01-01T00:00:00.000Z');
    const legacy = listComments(db, post, author).comments[0];
    assert.equal(legacy.contentFormat, 'text');
    assert.equal(legacy.contentHtml, null);
    let before, ids = [];
    do { const page = listComments(db, post, author, before); assert.equal(page.status, 200); ids.push(...page.comments.map(c => c.id)); before = page.next; } while (before);
    assert.equal(ids.length, 43); assert.equal(new Set(ids).size, 43);
    assert.equal(listComments(db, post, author, 'bad').status, 400);
    assert.equal(createComment(db, post, author, ' ').status, 400);
    assert.equal(createComment(db, post, author, {}).status, 400);
    assert.equal(createComment(db, post, author, '<script>bad()</script>').status, 400);
    assert.equal(createComment(db, post, author, 'x'.repeat(2001)).status, 400);
  } finally { db.close(); }
});
