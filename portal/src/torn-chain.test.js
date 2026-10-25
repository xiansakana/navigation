import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ChainMonitor, chainConfig, createChainApiClient, createChainStore, estimateCooldownStart } from './torn-chain-monitor.js';
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

test('cooldown start is estimated independently of discovery time and old history is enriched', t => {
  assert.equal(estimateCooldownStart(4000, 500, 1500), 1000);
  assert.equal(estimateCooldownStart(4000, 500, 900), null);
  assert.equal(estimateCooldownStart(4000, 0, 1500), null);
  assert.equal(estimateCooldownStart(undefined, 500, 1500), null);
  const db = new Database(':memory:'); t.after(() => db.close()); const store = createChainStore(db);
  store.get('a');
  db.prepare('UPDATE torn_chain_monitors SET history_json=? WHERE user_id=?').run(JSON.stringify([{ id: 10, hits: 500, cooldownUntil: 4000, detectedAt: 1500 }]), 'a');
  assert.equal(store.get('a').history[0].cooldownStartedAt, 1000);
  store.record('a', { ...candidate(11), chain: 500 }, { id: 11, current: 450, cooldown: 4000 }, false, 1600);
  assert.equal(store.get('a').history[1].cooldownStartedAt, 1000);
  assert.equal(store.get('a').history[1].detectedAt, 1600);
  store.record('a', { ...candidate(12), chain: 1000 }, { id: 12, current: 100, cooldown: 2000 }, false, 1500);
  assert.equal(store.get('a').history[2].cooldownStartedAt, null);
  assert.equal(store.get('b').history.length, 0);
});
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

test('active observations survive SQLite reopen and recover cooldowns absent from the listing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-persistence-'));
  const filename = path.join(directory, 'chain.db');
  let db = new Database(filename);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let store = createChainStore(db);
  store.save('a', { apiKey: key });
  let phase = 0, sent = 0;
  const request = async url => url.includes('warfarechains') ? page(phase ? [] : [candidate(1)]) : detail(1, 200, phase ? 2000 : 0);
  const first = monitor(store, request);
  first.start(); await first.promise; first.stop();
  assert.equal(store.loadKnown('a').get(1).status, 'active');
  assert.equal(store.loadKnown('b').size, 0);
  db.close(); db = new Database(filename); store = createChainStore(db); phase = 1;
  const restarted = monitor(store, request, { notify: async () => { sent++; } });
  restarted.start(); await restarted.promise; restarted.stop();
  assert.equal(sent, 1); assert.equal(store.get('a').history[0].fresh, true);
  store.clear('a');
  const again = monitor(store, async url => url.includes('warfarechains') ? page([candidate(1)]) : detail(1, 200, 2000), { notify: async () => { sent++; } });
  again.start(); await again.promise; again.stop(); assert.equal(sent, 1);
});

test('expired observations are not restored and only live unseen cooldowns are eligible', async t => {
  const store = fixture(t);
  store.saveKnown('a', new Map([[1, { status: 'active', listedAt: 399, candidate: candidate(1) }]]));
  const m = monitor(store, async () => page([])); m.start(); await m.promise; m.stop();
  assert.equal(m.known.size, 0);
  const expired = store.record('a', candidate(2), detail(2, 200, 999).chain, false, 1000);
  assert.equal(expired.notifyEligible, false);
  const discovered = store.record('a', candidate(3), detail(3, 200, 2000).chain, false, 1000);
  assert.equal(discovered.notifyEligible, true); assert.equal(discovered.fresh, false);
  assert.equal(store.record('a', candidate(4), detail(4, 99, 2000).chain, false, 1000), undefined);
  assert.equal(store.record('a', candidate(5), detail(5, 501, 2000).chain, false, 1000), undefined);
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

test('minimum hits filters before details without truncating pages and admits chains when they reach the boundary', async t => {
  const store = fixture(t), calls = []; let grown = false;
  const m = monitor(store, async path => {
    if (path.includes('warfarechains')) {
      if (path.includes('page=2')) return page([{ ...candidate(2), chain: 100 }, { ...candidate(3), chain: null }]);
      return { warfarechains: [{ ...candidate(1), chain: grown ? 100 : 99 }], _metadata: { links: { next: 'https://api.torn.com/v2/faction/warfarechains?page=2' } } };
    }
    const id = Number(path.split('/')[1]) - 100; calls.push(id); return detail(id, 100);
  });
  m.start(); await m.promise;
  assert.deepEqual(calls, [2, 3]); assert.equal(m.status().belowMinimum, 1); assert.equal(m.status().candidates, 2);
  grown = true; calls.length = 0; await m.scan(); m.stop();
  assert.deepEqual(calls, [1, 2, 3]); assert.equal(m.status().belowMinimum, 0);
});

test('full ascending active pages without links continue by inclusive start cursor instead of hiding long chains', async t => {
  const store = fixture(t), paths = [], details = [];
  const m = monitor(store, async path => {
    if (path.includes('warfarechains')) {
      paths.push(path); assert.match(path, /sort=asc/);
      if (path.includes('from=1099')) return page([{ ...candidate(100), chain: 50, start: 1099 }, { ...candidate(101), chain: 300, start: 1100 }]);
      return page(Array.from({ length: 100 }, (_, i) => ({ ...candidate(i + 1), chain: 50, start: 1000 + i })));
    }
    const id = Number(path.split('/')[1]) - 100; details.push(id); return detail(id, 300);
  });
  m.start(); await m.promise; m.stop();
  assert.equal(paths.length, 2); assert.deepEqual(details, [101]); assert.equal(m.status().candidates, 1); assert.equal(m.status().belowMinimum, 100); assert.equal(m.status().partial, false);
});

test('a full same-timestamp page reports incomplete coverage instead of looping or claiming an empty complete list', async t => {
  const store = fixture(t); let pages = 0;
  const m = monitor(store, async () => { pages++; return page(Array.from({ length: 100 }, (_, i) => ({ ...candidate(i + 1), chain: 50, start: 1000 }))); });
  m.start(); await m.promise; m.stop(); assert.equal(pages, 2); assert.equal(m.status().partial, true);
});

test('previously qualifying active chains survive short/absent listings to detect cooldown', async t => {
  const store = fixture(t); let phase = 0;
  const m = monitor(store, async path => {
    if (path.includes('warfarechains')) return page([{ ...candidate(1), chain: phase ? 0 : 100 }]);
    return detail(1, 100, phase ? 2000 : 0);
  });
  m.start(); await m.promise; phase = 1; await m.scan(); m.stop();
  assert.equal(store.get('a').history[0].fresh, true); assert.equal(m.status().confirmed, 1); assert.equal(m.status().belowMinimum, 0);
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
  for (const permission of SYSTEM_PERMISSIONS.filter(p => p.id.startsWith('torn-chain:'))) assert.deepEqual(permission.permissionPath.slice(0, 3), permission.id.startsWith('torn-chain:notify:') ? ['首页', '通知管理', '业务提醒'] : ['首页', 'Torn 工具箱', 'Chain 监控']);
});
