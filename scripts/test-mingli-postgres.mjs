import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { handleMingliApi } from '../portal/src/mingli.js';
import { createMingliPostgresStore } from '../portal/src/mingli-postgres.js';
import { createPostgresDatabase } from '../portal/src/postgres.js';
import { createPortalPostgresRbac } from '../portal/src/postgres-rbac.js';
import { createPasswordRecord } from '../portal/src/rbac.js';
import { createSessionCookie, resolveRequestUser, verifyLogin } from '../portal/src/auth.js';
import { handleAdminApi } from '../portal/src/admin-api.js';
import { requestDataAccess } from '../portal/src/data-access.js';
import { createPostgresRbacStore } from '../shared/db/postgres/rbac-store.js';
import { verifyPostgresSchema } from '../shared/db/postgres/readiness.js';
import { startAccessPortal } from '../portal/src/test-fixtures/access-portal.js';

async function verifyRbac(db) {
  const lowLevel = createPostgresRbacStore(db);
  const writer = createPortalPostgresRbac(db);
  const reader = createPortalPostgresRbac(db);
  const config = { auth: { anonymousGuest: false, sessionSecret: 'isolated-postgres-test-only' }, services: [] };
  await assert.rejects(() => reader.load(config), { status: 503 });
  const member = { id: 'member', username: 'member', roleIds: [], enabled: true, ...createPasswordRecord('fixture-passphrase') };
  const admin = { id: 'admin', username: 'admin', roleIds: ['role_admin'], enabled: true };
  await lowLevel.save({ roles: [{ id: 'role_admin', name: '管理员', permissions: ['*'] }], users: [member, admin] });
  const identity = await reader.load(config);
  assert.equal(verifyLogin('member', 'fixture-passphrase', config, identity).id, member.id);
  const cookie = createSessionCookie(member.id, config.auth.sessionSecret).split(';')[0];
  const req = { method: 'GET', url: '/api/mingli/cases', headers: { cookie } };
  const session = resolveRequestUser(req, config, identity);
  assert.equal(requestDataAccess(req, session, 'mingli', config, 'read', identity).ownerId, member.id);
  assert.throws(() => requestDataAccess({ ...req, headers: { ...req.headers, 'x-navigation-data-scope': 'user:admin' } },
    session, 'mingli', config, 'read', identity), { status: 403 });
  const a = await writer.load(config), b = await reader.load(config);
  a.userPrefs = { member: { fromA: true } };
  b.userPrefs = { member: { fromB: true } };
  const results = await Promise.allSettled([writer.save(a), reader.save(b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await assert.rejects(() => lowLevel.save({ users: [] }), { status: 409 });
  const before = await lowLevel.revision();
  const adminResponse = await handleAdminApi({ method: 'POST' }, {}, new URL('http://localhost/api/admin/users'),
    { userId: admin.id }, config, (_, status, body) => ({ status, body }),
    async () => ({ id: member.id, username: member.username, roleIds: [], enabled: false }), writer);
  assert.equal(adminResponse.status, 200);
  assert.equal(await lowLevel.revision(), before + 1n);
  const fresh = await reader.load(config);
  assert.equal(resolveRequestUser(req, config, fresh), null);
  assert.equal(verifyLogin('member', 'fixture-passphrase', config, fresh), null);
  await db.query("UPDATE navigation.rbac_snapshot SET payload = payload WHERE id = 1");
  assert.equal(await lowLevel.revision(), before + 2n);
  const enabled = await writer.load(config);
  enabled.users.find(user => user.id === member.id).enabled = true;
  await writer.save(enabled);
  const dsn = new URL('postgresql://127.0.0.1/');
  dsn.username = process.env.PGUSER || 'rehearsal';
  dsn.password = process.env.PGPASSWORD || '';
  dsn.hostname = process.env.PGHOST || '127.0.0.1';
  dsn.port = process.env.PGPORT || '5432';
  dsn.pathname = '/' + process.env.PGDATABASE;
  const running = await startAccessPortal({ extraEnv: { NAVIGATION_RBAC_POSTGRES_URL: dsn.toString(), NAVIGATION_MINGLI_POSTGRES_URL: dsn.toString() } });
  try {
    assert.equal((await fetch(running.baseUrl + '/readyz')).status, 200);
    const login = () => fetch(running.baseUrl + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: member.username, password: 'fixture-passphrase' }),
    });
    const response = await login();
    assert.equal(response.status, 200, await response.text());
    const authenticated = await running.request('/api/me', { uid: member.id });
    assert.equal(authenticated.data.userId, member.id);
    assert.equal((await running.request('/api/me/data-scopes?module=mingli', { uid: member.id })).status, 200);
    const written = await running.request('/api/mingli/cases', { uid: member.id, method: 'POST', body: {
      name: 'PostgreSQL end-to-end case', birth: { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1 },
      tags: [], notes: '',
    } });
    assert.equal(written.status, 201, JSON.stringify(written.data));
    const deadline = Date.now() + 3000;
    let audit;
    while (!(audit = (await db.query("SELECT actor_id,owner_id,status FROM navigation.data_access_audit WHERE module_id='mingli'")).rows[0])) {
      if (Date.now() >= deadline) throw new Error('No audit row in PostgreSQL');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(audit, { actor_id: member.id, owner_id: member.id, status: '201' });
    const adminWrite = await running.request('/api/admin/users', {
      uid: admin.id, method: 'POST', body: { id: member.id, username: member.username, enabled: false, roleIds: [] },
    });
    assert.equal(adminWrite.status, 200, JSON.stringify(adminWrite.data));
    assert.equal((await login()).status, 401);
    assert.equal((await running.request('/api/mingli/cases', { uid: member.id })).status, 403);
  } finally { await running.cleanup(); }
}

test('Mingli HTTP entry point uses PostgreSQL for owner-scoped cases, categories, filters and import', async () => {
  const db = createPostgresDatabase();
  let schemaCreated = false;
  try {
    const { rows: [database] } = await db.query('SELECT current_database() AS name');
    assert.match(database.name, /^navigation_rehearsal_[a-z0-9_]+$/);
    await assert.rejects(() => verifyPostgresSchema(db), { code: 'POSTGRES_NOT_READY' });
    const ddl = await readFile(new URL('../shared/db/postgres/001-initial.sql', import.meta.url), 'utf8');
    await db.transaction(async client => {
      await client.query('CREATE SCHEMA navigation');
      await client.query('SET LOCAL search_path = navigation, pg_catalog');
      await client.query(ddl);
    });
    schemaCreated = true;
    assert.deepEqual(await verifyPostgresSchema(db), { database: database.name, version: '001-initial' });
    await verifyRbac(db);
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
