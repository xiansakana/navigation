import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { serveUiAsset } from '../../shared/ui-assets.js';

const script = readFileSync(new URL('../../shared/ui/skeleton.js', import.meta.url), 'utf8');
function setup() {
  const dom = new JSDOM('<main data-skeleton="dashboard" data-skeleton-key="page"><input value="saved"><section data-skeleton="cards" data-skeleton-key="business"></section></main><div data-skeleton="cards" data-skeleton-key="blog" data-skeleton-ready></div>', { runScripts: 'outside-only' });
  dom.window.eval(script);
  return dom;
}

test('independent requests retain their skeleton until each settles', () => {
  const dom = setup();
  const { document, navigationSkeleton } = dom.window;
  assert.equal(document.querySelectorAll('.nav-skeleton').length, 2);
  navigationSkeleton.finish();
  assert.equal(document.querySelector('main').hasAttribute('aria-busy'), false);
  assert.equal(document.querySelector('[data-skeleton-key="business"]').getAttribute('aria-busy'), 'true');
  assert.equal(document.querySelector('input').value, 'saved');
  navigationSkeleton.finish('business');
  assert.equal(document.querySelectorAll('.nav-skeleton').length, 0);
  dom.window.close();
});

test('failure cleanup and repeated starts preserve DOM and restore prior aria state', () => {
  const dom = setup();
  const { document, navigationSkeleton } = dom.window;
  const blog = document.querySelector('[data-skeleton-key="blog"]');
  assert.equal(blog.querySelector('.nav-skeleton'), null);
  blog.setAttribute('aria-busy', 'false');
  navigationSkeleton.start('blog');
  navigationSkeleton.start('blog');
  assert.equal(blog.querySelectorAll('.nav-skeleton').length, 1);
  // Renderers can replace the content while a request is pending.
  blog.textContent = '加载失败，请重试';
  navigationSkeleton.finish('blog');
  navigationSkeleton.finish('blog');
  assert.equal(blog.textContent, '加载失败，请重试');
  assert.equal(blog.getAttribute('aria-busy'), 'false');
  assert.equal(blog.hasAttribute('data-skeleton-active'), false);
  dom.window.close();
});

test('shared assets support direct services, query versions, HEAD and exact paths', () => {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  assert.equal(serveUiAsset({ url: '/skeleton/skeleton.css?v=1', method: 'GET' }, res), true);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/css/);
  assert.match(res.body.toString(), /prefers-reduced-motion/);
  assert.equal(serveUiAsset({ url: '/skeleton/skeleton.js', method: 'HEAD' }, res), true);
  assert.equal(res.body, undefined);
  assert.equal(serveUiAsset({ url: '/skeleton/../ui-assets.js', method: 'GET' }, res), false);
});
