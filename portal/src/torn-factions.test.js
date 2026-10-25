import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { DAY, FACTION_DEFAULTS, factionConfig, historicNetworth, analyzeFactionHistory } from './torn-faction-analysis.js';
import { createFactionStore, FactionScanner } from './torn-faction-scan.js';
import { createFactionService, canFactionScan } from './torn-factions.js';
import { accessModules } from './access-policy.js';
import { SYSTEM_PERMISSIONS } from './rbac.js';

const today = 20000, key = '1234567890abcdef';
const series = values => values.map((value, i) => ({ day: today - values.length + 1 + i, value, timestamp: (today - values.length + 1 + i) * DAY, exactDay: true }));
const meta = { today, lastAction: (today - 1) * DAY, daysInFaction: 10 };
const config = patch => factionConfig({ dailyDropAmount: 200, peakDropAmount: 200, ...patch });
function fixture(t) { const db = new Database(':memory:'); t.after(() => db.close()); const store = createFactionStore(db); store.save('a', { apiKey: key, batchSize: 1, dailyDropAmount: 200, peakDropAmount: 200 }); return store; }
const faction = (id, respect) => ({ id, respect, name: 'Faction ' + id, leader: { id: id + 1000, name: 'Leader ' + id }, is_destroyed: false });
function mockRequest(calls = []) {
  return async path => {
    calls.push(path); const url = new URL(path, 'https://api.torn.com/v2/'), id = Number(url.pathname.split('/')[3]);
    if (url.pathname.endsWith('/search')) return { search: [faction(20, 500), faction(10, 100)], _metadata: { links: { next: null } } };
    if (url.pathname.endsWith('/basic')) return { basic: { id, leader_id: id + 1000 } };
    if (url.pathname.endsWith('/profile')) return { profile: { id, faction_id: id - 1000, signed_up: (today - 4) * DAY, last_action: { timestamp: (today - 1) * DAY } } };
    if (url.pathname.endsWith('/faction')) return { faction: { id: id - 1000, days_in_faction: 10 } };
    if (url.pathname.endsWith('/personalstats')) { const day = Number(url.searchParams.get('timestamp')) / DAY; return { personalstats: [{ name: 'networth', value: day === today - 3 ? 1000 : day === today - 2 ? 400 : 500, timestamp: day * DAY }] }; }
    throw new Error('unexpected mock path');
  };
}

test('latest unrecovered qualifying decline supplies A, B, C and inclusive configurable A−B', () => {
  const result = analyzeFactionHistory(series([1000, 400, 180, 200]), meta, config({ minDifference: 0, maxDifference: 0 }));
  assert.equal(result.status, 'match'); assert.equal(result.dropDay, today - 1); assert.equal(result.A, 1); assert.equal(result.B, 1); assert.equal(result.C, 10); assert.equal(result.difference, 0);
  assert.equal(result.peakBefore, 1000); assert.equal(result.beforeValue, 400); assert.equal(result.dropValue, 180);
  assert.equal(analyzeFactionHistory(series([1000, 400, 500, 500]), { ...meta, daysInFaction: 0 }, FACTION_DEFAULTS).status, 'excluded');
  assert.equal(analyzeFactionHistory(series([1000, 400, 500, 500]), meta, config({ minDifference: -10, maxDifference: -1 })).status, 'excluded');
});

test('any subsequent recovery to the old peak invalidates that event, even if current networth is lower again', () => {
  assert.equal(analyzeFactionHistory(series([1000, 400, 1000, 950]), meta, FACTION_DEFAULTS).status, 'excluded');
  assert.equal(analyzeFactionHistory(series([1000, 400, 1100, 1000]), meta, FACTION_DEFAULTS).status, 'excluded');
  const newDrop = analyzeFactionHistory(series([1000, 400, 1000, 400]), meta, config({ minDifference: -10 }));
  assert.equal(newDrop.status, 'match'); assert.equal(newDrop.dropDay, today);
});

test('daily, peak and combined absolute amounts have separate semantics and inclusive thresholds', () => {
  const points = series([1000, 800, 600, 590]);
  assert.equal(analyzeFactionHistory(points, meta, config({ dropMode: 'daily', dailyDropAmount: 400 })).status, 'excluded');
  assert.equal(analyzeFactionHistory(points, meta, config({ dropMode: 'peak', peakDropAmount: 400, minDifference: -1 })).dropDay, today);
  assert.equal(analyzeFactionHistory(points, meta, config({ dropMode: 'both', dailyDropAmount: 200, peakDropAmount: 400 })).dropDay, today - 1);
  assert.equal(analyzeFactionHistory(series([-100, -300]), meta, config({ dailyDropAmount: 200, minDifference: -1 })).dailyAmount, 200);
});

