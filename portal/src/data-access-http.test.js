import test from 'node:test';
import assert from 'node:assert/strict';
import { startAccessPortal } from './test-fixtures/access-portal.js';
import { createChainStore } from './torn-chain-monitor.js';
import { modulePolicy } from './access-policy.js';
import { createFactionStore } from './torn-faction-scan.js';

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

test('anonymous Chain browsing follows only explicit read grants and rejects all guest mutations', { timeout: 20000 }, async () => {
  const f = await startAccessPortal();
  try {
    const store = createChainStore(f.db), key = '1234567890abcdef';
    store.save(f.b.id, { apiKey: key }); store.record(f.b.id, { id: 77, chain: 100, faction: { id: 5, name: 'Shared faction' } }, { id: 77, current: 100, cooldown: 2000 }, false, 1000);
    const scope = 'user:' + f.b.id;
    f.update(r => { r.accessPolicy.modules['torn-chain'] = { ...modulePolicy(r, 'torn-chain'), grants: [{ kind: 'role', id: 'role_guest', scope, read: true, write: false }] }; });
    const read = await fetch(f.baseUrl + '/api/torn-chain/state'), data = await read.json();
    assert.equal(read.status, 200); assert.equal(data.history[0].id, 77); assert.ok(!JSON.stringify(data).includes(key)); assert.equal(data.permissions.control, false);
    const formerSelf = await fetch(f.baseUrl + '/api/torn-chain/state', { headers: { Cookie: 'portal_scope_torn-chain=self' } });
    assert.equal((await formerSelf.json()).history[0].id, 77); // An administrator's prior self-scope cookie cannot hide the guest share.
    assert.equal((await fetch(f.baseUrl + '/torn-toolbox/chain/')).status, 200);
    for (const [path, method] of [['config', 'POST'], ['start', 'POST'], ['stop', 'POST'], ['history', 'DELETE'], ['notifications/test', 'POST']]) {
      assert.equal((await fetch(f.baseUrl + '/api/torn-chain/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    }
    assert.equal((await fetch(f.baseUrl + '/api/torn-chain/start', { method: 'POST', headers: { 'X-Navigation-Data-Scope': 'self' } })).status, 403);
    assert.equal((await fetch(f.baseUrl + '/api/torn-chain/state', { headers: { 'X-Navigation-Data-Scope': 'user:' + f.a.id } })).status, 403);
    const factions = createFactionStore(f.db), secondKey = 'abcdef1234567890';
    factions.save(f.b.id, { apiKeys: [key, secondKey] });
    factions.saveRun(f.b.id, { cursor: 1, listed: 1, listComplete: true, rows: [{ id: 5, respect: 100, leaderId: 1000, status: 'match', name: 'Shared screening result' }] });
    f.update(r => { r.accessPolicy.modules['torn-factions'] = { ...modulePolicy(r, 'torn-factions'), grants: [{ kind: 'role', id: 'role_guest', scope, read: true, write: false }] }; });
    const factionResponse = await fetch(f.baseUrl + '/api/torn-factions/state?filter=match&offset=0', { headers: { Cookie: 'portal_scope_torn-factions=self' } });
    const factionData = await factionResponse.json(); assert.equal(factionResponse.status, 200); assert.equal(factionData.rows[0].id, 5); assert.deepEqual(factionData.permissions, { configure: false, control: false });
    assert.ok(!JSON.stringify(factionData).includes(key)); assert.ok(!JSON.stringify(factionData).includes(secondKey));
    for (const route of ['config', 'start', 'stop', 'reset']) assert.equal((await fetch(f.baseUrl + '/api/torn-factions/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(f.baseUrl + '/api/torn-factions/state', { headers: { 'X-Navigation-Data-Scope': 'user:' + f.a.id } })).status, 403);
    f.update(r => { r.accessPolicy.modules['torn-factions'].grants = []; });
    assert.equal((await fetch(f.baseUrl + '/api/torn-factions/state', { headers: { 'X-Navigation-Data-Scope': scope } })).status, 403);
    f.update(r => { r.accessPolicy.modules['torn-chain'].grants = []; });
    assert.equal((await fetch(f.baseUrl + '/api/torn-chain/state', { headers: { 'X-Navigation-Data-Scope': scope } })).status, 403);
    assert.equal((await (await fetch(f.baseUrl + '/api/torn-chain/state')).json()).history.length, 0);
  } finally { await f.cleanup(); }
});
