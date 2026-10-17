import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const script = readFileSync(new URL('../public/layout.js', import.meta.url), 'utf8');
async function setup(saved) {
  const dom = new JSDOM('<body class="portal-layout-enabled"><button class="navbar-layout-btn">全宽</button><button class="navbar-layout-btn"><span class="label">全宽</span></button><main data-layout-container></main></body>', { url: 'https://test/', runScripts: 'outside-only' });
  if (dom.window.document.readyState === 'loading') {
    await new Promise(resolve => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  if (saved !== undefined) dom.window.localStorage.setItem('smFullWidthLayout', JSON.stringify(saved));
  dom.window.eval(script);
  return dom;
}

test('layout toggles both button formats and all declared content containers', async () => {
  const dom = await setup(false);
  try {
    const { document } = dom.window;
    const buttons = [...document.querySelectorAll('.navbar-layout-btn')];
    const changes = [];
    dom.window.addEventListener('portal-layout-change', event => changes.push(event.detail.fullWidth));
    buttons[0].click();
    assert.equal(document.body.classList.contains('portal-layout--full'), true);
    assert.equal(document.querySelector('main').classList.contains('portal-layout--full'), true);
    for (const button of buttons) {
      assert.equal(button.textContent, '退出全宽');
      assert.equal(button.getAttribute('aria-pressed'), 'true');
    }
    buttons[1].querySelector('.label').click();
    assert.equal(document.body.classList.contains('portal-layout--full'), false);
    assert.equal(document.querySelector('main').classList.contains('portal-layout--full'), false);
    assert.equal(dom.window.localStorage.getItem('smFullWidthLayout'), 'false');
    assert.deepEqual(changes, [true, false]);
    for (const button of buttons) assert.equal(button.textContent, '全宽');
  } finally { dom.window.close(); }
});

test('new pages restore the persisted full-width preference on load', async () => {
  const dom = await setup(true);
  try {
    assert.equal(dom.window.document.querySelector('main').classList.contains('portal-layout--full'), true);
    assert.equal(dom.window.document.querySelector('.navbar-layout-btn').textContent, '退出全宽');
  } finally { dom.window.close(); }
});
