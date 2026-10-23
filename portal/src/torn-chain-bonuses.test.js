import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BONUS_HITS, normalizeBonusHits, reportBonusDefenders, selectedBonusDefenders, lookupDefenderLeader } from './torn-chain-bonuses.js';
import { ChainMonitor, chainConfig, createChainStore, createChainApiClient } from './torn-chain-monitor.js';
import { createChainNotifier } from './torn-chain-notifications.js';

function fixture(t) { const db = new Database(':memory:'); t.after(() => db.close()); const store = createChainStore(db); store.save('a', { apiKey: '1234567890abcdef', bonusHits: [100, 250] }); return store; }
const report = (id = 1) => ({ id, faction_id: id + 100, bonuses: [100, 250].map(hit => ({ chain: hit, defender_id: hit + 1000, attacker_id: 999, respect: 80 })) });
const candidate = id => ({ id, chain: 250, faction: { id: id + 100, name: 'Example' } });
const chain = id => ({ id, current: 250, timeout: 0, cooldown: 2000 });

test('bonus selections validate, deduplicate and persist per user', t => {
  const store = fixture(t);
  assert.deepEqual(normalizeBonusHits([250, 100, 250]), [100, 250]);
  assert.throws(() => normalizeBonusHits([99])); assert.throws(() => normalizeBonusHits(['100']));
  assert.deepEqual(store.get('b').config.bonusHits, []);
  assert.deepEqual(store.save('a', { minHits: 200 }).bonusHits, [100, 250]);
  assert.deepEqual(chainConfig({ bonusHits: [] }).bonusHits, []);
  assert.equal(BONUS_HITS.length, 13);
});

test('report parsing uses defender IDs, rejects foreign reports and never stores attackers', () => {
  const row = { id: 1, factionId: 101, hits: 250 };
  const bonuses = reportBonusDefenders(report(), row);
  assert.deepEqual(bonuses, [{ hit: 100, defenderId: 1100 }, { hit: 250, defenderId: 1250 }]);
  assert.ok(!JSON.stringify(bonuses).includes('999'));
  assert.throws(() => reportBonusDefenders(report(2), row));
  assert.throws(() => reportBonusDefenders({ ...report(), faction_id: 999 }, row));
  assert.throws(() => reportBonusDefenders({ ...report(), bonuses: [{ chain: 100, defender_id: '<script>' }] }, row));
  assert.deepEqual(selectedBonusDefenders({ ...row, bonusDetails: bonuses }, [100, 250, 500]), bonuses);
});

test('new cooldown reads one report, caches defenders before notifying, and does not refetch', async t => {
  const store = fixture(t), calls = [], notices = [];
  const m = new ChainMonitor({ uid: 'a', store, now: () => 1000, schedule: () => 1, cancel: () => {}, notify: async row => { notices.push(row); }, request: async path => {
    calls.push(path);
    if (path.includes('warfarechains')) return { warfarechains: [candidate(1)] };
    if (path.endsWith('chainreport')) return { chainreport: report() };
    return { chain: chain(1) };
  } });
  m.start(); await m.promise;
  assert.equal(calls.filter(path => path.endsWith('chainreport')).length, 1);
  assert.deepEqual(notices[0].bonusSelection, [100, 250]);
  assert.equal(notices[0].bonusDetails[1].defenderId, 1250);
  assert.equal(store.get('a').history[0].bonusStatus, 'ready');
  await m.scan(); assert.equal(calls.filter(path => path.endsWith('chainreport')).length, 1); assert.equal(notices.length, 1); m.stop();
});

test('report failure preserves records and fallback notice, with bounded retries and no repeat notices', async t => {
  const store = fixture(t); let now = 1000, attempts = 0, notices = 0;
  const m = new ChainMonitor({ uid: 'a', store, now: () => now, schedule: () => 1, cancel: () => {}, notify: async () => { notices++; }, request: async path => {
    if (path.includes('warfarechains')) return { warfarechains: [candidate(1)] };
    if (path.endsWith('chainreport')) { attempts++; throw new Error('report unavailable'); }
    return { chain: chain(1) };
  } });
  m.start(); await m.promise; assert.equal(store.get('a').history.length, 1); assert.equal(notices, 1);
  await m.scan(); assert.equal(attempts, 1);
  for (let i = 0; i < 5; i++) { now += 60; await m.scan(); }
  assert.equal(attempts, 3); assert.equal(notices, 1); assert.equal(store.get('a').history[0].bonusStatus, 'unavailable'); m.stop();
});

