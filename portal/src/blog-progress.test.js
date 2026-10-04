import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

test('editing upload progress stays inside the post content and preserves the editor', () => {
  const dom = new JSDOM('<article class="blog-post"><span class="blog-avatar">A</span><div class="blog-post-main"><div contenteditable="true">draft</div></div></article><div class="blog-composer"></div>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(fs.readFileSync(new URL('../public/blog-progress.js', import.meta.url), 'utf8'));
    const post = dom.window.document.querySelector('article');
    const items = [{ file: { name: 'IMG_3017.mov' }, kind: 'video' }, { file: { name: 'IMG_0998.mov' }, kind: 'video' }];
    const progress = dom.window.createBlogUploadProgress(post, items);
    progress.update(0, 'compressing', 0);
    progress.update(1, 'transfer', 97);
    assert.equal(post.children.length, 2);
    assert.equal(post.querySelector('.blog-upload-progress').parentElement, post.querySelector('.blog-post-main'));
    assert.equal(post.querySelector('[contenteditable]').textContent, 'draft');
    assert.match(post.querySelector('[role=status]').textContent, /0 \/ 2/);
    progress.clear();
    assert.equal(post.querySelector('.blog-upload-progress'), null);
    const composer = dom.window.document.querySelector('.blog-composer');
    dom.window.createBlogUploadProgress(composer, items);
    assert.equal(composer.querySelector('.blog-upload-progress').parentElement, composer);
  } finally { dom.window.close(); }
});