test('missing or merged history and invalid identity times never become matches', () => {
  const points = series([1000, 400, 500]);
  assert.equal(analyzeFactionHistory([points[0], points[2]], meta, FACTION_DEFAULTS).status, 'unknown');
  assert.equal(analyzeFactionHistory(points.map(row => ({ ...row, timestamp: (today + 1) * DAY })), meta, FACTION_DEFAULTS).status, 'unknown');
  assert.equal(analyzeFactionHistory(points, { ...meta, lastAction: 0 }, FACTION_DEFAULTS).status, 'unknown');
  assert.equal(historicNetworth({ personalstats: [{ name: 'networth', value: 10, timestamp: (today - 1) * DAY }] }, today).timestamp, (today - 1) * DAY);
  assert.throws(() => historicNetworth({ personalstats: [{ name: 'networth', value: 10, timestamp: (today + 1) * DAY }] }, today), /晚于/);
  assert.throws(() => historicNetworth({ personalstats: [{ name: 'networth', value: '10', timestamp: today * DAY }] }, today));
});

test('configuration validates integer money amounts and signed difference bounds', () => {
  assert.equal(config({ minDifference: '-30', maxDifference: '0' }).minDifference, -30);
  assert.equal(config({ maxRespect: '', minDifference: '', maxDifference: '' }).maxRespect, null);
  assert.equal(config({ dailyDropAmount: '1234567890' }).dailyDropAmount, 1234567890);
  for (const patch of [{ minRespect: 200, maxRespect: 100 }, { dailyDropAmount: 0 }, { peakDropAmount: 1.5 }, { peakDropAmount: Number.MAX_SAFE_INTEGER + 1 }, { dailyDropAmount: ' ' }, { dailyDropPct: 50 }, { historyMode: 'bad' }, { batchSize: 500 }, { minDifference: 1, maxDifference: -1 }, { apiKey: 'bad' }]) assert.throws(() => config(patch));
});

test('one start automatically crosses faction batches after sorting all search pages', async t => {
  const store = fixture(t), calls = [], scanner = new FactionScanner({ uid: 'a', store, request: mockRequest(calls), now: () => today * DAY + 3600 });
  scanner.start(); await scanner.promise;
  assert.deepEqual(scanner.run.rows.map(row => row.id), [10, 20]); assert.equal(scanner.run.cursor, 2); assert.ok(scanner.run.rows.every(row => row.status === 'match'));
  assert.equal(scanner.run.factionBatch, 2); assert.equal(scanner.run.stage, '本次列表扫描完成'); assert.equal(scanner.running, false);
  const count = calls.length; scanner.start(); await scanner.promise; assert.equal(calls.length, count);
  assert.equal(calls.filter(path => path.includes('/search')).length, 1);
  assert.equal(store.get('a').run.rows[0].id, 10); assert.deepEqual(store.get('b').run.rows, []);
});

test('stop, process replacement and resume preserve completed daily cache without refetching the list', async t => {
  const store = fixture(t), calls = [], base = mockRequest(calls); let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const scanner = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, request: async path => {
    if (path.includes('timestamp=' + (today - 2) * DAY)) { entered(); await new Promise(resolve => { release = resolve; }); }
    return base(path);
  } });
  t.after(async () => { scanner.stop(); release?.(); await scanner.promise; });
  scanner.start(); await waiting; scanner.stop(); release(); await scanner.promise;
  assert.ok(store.point('a', 1010, today - 1)); assert.equal(scanner.run.cursor, 0);
  const resumed = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, request: base }); resumed.start(); await resumed.promise;
  assert.equal(resumed.run.rows[0].status, 'match'); assert.ok(resumed.run.cached >= 1);
  assert.equal(calls.filter(path => path.includes('user/1010/personalstats') && path.includes('timestamp=' + (today - 1) * DAY)).length, 1);
  assert.equal(calls.filter(path => path.includes('/search')).length, 1);
});

test('changed Leaders and future historical updates are unknown rather than invented results', async t => {
  const store = fixture(t), base = mockRequest();
  const scanner = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, request: async path => path.endsWith('/basic') ? { basic: { id: 10, leader_id: 999 } } : base(path) });
  scanner.start(); await scanner.promise; assert.equal(scanner.run.rows[0].status, 'unknown'); assert.match(scanner.run.rows[0].reason, /Leader 已变更/);
  store.save('a', { historyMode: 'window' });
  const bad = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, request: async path => path.includes('/personalstats') ? { personalstats: [{ name: 'networth', value: 100, timestamp: (today + 1) * DAY }] } : base(path) });
  bad.start(); await bad.promise; assert.equal(bad.run.rows[0].status, 'unknown'); assert.equal(store.point('a', 1010, today - 3), null);
});