test('bonus opt-out avoids report requests and later selections backfill five old records per round', async t => {
  const store = fixture(t); store.save('a', { bonusHits: [] });
  for (let id = 1; id <= 7; id++) store.record('a', candidate(id), chain(id), false, 1000);
  let requests = 0;
  const m = new ChainMonitor({ uid: 'a', store, now: () => 1000, schedule: () => 1, cancel: () => {}, request: async path => {
    if (path.includes('warfarechains')) return { warfarechains: [] };
    requests++; const id = Number(path.split('/')[1]); return { chainreport: report(id) };
  } });
  m.start(); await m.promise; assert.equal(requests, 0); m.stop();
  store.save('a', { bonusHits: [100] }); m.start(); await m.promise; assert.equal(requests, 5);
  await m.scan(); assert.equal(requests, 7); assert.equal(store.get('a').history.filter(row => row.bonusStatus === 'ready').length, 7); m.stop();
});

test('notification includes only selected reached bonus defender profile URLs', async () => {
  const messages = [];
  const notify = createChainNotifier({ endpoint: 'http://localhost:8787', token: 'secret', fetchImpl: async (_, options) => { messages.push(JSON.parse(options.body).message); return { ok: true, json: async () => ({ ok: true }) }; } });
  await notify({ qq: { enabled: false }, slack: { enabled: true } }, { id: 1, name: 'Example', hits: 250, bonusSelection: [100, 250, 500], bonusDetails: [{ hit: 100, defenderId: 1100 }] });
  assert.match(messages[0], /Bonus #100 被打玩家：https:\/\/www.torn.com\/profiles.php\?XID=1100/);
  assert.match(messages[0], /Bonus #250 被打玩家：暂不可用/); assert.ok(!messages[0].includes('#500')); assert.ok(!messages[0].includes('attacker'));
});

test('public API client allows only the specific official chainreport path', async () => {
  let called = false;
  const request = createChainApiClient({ spacingMs: 0, fetchImpl: async url => { assert.equal(new URL(url).pathname, '/v2/faction/123/chainreport'); called = true; return { ok: true, json: async () => ({ chainreport: report() }) }; } });
  await request('faction/123/chainreport', '1234567890abcdef'); assert.equal(called, true);
  await assert.rejects(request('https://evil.test/v2/faction/123/chainreport', '1234567890abcdef'));
});

test('Leader filter validates selections and uses the actual leader ID rather than custom position or co-leader', async () => {
  assert.throws(() => chainConfig({ leaderFilter: 'leader' }), /至少选择/);
  assert.throws(() => chainConfig({ bonusHits: [100], leaderFilter: 'wrong' }));
  const cache = new Map(), calls = [];
  const request = async path => {
    calls.push(path);
    if (path.startsWith('user/')) return { profile: { id: Number(path.split('/')[1]), faction_id: 500, position: 'Leader' } };
    return { basic: { id: 500, leader_id: 1100, co_leader_id: 1250 } };
  };
  assert.equal((await lookupDefenderLeader(1100, request, cache)).isLeader, true);
  assert.equal((await lookupDefenderLeader(1250, request, cache)).isLeader, false);
  assert.equal(calls.filter(path => path.endsWith('/basic')).length, 1);
  assert.deepEqual(await lookupDefenderLeader(1234, async () => ({ profile: { id: 1234, faction_id: null } })), { isLeader: false, factionId: null });
  await assert.rejects(lookupDefenderLeader(1234, async () => ({ profile: { id: 999, faction_id: null } })));
  const row = { hits: 250, bonusDetails: [{ hit: 100, defenderId: 1100, isLeader: true }, { hit: 250, defenderId: 1250, isLeader: false }] };
  assert.deepEqual(selectedBonusDefenders(row, [100, 250], 'leader').map(bonus => bonus.defenderId), [1100]);
  assert.deepEqual(selectedBonusDefenders(row, [100, 250], 'non-leader').map(bonus => bonus.defenderId), [1250]);
  assert.deepEqual(selectedBonusDefenders({ hits: 100, bonusDetails: [{ hit: 100, defenderId: 1100, isLeader: null }] }, [100], 'non-leader'), []);
});

test('unknown Leader state defers notification, then confirmed matching identity notifies once', async t => {
  const store = fixture(t); store.save('a', { leaderFilter: 'leader' });
  let now = 1000, available = false; const notices = [];
  const m = new ChainMonitor({ uid: 'a', store, now: () => now, schedule: () => 1, cancel: () => {}, notify: async row => { notices.push(row); }, request: async path => {
    if (path.includes('warfarechains')) return { warfarechains: [candidate(1)] };
    if (path.endsWith('chainreport')) return { chainreport: report() };
    if (path.startsWith('user/')) { if (!available) throw new Error('offline'); return { profile: { id: Number(path.split('/')[1]), faction_id: 500 } }; }
    if (path.endsWith('/basic')) return { basic: { id: 500, leader_id: 1100 } };
    return { chain: chain(1) };
  } });
  m.start(); await m.promise; assert.equal(notices.length, 0); assert.equal(store.get('a').history[0].notificationPending, true);
  available = true; now += 61; await m.scan(); assert.equal(notices.length, 1); assert.equal(notices[0].bonusDetails[0].isLeader, true); assert.equal(notices[0].bonusDetails[1].isLeader, false);
  assert.equal(store.get('a').history[0].notificationPending, false);
  await m.scan(); assert.equal(notices.length, 1); m.stop();
});

test('Leader verification is capped at ten unique players each round, then resumes without duplicate notices', async t => {
  const store = fixture(t); store.save('a', { bonusHits: [100], leaderFilter: 'leader' });
  const notices = []; let lookups = 0;
  const m = new ChainMonitor({ uid: 'a', store, now: () => 1000, schedule: () => 1, cancel: () => {}, notify: async row => notices.push(row), request: async path => {
    if (path.includes('warfarechains')) return { warfarechains: Array.from({ length: 12 }, (_, i) => candidate(i + 1)) };
    const id = Number(path.split('/')[1]);
    if (path.endsWith('chainreport')) return { chainreport: { id, faction_id: id + 100, bonuses: [{ chain: 100, defender_id: id + 1000 }] } };
    if (path.startsWith('user/')) { lookups++; return { profile: { id, faction_id: id + 10000 } }; }
    if (path.endsWith('/basic')) return { basic: { id, leader_id: id - 10000 } };
    return { chain: chain(id - 100) };
  } });
  m.start(); await m.promise; assert.equal(lookups, 10); assert.equal(notices.length, 10);
  await m.scan(); assert.equal(lookups, 12); assert.equal(notices.length, 12);
  await m.scan(); assert.equal(notices.length, 12); m.stop();
});

test('notification suppresses nonmatching or unknown defenders and includes only the matched Leader', async () => {
  const messages = [];
  const send = createChainNotifier({ endpoint: 'http://localhost:8787', token: 'secret', fetchImpl: async (_, options) => { messages.push(JSON.parse(options.body).message); return { ok: true, json: async () => ({ ok: true }) }; } });
  const settings = { qq: { enabled: false }, slack: { enabled: true } }, row = { id: 1, hits: 250, bonusSelection: [100, 250], leaderFilter: 'leader' };
  await send(settings, { ...row, bonusDetails: [{ hit: 100, defenderId: 1100, isLeader: null }, { hit: 250, defenderId: 1250, isLeader: false }] }); assert.equal(messages.length, 0);
  await send(settings, { ...row, bonusDetails: [{ hit: 100, defenderId: 1100, isLeader: true }, { hit: 250, defenderId: 1250, isLeader: false }] });
  assert.equal(messages.length, 1); assert.match(messages[0], /XID=1100/); assert.ok(!messages[0].includes('XID=1250'));
});

test('unconfirmed identities stop after three attempts and never match exclusion or trigger a stale notice', async t => {
  const store = fixture(t); store.save('a', { bonusHits: [100], leaderFilter: 'non-leader' });
  let now = 1000, attempts = 0, sent = 0;
  const m = new ChainMonitor({ uid: 'a', store, now: () => now, schedule: () => 1, cancel: () => {}, notify: async () => { sent++; }, request: async path => {
    if (path.includes('warfarechains')) return { warfarechains: [candidate(1)] };
    if (path.endsWith('chainreport')) return { chainreport: report() };
    if (path.startsWith('user/')) { attempts++; throw new Error('unknown identity'); }
    return { chain: chain(1) };
  } });
  m.start(); await m.promise;
  for (let i = 0; i < 5; i++) { now += 61; await m.scan(); }
  assert.equal(attempts, 3); assert.equal(sent, 0); assert.equal(store.get('a').history[0].notificationPending, false); m.stop();
});

test('expired deferred notifications are discarded even if identity verification later succeeds', async t => {
  const store = fixture(t); store.save('a', { bonusHits: [100], leaderFilter: 'leader' });
  let now = 1000, available = false, sent = 0;
  const m = new ChainMonitor({ uid: 'a', store, now: () => now, schedule: () => 1, cancel: () => {}, notify: async () => { sent++; }, request: async path => {
    if (path.includes('warfarechains')) return { warfarechains: [candidate(1)] };
    if (path.endsWith('chainreport')) return { chainreport: report() };
    if (path.startsWith('user/')) { if (!available) throw new Error('offline'); return { profile: { id: Number(path.split('/')[1]), faction_id: 500 } }; }
    if (path.endsWith('/basic')) return { basic: { id: 500, leader_id: 1100 } };
    return { chain: chain(1) };
  } });
  m.start(); await m.promise; assert.equal(store.get('a').history[0].notificationPending, true);
  now = 2100; available = true; await m.scan(); assert.equal(sent, 0); assert.equal(store.get('a').history[0].notificationPending, false); m.stop();
});
