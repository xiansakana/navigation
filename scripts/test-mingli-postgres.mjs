import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { handleMingliApi } from '../portal/src/mingli.js';
import { createMingliPostgresStore } from '../portal/src/mingli-postgres.js';
import { createPostgresDatabase } from '../portal/src/postgres.js';

test('Mingli HTTP entry point uses PostgreSQL for owner-scoped cases, categories, filters and import', async () => {
  const db = createPostgresDatabase();
  let schemaCreated = false;
  try {
    const { rows: [database] } = await db.query('SELECT current_database() AS name');
    assert.match(database.name, /^navigation_rehearsal_[a-z0-9_]+$/);
    const ddl = await readFile(new URL('../shared/db/postgres/001-initial.sql', import.meta.url), 'utf8');
    await db.transaction(async client => {
      await client.query('CREATE SCHEMA navigation');
      await client.query('SET LOCAL search_path = navigation, pg_catalog');
      await client.query(ddl);
    });
    schemaCreated = true;
    const store = createMingliPostgresStore(db);
    const session = (userId, isGuest = false) => ({ userId, isGuest, permissions: ['*'] });
    async function call(route, method = 'GET', data, user = session('a')) {
      const req = {
        method, headers: { host: 'localhost' },
        async *[Symbol.asyncIterator]() { if (data !== undefined) yield Buffer.from(JSON.stringify(data)); },
      };
      return handleMingliApi(req, { setHeader() {} }, new URL('http://localhost/api/mingli' + route), user,
        (_, status, body) => ({ status, body }), () => store);
    }

    assert.equal((await call('/cases', 'GET', undefined, session('guest', true))).status, 403);
    const [first, second] = await Promise.all([
      call('/categories', 'POST', { name: 'Stocks' }),
      call('/categories', 'POST', { name: 'stocks' }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 400]);
    const categoryId = (first.body.category || second.body.category).id;
    const { body: { category: foreign } } = await call('/categories', 'POST', { name: 'STOCKS' }, session('b'));
    const input = {
      name: '案例 A %_', birth: { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1, location: 'City' },
      notes: '核对出生记录', tags: ['学习'], categoryId, userId: 'b',
    };
    const created = await call('/cases', 'POST', input);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.case.id;
    assert.equal(created.body.case.categoryId, categoryId);
    assert.equal((await call('/cases', 'POST', { ...input, categoryId: foreign.id })).status, 400);
    assert.equal((await call('/cases/' + id, 'GET', undefined, session('b'))).status, 404);
    const filters = encodeURIComponent(JSON.stringify({ gender: 1, location: 'CITY', notes: 'yes', solarFrom: '2005-12-01', pillars: [{ gan: '乙' }, {}, {}, {}], characters: ['酉'] }));
    const list = await call('/cases?search=%25_&filters=' + filters);
    assert.equal(list.body.total, 1, JSON.stringify(list.body));
    const updated = await call('/cases/' + id, 'PUT', { ...input, name: '已更新' });
    assert.equal(updated.body.case.name, '已更新');
    const notAssigned = await call('/cases/category', 'POST', { ids: [id, 'a'.repeat(32)], categoryId: null });
    assert.equal(notAssigned.status, 404);
    assert.equal((await call('/cases/' + id)).body.case.categoryId, categoryId);
    assert.equal((await call('/categories/' + categoryId, 'DELETE')).body.moved, 1);
    assert.equal((await call('/cases/' + id)).body.case.categoryId, null);
    const bundle = { format: 'navigation-wenzhen-v1', settings: { midnight: false }, groups: [{ id: 'group', name: '家人' }], cases: [{
      guid: '11111111-1111-4111-8111-111111111111', name: '测试命例', sex: 2, solarTime: '2005-12-23 09:00:00',
      sunTime: '2005-12-23 08:37:00', bz: '乙 酉 戊 子 辛 巳 壬 辰', groupGuid: 'group', type: 1,
    }] };
    assert.equal((await call('/import/preview', 'POST', bundle)).body.matched, 1);
    const imports = await Promise.all([call('/import/confirm', 'POST', bundle), call('/import/confirm', 'POST', bundle)]);
    assert.deepEqual(imports.map(result => result.body.imported).sort(), [0, 1]);
    assert.equal((await call('/cases', 'GET', undefined, session('b'))).body.total, 0);
    assert.equal((await call('/cases/' + id, 'DELETE')).status, 200);
  } finally {
    if (schemaCreated) await db.query('DROP SCHEMA navigation CASCADE');
    await db.close();
  }
});
