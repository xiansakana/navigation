import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContent, normalizeTags } from './blog-content.js';
import { initSchema } from '../../shared/db/schema.js';
import { createPost, changePost, listPosts } from './blog.js';

test('rich text keeps supported formatting and removes executable HTML and unsafe links', () => {
  const value = '<h2>标题</h2><p><b>粗体</b><i>斜体</i><u>下划线</u></p><ul><li>列表</li></ul><blockquote>引用</blockquote>';
  assert.equal(normalizeContent(value, 'html'), value);
  const dirty = '<script>alert(1)</script><img src=x onerror=alert(2)><svg onload=alert(3)></svg><p onclick="alert(4)">正文</p><a href="javascript:alert(5)">链接</a><a href="https://example.test" style="color:red">安全链接</a>';
  const clean = normalizeContent(dirty, 'html');
  assert.ok(!/script|onerror|onload|onclick|javascript:|<img|<svg|style=/.test(clean));
  assert.match(clean, /<p>正文<\/p>/);
  assert.match(clean, /href="https:\/\/example.test" target="_blank" rel="noopener noreferrer"/);
  assert.ok(!normalizeContent('<a href="//evil.test">x</a>', 'html').includes('href='));
  assert.ok(!normalizeContent('<a href="data:text/html,test">x</a>', 'html').includes('href='));
  assert.equal(normalizeContent('<b>literal</b>\nplain', 'text'), '<b>literal</b>\nplain');
  assert.throws(() => normalizeContent('<p>&nbsp;<br></p>', 'html'), /请输入/);
  assert.throws(() => normalizeContent('<script>x</script>', 'html'), /请输入/);
  assert.equal(normalizeContent('<p><br></p>', 'html', true), '');
  assert.throws(() => normalizeContent('<p>' + '&amp;'.repeat(10001) + '</p>', 'html'), /最多/);
  assert.throws(() => normalizeContent('x', 'unknown'), /格式/);
});

test('tags are normalized, deduplicated and bounded', () => {
  assert.deepEqual(normalizeTags([' #工作 ', '工作', '', '生活', 'e\u0301', 'é']), ['工作', '生活', 'é']);
  assert.throws(() => normalizeTags('工作'), /参数/);
  assert.throws(() => normalizeTags([1]), /参数/);
  assert.throws(() => normalizeTags(['字'.repeat(31)]), /30/);
  assert.throws(() => normalizeTags(['换\n行']), /换行/);
  assert.throws(() => normalizeTags(Array.from({ length: 21 }, (_, i) => String(i))), /20/);
});

test('legacy migration, rich persistence, tag pagination and author permissions', async t => {
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite) return t.skip('node:sqlite requires Node 22 or newer');
  const db = new sqlite.DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE blog_posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO blog_posts VALUES (?, ?, ?, ?, ?, ?)').run('0'.repeat(32), 'old', '旧作者', '<旧文章>\n第二行', '2020-01-01', '2020-01-01');
    initSchema(db); initSchema(db);
    assert.equal(listPosts(db)[0].contentFormat, 'text');
    assert.deepEqual(listPosts(db)[0].tags, []);
    const author = { userId: 'author', username: '作者', permissions: ['blog:post:edit'] };
    const other = { userId: 'other', permissions: ['blog:post:edit'] };
    const id = createPost(db, author, '<p><b>文章</b></p>', false, { contentFormat: 'html', tags: ['工作', '生活'] });
    const next = createPost(db, author, '第二篇', false, { tags: ['工作'] });
    const first = listPosts(db, null, 1, '工作')[0];
    const second = listPosts(db, first.id, 1, '工作')[0];
    assert.deepEqual(new Set([first.id, second.id]), new Set([id, next]));
    assert.equal(listPosts(db, second.id, 1, '工作').length, 0);
    assert.equal(changePost(db, id, other, '篡改', false, { tags: ['恶意'] }).status, 403);
    assert.equal(changePost(db, id, author, '<h2>更新</h2>', false, { contentFormat: 'html', tags: ['日记'] }).status, 200);
    assert.equal(listPosts(db, null, 20, '日记')[0].content, '<h2>更新</h2>');
    assert.equal(listPosts(db, null, 20, '工作').length, 1);
    assert.throws(() => changePost(db, id, author, '无效', false, { tags: ['字'.repeat(31)] }), /30/);
    assert.equal(listPosts(db, null, 20, '日记')[0].content, '<h2>更新</h2>');
    changePost(db, id, author, '兼容旧客户端');
    assert.deepEqual(listPosts(db, null, 20, '日记')[0].tags, ['日记']);
    changePost(db, id, author, null, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_post_tags WHERE post_id = ?').get(id).n, 0);
  } finally { db.close(); }
});
