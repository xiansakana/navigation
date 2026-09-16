import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginateActions } from './store.js';

const actions = [
  { id: '5', source: 'auto' },
  { id: '4', source: 'user' },
  { id: '3', source: 'auto' },
  { id: '2', source: 'user' },
  { id: '1', source: 'auto' }
];

test('operation records paginate newest-first rows', () => {
  const page = paginateActions(actions, { limit: 2, offset: 2 });
  assert.equal(page.total, 5);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 2);
  assert.deepEqual(page.items.map((item) => item.id), ['3', '2']);
});

test('operation record source filter is applied before pagination', () => {
  const page = paginateActions(actions, { limit: 2, offset: 1, source: 'auto' });
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.map((item) => item.id), ['3', '1']);
});
