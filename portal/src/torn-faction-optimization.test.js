import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { DAY, factionConfig, possibleFactionEvent, analyzeFactionHistory } from './torn-faction-analysis.js';
import { createFactionStore, FactionScanner } from './torn-faction-scan.js';
import { createFactionService } from './torn-factions.js';

const today = 20000, key = '1234567890abcdef', key2 = 'abcdef1234567890', key3 = 'fedcba0987654321';
function setup(t, patch = {}, changes = [{ day: today - 1000, value: 1000 }, { day: today - 10, value: 400 }]) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = createFactionStore(db), calls = [];
  store.save('a', { apiKey: key, dailyDropAmount: 200, peakDropAmount: 200, ...patch });
  const profile = { id: 1010, faction_id: 10, signed_up: (today - 1001) * DAY, last_action: { timestamp: (today - 20) * DAY } };
  const member = { id: 10, days_in_faction: 500 };
  const request = async (path, apiKey) => {
    calls.push({ path, apiKey });
    if (path === 'key/info') return { info: { user: { id: apiKey === key3 ? 2 : 1 } } };
    if (path.includes('/search')) return { search: [{ id: 10, respect: 1, leader: { id: 1010 } }], _metadata: { links: { next: null } } };
    if (path.endsWith('/basic')) return { basic: { id: 10, leader_id: 1010 } };
    if (path.endsWith('/profile')) return { profile };
    if (path.endsWith('/faction')) return { faction: member };
    const day = Number(new URL(path, 'https://api.torn.com/v2/').searchParams.get('timestamp')) / DAY;
    const point = changes.findLast(point => point.day <= day);
    return { personalstats: [{ name: 'networth', value: point.value, timestamp: point.day * DAY }] };
  };
  const scanner = new FactionScanner({ uid: 'a', store, request, now: () => today * DAY + 3600 });
  return { store, scanner, request, calls, profile, member, changes };
}

test('optional N selects full history, explicit N selects a bounded window and legacy keys migrate', () => {
  for (const historyDays of ['', '   ', null]) {
    const cfg = factionConfig({ historyMode: 'window', historyDays });
    assert.equal(cfg.historyMode, 'full'); assert.equal(cfg.historyDays, null);
  }
  assert.equal(factionConfig({ historyDays: '90' }).historyMode, 'window');
  assert.equal(factionConfig({ historyDays: '90' }).historyDays, 90);
  assert.equal(factionConfig({}).historyDays, null);
  assert.deepEqual(factionConfig({}, { apiKey: key }).apiKeys, [key]);
  assert.deepEqual(factionConfig({ apiKeys: `${key}\n${key2},${key}` }).apiKeys, [key, key2]);
  const saved = factionConfig({ apiKeys: [key, key2], historyDays: 90 });
  assert.deepEqual(factionConfig({ minRespect: 1 }, saved).apiKeys, [key, key2]);
  assert.deepEqual(factionConfig({ apiKeys: [] }, saved).apiKeys, []);
  for (const apiKeys of [null, [123], ['bad'], Array(11).fill(key)]) assert.throws(() => factionConfig({ apiKeys }));
  for (const historyDays of [0, 1, false, 2.5, 3651]) assert.throws(() => factionConfig({ historyDays }));
});

test('backward traversal preserves every daily result using two calls for 1001 days', async t => {
  const f = setup(t, { minDifference: null });
  f.scanner.start(); await f.scanner.promise;
  const row = f.scanner.run.rows[0];
  assert.equal(row.status, 'match'); assert.equal(row.dropDay, today - 10);
  assert.equal(row.loadedDays, 1001); assert.equal(f.scanner.run.skippedDays, 999);
  assert.deepEqual(f.calls.filter(c => c.path.includes('/personalstats')).map(c => Number(new URL(c.path, 'https://api.torn.com').searchParams.get('timestamp')) / DAY), [today, today - 11]);
  const samples = Array.from({ length: 1001 }, (_, i) => f.store.point('a', 1010, today - 1000 + i));
  const expected = analyzeFactionHistory(samples, { today, lastAction: f.profile.last_action.timestamp, daysInFaction: 500 }, f.store.get('a').config);
  for (const name of ['status', 'dropDay', 'peakBefore', 'dailyAmount', 'peakAmount', 'A', 'difference']) assert.equal(row[name], expected[name]);
});

