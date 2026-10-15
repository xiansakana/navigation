import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewResources, parseMemory, parseNetwork, parseDiskIo, parsePm2Output, publicPm2, publicContainers, counterRate, createResourceMonitor, handleResourceApi } from './resources.js';
import { resolveRoute } from './router.js';
import { buildMenusFromServices, ensureGuestAccess, getVisibleMenus } from './rbac.js';

test('resource home entry is built in without config edits or default guest grants', () => {
  const menu = buildMenusFromServices([], [{ id: 'menu_resources', enabled: false, sort: 20 }]).find((m) => m.id === 'menu_resources');
  assert.equal(menu.title, '资源管理');
  assert.equal(menu.path, '/resources/');
  assert.equal(menu.permission, 'service:resources:view');
  assert.equal(menu.enabled, false);
  assert.equal(menu.sort, 20);
  const data = { users: [], roles: [] };
  ensureGuestAccess(data, { services: [] });
  assert.equal(data.roles[0].permissions.includes('service:resources:view'), false);
  assert.equal(data.roles[0].permissions.includes('service:resources:edit'), false);
  const menus = buildMenusFromServices([]);
  for (const permissions of [[], data.roles[0].permissions, ['service:resources:view'], ['*']]) {
    assert.ok(getVisibleMenus({ menus }, permissions).some((m) => m.serviceId === 'resources'));
  }
  assert.ok(!getVisibleMenus({ menus: [menu] }, []).some((m) => m.serviceId === 'resources'));
});

test('resource API stays in Portal even when referred from a proxied app', () => {
  const services = [{ id: 'napcat', path: '/napcat', type: 'proxy', internalUrl: 'http://localhost:6099' }];
  assert.equal(resolveRoute(services, '/api/resources/metrics', 'GET', '', { referer: 'https://test/napcat/' }).kind, 'portal-api');
});

test('resource access requires a logged-in user with edit permission', async () => {
  assert.equal(canViewResources({ isGuest: true, permissions: ['*'] }), false);
  assert.equal(canViewResources({ permissions: ['admin:access:view'] }), false);
  assert.equal(canViewResources({ permissions: ['service:resources:view'] }), false);
  assert.equal(canViewResources({ permissions: ['service:resources:edit'] }), true);
  let collected = false;
  const res = { setHeader(name, value) { assert.equal(value, name === 'Cache-Control' ? 'no-store' : 'GET'); } };
  const json = (_, status, body) => ({ status, body });
  const monitor = { async snapshot() { collected = true; throw new Error('SECRET-env-value'); } };
  assert.equal((await handleResourceApi({ method: 'GET' }, res, { permissions: [] }, monitor, json)).status, 403);
  assert.equal((await handleResourceApi({ method: 'GET' }, res, { permissions: ['service:resources:view'] }, monitor, json)).status, 403);
  assert.equal((await handleResourceApi({ method: 'GET' }, res, { isGuest: true, permissions: ['*'] }, monitor, json)).status, 403);
  assert.equal((await handleResourceApi({ method: 'POST' }, res, { permissions: ['*'] }, monitor, json)).status, 405);
  assert.equal(collected, false);
  const failure = await handleResourceApi({ method: 'GET' }, res, { permissions: ['*'] }, monitor, json);
  assert.equal(failure.status, 503);
  assert.doesNotMatch(JSON.stringify(failure), /SECRET/);
});

test('Linux counters retain available memory, drops and physical disk units', () => {
  const memory = parseMemory('MemTotal: 1000 kB\nMemAvailable: 600 kB\nMemFree: 100 kB\nCached: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB');
  assert.equal(memory.used, 400 * 1024);
  assert.equal(memory.percent, 40);
  assert.equal(memory.swapPercent, null);
  const interfaces = parseNetwork('eth0: 1024 10 2 3 0 0 0 0 2048 20 4 5 0 0 0 0');
  assert.equal(interfaces[0].rxDropped, 3);
  assert.equal(interfaces[0].txErrors, 4);
  assert.deepEqual(parseDiskIo('8 0 sda 1 0 10 0 1 0 20 0 0 5 0\n8 1 sda1 1 0 10 0 1 0 20 0 0 5 0'), [{ name: 'sda', readBytes: 5120, writeBytes: 10240, ioMs: 5 }]);
  assert.equal(counterRate(2000, 1000, 2000), 500);
  assert.equal(counterRate(2, 1000, 2000), null);
  assert.equal(counterRate(2, null, 2000), null);
});

test('PM2 and Docker projection never exposes environment, commands, paths or labels', () => {
  const item = { pm_id: 1, name: 'portal', pid: 10, monit: { cpu: 2, memory: 1024 }, pm2_env: { status: 'online', pm_uptime: 100, restart_time: 2, env: { KEY: 'SECRET' }, args: 'SECRET', pm_exec_path: '/private/SECRET' } };
  const process = publicPm2([item])[0];
  assert.equal(process.memoryBytes, 1024);
  assert.doesNotMatch(JSON.stringify(process), /SECRET|env|args|exec_path/);
  assert.deepEqual(parsePm2Output('PM2 upgrade notice\n' + JSON.stringify([item]) + '\n'), [item]);
  const containers = publicContainers([{ ID: 'abc', Names: 'alist', State: 'exited', Labels: 'SECRET', Command: 'SECRET' }], []);
  assert.equal(containers[0].cpuPercent, null);
  assert.doesNotMatch(JSON.stringify(containers), /SECRET/);
});

test('snapshots coalesce concurrent readers, cache expensive collection and calculate real deltas', async () => {
  let now = 1000, reads = 0;
  const hostReader = async () => {
    reads++;
    return { collectedAt: now, cpu: { total: now / 10, idle: now / 50 }, cpuCount: 2, platform: 'linux', load: [1, 1, 1], memory: { percent: 20 },
      network: [{ name: 'eth0', rxBytes: now, txBytes: now * 2, external: true }, { name: 'veth0', rxBytes: now * 100, txBytes: now * 100, external: false }], diskIo: [{ name: 'sda', readBytes: now, writeBytes: now }], disks: [] };
  };
  const monitor = createResourceMonitor({ hostReader, serviceReader: async () => ({ processes: [], containers: [], warnings: [] }), clock: () => now, cacheMs: 10000 });
  const [a, b] = await Promise.all([monitor.snapshot(), monitor.snapshot()]);
  assert.equal(a, b); assert.equal(reads, 1);
  assert.equal(a.network[0].rxBytesPerSecond, null);
  now = 2000; await monitor.snapshot(); assert.equal(reads, 1);
  now = 11000; const next = await monitor.snapshot();
  assert.equal(next.cpuPercent, 80);
  assert.equal(next.network[0].rxBytesPerSecond, 1000);
  assert.equal(next.diskIo[0].readBytesPerSecond, 1000);
  assert.equal(next.history.length, 2);
  assert.equal(next.history[1].rx, 1000);
  assert.equal(a.history.length, 1);
});
