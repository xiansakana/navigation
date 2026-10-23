import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { ChainMonitor, chainConfig, createChainApiClient, createChainStore } from './torn-chain-monitor.js';
import { canTornChain, createTornChainService } from './torn-chain.js';
import { resolveRoute } from './router.js';
import { SYSTEM_PERMISSIONS } from './rbac.js';

const key = 'testKey123456789';
function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = createChainStore(db); store.save('a', { apiKey: key, minHits: 100, maxHits: 500 });
  return store;
}
const candidate = id => ({ id, chain: 200, faction: { id: id + 100, name: 'Faction ' + id } });
const detail = (id, current = 200, cooldown = 0) => ({ chain: { id, current, cooldown, timeout: cooldown ? 0 : 300 } });
const page = rows => ({ warfarechains: rows, _metadata: { links: { next: null } } });
function monitor(store, request, options = {}) {
  return new ChainMonitor({ uid: 'a', store, request, now: () => 1000, schedule: () => 1, cancel: () => {}, ...options });
}

test('configuration validates inclusive ranges and preserves a saved key', t => {
  const store = fixture(t);
  assert.throws(() => chainConfig({ minHits: 501, maxHits: 500 }));
  assert.throws(() => chainConfig({ intervalSeconds: 29 }));
  assert.throws(() => chainConfig({ apiKey: 'bad' }));
  assert.equal(store.save('a', { minHits: 120 }).apiKey, key);
  assert.equal(store.get('b').config.apiKey, '');
  assert.equal(chainConfig({ maxHits: '' }).maxHits, null);
});

test('only a confirmed active to cooldown transition is fresh; bounds, dedup and isolation persist', async t => {
  const store = fixture(t); let phase = 0;
  const m = monitor(store, async path => {
    if (path.includes('warfarechains')) return page([1, 2, 3, 4, 5].map(candidate));
    const id = Number(path.split('/')[1]) - 100;
    return detail(id, [0, 100, 500, 99, 501, 200][id], id === 5 || phase ? 2000 : 0);
  });
  m.start(); await m.promise;
  assert.deepEqual(store.get('a').history.map(row => [row.id, row.fresh]), [[5, false]]);
  phase = 1; await m.scan();
  assert.deepEqual(store.get('a').history.filter(row => row.fresh).map(row => row.id), [1, 2]);
  assert.equal(store.get('a').history.length, 3);
  await m.scan(); assert.equal(store.get('a').history.length, 3);
  assert.deepEqual(store.get('b').history, []);
  m.stop(); store.clear('a');
  m.start(); await m.promise;
  assert.ok(store.get('a').history.every(row => !row.fresh)); m.stop();
});

test('unknown, mismatched and transient failures do not invent cooldown transitions', async t => {
  const store = fixture(t); let phase = 0;
  const m = monitor(store, async path => {
    if (path.includes('warfarechains')) return page([candidate(1), candidate(2)]);
    const id = Number(path.split('/')[1]) - 100;
    if (phase === 1) throw new Error('unavailable');
    if (id === 2) return detail(999, 200, 2000);
    return detail(1, 200, phase === 2 ? 2000 : 0);
  });
  m.start(); await m.promise; phase = 1; await m.scan();
  assert.equal(m.status().failed, 2); assert.equal(store.get('a').history.length, 0);
  phase = 2; await m.scan();
  assert.deepEqual(store.get('a').history.map(row => [row.id, row.fresh]), [[1, true]]); m.stop();
});

test('pagination and rotating detail budget cover candidates without truncating silently', async t => {
  const store = fixture(t), calls = [];
  const m = monitor(store, async path => {
    if (path.includes('warfarechains')) {
      if (path.includes('page=2')) return page(Array.from({ length: 5 }, (_, i) => candidate(i + 41)));
      return { warfarechains: Array.from({ length: 40 }, (_, i) => candidate(i + 1)), _metadata: { links: { next: 'https://api.torn.com/v2/faction/warfarechains?page=2' } } };
    }
    const id = Number(path.split('/')[1]) - 100; calls.push(id); return detail(id);
  });
  m.start(); await m.promise; assert.equal(calls.length, 40); assert.equal(m.status().remainingCandidates, 5);
  await m.scan(); assert.equal(new Set(calls).size, 45); m.stop();
});