test('reverse traversal agrees with daily reference across rises, recoveries, negative values and window edges', async t => {
  // Each deterministic curve includes long plateaus and temporary recoveries.
  for (let seed = 1; seed <= 12; seed++) {
    const changes = [{ day: today - 60, value: 1000 }];
    for (let i = 1; i <= 15; i++) changes.push({ day: today - 60 + i * 4, value: (seed * 733 + i * 379) % 1600 - 300 });
    const f = setup(t, { minDifference: null, historyDays: 49, dropMode: ['daily', 'peak', 'both'][seed % 3] }, changes);
    f.scanner.start(); await f.scanner.promise;
    const daily = Array.from({ length: 50 }, (_, i) => {
      const day = today - 49 + i, point = changes.findLast(p => p.day <= day);
      return { day, value: point.value, timestamp: point.day * DAY };
    });
    const expected = analyzeFactionHistory(daily, { today, lastAction: f.profile.last_action.timestamp, daysInFaction: 500 }, f.store.get('a').config);
    const actual = f.scanner.run.rows[0];
    for (const name of ['status', 'dropDay', 'dailyAmount', 'peakAmount', 'peakBefore']) assert.equal(actual[name], expected[name], `seed ${seed}: ${name}`);
  }
});

test('identity bounds exclude impossible candidates without any historical requests and keep inclusive dates', async t => {
  const f = setup(t, { minDifference: 0 }); f.member.days_in_faction = 2;
  f.scanner.start(); await f.scanner.promise;
  assert.equal(f.scanner.run.rows[0].earlyExcluded, true);
  assert.equal(f.calls.some(c => c.path.includes('/personalstats')), false);
  assert.equal(possibleFactionEvent({ today, first: today - 30, lastAction: (today - 20) * DAY, daysInFaction: 20 }, factionConfig({ minDifference: 0, maxDifference: 0 })).possible, true);
  assert.equal(possibleFactionEvent({ today, first: today - 30, lastAction: today * DAY, daysInFaction: 20 }, factionConfig({ maxDifference: -1, minDifference: null })).possible, false);
  assert.throws(() => possibleFactionEvent({ today, first: today - 30, lastAction: today * DAY, daysInFaction: -1 }, factionConfig({})));
});

test('a newer event outside identity bounds is not replaced with an older matching event', async t => {
  const f = setup(t, {}, [{ day: today - 1000, value: 1000 }, { day: today - 30, value: 600 }, { day: today - 5, value: 300 }]);
  f.scanner.start(); await f.scanner.promise;
  const row = f.scanner.run.rows[0]; assert.equal(row.status, 'excluded'); assert.equal(row.dropDay, today - 5); assert.match(row.reason, /A−B/);
});

test('contradictory cache is rejected instead of overwriting evidence while jumping a plateau', async t => {
  const f = setup(t, { minDifference: null });
  f.store.savePoint('a', 1010, { day: today - 1, value: 999, timestamp: (today - 1) * DAY });
  f.scanner.start(); await f.scanner.promise;
  assert.equal(f.scanner.run.rows[0].status, 'unknown'); assert.match(f.scanner.run.rows[0].reason, /矛盾/);
  assert.equal(f.store.point('a', 1010, today - 1).value, 999);
});

test('multiple keys rotate by distinct verified owners, never by duplicate account keys', async t => {
  const f = setup(t, { apiKeys: [key, key2, key3], minDifference: null });
  f.scanner.start(); await f.scanner.promise;
  assert.equal(f.scanner.run.ownerCount, 2); assert.equal(f.scanner.run.keyCount, 3);
  const work = f.calls.filter(c => c.path !== 'key/info');
  assert.ok(work.length > 4); assert.equal(work.some(c => c.apiKey === key2), false);
  work.forEach((c, i) => assert.equal(c.apiKey, i % 2 ? key3 : key));
  assert.equal(f.scanner.run.rows[0].status, 'match');
});

test('invalid keys are skipped during ownership verification while valid keys finish the scan', async t => {
  const f = setup(t, { apiKeys: [key, key3], minDifference: null }), base = f.request;
  f.scanner.request = async (path, apiKey) => {
    if (apiKey === key) throw Object.assign(new Error('invalid ' + key), { apiCode: 2, fatal: true });
    return base(path, apiKey);
  };
  f.scanner.start(); await f.scanner.promise;
  assert.equal(f.scanner.run.rows[0].status, 'match'); assert.equal(f.scanner.run.availableKeyCount, 1); assert.equal(f.scanner.run.ownerCount, 1);
  assert.deepEqual(f.scanner.run.skippedKeys, [{ index: 1, code: 2, reason: 'API 错误 2' }]);
  assert.ok(!JSON.stringify(f.scanner.run).includes(key)); assert.equal(f.store.get('a').config.apiKeys.length, 2);
});

