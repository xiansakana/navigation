import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createMingliStore } from './mingli-store.js';
import { calculateChart } from './mingli-chart.js';
import { handleMingliApi } from './mingli.js';
import { closeDatabase } from '../../shared/db/index.js';

const birth = { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1 };
const payload = { name: '分类测试案例', birth, tags: ['学习'], notes: '保留笔记' };

test('categories support counts, exact filtering, renames and deletion without deleting cases', () => {
  const db = new Database(':memory:');
  try {
    const store = createMingliStore(db), a = store.categories.save('a', { name: '家人' }), b = store.categories.save('a', { name: '同学' });
    const item = store.save('a', { ...payload, categoryId: a.id }), loose = store.save('a', payload);
    assert.equal(store.categories.list('a').categories.find(g => g.id === a.id).count, 1);
    assert.equal(store.categories.list('a').uncategorized, 1);
    assert.equal(store.list('a', { categoryId: a.id }).total, 1);
    assert.equal(store.list('a', { categoryId: b.id }).total, 0);
    assert.equal(store.list('a', { categoryId: 'uncategorized' }).cases[0].id, loose.id);
    assert.equal(store.list('a', { categoryId: a.id, search: 'missing' }).total, 0);
    store.categories.save('a', { name: '亲友' }, a.id);
    assert.equal(store.get('a', item.id).categoryName, '亲友');
    assert.throws(() => store.categories.save('a', { name: '亲友' }), /已存在/);
    assert.throws(() => store.categories.save('a', { name: '亲友' }, b.id), /已存在/);
    for (const name of ['', ' ', 'a'.repeat(31), null]) assert.throws(() => store.categories.save('a', { name }));
    store.save('a', { ...payload, notes: '只修改笔记' }, item.id);
    assert.equal(store.get('a', item.id).categoryId, a.id);
    assert.equal(store.categories.remove('a', a.id).moved, 1);
    assert.equal(store.get('a', item.id).categoryId, null);
    assert.equal(store.get('a', item.id).notes, '只修改笔记');
    assert.equal(store.list('a').total, 2);
    assert.equal(createMingliStore(db).categories.list('a').categories.length, 1);
  } finally { db.close(); }
});

test('category assignment and bulk changes isolate users and reject partial changes', () => {
  const db = new Database(':memory:');
  try {
    const store = createMingliStore(db), own = store.categories.save('a', { name: '客户' }), foreign = store.categories.save('b', { name: '客户' });
    const first = store.save('a', payload), second = store.save('a', payload), other = store.save('b', payload);
    assert.equal(store.categories.save('a', { name: '不能修改' }, foreign.id), null);
    assert.equal(store.categories.remove('a', foreign.id), null);
    assert.throws(() => store.categories.assign('a', [first.id], foreign.id), /不属于/);
    assert.throws(() => store.save('a', { ...payload, categoryId: foreign.id }), /不属于/);
    assert.equal(store.categories.assign('a', [first.id, other.id], own.id), null);
    assert.equal(store.get('a', first.id).categoryId, null);
    for (const ids of [[], ['bad'], Array(201).fill(first.id)]) assert.throws(() => store.categories.assign('a', ids, own.id));
    assert.throws(() => store.categories.assign('a', [first.id], undefined));
    assert.equal(store.categories.assign('a', [first.id, second.id, first.id], own.id).count, 2);
    assert.equal(store.categories.list('a').categories[0].count, 2);
    assert.equal(store.categories.list('b').categories[0].count, 0);
    assert.equal(store.list('b', { categoryId: own.id }).total, 0);
    assert.equal(store.categories.assign('a', [first.id], '').count, 1);
    assert.equal(store.get('a', second.id).notes, '保留笔记');
  } finally { db.close(); }
});

