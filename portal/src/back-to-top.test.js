import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { serveUiAsset } from '../../shared/ui-assets.js';

const script = readFileSync(new URL('../../shared/ui/back-to-top.js', import.meta.url), 'utf8');
function setup() {
  const dom = new JSDOM('<main style="overflow-y:auto"></main><div role="dialog"><section style="overflow-y:auto"></section></div>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.requestAnimationFrame = (fn) => { fn(); return 1; };
  window.matchMedia = () => ({ matches: false });
  const page = window.document.documentElement;
  Object.defineProperty(page, 'clientHeight', { value: 800 });
  window.eval(script);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const button = window.document.getElementById('navigation-back-to-top').shadowRoot.querySelector('button');
  const scroll = (target, top) => {
    target.scrollTop = top;
    target.dispatchEvent(new window.Event('scroll'));
  };
  return { dom, window, page, button, scroll };
}

test('long pages show the button after scrolling and respect reduced motion', () => {
  const { dom, window, page, button, scroll } = setup();
  assert.equal(button.hidden, true);
  scroll(page, 600);
  assert.equal(button.hidden, false);
  const calls = [];
  page.scrollTo = (options) => calls.push(options);
  button.click();
  assert.equal(calls[0].top, 0);
  assert.equal(calls[0].behavior, 'smooth');
  window.matchMedia = () => ({ matches: true });
  button.click();
  assert.equal(calls[1].behavior, 'instant');
  scroll(page, 0);
  assert.equal(button.hidden, true);
  window.eval(script);
  assert.equal(window.document.querySelectorAll('#navigation-back-to-top').length, 1);
  dom.window.close();
});

test('nested page scrolling targets that region while dialogs do not trigger it', () => {
  const { dom, window, button, scroll } = setup();
  const main = window.document.querySelector('main');
  const dialog = window.document.querySelector('section');
  for (const node of [main, dialog]) Object.defineProperty(node, 'clientHeight', { value: 600 });
  scroll(dialog, 900);
  assert.equal(button.hidden, true);
  scroll(main, 700);
  assert.equal(button.hidden, false);
  let returned = false;
  main.scrollTo = (options) => { returned = options.top === 0; };
  button.click();
  assert.equal(returned, true);
  main.remove();
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(button.hidden, true);
  dom.window.close();
});

test('shared button asset is available and all first-party HTML pages load it', () => {
  const res = { writeHead(status) { assert.equal(status, 200); }, end(body) { this.body = body; } };
  assert.equal(serveUiAsset({ url: '/ui/back-to-top.js?v=1', method: 'GET' }, res), true);
  assert.match(res.body.toString(), /navigationBackToTop/);
  for (const service of ['portal', 'stock-manage', 'qqq-dip', 'qq-bot', 'torn-toolbox-desktop']) {
    const dir = new URL(`../../${service}/public/`, import.meta.url);
    for (const file of readdirSync(dir, { recursive: true }).filter(name => name.endsWith('.html'))) {
      assert.match(readFileSync(new URL(file.replaceAll('\\', '/'), dir), 'utf8'), /\/ui\/back-to-top\.js/, `${service}/${file}`);
    }
  }
});
