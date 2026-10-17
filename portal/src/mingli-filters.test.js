import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createMingliStore } from './mingli-store.js';
import { parseCaseFilters } from './mingli-filters.js';
import { handleMingliApi } from './mingli.js';
import { closeDatabase } from '../../shared/db/index.js';
import { resolveLoggedInPermissions } from './auth.js';

const birth = { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1, location: '安徽省 池州市 100%_区' };
const payload = { name: '案例', birth, tags: ['学习'], notes: '已核验' };
// Explicit natal snapshots isolate relation semantics from calendar-date selection.
function natal(db, store, uid, name, pairs, overrides = {}) {
  const item = store.save(uid, { ...payload, name, ...overrides });
  const chart = item.chart;
  chart.pillars = pairs.map((pair, i) => ({ ...chart.pillars[i], gan: pair[0], zhi: pair[1], ganZhi: pair }));
  db.prepare('UPDATE mingli_cases SET chart_json=? WHERE id=?').run(JSON.stringify(chart), item.id);
  return item.id;
}

test('advanced filters intersect search/category, isolate owners, and paginate only after filtering', () => {
  const db = new Database(':memory:');
  try {
    const store = createMingliStore(db), category = store.categories.save('a', { name: '亲友' });
    for (let i = 0; i < 36; i++) natal(db, store, 'a', '命中' + i, ['甲子', '己丑', '壬辰', '戊辰'], { categoryId: category.id });
    natal(db, store, 'a', '排除', ['乙卯', '庚申', '丙午', '癸亥'], { birth: { ...birth, gender: 0 }, notes: '' });
    natal(db, store, 'b', '命中他人', ['甲子', '己丑', '壬辰', '戊辰']);
    const filters = { gender: 1, location: '100%_', solarFrom: '2005-12-23', solarTo: '2005-12-23', notes: 'yes',
      pillars: [{ gan: '甲' }, { zhi: '丑' }, {}, {}], characters: ['甲', '辰'], relations: ['stem-combine:甲己', 'branch-combine:子丑', 'punish:辰辰'] };
    const query = { filters, search: '命中', categoryId: category.id, limit: 30 };
    const first = store.list('a', query), second = store.list('a', { ...query, offset: 30 });
    assert.equal(first.total, 36); assert.equal(first.cases.length, 30); assert.equal(second.total, 36); assert.equal(second.cases.length, 6);
    assert.equal(new Set([...first.cases, ...second.cases].map(c => c.id)).size, 36);
    for (const extra of [{ location: 'missing' }, { gender: 0 }, { solarFrom: '2005-12-24' }, { notes: 'no' }, { characters: ['癸'] }, { pillars: [{ zhi: '午' }, {}, {}, {}] }]) {
      assert.equal(store.list('a', { ...query, filters: { ...filters, ...extra, ...(extra.solarFrom ? { solarTo: '2005-12-25' } : {}) } }).total, 0);
    }
    assert.equal(store.list('a', { filters: { gender: 0, notes: 'no' } }).total, 1);
    assert.equal(store.list('a', { ...query, search: '他人' }).total, 0);
    assert.equal(store.list('b', { filters }).total, 1);
  } finally { db.close(); }
});

test('relations count distinct positions, require complete triples, and support explicit all/any semantics', () => {
  const db = new Database(':memory:');
  try {
    const store = createMingliStore(db);
    const single = natal(db, store, 'a', '单辰', ['甲子', '己丑', '壬辰', '戊午']);
    const double = natal(db, store, 'a', '双辰', ['甲子', '己丑', '壬辰', '戊辰']);
    const triple = natal(db, store, 'a', '三刑', ['甲寅', '乙巳', '丙申', '丁酉']);
    const ids = filters => store.list('a', { filters }).cases.map(c => c.id).sort();
    assert.deepEqual(ids({ relations: ['punish:辰辰'] }), [double]);
    assert.deepEqual(ids({ relations: ['punish:寅巳申'] }), [triple]);
    assert.deepEqual(ids({ relations: ['triple-combine:申子辰'] }), []);
    assert.deepEqual(ids({ relations: ['punish:辰辰', 'punish:寅巳申'], relationMode: 'all' }), []);
    assert.deepEqual(ids({ relations: ['punish:辰辰', 'punish:寅巳申'], relationMode: 'any' }), [double, triple].sort());
    assert.deepEqual(ids({ relations: ['stem-combine:甲己', 'branch-combine:子丑'] }), [single, double].sort());
    assert.deepEqual(ids({ characters: ['庚'] }), []); // hidden stems never count as exposed stems
  } finally { db.close(); }
});