test('stop cancels in-flight results and revoked authorization prevents further requests', async t => {
  const store = fixture(t); let release, allowed = true, calls = 0;
  const m = monitor(store, async () => { calls++; return new Promise(resolve => { release = resolve; }); }, { authorize: () => allowed });
  m.start(); assert.throws(() => m.start()); m.stop(); release(page([candidate(1)])); await m.promise;
  assert.equal(calls, 1); assert.deepEqual(store.get('a').history, []);
  allowed = false; assert.throws(() => m.start());
});

test('official API client rejects redirects/off-origin pages and stops on rate limits without leaking keys', async () => {
  let calls = 0;
  const client = createChainApiClient({ spacingMs: 0, fetchImpl: async (url, options) => {
    calls++; assert.equal(new URL(url).origin, 'https://api.torn.com'); assert.equal(options.redirect, 'error');
    return { status: 429, ok: false };
  } });
  await assert.rejects(client('https://evil.test/v2/faction/warfarechains', key), /分页地址无效/);
  assert.equal(calls, 0);
  await assert.rejects(client('faction/warfarechains', key), error => error.fatal && !error.message.includes(key));
});

test('Portal API enforces permissions, CSRF, user ownership and key redaction', async t => {
  const store = fixture(t), service = createTornChainService({ store, request: async () => page([]), monitorOptions: { schedule: () => 1, cancel: () => {} } });
  const session = { userId: 'a', permissions: ['torn-chain:view'] };
  async function call(path, method = 'GET', body, extra = {}, headers = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { host: 'localhost', ...headers };
    let result; await service.handle(req, { setHeader() {} }, new URL('http://localhost/api/torn-chain/' + path), { ...session, ...extra }, (_, status, data) => { result = { status, data }; }); return result;
  }
  const initial = await call('state'); assert.equal(initial.status, 200); assert.ok(!JSON.stringify(initial).includes(key)); assert.equal(initial.data.permissions.control, false);
  assert.equal((await call('start', 'POST')).status, 403);
  assert.equal((await call('state', 'GET', undefined, { isGuest: true, permissions: ['*'] })).status, 403);
  const admin = { permissions: ['*'] };
  assert.equal((await call('config', 'POST', { minHits: 200 }, admin, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('config', 'POST', { minHits: 200 }, admin)).status, 200);
  assert.equal(store.get('a').config.apiKey, key);
  assert.equal((await call('state', 'GET', undefined, { userId: 'b' })).data.config.hasKey, false);
  assert.equal((await call('start', 'POST', undefined, admin)).status, 200);
  await service.monitors.get('a').promise;
  assert.equal((await call('config', 'POST', { maxHits: 1 }, admin)).status, 400);
  assert.equal(service.monitors.get('a').running, true);
  assert.equal((await call('config', 'POST', { apiKey: '' }, admin)).status, 200);
  assert.equal(service.monitors.get('a').running, false);
  assert.equal(store.get('a').config.apiKey, '');
});

test('native Chain page and API bypass toolbox proxies and declare action permission hierarchy', () => {
  const services = [{ id: 'torn-toolbox', type: 'proxy', path: '/torn-toolbox' }];
  for (const path of ['/torn-toolbox/chain', '/torn-toolbox/chain/', '/torn-toolbox/chain/app.js']) assert.equal(resolveRoute(services, path, 'GET').kind, 'pass');
  assert.equal(resolveRoute(services, '/api/torn-chain/state', 'GET').kind, 'portal-api');
  assert.equal(resolveRoute(services, '/torn-toolbox/company/', 'GET').kind, 'proxy');
  assert.ok(!canTornChain({ userId: 'a', permissions: ['torn-chain:control:edit'] }, 'control:edit'));
  for (const permission of SYSTEM_PERMISSIONS.filter(p => p.id.startsWith('torn-chain:'))) assert.deepEqual(permission.permissionPath.slice(0, 3), ['首页', 'Torn 工具箱', 'Chain 监控']);
});