test('unchanged historic stats can retain old update timestamps without inventing new declines', async t => {
  const store = fixture(t), base = mockRequest();
  const scanner = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, request: async path => {
    if (!path.includes('/personalstats')) return base(path);
    const day = Number(new URL(path, 'https://api.torn.com/v2/').searchParams.get('timestamp')) / DAY;
    return { personalstats: [{ name: 'networth', value: day < today - 2 ? 1000 : 400, timestamp: (day < today - 2 ? today - 1000 : today - 2) * DAY }] };
  } });
  scanner.start(); await scanner.promise;
  assert.equal(scanner.run.rows[0].status, 'match'); assert.equal(scanner.run.rows[0].dropDay, today - 2);
  assert.equal(store.point('a', 1010, today - 1).timestamp, (today - 2) * DAY);
  const points = series([1000, 400, 400]); points[2].timestamp = points[1].timestamp;
  assert.equal(analyzeFactionHistory(points, meta, config({})).dropDay, today - 1);
  points[2].value = 200; assert.equal(analyzeFactionHistory(points, meta, config({})).status, 'unknown');
});

test('legacy percentage configuration resets derived results while retaining keys, other settings and historic cache', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); const store = createFactionStore(db);
  store.save('legacy', { apiKey: key, maxRespect: 10000, minDifference: null });
  store.savePoint('legacy', 42, { day: today - 1, timestamp: (today - 5) * DAY, value: 100 });
  store.saveRun('legacy', { rows: [{ id: 42, respect: 100, status: 'match', dailyPct: 50 }] });
  const old = { ...FACTION_DEFAULTS, dailyDropPct: 50, peakDropPct: 60 }; delete old.dailyDropAmount; delete old.peakDropAmount;
  db.prepare('UPDATE torn_faction_scans SET config_json=? WHERE user_id=?').run(JSON.stringify({ ...old, apiKey: key, maxRespect: 10000, minDifference: null }), 'legacy');
  const migrated = store.get('legacy'); assert.equal(migrated.config.dailyDropAmount, 1000000000); assert.equal(migrated.config.apiKey, key); assert.equal(migrated.config.maxRespect, 10000); assert.equal(migrated.config.minDifference, null);
  assert.equal('dailyDropPct' in migrated.config, false); assert.deepEqual(migrated.run.rows, []); assert.ok(store.point('legacy', 42, today - 1));
  assert.equal(JSON.parse(db.prepare('SELECT config_json FROM torn_faction_scans WHERE user_id=?').get('legacy').config_json).dailyDropPct, undefined);
});

test('missing pagination cannot pretend that the first unsorted page is a globally sorted complete list', async t => {
  const store = fixture(t), scanner = new FactionScanner({ uid: 'a', store, now: () => today * DAY, request: async () => ({ search: [faction(10, 100)] }) });
  scanner.start(); await scanner.promise; assert.equal(scanner.run.listComplete, false); assert.match(scanner.run.error, /分页/); assert.equal(scanner.run.rows.length, 0);
});

