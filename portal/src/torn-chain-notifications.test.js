import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { ChainMonitor, createChainStore } from './torn-chain-monitor.js';
import { createTornChainService } from './torn-chain.js';
import { chainNotifySettings, createChainNotifier } from './torn-chain-notifications.js';

const settings = () => ({ qq: { enabled: true }, slack: { enabled: true }, targets: [{ id: 'x', type: 'group', groupId: '123456', atUserId: '654321' }] });
function fixture(t) { const db = new Database(':memory:'); t.after(() => db.close()); return createChainStore(db); }

test('notification settings are isolated, opt-in and validate recipients', t => {
  const store = fixture(t);
  assert.equal(store.getNotify('a').qq.enabled, false);
  store.saveNotify('a', settings()); assert.equal(store.getNotify('a').targets[0].groupId, '123456');
  assert.equal(store.getNotify('b').targets.length, 0);
  assert.throws(() => chainNotifySettings({ ...settings(), targets: [] }), /通知目标/);
  assert.throws(() => chainNotifySettings({ ...settings(), targets: [{ type: 'group', groupId: '<x>' }] }), /QQ/);
  assert.throws(() => chainNotifySettings({ ...settings(), qq: { enabled: 'yes' } }));
  const mixed = chainNotifySettings({ ...settings(), targets: [{ type: 'group', groupId: '123456', atUserId: '12345678,23456789；34567890 12345678' }] });
  assert.equal(mixed.targets[0].atUserId, '12345678,23456789,34567890');
});

test('notifier uses authenticated delivery channels, fixed report link and sanitizes failures', async () => {
  const calls = [];
  const send = createChainNotifier({ endpoint: 'http://127.0.0.1:8787', token: 'private-token', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options, data: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true }) };
  } });
  await send(settings(), { id: 123, name: 'Example', hits: 250 });
  assert.equal(calls.length, 2); assert.equal(calls[0].headers.Authorization, 'Bearer private-token');
  assert.equal(calls[0].data.channel, 'qq'); assert.equal(calls[0].data.groupId, '123456');
  assert.equal(calls[1].data.channel, 'slack'); assert.match(calls[1].data.message, /chainID=123$/);
  assert.ok(!calls[1].data.message.includes('private-token'));
  await send({ qq: { enabled: false }, slack: { enabled: false } }, null); assert.equal(calls.length, 2);
  await assert.rejects(createChainNotifier({ endpoint: 'https://evil.test', token: 'secret' })(settings(), null), /认证/);
  await assert.rejects(createChainNotifier({ endpoint: 'http://localhost:8787', token: 'secret', fetchImpl: async () => { throw new Error('secret'); } })(settings(), null), error => !error.message.includes('secret') && error.message.includes('不自动重试'));
});

test('first discoveries and observed transitions notify once; delivery failure preserves records and dedup', async t => {
  const store = fixture(t); store.save('a', { apiKey: '1234567890abcdef' });
  let phase = 0, sent = 0;
  const monitor = new ChainMonitor({ uid: 'a', store, now: () => 1000, schedule: () => 1, cancel: () => {}, notify: async row => { sent++; assert.ok([1, 2].includes(row.id)); throw new Error('delivery failed'); }, request: async path => path.includes('warfarechains') ? { warfarechains: [1, 2].map(id => ({ id, faction: { id } })) } : { chain: { id: Number(path.split('/')[1]), current: 200, timeout: 300, cooldown: Number(path.split('/')[1]) === 2 || phase ? 2000 : 0 } } });
  monitor.start(); await monitor.promise; assert.equal(sent, 1);
  assert.equal(store.get('a').history[0].fresh, false);
  phase = 1; await monitor.scan(); assert.equal(sent, 2); assert.equal(store.get('a').history.length, 2);
  assert.match(monitor.status().notificationError, /通知/);
  await monitor.scan(); assert.equal(sent, 2); monitor.stop();
  store.clear('a'); monitor.start(); await monitor.promise;
  assert.equal(sent, 2); assert.ok(store.get('a').history.every(row => !row.notifyEligible)); monitor.stop();
});

