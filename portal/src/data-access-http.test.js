import test from 'node:test';
import assert from 'node:assert/strict';
import { startAccessPortal } from './test-fixtures/access-portal.js';

test('real Portal enforces shared read/write scopes, spoofing protection, policy revocation and audit identity', { timeout: 20000 }, async () => {
  const f = await startAccessPortal();
  try {
    assert.equal((await f.request('/api/bookkeeping/accounts')).data.accounts.length, 0);
    const target = 'user:' + f.b.id;
    const other = await f.request('/api/bookkeeping/accounts', { scope: target });
    assert.equal(other.status, 200); assert.equal(other.data.accounts[0].name, 'B 的账户');
    const view = await f.request('/api/me', { scope: target, headers: { Referer: f.baseUrl + '/bookkeeping/' } });
    assert.equal(view.data.dataContext.writable, false);
    assert.ok(!view.data.permissions.includes('bookkeeping:entries:edit'));
    assert.ok(view.data.permissions.includes('bookkeeping:view'));
    assert.equal((await f.request('/api/bookkeeping/accounts', { scope: target, method: 'POST', body: { name: 'unauthorized' } })).status, 403);
    assert.equal((await f.request('/api/bookkeeping/accounts', { uid: f.b.id, scope: 'user:' + f.a.id })).status, 403);
    const created = await f.request('/api/bookkeeping/accounts', { scope: 'team:research', method: 'POST', body: { name: '团队账户', balance: 5, userId: f.a.id } });
    assert.equal(created.status, 201);
    assert.equal((await f.request('/api/bookkeeping/accounts')).data.accounts.length, 0);
    const audit = f.db.prepare("SELECT * FROM data_access_audit WHERE scope='team:research'").get();
    assert.equal(audit.actor_id, f.a.id); assert.equal(audit.owner_id, f.b.id);
    const proxied = await f.request('/stock-manage/api/state', { scope: target, headers: { 'X-Portal-User-Id': 'forged', 'X-Portal-Permissions': 'forged' } });
    assert.equal(proxied.status, 200); assert.equal(proxied.data.owner, f.b.id); assert.notEqual(proxied.data.permissions, 'forged');
    assert.equal((await f.request('/stock-manage/api/state', { scope: target, method: 'POST', body: {} })).status, 403);
    const instance = await f.request('/torn-toolbox/company/api/state', { scope: 'instance:company-team' });
    assert.equal(instance.status, 200); assert.equal(instance.data.url, '/team/api/state');
    assert.equal((await f.request('/api/me/data-scopes?module=bookkeeping', { method: 'PUT', body: { scope: target } })).status, 200);
    assert.equal((await f.request('/api/me/data-modules')).status, 200);
    f.update(r => { r.accessPolicy.modules.bookkeeping.grants = []; });
    assert.equal((await f.request('/api/bookkeeping/accounts', { scope: target })).status, 403);
    f.update(r => { r.accessPolicy.modules.bookkeeping.enabled = false; });
    assert.equal((await f.request('/api/bookkeeping/accounts')).status, 403);
    assert.equal((await f.request('/bookkeeping/')).status, 403);
    assert.equal((await f.request('/api/admin/data-policy')).status, 403);
    const admin = await f.request('/api/admin/data-policy', { uid: 'usr_admin' });
    assert.equal(admin.status, 200);
    assert.equal((await f.request('/api/admin/data-policy', { uid: 'usr_admin', method: 'PUT', body: { ...admin.data.policy, revision: -1 } })).status, 409);
    assert.equal((await f.request('/api/admin/data-policy', { uid: 'usr_admin', method: 'PUT', body: admin.data.policy, headers: { Origin: 'https://hostile.test' } })).status, 403);
  } finally { await f.cleanup(); }
});
