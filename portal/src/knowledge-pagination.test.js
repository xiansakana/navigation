import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotePager } from '../public/knowledge/pagination.js';

const filters = { search: '', topic: '', status: '' };
const page = (offset, total = 79) => ({ total, documents: Array.from({ length: Math.min(30, Math.max(0, total - offset)) }, (_, i) => ({ id: String(offset + i) })), topics: [] });

test('polling retains the current page and applied filters, while changed filters return to page one', async () => {
  const requests = [];
  const pager = createNotePager(async params => { requests.push(params); return page(params.offset); });
  assert.equal((await pager.load(filters)).offset, 0);
  const second = await pager.load(filters, 30);
  assert.equal(second.documents[0].id, '30'); assert.equal(second.documents.length, 30);
  for (let i = 0; i < 3; i++) assert.equal((await pager.refresh()).offset, 30);
  assert.deepEqual(requests.at(-1), { ...filters, offset: 30, limit: 30 });
  assert.equal((await pager.load({ ...filters, topic: '课程' }, 60)).offset, 0);
  assert.equal((await pager.load({ ...filters, topic: '课程' }, 30)).offset, 30);
  assert.equal((await pager.refresh()).offset, 30);
  assert.equal(requests.at(-1).topic, '课程');
});

test('polling cannot override a pending navigation, and late responses cannot restore an older page', async () => {
  const pending = [];
  const pager = createNotePager(params => new Promise(resolve => pending.push({ params, resolve })));
  const first = pager.load(filters); pending[0].resolve(page(0)); await first;
  const second = pager.load(filters, 30);
  assert.equal(await pager.refresh(), null); assert.equal(pending.length, 2);
  const third = pager.load(filters, 60);
  pending[2].resolve(page(60)); assert.equal((await third).offset, 60);
  pending[1].resolve(page(30)); assert.equal(await second, null);
  const refresh = pager.refresh(); assert.equal(pending[3].params.offset, 60);
  pending[3].resolve(page(60)); await refresh;
});

test('deleting the last page clamps to a valid page, and failed requests retain the committed page', async () => {
  let total = 79, failed = false;
  const pager = createNotePager(async params => { if (failed) throw new Error('offline'); return page(params.offset, total); });
  await pager.load(filters); await pager.load(filters, 60);
  total = 60;
  const clamped = await pager.refresh(); assert.equal(clamped.offset, 30); assert.equal(clamped.documents.length, 30);
  failed = true;
  await assert.rejects(pager.load(filters, 0), /offline/);
  failed = false; assert.equal((await pager.refresh()).offset, 30);
  total = 0; const empty = await pager.refresh(); assert.equal(empty.offset, 0); assert.deepEqual(empty.documents, []);
});
