import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAccessPolicy, modulePolicy, validateAccessPolicy, resolveDataAccess, listDataAccess, dataRequestAction, accessModules } from './access-policy.js';
import { resolveLoggedInPermissions } from './auth.js';
import { ensureGuestAccess } from './rbac.js';

const fixture = () => {
  const rbac = { users: [{ id: 'a', username: 'A', roleIds: ['members'] }, { id: 'b', username: 'B', roleIds: ['members'] }, { id: 'admin', username: 'admin', roleIds: ['admins'] }], roles: [{ id: 'members' }, { id: 'admins' }], permissions: [{ id: 'bookkeeping:view' }] };
  ensureAccessPolicy(rbac); rbac.accessPolicy.memberPermissions = ['bookkeeping:view'];
  return rbac;
};
test('migration preserves default grants once and configured removal stays removed', () => {
  const rbac = fixture(), user = rbac.users[0];
  assert.ok(resolveLoggedInPermissions(rbac, user).includes('bookkeeping:view'));
  rbac.accessPolicy.memberPermissions = [];
  ensureAccessPolicy(rbac);
  assert.ok(!resolveLoggedInPermissions(rbac, user).includes('bookkeeping:view'));
});
test('guest account status, roles and explicitly configured cash permissions survive subsequent synchronization', () => {
  const rbac = { users: [], roles: [] }, config = { services: [], auth: { guestUsername: 'visitor' } };
  ensureGuestAccess(rbac, config);
  const guest = rbac.users.find(u => u.username === 'visitor'), role = rbac.roles.find(r => r.id === 'role_guest');
  guest.enabled = false; guest.roleIds = ['custom']; role.permissions.push('service:stock-manage:cash:view');
  ensureGuestAccess(rbac, config);
  assert.equal(guest.enabled, false); assert.deepEqual(guest.roleIds, ['custom']);
  assert.ok(role.permissions.includes('service:stock-manage:cash:view'));
});
test('personal scope does not implicitly grant another owner even to an administrator', () => {
  const rbac = fixture();
  assert.equal(resolveDataAccess(rbac, { userId: 'a' }, 'bookkeeping').ownerId, 'a');
  assert.throws(() => resolveDataAccess(rbac, { userId: 'a', permissions: ['*'] }, 'bookkeeping', 'user:b'));
  assert.throws(() => resolveDataAccess(rbac, { userId: 'admin', permissions: ['*'] }, 'bookkeeping', 'user:b'));
  assert.throws(() => resolveDataAccess(rbac, { userId: 'missing' }, 'bookkeeping'));
});
test('role and user grants separate viewing from modifying; revocations and disabled owners apply immediately', () => {
  const rbac = fixture(), p = modulePolicy(rbac, 'knowledge'); rbac.accessPolicy.modules.knowledge = p;
  p.grants.push({ kind: 'role', id: 'members', scope: 'user:b', read: true, write: false });
  const session = { userId: 'a' };
  assert.equal(resolveDataAccess(rbac, session, 'knowledge', 'user:b').ownerId, 'b');
  assert.throws(() => resolveDataAccess(rbac, session, 'knowledge', 'user:b', 'write'));
  p.grants.push({ kind: 'user', id: 'a', scope: 'user:b', read: true, write: true });
  assert.equal(resolveDataAccess(rbac, session, 'knowledge', 'user:b', 'write').actorId, 'a');
  assert.equal(listDataAccess(rbac, session, 'knowledge').find(s => s.scope === 'user:b').writable, true);
  p.grants = [];
  assert.throws(() => resolveDataAccess(rbac, session, 'knowledge', 'user:b'));
  p.grants.push({ kind: 'user', id: 'a', scope: 'user:b', read: true, write: true });
  rbac.users[1].enabled = false;
  assert.throws(() => resolveDataAccess(rbac, session, 'knowledge', 'user:b'));
});
test('team spaces bind explicit owners without modifying existing users or granting unrelated modules', () => {
  const rbac = fixture(), before = structuredClone(rbac.users), p = modulePolicy(rbac, 'mingli');
  rbac.accessPolicy.teams.push({ id: 'team_one', name: '研究组', ownerId: 'b' });
  p.grants.push({ kind: 'user', id: 'a', scope: 'team:team_one', read: true, write: true });
  rbac.accessPolicy.modules.mingli = p;
  assert.equal(resolveDataAccess(rbac, { userId: 'a' }, 'mingli', 'team:team_one').ownerId, 'b');
  assert.throws(() => resolveDataAccess(rbac, { userId: 'a' }, 'bookkeeping', 'team:team_one'));
  assert.deepEqual(rbac.users, before);
});
test('shared services expose only explicitly registered and authorized independent instances', () => {
  const rbac = fixture(), services = [{ id: 'torn-company', type: 'proxy' }, { id: 'company-team', type: 'proxy', internalUrl: 'http://127.0.0.1:9999' }];
  const p = modulePolicy(rbac, 'torn-company', services); rbac.accessPolicy.modules['torn-company'] = p;
  p.instances = ['company-team']; p.grants = [{ kind: 'user', id: 'a', scope: 'instance:company-team', read: true, write: false }];
  assert.equal(resolveDataAccess(rbac, { userId: 'a' }, 'torn-company', 'instance:company-team', 'read', services).binding.internalUrl, services[1].internalUrl);
  assert.throws(() => resolveDataAccess(rbac, { userId: 'b' }, 'torn-company', 'instance:company-team', 'read', services));
  assert.throws(() => resolveDataAccess(rbac, { userId: 'a' }, 'torn-company', 'instance:company-team', 'write', services));
  assert.throws(() => resolveDataAccess(rbac, { userId: 'a' }, 'torn-company', 'user:b', 'read', services));
});
test('policy validation rejects dangling references, unknown permissions and write-only grants atomically', () => {
  const rbac = fixture(), original = JSON.stringify(rbac), input = structuredClone(rbac.accessPolicy);
  input.modules.bookkeeping = modulePolicy(rbac, 'bookkeeping');
  input.modules.bookkeeping.grants.push({ kind: 'user', id: 'a', scope: 'user:b', read: false, write: true });
  assert.throws(() => validateAccessPolicy(input, rbac));
  input.modules.bookkeeping.grants[0].read = true;
  assert.equal(validateAccessPolicy(input, rbac).revision, 2);
  input.modules.bookkeeping.grants[0].scope = 'team:missing';
  assert.throws(() => validateAccessPolicy(input, rbac));
  input.memberPermissions = ['*']; assert.throws(() => validateAccessPolicy(input, rbac));
  assert.equal(JSON.stringify(rbac), original);
});
test('module kill switch, read-only personal access and credential-producing GET requests are enforced', () => {
  const rbac = fixture(), p = modulePolicy(rbac, 'bookkeeping'); rbac.accessPolicy.modules.bookkeeping = p;
  p.own.write = false;
  assert.equal(resolveDataAccess(rbac, { userId: 'a' }, 'bookkeeping').ownerId, 'a');
  assert.throws(() => resolveDataAccess(rbac, { userId: 'a' }, 'bookkeeping', 'self', 'write'));
  p.enabled = false;
  assert.deepEqual(listDataAccess(rbac, { userId: 'a' }, 'bookkeeping'), []);
  assert.equal(dataRequestAction({ method: 'GET' }, '/api/knowledge/worker-package'), 'write');
  assert.equal(dataRequestAction({ method: 'GET' }, '/api/knowledge/documents'), 'read');
  assert.equal(dataRequestAction({ method: 'POST' }, '/api/knowledge/imports/preview'), 'write');
  for (const id of ['bookkeeping', 'knowledge', 'mingli', 'stock-manage', 'torn-chain', 'codex-cli', 'qq-codex', 'blog', 'resources']) assert.ok(accessModules().some(m => m.id === id));
});
