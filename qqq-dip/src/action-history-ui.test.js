import assert from 'node:assert/strict';
import test from 'node:test';
import { createActionHistory } from '../public/js/action-history.js';

test('a slow history response cannot replace a newer filtered page', async () => {
  const elements = {};
  for (const id of ['action-filter', 'action-list', 'action-page-info', 'action-prev', 'action-next']) {
    elements[id] = { value: '' };
  }
  const calls = [];
  const history = createActionHistory({ getElementById: id => elements[id] }, {
    api: (path) => new Promise(resolve => calls.push({ path, resolve })),
    escapeHtml: String,
    formatDateTime: String
  });
  const previous = history.load(2);
  elements['action-filter'].value = 'manual';
  const latest = history.load(1);
  assert.match(calls[0].path, /offset=20&source=all/);
  assert.match(calls[1].path, /offset=0&source=manual/);
  calls[1].resolve({ items: [{ message: 'filtered result' }], total: 1 });
  await latest;
  history.acceptSnapshot({ items: [{ message: 'background refresh' }], total: 1 });
  calls[0].resolve({ items: [{ message: 'stale result' }], total: 40 });
  await previous;
  history.render();
  assert.match(elements['action-list'].innerHTML, /filtered result/);
  assert.equal(elements['action-next'].disabled, true);
});
