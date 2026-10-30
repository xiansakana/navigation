import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { UsersMonitor, createUsersStore, usersConfig } from './torn-users-monitor.js';
import { createTornUsersService } from './torn-users.js';
import { createChainNotifier } from './torn-chain-notifications.js';
import { resolveRoute } from './router.js';
import { SYSTEM_PERMISSIONS } from './rbac.js';
import { TORN_WORKER_MODULES } from './torn-worker-transport.js';
const key = 'a'.repeat(16);
const settings = { qq: { enabled: true }, slack: { enabled: false }, targets: [{ type: 'private', userId: '123456', groupId: '', atUserId: '' }] };
const profile = (id, until, state = 'Hospital') => ({ profile: { id, name: '<Target ' + id + '>', status: { state, until } } });
function fixture(t) { const db = new Database(':memory:'); t.after(() => db.close()); return createUsersStore(db); }
function monitor(t, input = {}) {
  const store = fixture(t); store.save('a', { apiKey: key, targets: [1, 2], ...input });
  let now = 1000, responses = new Map([[1, profile(1, 1120)], [2, profile(2, 0, 'Okay')]]), schedule;
  const sent = [], calls = [];
  const request = async (path, _key, _signal, policy) => { calls.push({ path, policy }); const data = responses.get(Number(path.split('/')[1])); if (data instanceof Error) throw data; return data; };
  const job = new UsersMonitor({ uid: 'a', store, request, now: () => now, schedule: (fn, ms) => { schedule = { fn, ms }; return { unref() {} }; }, cancel() {}, notify: async row => { sent.push(row); return { sent: 1 }; } });
  t.after(() => job.stop());
  return { store, job, sent, calls, setNow: value => { now = value; }, response: (id, data) => responses.set(id, data), scheduled: () => schedule };
}
test('users config accepts profiles and multiple keys; validates ranges/IDs and keeps secrets on partial saves', () => {
  const config = usersConfig({ apiKey: key, targets: '1\nhttps://www.torn.com/profiles.php?XID=2' });
  assert.equal(config.leadMinutes, 1); assert.deepEqual(config.targets, [{ id: 1 }, { id: 2 }]);
  assert.equal(usersConfig({ leadMinutes: 2 }, config).apiKey, key);
  for (const input of [{ targets: [1, 1] }, { targets: ['https://evil.test/profiles.php?XID=2'] }, { leadMinutes: 0 }, { leadMinutes: 1441 }, { intervalSeconds: 4 }, { apiIntervalSeconds: 0 }, { apiKeys: ['bad'] }]) assert.throws(() => usersConfig(input));
});
test('hospital reminders fire on boundary, once per user/deadline, persist across restarts and history clearing', async t => {
  const f = monitor(t); f.job.start(); await f.job.promise; assert.equal(f.sent.length, 0); assert.equal(f.scheduled().ms, 15000);
  f.setNow(1058); await f.job.scan(); assert.equal(f.scheduled().ms, 2000, 'known reminder is checked before ordinary next round');
  f.setNow(1060); await f.job.scan(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].remainingSeconds, 60); assert.equal(f.sent[0].link, 'https://www.torn.com/profiles.php?XID=1');
  assert.equal(f.calls[0].policy.scope, 'users:a');
  f.store.clear('a'); await f.job.scan(); assert.equal(f.sent.length, 1, 'clear does not clear dedup');
  f.job.stop(); f.job.start(); await f.job.promise; assert.equal(f.sent.length, 1, 'restart preserves dedup');
  f.response(1, profile(1, 1300)); await f.job.scan(); assert.equal(f.sent.length, 1, 'extension recomputes reminder');
  f.setNow(1240); await f.job.scan(); assert.equal(f.sent.length, 2);
  f.response(1, profile(1, 0, 'Okay')); await f.job.scan(); assert.equal(f.sent.length, 2); assert.equal(f.job.status().rows[0].hospitalUntil, null);
});
test('first discovery inside window alerts; expired/malformed/failed responses never generate discharge assumptions', async t => {
  const f = monitor(t); f.response(1, profile(1, 1030)); f.response(2, profile(2, 1000)); f.job.start(); await f.job.promise; assert.equal(f.sent.length, 1);
  f.response(1, new Error('network ' + key)); f.response(2, profile(99, 1030)); await f.job.scan(); assert.equal(f.sent.length, 1); assert.ok(f.job.status().rows.every(row => row.status === 'unknown')); assert.ok(!JSON.stringify(f.job.status()).includes(key));
  f.response(1, profile(1, 0)); await f.job.scan(); assert.equal(f.sent.length, 1);
});
test('notifications are isolated, failed delivery is visible without replay; one user cannot consume another user dedup', async t => {
  const f = monitor(t); f.response(1, profile(1, 1020)); f.job.notify = async () => { throw Error('offline'); }; f.job.start(); await f.job.promise;
  assert.equal(f.store.get('a').history[0].notification, 'failed'); assert.match(f.job.status().notificationError, /通知失败/);
  assert.equal(f.store.get('b').history.length, 0); assert.equal(f.store.record('b', f.store.get('a').history[0]), true);
  await f.job.scan(); assert.equal(f.store.get('a').history.length, 1);
  f.store.saveNotify('a', settings); assert.equal(f.store.getNotify('b').qq.enabled, false);
});
test('user monitor automatically retries network/limited rounds and stop aborts future scans', async t => {
  const f = monitor(t); f.job.prepareKeys = async () => { throw Object.assign(new Error('retry exhausted'), { fatal: true }); }; f.job.start(); await f.job.promise;
  assert.equal(f.job.status().running, true); assert.ok(f.scheduled()); f.job.stop(); assert.equal(f.job.status().nextScanAt, null);
});
async function request(service, method, path, session, body, origin = 'http://test') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { host: 'test', origin };
  let result; await service.handle(req, { setHeader() {} }, new URL('http://test/api/torn-users/' + path), session, (_r, status, data) => { result = { status, data }; }); return result;
}
test('users API enforces view/config/control/notification permissions, guest read-only and key redaction', async t => {
  const store = fixture(t); store.save('a', { apiKey: key, targets: [1] }); const service = createTornUsersService({ store });
  const viewer = { userId: 'a', permissions: ['torn-users:view'] }, admin = { userId: 'a', permissions: ['*'] };
  assert.equal((await request(service, 'GET', 'state', { userId: 'b', permissions: [] })).status, 403);
  const state = await request(service, 'GET', 'state', viewer); assert.equal(state.status, 200); assert.ok(!JSON.stringify(state).includes(key)); assert.equal(state.data.permissions.configure, false);
  for (const [method, path, body] of [['POST', 'config', {}], ['POST', 'start', {}], ['POST', 'stop', {}], ['DELETE', 'history'], ['PUT', 'notifications', settings], ['POST', 'notifications/test', {}]]) assert.equal((await request(service, method, path, viewer, body)).status, 403);
  assert.equal((await request(service, 'GET', 'notifications', viewer)).status, 403);
  assert.equal((await request(service, 'POST', 'config', { ...admin, isGuest: true }, {})).status, 403);
  assert.equal((await request(service, 'POST', 'config', admin, { leadMinutes: 2 }, 'https://evil.test')).status, 403);
  assert.equal((await request(service, 'POST', 'config', admin, { leadMinutes: 2 })).status, 200);
  assert.equal((await request(service, 'GET', 'notifications', admin)).data.settings.qq.enabled, false);
  assert.equal((await request(service, 'PUT', 'notifications', admin, settings)).status, 200);
  assert.equal((await request(service, 'GET', 'state', { ...admin, userId: 'b' })).data.config.keyCount, 0);
  assert.ok(TORN_WORKER_MODULES.includes('torn-users')); assert.ok(SYSTEM_PERMISSIONS.some(row => row.id === 'torn-users:notify:test:edit' && row.permissionPath.includes('通知管理')));
  assert.equal(resolveRoute([], '/api/torn-users/state', 'GET').kind, 'portal-api');
});
test('QQ user alert includes player link/deadline, tests saved central settings; disabled channels never send', async () => {
  const bodies = []; const notify = createChainNotifier({ endpoint: 'http://127.0.0.1:8787', token: 'test', fetchImpl: async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; } });
  const row = { kind: 'user-hospital', id: 123, name: 'Target', hospitalUntil: 2000, detectedAt: 1940, remainingSeconds: 60, leadMinutes: 1, link: 'https://www.torn.com/profiles.php?XID=123' };
  await notify(settings, row); assert.equal(bodies.length, 1); assert.match(bodies[0].message, /剩余 60 秒/); assert.match(bodies[0].message, /profiles.php\?XID=123/); assert.doesNotMatch(bodies[0].message, /Bonus|Chain/);
  await notify({ ...settings, qq: { enabled: false } }, row); assert.equal(bodies.length, 1);
});
const until = async check => { const end = Date.now() + 2000; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
test('users tab renders safely, preserves dirty form, paginates and remains read-only for viewers', async () => {
  const dom = new JSDOM(fs.readFileSync(new URL('../public/torn-toolbox/chain/index.html', import.meta.url), 'utf8'), { runScripts: 'outside-only', url: 'https://test/torn-toolbox/chain/#users' });
  const w = dom.window, data = { ok: true, config: { ...usersConfig({ targets: [1] }), keyCount: 1 }, permissions: { configure: false, control: false, clear: false }, state: { rows: [{ id: 1, name: '<img src=x onerror=alert(1)>', status: 'Hospital', hospitalUntil: 2000, reminderAt: 1940, checkedAt: 1000 }], serverNow: 1000, running: true, rounds: 1 }, history: Array.from({ length: 21 }, (_, i) => ({ id: i + 1, name: 'User', hospitalUntil: 2000, detectedAt: 1940, remainingSeconds: 60, notification: 'disabled' })) };
  const calls = []; w.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => structuredClone(data) }; };
  try {
    w.eval(fs.readFileSync(new URL('../public/torn-toolbox/chain/users.js', import.meta.url), 'utf8')); await until(() => !w.document.getElementById('users-view').hidden);
    assert.equal(w.document.querySelectorAll('#users-rows img').length, 0); assert.equal(w.document.getElementById('users-targets').disabled, true); assert.equal(w.document.getElementById('users-start').hidden, true);
    assert.equal(w.document.querySelectorAll('#users-history article').length, 20); w.document.getElementById('users-next').click(); assert.equal(w.document.querySelectorAll('#users-history article').length, 1);
    assert.ok(calls.every(row => row.options.method === 'GET'));
  } finally { w.close(); }
});