test('API masks keys, checks view/config/control/CSRF and isolates results', async t => {
  const store = fixture(t), service = createFactionService({ store, request: mockRequest(), scannerOptions: { now: () => today * DAY + 3600 } });
  const view = ['torn-chain:view', 'torn-factions:view'];
  async function call(path, method = 'GET', permissions = view, body = {}, uid = 'a', headers = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { host: 'local', ...headers };
    let result; await service.handle(req, { setHeader() {} }, new URL('http://local/api/torn-factions/' + path), { userId: uid, permissions }, (_, status, data) => { result = { status, data }; }); return result;
  }
  const initial = await call('state'); assert.ok(!JSON.stringify(initial).includes(key)); assert.equal(initial.data.permissions.configure, false);
  assert.equal((await call('state', 'GET', ['torn-factions:view'])).status, 403);
  assert.equal((await call('start', 'POST')).status, 403);
  assert.equal((await call('config', 'POST', ['*'], { minDifference: -10 }, 'a', { origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('start', 'POST', ['*'])).status, 200); await service.scanners.get('a').promise;
  assert.equal((await call('state?filter=match')).data.total, 2);
  assert.equal((await call('state', 'GET', ['*'], {}, 'b')).data.total, 0);
  assert.equal((await call('reset', 'POST', ['*'])).status, 200); assert.equal((await call('state')).data.total, 0); assert.ok(store.point('a', 1010, today - 3));
});

test('networth automatically crosses sample batches and can pause while filling a long unchanged interval', async t => {
  const store = fixture(t), base = mockRequest(), calls = [];
  let pause = false, scanner;
  const saveRun = store.saveRun.bind(store);
  store.saveRun = (uid, run) => {
    saveRun(uid, run);
    const row = run.rows?.[0];
    if (pause && row?.loadedDays === 100) { pause = false; setImmediate(() => scanner.stop()); }
  };
  scanner = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, request: async path => {
    calls.push(path);
    if (path.endsWith('/profile')) { const data = await base(path); data.profile.signed_up = (today - 250) * DAY; return data; }
    if (path.includes('/personalstats')) return { personalstats: [{ name: 'networth', value: 1000, timestamp: (today - 300) * DAY }] };
    return base(path);
  } });
  pause = true; scanner.start(); await scanner.promise;
  assert.equal(scanner.run.cursor, 0); assert.equal(scanner.run.rows[0].loadedDays, 100); assert.equal(scanner.run.rows[0].status, 'waiting'); assert.match(scanner.run.stage, /已暂停/);
  assert.ok(store.point('a', 1010, today - 99));
  scanner.start(); await scanner.promise;
  assert.equal(scanner.run.cursor, 2); assert.equal(scanner.run.rows[0].loadedDays, 250); assert.equal(scanner.run.rows[0].historyBatch, 3);
  assert.equal(scanner.run.rows[1].historyBatch, 3); assert.ok(scanner.run.rows.every(row => row.status === 'excluded'));
  assert.equal(scanner.running, false); assert.equal(calls.filter(path => path.includes('/personalstats')).length, 3);
});

test('new tab permissions declare full hierarchy and personal data policy registration', () => {
  assert.equal(accessModules([]).find(row => row.id === 'torn-factions').kind, 'personal');
  for (const permission of SYSTEM_PERMISSIONS.filter(row => row.id.startsWith('torn-factions:'))) assert.deepEqual(permission.permissionPath.slice(0, 4), ['首页', 'Torn 工具箱', 'Chain 监控', '帮派筛选']);
  assert.equal(canFactionScan({ userId: 'a', permissions: ['*'], isGuest: true }), false);
  assert.equal(canFactionScan({ userId: 'a', permissions: ['*'], dataAccess: { permissions: ['torn-chain:view', 'torn-factions:view'] } }, 'control:edit'), false);
});

test('multiple search pages are sorted together and off-origin continuation is rejected', async t => {
  const store = fixture(t), base = mockRequest(), calls = [];
  const scanner = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, request: async path => {
    calls.push(path);
    if (path.includes('/search')) {
      if (path.includes('offset=100')) return { search: [faction(10, 100)], _metadata: { links: { next: null } } };
      return { search: [faction(20, 500)], _metadata: { links: { next: 'https://api.torn.com/v2/faction/search?limit=100&filters=notDestroyed,respect:&gt;=:0&offset=100' } } };
    }
    return base(path);
  } });
  scanner.start(); await scanner.promise; assert.equal(scanner.run.rows[0].id, 10); assert.equal(calls.filter(path => path.includes('/search')).length, 2);
  assert.equal(new URL(calls[1], 'https://api.torn.com/v2/').searchParams.get('filters'), 'notDestroyed,respect:>=:0');
  store.save('a', {});
  let external = false;
  const bad = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, request: async path => { if (path.includes('evil.test')) external = true; return { search: [], _metadata: { links: { next: 'https://evil.test/v2/faction/search' } } }; } });
  bad.start(); await bad.promise; assert.equal(external, false); assert.match(bad.run.error, /分页地址无效/);
});

test('revoked authorization stops the batch before another request and keeps an incomplete row resumable', async t => {
  const store = fixture(t), base = mockRequest(); let allowed = true, count = 0;
  const scanner = new FactionScanner({ uid: 'a', store, now: () => today * DAY + 3600, authorize: () => allowed, request: async path => { count++; const data = await base(path); if (path.endsWith('/profile')) allowed = false; return data; } });
  scanner.start(); await scanner.promise; assert.equal(count, 3); assert.equal(scanner.run.cursor, 0); assert.equal(scanner.run.rows[0].status, 'waiting'); assert.match(scanner.run.error, /权限/);
});
