import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from '../../shared/db/index.js';
import { canMingli, handleMingliApi } from './mingli.js';
import { resolveLoggedInPermissions } from './auth.js';
import { buildMenusFromServices, getVisibleMenus, SYSTEM_PERMISSIONS } from './rbac.js';
import { canonicalPortalPagePath, resolveRoute } from './router.js';

const birth = { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1 };
const member = id => ({ userId: id, isGuest: false, permissions: resolveLoggedInPermissions({ roles: [] }, { id, username: id }) });
async function call(route, method = 'GET', data, session = member('a'), headers = {}) {
  let status, result;
  const req = { method, headers: { host: 'localhost', ...headers }, async *[Symbol.asyncIterator]() { if (data !== undefined) yield Buffer.from(JSON.stringify(data)); } };
  await handleMingliApi(req, { setHeader() {} }, new URL('http://localhost/api/mingli' + route), session, (_, s, r) => { status = s; result = r; });
  return { status, result };
}

test('member permissions, menu, protected aliases and API routing', () => {
  const session = member('a'); assert.ok(canMingli(session));
  for (const p of SYSTEM_PERMISSIONS.filter(p => p.id.startsWith('mingli:'))) {
    assert.ok(p.permissionPath?.length); assert.ok(session.permissions.includes(p.id));
  }
  const menus = buildMenusFromServices([]);
  assert.equal(getVisibleMenus({ menus }, session.permissions).find(m => m.serviceId === 'mingli').path, '/mingli/');
  assert.ok(!getVisibleMenus({ menus }, []).some(m => m.serviceId === 'mingli'));
  const services = [{ id: 'napcat', type: 'proxy', path: '/napcat', internalUrl: 'http://localhost:6099' }];
  for (const p of ['/mingli', '/mingli/', '/mingli/index.html']) {
    assert.equal(canonicalPortalPagePath(p), '/mingli/');
    assert.equal(resolveRoute(services, p, 'GET', '', { referer: 'http://localhost/napcat/' }).kind, 'pass');
  }
  assert.equal(resolveRoute(services, '/api/mingli/cases', 'GET', '', { referer: 'http://localhost/napcat/' }).kind, 'portal-api');
});

test('API rejects guests, missing action grants and cross-site writes before accessing data', async () => {
  for (const s of [{}, { ...member('guest'), isGuest: true, permissions: ['*'] }, { userId: 'a', permissions: [] }]) assert.equal((await call('/cases', 'GET', undefined, s)).status, 403);
  const limited = { userId: 'a', permissions: ['mingli:view'] };
  for (const [route, method] of [['/chart', 'POST'], ['/cases', 'GET'], ['/cases', 'POST'], ['/cases/' + 'a'.repeat(32), 'DELETE']]) assert.equal((await call(route, method, birth, limited)).status, 403);
  assert.equal((await call('/chart', 'POST', birth, member('a'), { origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('/chart', 'POST', birth, member('a'), { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/chart', 'POST', birth, member('a'), { origin: 'https://localhost' })).status, 200);
  assert.equal((await call('/chart', 'POST', { ...birth, hour: 88 })).status, 400);
  assert.equal((await call('/cases', 'POST', { name: 'x'.repeat(140000) })).status, 400);
  assert.equal((await call('/unknown')).status, 404);
});

test('cases persist birth settings and chart snapshots, search literally and isolate owners', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingli-test-')), before = process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH = path.join(dir, 'test.db');
  try {
    const payload = { name: '案例 A %_', birth: { ...birth, sect: 1 }, tags: ['已核对', '学习'], notes: '2026：核对出生记录。', userId: 'b' };
    const created = await call('/cases', 'POST', payload); assert.equal(created.status, 201);
    const id = created.result.case.id;
    assert.equal(created.result.case.chart.engine, 'lunar-javascript@1.7.7/mingli-v2');
    assert.equal(created.result.case.birth.sect, 1);
    closeDatabase();
    assert.equal((await call('/cases/' + id)).result.case.notes, payload.notes);
    for (const q of ['已核对', '出生记录', '%_']) assert.equal((await call('/cases?search=' + encodeURIComponent(q))).result.total, 1);
    assert.equal((await call('/cases?search=missing')).result.total, 0);
    assert.equal((await call('/cases', 'GET', undefined, member('b'))).result.total, 0);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      assert.equal((await call('/cases/' + id, method, payload, member('b'))).status, 404);
      assert.equal((await call('/cases/' + id, method, payload, { userId: 'admin', permissions: ['*'] })).status, 404);
    }
    assert.equal((await call('/cases/' + id, 'PUT', { ...payload, name: '新名称', notes: '<script>笔记</script>', birth: { ...birth, hour: 9 } })).status, 200);
    const updated = (await call('/cases/' + id)).result.case;
    assert.equal(updated.name, '新名称'); assert.equal(updated.birth.hour, 9);
    assert.equal((await call('/cases/' + id, 'PUT', { ...payload, birth: { ...birth, month: 2, day: 31 } })).status, 400);
    assert.equal((await call('/cases/' + id)).result.case.name, '新名称');
    const other = await call('/cases', 'POST', { ...payload, name: '第二个' });
    assert.equal((await call('/cases?limit=1&offset=1')).result.cases.length, 1);
    assert.equal((await call('/cases/' + id, 'DELETE')).status, 200);
    assert.equal((await call('/cases/' + id)).status, 404);
    assert.equal((await call('/cases')).result.cases[0].id, other.result.case.id);
    const importPermission = { userId: 'a', permissions: ['mingli:view', 'mingli:cases:import'] };
    const onlyEdit = { userId: 'a', permissions: ['mingli:view', 'mingli:cases:edit'] };
    assert.equal((await call('/import/preview', 'POST', {}, onlyEdit)).status, 403);
    assert.equal((await call('/import/confirm', 'POST', {}, importPermission)).status, 403);
    assert.equal((await call('/import/preview', 'POST', {}, member('a'))).status, 400);
  } finally {
    closeDatabase(); if (before == null) delete process.env.NAVIGATION_DB_PATH; else process.env.NAVIGATION_DB_PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