test('notification API uses separate view/save/test permissions and saved settings', async t => {
  const store = fixture(t), deliveries = [];
  const service = createTornChainService({ store, Monitor: ChainMonitor, sendNotification: async (config, row) => { deliveries.push({ config, row }); return { sent: 1 }; } });
  const base = ['torn-chain:view', 'torn-chain:notify:view'];
  async function call(method, suffix = '', permissions = base, body = settings(), headers = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { host: 'localhost', ...headers };
    let result; await service.handle(req, { setHeader() {} }, new URL('http://localhost/api/torn-chain/notifications' + suffix), { userId: 'a', permissions }, (_, status, data) => { result = { status, data }; }); return result;
  }
  assert.equal((await call('GET', '', ['torn-chain:view'])).status, 403);
  assert.equal((await call('GET')).data.permissions.save, false);
  assert.equal((await call('PUT')).status, 403);
  assert.equal((await call('PUT', '', ['*'], settings(), { origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('PUT', '', [...base, 'torn-chain:notify:edit'])).status, 200);
  assert.equal((await call('POST', '/test')).status, 403);
  assert.equal((await call('POST', '/test', [...base, 'torn-chain:notify:test:edit'], { targets: ['ignored'] })).status, 200);
  assert.equal(deliveries[0].config.targets[0].groupId, '123456'); assert.equal(deliveries[0].row, null);
});

test('background notification permission revocation suppresses delivery', async t => {
  const store = fixture(t); store.save('a', { apiKey: '1234567890abcdef' }); store.saveNotify('a', settings());
  let phase = 0, sent = 0;
  const service = createTornChainService({ store, Monitor: ChainMonitor, authorizeNotify: () => false, sendNotification: async () => { sent++; }, monitorOptions: { now: () => 1000, schedule: () => 1, cancel: () => {} }, request: async path => path.includes('warfarechains') ? { warfarechains: [{ id: 1, faction: { id: 1 } }] } : { chain: { id: 1, current: 200, timeout: 300, cooldown: phase ? 2000 : 0 } } });
  let result; const req = Readable.from([]); req.method = 'POST'; req.headers = {};
  await service.handle(req, { setHeader() {} }, new URL('http://local/api/torn-chain/start'), { userId: 'a', permissions: ['*'] }, (_, status) => { result = status; }); assert.equal(result, 200);
  const m = service.monitors.get('a'); await m.promise; phase = 1; await m.scan(); assert.equal(sent, 0); assert.equal(store.get('a').history[0].fresh, true); m.stop();
});

test('notification management Chain card saves targets and tests saved configuration through Portal', async () => {
  const dom = new JSDOM('<div id="chain-notifications" hidden></div><button id="business-refresh"></button>', { runScripts: 'outside-only', url: 'https://test/notifications/' });
  const w = dom.window, host = w.document.getElementById('chain-notifications'), calls = [];
  const until = async check => { for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  let writable = true;
  w.toast = () => {};
  w.fetch = async (url, options) => {
    calls.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, settings: options.body ? JSON.parse(options.body) : settings(), permissions: { save: writable, test: writable } }) };
  };
  try {
    w.eval(fs.readFileSync(new URL('../../qq-bot/public/qq-targets.js', import.meta.url), 'utf8'));
    w.eval(fs.readFileSync(new URL('../../qq-bot/public/chain-notifications.js', import.meta.url), 'utf8'));
    await until(() => !host.hidden);
    host.querySelector('[data-action="add-target"]').click(); assert.equal(host.querySelectorAll('.biz-target').length, 2);
    host.querySelectorAll('[data-action="remove-target"]')[1].click();
    host.querySelector('[data-field="groupId"]').value = '987654';
    host.querySelector('[data-action="chain-save"]').click(); await until(() => calls.some(row => row.method === 'PUT'));
    assert.equal(JSON.parse(calls.find(row => row.method === 'PUT').body).targets[0].groupId, '987654');
    await until(() => !host.querySelector('[data-action="chain-save"]').disabled);
    host.querySelector('[data-action="chain-test"]').click(); await until(() => calls.some(row => row.method === 'POST'));
    assert.equal(calls.find(row => row.method === 'POST').body, undefined);
    writable = false; w.document.getElementById('business-refresh').click(); await until(() => host.querySelector('input').disabled);
    assert.equal(host.querySelector('[data-action="chain-test"]').disabled, true);
  } finally { w.close(); }
});
