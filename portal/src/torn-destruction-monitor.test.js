import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { createChainStore } from './torn-chain-monitor.js';
import { DestructionMonitor, createDestructionStore, destructionConfig } from './torn-destruction-monitor.js';
import { createTornChainService } from './torn-chain.js';
import { createChainNotifier } from './torn-chain-notifications.js';

const key = '1234567890abcdef', key2 = 'abcdef1234567890';
const faction = (id, respect = 100, dead = false) => ({ id, name: 'Faction ' + id, respect, is_destroyed: dead, leader: { id: id + 1000, name: 'Leader ' + id } });
const page = (search, next = null) => ({ search, _metadata: { links: { next } } });
function fixture(t, request, extra = {}) {
  const db = new Database(':memory:'), store = createDestructionStore(db);
  store.save('a', { apiKeys: [key] }); const sent = [];
  const m = new DestructionMonitor({ uid: 'a', store, request, now: () => 1000, schedule: () => 1, cancel: () => {}, notify: async row => { sent.push(row); }, ...extra });
  t.after(() => { m.stop(); db.close(); }); return { db, store, m, sent };
}
test('destruction configuration migrates keys and notification settings without mixing Chain history', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const old = createChainStore(db); old.save('a', { apiKeys: [key, key2], apiIntervalSeconds: 3, minHits: 500 });
  old.saveNotify('a', { qq: { enabled: false }, slack: { enabled: true }, targets: [] });
  const store = createDestructionStore(db), config = store.get('a').config;
  assert.deepEqual(config.apiKeys, [key, key2]); assert.equal(config.apiIntervalSeconds, 3);
  assert.equal(config.minRespect, 0); assert.equal(config.maxRespect, 10000); assert.equal(config.intervalSeconds, 15);
  assert.ok(!('minHits' in config)); assert.deepEqual(store.get('a').history, []); assert.equal(store.getNotify('a').slack.enabled, true);
  store.save('a', { minRespect: 20 }); assert.deepEqual(store.get('a').config.apiKeys, [key, key2]);
  assert.equal(store.get('b').config.apiKeys.length, 0);
  assert.equal(destructionConfig({ maxRespect: '' }).maxRespect, null);
  for (const input of [{ intervalSeconds: 4 }, { intervalSeconds: 3601 }, { minRespect: '' }, { minRespect: -1 }, { maxRespect: 10, minRespect: 11 }, { apiKeys: ['invalid'] }]) assert.throws(() => destructionConfig(input));
});
test('only an observed live to confirmed destroyed transition sends once across restart and clear', async t => {
  let phase = 0;
  const f = fixture(t, async path => {
    const filter = new URL(path, 'https://api.torn.com/v2/').searchParams.get('filters');
    if (filter.includes('id:=:')) return page([faction(1, 0, true)]);
    return page(phase ? [] : [faction(1)]);
  });
  f.m.start(); await f.m.promise; assert.equal(f.sent.length, 0); assert.equal(f.store.observations('a')[0].lastAliveAt, 1000);
  phase = 1; f.m.now = () => 1015; await f.m.scan();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].previousRespect, 100); assert.equal(f.sent[0].leaderId, 1001);
  assert.equal(f.sent[0].lastAliveAt, 1000); assert.equal(f.sent[0].detectedAt, 1015); assert.equal(f.sent[0].cause, 'unknown');
  await f.m.scan(); f.m.stop(); f.store.clear('a'); f.m.start(); await f.m.promise;
  assert.equal(f.sent.length, 1); assert.deepEqual(f.store.get('a').history, []);
  assert.equal(f.store.get('b').history.length, 0);
  assert.equal(f.store.observe('a', { id: 1, respect: 100, isDestroyed: false, checkedAt: 2000 }), null);
  assert.equal(f.store.observations('a')[0].isDestroyed, true);
});
test('missing faction, invalid data and above-range alive faction never generate false destruction', async t => {
  let phase = 0;
  const f = fixture(t, async path => {
    const filter = new URL(path, 'https://api.torn.com/v2/').searchParams.get('filters');
    if (!filter.includes('id:=:')) return page(phase ? [] : [faction(1), faction(2)]);
    if (filter === 'id:=:1') return page([faction(1, 20000)]);
    return page(phase === 1 ? [] : [{ ...faction(2, 0, true), is_destroyed: undefined }]);
  });
  f.m.start(); await f.m.promise; phase = 1; await f.m.scan();
  assert.equal(f.sent.length, 0); assert.equal(f.m.status().failed, 1);
  assert.equal(f.m.status().problems[0].id, 2); assert.equal(f.m.status().factions.length, 1);
  assert.equal(f.store.observations('a').find(row => row.id === 1).respect, 20000);
  phase = 2; await f.m.scan(); assert.equal(f.sent.length, 0); assert.equal(f.m.running, true);
});
test('respect baseline updates and pagination covers over 100 factions without a 40-faction cap', async t => {
  const calls = []; let phase = 0;
  const f = fixture(t, async path => {
    calls.push(path); const url = new URL(path, 'https://api.torn.com/v2/');
    const offset = Number(url.searchParams.get('offset'));
    return page(Array.from({ length: offset ? 5 : 100 }, (_, i) => faction(offset + i + 1, phase ? 99 : 100)));
  });
  f.m.start(); await f.m.promise; assert.equal(f.store.observations('a').length, 105); assert.equal(f.m.status().pages, 2);
  phase = 1; await f.m.scan(); assert.equal(f.m.status().confirmed, 105); assert.equal(f.m.status().factions[0].previousRespect, 100);
  assert.equal(f.m.status().factions[0].respect, 99); assert.ok(calls.every(path => path.startsWith('faction/search?')));
});
test('incomplete pagination cannot update baseline, and transient requests retry the same key', async t => {
  let phase = 0, fail = true; const waits = [], calls = [];
  const f = fixture(t, async (path, key) => {
    calls.push(key);
    if (!phase) return page([faction(1)]);
    if (fail) { fail = false; throw Object.assign(new Error('timeout'), { transient: true }); }
    return page([faction(1, 50)], path);
  }, { wait: async ms => { waits.push(ms); } });
  f.m.start(); await f.m.promise; phase = 1; await f.m.scan();
  assert.deepEqual(waits, [10000]); assert.equal(f.m.status().partial, true); assert.equal(f.m.running, true);
  assert.equal(f.store.observations('a')[0].respect, 100); assert.ok(calls.every(k => k === key));
});
test('pagination retains filters omitted by API next links and skips rows changing out of range', async t => {
  const filters = [];
  const f = fixture(t, async path => {
    const url = new URL(path, 'https://api.torn.com/v2/'); filters.push(url.searchParams.get('filters'));
    assert.equal(url.searchParams.get('limit'), '100');
    if (url.searchParams.get('offset') === '0') return page([faction(1)], 'https://api.torn.com/v2/faction/search?offset=100');
    return page([faction(2), faction(3, 20000), faction(4, 0, true)]);
  });
  f.m.start(); await f.m.promise;
  assert.deepEqual(filters, ['notDestroyed,respect:>=:0,respect:<=:10000', 'notDestroyed,respect:>=:0,respect:<=:10000']);
  assert.equal(f.m.status().rounds, 1); assert.equal(f.m.status().outsideRange, 2);
  assert.deepEqual(f.store.observations('a').map(row => row.id), [1, 2]); assert.equal(f.sent.length, 0);
});
test('multi-key rejection skips bad keys and never rotates for a rate-limit retry', async t => {
  const calls = [], waits = []; let limited = true;
  const f = fixture(t, async (path, used) => {
    calls.push({ path, key: used });
    if (path === 'key/info') {
      if (used === key) throw Object.assign(new Error('invalid'), { apiCode: 2, fatal: true });
      return { info: { user: { id: 2 } } };
    }
    if (limited) { limited = false; throw Object.assign(new Error('rate limit'), { apiCode: 5, fatal: true }); }
    return page([faction(1)]);
  }, { wait: async ms => { waits.push(ms); } });
  f.store.save('a', { apiKeys: [key, key2] }); f.m.start(); await f.m.promise;
  assert.equal(f.m.status().skippedKeys[0].index, 1); assert.equal(f.m.status().availableKeyCount, 1);
  assert.deepEqual(waits, [65000]); assert.ok(calls.filter(c => c.path !== 'key/info').every(c => c.key === key2));
});
test('stop during list read cannot commit observations or send notifications', async t => {
  let entered, release; const waiting = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, async () => new Promise(resolve => { release = resolve; entered(); }));
  f.m.start(); await waiting; f.m.stop(); release(page([faction(1)])); await f.m.promise;
  assert.deepEqual(f.store.observations('a'), []); assert.equal(f.sent.length, 0); assert.equal(f.m.status().nextScanAt, null);
});
test('failed delivery preserves permanent dedup and initial destroyed baseline never alerts', async t => {
  let phase = 0, sends = 0;
  const f = fixture(t, async path => page(path.includes('id%3A') ? [faction(1, 0, true)] : phase ? [] : [faction(1)]), { notify: async () => { sends++; throw new Error('failed'); } });
  f.store.observe('a', { id: 2, respect: 0, isDestroyed: true, checkedAt: 999 });
  f.m.start(); await f.m.promise; phase = 1; await f.m.scan(); await f.m.scan();
  assert.equal(sends, 1); assert.equal(f.store.get('a').history.length, 1); assert.match(f.m.status().notificationError, /投递失败/);
});
test('new monitoring API hides all keys, validates ranges and enforces guest and action permissions', async t => {
  const f = fixture(t, async () => page([])); f.store.save('a', { apiKeys: [key, key2] });
  const service = createTornChainService({ store: f.store, request: async () => page([]) });
  const call = async (path, method = 'GET', body, session = { userId: 'a', permissions: ['*'] }, headers = {}) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.headers = { host: 'localhost', ...headers };
    let result; await service.handle(req, { setHeader() {} }, new URL('http://localhost/api/torn-chain/' + path), session, (_, status, data) => { result = { status, data }; }); return result;
  };
  const guest = { userId: 'a', isGuest: true, permissions: ['*'] };
  const result = await call('state', 'GET', null, guest); assert.equal(result.status, 200);
  assert.equal(result.data.state.kind, 'destruction'); assert.equal(result.data.config.keyCount, 2);
  assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(result).includes(key2)); assert.ok(!('apiKeys' in result.data.config));
  for (const [path, method] of [['config', 'POST'], ['start', 'POST'], ['stop', 'POST'], ['history', 'DELETE'], ['notifications', 'GET']]) assert.equal((await call(path, method, {}, guest)).status, 403);
  assert.equal((await call('config', 'POST', { minRespect: 0, maxRespect: 50, intervalSeconds: 5 })).status, 200);
  assert.equal(f.store.get('a').config.maxRespect, 50); assert.equal(f.store.get('a').config.apiKeys.length, 2);
  assert.equal((await call('config', 'POST', { minRespect: 51 })).status, 400);
  assert.equal((await call('config', 'POST', {}, undefined, { origin: 'https://evil.test' })).status, 403);
  for (let i = 1; i <= 55; i++) f.store.observe('a', { id: i, name: 'Faction ' + i, respect: 1, leaderId: 1000 + i, isDestroyed: false, checkedAt: 1000 });
  const first = (await call('state', 'GET', null, guest)).data;
  assert.equal(first.state.factions.length, 50); assert.equal(first.state.factionsTotal, 55);
  const second = (await call('state?offset=50', 'GET', null, guest)).data;
  assert.equal(second.state.factions.length, 5); assert.equal(second.state.factions[0].id, 51); assert.equal(second.state.factionsOffset, 50);
  const monitor = service.monitors.get('a'); monitor.state.problems = [{ id: 52, reason: 'unknown' }];
  const problems = (await call('state?filter=problem', 'GET', null, guest)).data;
  assert.equal(problems.state.factionsTotal, 1); assert.equal(problems.state.factions[0].id, 52);
  const invalidOffset = (await call('state?offset=bad', 'GET', null, guest)).data;
  assert.equal(invalidOffset.state.factionsOffset, 0);
});
test('destruction notifications contain faction, former Leader and observation times without a fake Chain report', async () => {
  const messages = []; const send = createChainNotifier({ endpoint: 'http://127.0.0.1:8787', token: 'test-token', fetchImpl: async (_, opts) => { messages.push(JSON.parse(opts.body).message); return { ok: true, json: async () => ({ ok: true }) }; } });
  await send({ qq: { enabled: false }, slack: { enabled: true }, targets: [] }, { kind: 'destruction', id: 5, name: 'Faction', leaderId: 100, previousRespect: 55, respect: 0, lastAliveAt: 1000, detectedAt: 1015 });
  assert.match(messages[0], /ID=5/); assert.match(messages[0], /XID=100/); assert.match(messages[0], /55 → 0/); assert.match(messages[0], /摧毁原因未知/); assert.ok(!messages[0].includes('chainreport'));
});

