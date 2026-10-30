import test from 'node:test';
import assert from 'node:assert/strict';
import { PORTAL_MODULES, moduleInventory } from './modules.js';
import { PORTAL_API_NAMESPACES, resolveRoute } from './router.js';
import { moduleApiHandler } from './module-api.js';
import { buildMenusFromServices, SYSTEM_PERMISSIONS } from './rbac.js';
import { resolveLoggedInPermissions } from './auth.js';

test('every built-in module owns its namespace, dispatch and declared menu', () => {
  const menus = buildMenusFromServices([]);
  assert.equal(new Set(PORTAL_MODULES.map(module => module.id)).size, PORTAL_MODULES.length);
  for (const module of PORTAL_MODULES) {
    assert.ok(PORTAL_API_NAMESPACES.has(module.namespace));
    const api = module.apiPath || module.apiPrefix + (module.id === 'blog' ? 'posts' : 'probe');
    assert.equal(resolveRoute([], api, 'GET', '', { referer: 'https://test/napcat/' }).kind, 'portal-api');
    assert.equal(typeof moduleApiHandler(api), 'function');
    if (module.path) {
      assert.equal(menus.find(menu => menu.serviceId === module.id).path, module.path);
      assert.ok(SYSTEM_PERMISSIONS.some(permission => permission.id === module.permission));
    }
  }
});

test('future permission catalog additions are not automatically granted to members', () => {
  const permission = { id: 'knowledge:future-admin:edit' };
  SYSTEM_PERMISSIONS.push(permission);
  try {
    assert.ok(!resolveLoggedInPermissions({ roles: [] }, { username: 'member' }).includes(permission.id));
  } finally { SYSTEM_PERMISSIONS.splice(SYSTEM_PERMISSIONS.indexOf(permission), 1); }
});


test('every native monitor HTML asset is registered in the production static allowlist', async () => {
  const { TORN_MONITOR_ASSETS } = await import('./modules.js');
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/torn-toolbox/chain/index.html', import.meta.url), 'utf8');
  const server = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(server, /TORN_MONITOR_ASSETS\.includes\(file\)/);
  for (const match of html.matchAll(/(?:src|href)="\/torn-toolbox\/chain\/([^"?]+)(?:\?[^" ]*)?"/g)) {
    assert.ok(TORN_MONITOR_ASSETS.includes(match[1]), match[1] + ' must be served by Portal');
    assert.ok((await readFile(new URL('../public/torn-toolbox/chain/' + match[1], import.meta.url))).length);
  }
  assert.ok(!TORN_MONITOR_ASSETS.includes('../config.json'));
});
