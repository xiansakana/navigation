import test from 'node:test';
import assert from 'node:assert/strict';
import { initSchema } from '../../shared/db/schema.js';
import { createPost, changePost, listPosts, handleBlogApi } from './blog.js';
import { normalizeSearch } from './blog-content.js';

test('search finds visible rich/Markdown text, author, tags and address; literals and pagination stay accurate', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    initSchema(db);
    const writer = { userId: 'writer', username: 'Alice', permissions: ['blog:post:edit'] };
    const rich = createPost(db, writer, '<p>项目<strong>进展</strong> 50%_完成</p><a href="https://hidden.example">文档</a>', false,
      { contentFormat: 'html', tags: ['工作'], location: { label: '上海市 · 世纪大道', latitude: 31.2, longitude: 121.5 } });
    const markdown = createPost(db, writer, '# 项目进展\n\n**记录**', false, { contentFormat: 'markdown', tags: ['生活'] });
    assert.equal(listPosts(db, null, 20, '', '项目进展').length, 2);
    assert.equal(listPosts(db, null, 20, '工作', '项目进展')[0].id, rich);
    assert.equal(listPosts(db, null, 20, '生活', '项目进展')[0].id, markdown);
    for (const query of ['ALICE', '工作', '世纪大道', '50%_']) assert.ok(listPosts(db, null, 20, '', query).some(p => p.id === rich));
    for (const query of ['hidden.example', '<strong>', "' OR 1=1 --", '不存在']) assert.equal(listPosts(db, null, 20, '', query).length, 0);
    const before = db.prepare('SELECT created_at, updated_at FROM blog_posts WHERE id = ?').get(rich);
    db.prepare('UPDATE blog_posts SET search_text = NULL WHERE id = ?').run(rich);
    assert.equal(listPosts(db, null, 20, '', '项目进展').length, 2);
    assert.deepEqual(db.prepare('SELECT created_at, updated_at FROM blog_posts WHERE id = ?').get(rich), before);
    changePost(db, rich, writer, '新内容');
    assert.equal(listPosts(db, null, 20, '工作', '项目进展').length, 0);
    assert.equal(listPosts(db, null, 20, '工作', '新内容')[0].id, rich);
    for (let i = 0; i < 23; i++) createPost(db, writer, '分页关键词 ' + i, false, { tags: ['分页'] });
    const first = listPosts(db, null, 20, '分页', '分页关键词');
    const second = listPosts(db, first.at(-1).id, 20, '分页', '分页关键词');
    assert.equal(first.length, 20); assert.equal(second.length, 3);
    assert.equal(new Set([...first, ...second].map(p => p.id)).size, 23);
    assert.equal(normalizeSearch('  ＨＥＬＬＯ\n World '), 'hello world');
    assert.throws(() => normalizeSearch('字'.repeat(201)), /200/);
  } finally { db.close(); }
});

test('search API denies readers without blog permission', async () => {
  let status;
  await handleBlogApi({ method: 'GET' }, {}, new URL('https://saoyu.fun/api/blog/posts?q=keyword'), { permissions: [] }, (_, code) => { status = code; }, {});
  assert.equal(status, 403);
});