test('respect zero alerts on the first page before destruction or full pagination; later confirmation is silent', async t => {
  let phase = 0, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, async path => {
    const u = new URL(path, 'https://api.torn.com/v2/'), filter = u.searchParams.get('filters');
    if (filter === 'id:=:1') return page([faction(1, 0, true)]);
    if (phase === 0) return page([faction(1, 100)]);
    if (phase === 2) return page([]);
    if (u.searchParams.get('offset') === '0') return page([faction(1, 0, false)], 'https://api.torn.com/v2/faction/search?offset=100');
    entered(); return new Promise(resolve => { release = resolve; });
  });
  f.m.start(); await f.m.promise; phase = 1; f.m.now = () => 1015;
  const scan = f.m.scan(); await waiting;
  assert.equal(f.sent.length, 1, 'zero notification must precede fetching the remaining list');
  assert.equal(f.sent[0].kind, 'respect-zero'); assert.equal(f.sent[0].isDestroyed, false); assert.equal(f.sent[0].previousRespect, 100);
  assert.equal(f.m.status().zeroed, 1); release(page([])); await scan;
  phase = 2; f.m.now = () => 3600; await f.m.scan();
  assert.equal(f.sent.length, 1); assert.equal(f.store.get('a').history.length, 1);
  assert.equal(f.store.get('a').history[0].destroyedConfirmedAt, 3600);
  f.store.clear('a'); f.m.stop(); f.m.start(); await f.m.promise; assert.equal(f.sent.length, 1);
});
test('first-seen zeros are baseline-only, while pre-upgrade tracked live zeros alert on their next verification', async t => {
  const f = fixture(t, async () => page([faction(1, 0, false), faction(2, 0, false)]));
  f.db.prepare('INSERT INTO torn_destruction_observations(user_id,faction_id,row_json) VALUES(?,?,?)').run('a', 2, JSON.stringify({ id: 2, name: 'Legacy', leaderId: 1002, respect: 0, isDestroyed: false, lastAliveAt: 999, checkedAt: 999 }));
  f.m.start(); await f.m.promise;
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].id, 2); assert.equal(f.sent[0].previousRespect, null);
  await f.m.scan(); f.m.stop(); f.m.start(); await f.m.promise; assert.equal(f.sent.length, 1);
});
test('zero below configured minimum is still detected by ID verification for a previously in-range faction', async t => {
  let phase = 0;
  const f = fixture(t, async path => page(path.includes('id%3A') ? [faction(1, 0, false)] : phase ? [] : [faction(1, 100)]));
  f.store.save('a', { minRespect: 50 }); f.m.start(); await f.m.promise; phase = 1; await f.m.scan();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, 'respect-zero');
  assert.equal(f.m.status().factions[0].respect, 0); await f.m.scan(); assert.equal(f.sent.length, 1);
});
test('explicit zero evidence alerts even if later pagination fails; no later duplication or stale cache revival', async t => {
  let phase = 0;
  const f = fixture(t, async path => phase ? page([faction(1, 0, false)], path) : page([faction(1)]));
  f.m.start(); await f.m.promise; phase = 1; await f.m.scan();
  assert.equal(f.m.status().partial, true); assert.equal(f.sent.length, 1);
  f.store.observe('a', { ...f.store.observations('a')[0], respect: 5, checkedAt: 1010 });
  await f.m.scan(); assert.equal(f.sent.length, 1, 'positive cache oscillation must not reset permanent dedup');
});
test('zero notification does not falsely claim destruction and carries both faction and Leader links', async () => {
  const messages = [], send = createChainNotifier({ endpoint: 'http://127.0.0.1:8787', token: 'test-token', fetchImpl: async (_url, options) => { messages.push(JSON.parse(options.body).message); return { ok: true, json: async () => ({ ok: true }) }; } });
  await send({ qq: { enabled: false }, slack: { enabled: true }, targets: [] }, { kind: 'respect-zero', id: 5, name: 'Faction', leaderId: 100, previousRespect: 55, respect: 0, detectedAt: 1015, isDestroyed: false });
  assert.match(messages[0], /respect 清零/); assert.match(messages[0], /尚未标记摧毁/); assert.match(messages[0], /ID=5/); assert.match(messages[0], /XID=100/); assert.doesNotMatch(messages[0], /已确认摧毁|chainreport|Bonus #/);
});
