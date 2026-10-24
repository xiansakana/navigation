import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { ChainMonitor, createChainStore } from './torn-chain-monitor.js';
import { createTornChainService } from './torn-chain.js';

const key = '1234567890abcdef';
const candidate = id => ({ id, chain: 200, faction: { id: id + 100, name: 'Faction ' + id } });
function setup(t, request) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = createChainStore(db); store.save('a', { apiKey: key });
  const monitor = new ChainMonitor({ uid: 'a', store, request, now: () => 1000, schedule: () => 1, cancel: () => {} });
  t.after(() => monitor.stop()); return { store, monitor };
}

test('monitor details identify each faction, verified state, malformed response and sanitized failure', async t => {
  const { monitor } = setup(t, async path => {
    if (path.includes('warfarechains')) return { warfarechains: [1, 2, 3, 4, 5, 6].map(candidate) };
    const id = Number(path.split('/')[1]) - 100;
    if (id === 3) throw new Error('Network unavailable ' + key);
    if (id === 4) return { chain: { id: 999, current: 200, cooldown: 0, timeout: 100 } };
    if (id === 6) return { chain: { id: 6, current: 'invalid' } };
    return { chain: { id, current: id === 1 ? 250 : 200, cooldown: id === 2 ? 2000 : 0, timeout: id === 1 ? 278 : 0 } };
  });
  monitor.start(); await monitor.promise;
  const state = monitor.status(), rows = state.chains;
  assert.deepEqual(rows.map(row => row.status), ['active', 'cooldown', 'failed', 'unknown', 'ended', 'unknown']);
  assert.equal(rows[0].factionId, 101); assert.equal(rows[0].name, 'Faction 1'); assert.equal(rows[0].hits, 250); assert.equal(rows[0].timeoutSeconds, 278); assert.equal(rows[0].verifiedAt, 1000);
  assert.equal(rows[1].cooldownUntil, 2000); assert.match(rows[2].reason, /Network unavailable \[Key\]/); assert.equal(rows[2].verifiedAt, null); assert.equal(rows[2].hitsSource, 'list');
  assert.match(rows[3].reason, /999.*候选 4/); assert.match(rows[5].reason, /缺少有效/);
  assert.equal(state.confirmed, 3); assert.equal(state.failed, 3); assert.ok(!JSON.stringify(state).includes(key));
  rows[0].name = 'modified outside'; assert.equal(monitor.status().chains[0].name, 'Faction 1');
});

test('confirmed cooldown cache is marked explicitly while new failures retain prior successful verification time', async t => {
  let phase = 0, cooldownCalls = 0;
  const { monitor } = setup(t, async path => {
    if (path.includes('warfarechains')) return { warfarechains: [candidate(1), candidate(2)] };
    const id = Number(path.split('/')[1]) - 100;
    if (id === 2) cooldownCalls++;
    if (phase && id === 1) throw new Error('Torn API HTTP 503');
    return { chain: { id, current: 250, cooldown: id === 2 ? 2000 : 0, timeout: 120 } };
  });
  monitor.start(); await monitor.promise; phase = 1; await monitor.scan();
  const rows = monitor.status().chains;
  assert.equal(cooldownCalls, 1); assert.equal(rows[1].cached, true); assert.equal(rows[1].verifiedAt, 1000); assert.equal(rows[1].hits, 250);
  assert.equal(rows[0].status, 'failed'); assert.equal(rows[0].previousStatus, 'active'); assert.equal(rows[0].verifiedAt, 1000);
});

test('detail rows show in-flight checks and stop does not leave a checking state behind', async t => {
  let release, entered;
  const checking = new Promise(resolve => { entered = resolve; });
  const { monitor } = setup(t, async path => {
    if (path.includes('warfarechains')) return { warfarechains: [candidate(1)] };
    entered(); return new Promise(resolve => { release = resolve; });
  });
  monitor.start(); await checking;
  assert.equal(monitor.status().chains[0].status, 'checking'); assert.equal(monitor.status().candidates, 1);
  monitor.stop(); release({ chain: { id: 1, current: 200, cooldown: 0, timeout: 100 } }); await monitor.promise;
  assert.equal(monitor.status().chains[0].status, 'waiting'); assert.match(monitor.status().chains[0].reason, /已停止/);
});

test('waiting candidates and stale list errors remain visible without extra API calls', async t => {
  let phase = 0, requests = 0;
  const { monitor } = setup(t, async path => {
    requests++;
    if (path.includes('warfarechains')) { if (phase) throw new Error('list unavailable'); return { warfarechains: Array.from({ length: 45 }, (_, i) => candidate(i + 1)) }; }
    const id = Number(path.split('/')[1]) - 100; return { chain: { id, current: 200, cooldown: 0, timeout: 100 } };
  });
  monitor.start(); await monitor.promise;
  assert.equal(requests, 41); assert.equal(monitor.status().chains.filter(row => row.status === 'waiting').length, 5);
  assert.match(monitor.status().chains.at(-1).reason, /轮换/);
  phase = 1; await monitor.scan(); assert.equal(requests, 42); assert.equal(monitor.status().detailsStale, true); assert.equal(monitor.status().chains.length, 45);
});

test('monitor detail API stays isolated by authenticated Portal user', async t => {
  const { store } = setup(t, async () => ({}));
  const service = createTornChainService({ store, monitorOptions: { now: () => 1000, schedule: () => 1, cancel: () => {} }, request: async path => path.includes('warfarechains') ? { warfarechains: [candidate(1)] } : { chain: { id: 1, current: 200, cooldown: 0, timeout: 100 } } });
  async function call(uid, route, method = 'GET') {
    const req = Readable.from([]); req.method = method; req.headers = {};
    let result; await service.handle(req, { setHeader() {} }, new URL('http://local/api/torn-chain/' + route), { userId: uid, permissions: ['*'] }, (_, status, data) => { result = { status, data }; }); return result;
  }
  await call('a', 'start', 'POST'); await service.monitors.get('a').promise;
  assert.equal((await call('a', 'state')).data.state.chains.length, 1);
  assert.deepEqual((await call('b', 'state')).data.state.chains, []);
  assert.ok(!JSON.stringify(await call('a', 'state')).includes(key)); service.monitors.get('a').stop();
});