test('legacy source groups migrate once per owner without changing records or source snapshots', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE mingli_cases (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,birth_json TEXT NOT NULL,chart_json TEXT NOT NULL,tags_json TEXT NOT NULL,notes TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_type TEXT,source_key TEXT,source_json TEXT)');
  const chart = JSON.stringify(calculateChart(birth)), source = JSON.stringify({ provider: 'wenzhen', group: '家人', originalPillars: '乙酉戊子辛巳壬辰' });
  const id = 'a'.repeat(32), otherId = 'b'.repeat(32);
  for (const [key, uid] of [[id, 'a'], [otherId, 'b']]) db.prepare('INSERT INTO mingli_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(key, uid, '旧案例', JSON.stringify(birth), chart, '["家人","自定义标签"]', '旧笔记', 'old-created', 'old-updated', 'wenzhen', 'source-' + uid, source);
  try {
    let store = createMingliStore(db);
    const own = store.categories.list('a').categories[0], foreign = store.categories.list('b').categories[0];
    assert.notEqual(own.id, foreign.id); assert.equal(own.count, 1); assert.equal(foreign.count, 1);
    const after = db.prepare('SELECT chart_json,source_json,tags_json,notes,updated_at FROM mingli_cases WHERE id=?').get(id);
    assert.equal(after.chart_json, chart); assert.equal(after.source_json, source); assert.equal(after.tags_json, '["家人","自定义标签"]');
    assert.equal(after.notes, '旧笔记'); assert.equal(after.updated_at, 'old-updated');
    store.categories.save('a', { name: '亲友' }, own.id);
    store = createMingliStore(db); assert.equal(store.get('a', id).categoryName, '亲友');
    store.categories.remove('a', own.id);
    store = createMingliStore(db); assert.equal(store.get('a', id).categoryId, null); assert.equal(store.categories.list('a').categories.length, 0);
    assert.equal(store.get('b', otherId).categoryName, '家人');
  } finally { db.close(); }
});

test('category API checks action grants, ownership and classification permission on case saves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingli-categories-')), previous = process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH = path.join(dir, 'test.db');
  const session = (userId = 'a', permissions = ['*']) => ({ userId, isGuest: false, permissions });
  const call = async (route, method = 'GET', data, ctx = session()) => {
    let status, result;
    await handleMingliApi({ method, headers: {}, async *[Symbol.asyncIterator]() { if (data !== undefined) yield Buffer.from(JSON.stringify(data)); } },
      { setHeader() {} }, new URL('http://localhost/api/mingli' + route), ctx, (_, s, r) => { status = s; result = r; });
    return { status, result };
  };
  try {
    const limited = session('a', ['mingli:view', 'mingli:cases:edit']);
    for (const [route, method, data] of [['/categories', 'GET'], ['/categories', 'POST', { name: '分类' }], ['/cases/category', 'POST', { ids: ['a'.repeat(32)], categoryId: '' }]]) assert.equal((await call(route, method, data, limited)).status, 403);
    const category = (await call('/categories', 'POST', { name: '家人' })).result.category;
    assert.equal((await call('/cases', 'POST', { ...payload, categoryId: category.id }, limited)).status, 403);
    const created = await call('/cases', 'POST', { ...payload, categoryId: category.id }); assert.equal(created.status, 201);
    const item = created.result.case;
    assert.equal((await call('/cases?categoryId=' + category.id)).result.total, 1);
    assert.deepEqual((await call('/categories', 'GET', undefined, session('b'))).result.categories, []);
    assert.equal((await call('/categories/' + category.id, 'DELETE', undefined, session('b'))).status, 404);
    assert.equal((await call('/cases/category', 'POST', { ids: [item.id], categoryId: '' }, session('b'))).status, 404);
    assert.equal((await call('/cases/' + item.id, 'PUT', { ...payload, notes: '改笔记' }, limited)).status, 200);
    assert.equal((await call('/cases/' + item.id)).result.case.categoryId, category.id);
    assert.equal((await call('/cases/category', 'POST', { ids: [item.id], categoryId: '' })).result.count, 1);
    assert.equal((await call('/cases?categoryId=uncategorized')).result.total, 1);
    assert.equal((await call('/categories/' + category.id, 'PUT', { name: '亲友' })).status, 200);
    assert.equal((await call('/categories/' + category.id, 'DELETE')).status, 200);
  } finally {
    closeDatabase(); if (previous == null) delete process.env.NAVIGATION_DB_PATH; else process.env.NAVIGATION_DB_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