test('date filtering uses civil Gregorian snapshot for lunar inputs and preserves saved charts', () => {
  const db = new Database(':memory:');
  try {
    const store = createMingliStore(db);
    const item = store.save('a', { ...payload, birth: { ...birth, calendar: 'lunar', month: 11, day: 23 } });
    const before = JSON.stringify(store.get('a', item.id)), solar = item.chart.solar.slice(0, 10);
    assert.equal(store.list('a', { filters: { solarFrom: solar, solarTo: solar } }).total, 1);
    assert.equal(JSON.stringify(store.get('a', item.id)), before);
  } finally { db.close(); }
});

test('filter validation rejects invalid structures, dates, SQL fragments and unbounded lists', () => {
  for (const value of ['{', 'x'.repeat(6001), 'null', '[]', { unknown: 1 }, { gender: 2 }, { gender: false }, { location: {} }, { solarFrom: '2005-02-30' },
    { solarFrom: '1899-01-01' }, { solarFrom: '2005-12-24', solarTo: '2005-12-23' }, { notes: 'maybe' }, { characters: '甲' }, { characters: ['甲 OR 1=1'] },
    { pillars: [] }, { pillars: [{ gan: '甲子' }, {}, {}, {}] }, { pillars: [{ sql: '1=1' }, {}, {}, {}] }, { relations: ['clash:子子'] }, { relationMode: 'OR 1=1' }]) {
    assert.throws(() => parseCaseFilters(value));
  }
  assert.deepEqual(parseCaseFilters({ characters: [], relations: [], pillars: [{}, {}, {}, {}], relationMode: 'all' }), {});
});

test('advanced search requires its permission in addition to case read and cannot cross user boundaries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingli-filter-api-')), previous = process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH = path.join(dir, 'test.db');
  const member = id => ({ userId: id, permissions: resolveLoggedInPermissions({ roles: [] }, { id, username: id }) });
  async function call(route, session = member('a'), method = 'GET', data) {
    let result, status;
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (data) yield Buffer.from(JSON.stringify(data)); } };
    await handleMingliApi(req, { setHeader() {} }, new URL('http://localhost/api/mingli' + route), session, (_, s, r) => { status = s; result = r; });
    return { status, result };
  }
  try {
    assert.equal((await call('/cases', member('a'), 'POST', payload)).status, 201);
    const route = '/cases?filters=' + encodeURIComponent(JSON.stringify({ gender: 1, location: '安徽' }));
    assert.equal((await call(route)).result.total, 1);
    assert.equal((await call(route, member('b'))).result.total, 0);
    assert.equal((await call(route, { userId: 'a', permissions: ['mingli:view', 'mingli:cases:view'] })).status, 403);
    assert.equal((await call(route, { userId: 'a', permissions: ['mingli:view', 'mingli:cases:filter'] })).status, 403);
    assert.equal((await call(route, { ...member('a'), isGuest: true })).status, 403);
    assert.equal((await call('/cases?filters=%7B')).status, 400);
    assert.equal((await call('/cases?filters={}', { userId: 'a', permissions: ['mingli:view', 'mingli:cases:view'] })).status, 200);
  } finally {
    closeDatabase(); if (previous === undefined) delete process.env.NAVIGATION_DB_PATH; else process.env.NAVIGATION_DB_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