test('a disabled representative key falls back to a verified same-owner standby without resetting progress', async t => {
  const f = setup(t, { apiKeys: [key, key2], minDifference: null }), base = f.request, attempts = [];
  f.scanner.request = async (path, apiKey) => {
    attempts.push({ path, apiKey });
    if (apiKey === key && path.endsWith('/basic')) throw Object.assign(new Error('disabled'), { apiCode: 13, fatal: true });
    return base(path, apiKey);
  };
  f.scanner.start(); await f.scanner.promise;
  const basics = attempts.filter(row => row.path.endsWith('/basic'));
  assert.deepEqual(basics.slice(0, 2).map(row => row.apiKey), [key, key2]); assert.equal(f.scanner.run.rows[0].status, 'match');
  assert.equal(f.scanner.run.skippedKeys[0].code, 13); assert.equal(f.scanner.run.ownerCount, 1);
  assert.equal(attempts.filter(row => row.apiKey === key && row.path !== 'key/info').length, 2); // search, then failed basic only
});

test('all rejected keys stop with per-key diagnostics while bans never trigger fallback', async t => {
  const f = setup(t, { apiKeys: [key, key3] });
  f.scanner.request = async () => { throw Object.assign(new Error('paused'), { apiCode: 18, fatal: true }); };
  f.scanner.start(); await f.scanner.promise;
  assert.equal(f.scanner.run.skippedKeys.length, 2); assert.equal(f.scanner.run.availableKeyCount, 0); assert.match(f.scanner.run.error, /所有 API Key 均不可用/);
  const calls = [];
  f.scanner.request = async (path, apiKey) => { calls.push(apiKey); throw Object.assign(new Error('IP blocked'), { apiCode: 8, fatal: true }); };
  f.scanner.start(); await f.scanner.promise;
  assert.deepEqual(calls, [key]); assert.match(f.scanner.run.error, /IP blocked/); assert.equal(f.scanner.run.skippedKeys.length, 0);
});

test('unknown key owners and fatal quota errors stop, redact ALL keys, and never rotate past failure', async t => {
  const f = setup(t, { apiKeys: [key, key2], minDifference: null });
  f.scanner.request = async () => ({ info: { user: {} } });
  f.scanner.start(); await f.scanner.promise; assert.match(f.scanner.run.error, /所属账号/); assert.equal(f.scanner.run.cursor, undefined);
  let requests = 0;
  f.scanner.request = async (path, apiKey) => {
    requests++;
    if (path === 'key/info') return { info: { user: { id: apiKey === key ? 1 : 2 } } };
    throw Object.assign(new Error(`${key} ${key2}: quota exceeded`), { fatal: true });
  };
  f.scanner.start(); await f.scanner.promise;
  assert.equal(requests, 3); assert.ok(!f.scanner.run.error.includes(key)); assert.ok(!f.scanner.run.error.includes(key2));
});

test('multiple key storage remains scoped and API exposes only counts, including after config edits', async t => {
  const f = setup(t, { apiKeys: [key, key2] }), service = createFactionService({ store: f.store, request: f.request });
  const call = async (route, method = 'GET', body = {}, uid = 'a', permissions = ['*']) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { host: 'local' };
    let result;
    await service.handle(req, { setHeader() {} }, new URL('http://local/api/torn-factions/' + route), { userId: uid, permissions }, (_, status, data) => { result = { status, data }; });
    return result;
  };
  assert.equal((await call('state')).data.config.keyCount, 2);
  assert.equal((await call('config', 'POST', { historyDays: '' })).status, 200);
  assert.deepEqual(f.store.get('a').config.apiKeys, [key, key2]);
  assert.equal((await call('state')).data.config.historyMode, 'full');
  assert.equal((await call('state', 'GET', {}, 'b')).data.config.keyCount, 0);
  assert.equal((await call('config', 'POST', { apiKeys: [key3] }, 'a', ['torn-chain:view', 'torn-factions:view'])).status, 403);
  const publicState = JSON.stringify(await call('state'));
  assert.ok(!publicState.includes(key)); assert.ok(!publicState.includes(key2)); assert.ok(!publicState.includes('apiKeys'));
});
