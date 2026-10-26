import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createWatchdogStore, startLoginWatchdog, loginAlertChannels } from './watchdog.js';
const require = createRequire(import.meta.url);
const Database = require('../../portal/node_modules/better-sqlite3');

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = createWatchdogStore(db);
  let clock = 1000000, online = false, reachable = true, restarts = 0, failSlack = false;
  const sent = [];
  const config = { napcat: { baseUrl: 'http://localhost', watchdog: { enabled: true, failBeforeRestart: 2, settleMs: 45000, cooldownMs: 600000 } }, channels: {
    slack: { enabled: true, webhookUrl: 'secret' }, email: { enabled: true, smtp: { host: 'smtp.test', user: 'sender' }, to: 'receiver' }
  } };
  const create = () => startLoginWatchdog(() => config, { schedule: false, store, now: () => clock,
    getStatus: async () => { if (!reachable) throw new Error('secret'); return { data: { online, good: true } }; },
    restart: async () => { restarts++; },
    send: async (channel, message) => { if (channel === 'slack' && failSlack) throw new Error('secret'); sent.push({ channel, message }); }
  });
  return { create, config, store, sent, online: value => { online = value; }, reachable: value => { reachable = value; }, failSlack: value => { failSlack = value; }, advance: ms => { clock += ms; }, restarts: () => restarts };
}

test('online false good true alerts independently, deduplicates across restart, and reports recovery once', async t => {
  const f = fixture(t), w = f.create();
  await w.tick(); assert.equal(f.sent.length, 0); assert.equal(w.status().online, false); assert.equal(w.status().reachable, true);
  await w.tick(); assert.equal(f.restarts(), 1); assert.equal(f.sent.length, 2);
  await f.create().tick(); assert.equal(f.sent.length, 2); assert.equal(f.restarts(), 1);
  f.advance(60000); await w.tick(); f.advance(60000); await w.tick();
  assert.equal(f.sent.length, 4); assert.match(f.sent[2].message, /自动恢复失败/);
  assert.equal(f.restarts(), 1);
  f.online(true); await w.tick(); await f.create().tick();
  assert.equal(f.sent.length, 6); assert.match(f.sent[4].message, /恢复在线/);
  assert.equal(f.store.read().events.length, 3);
});

test('unreachable API triggers recovery and email still works when Slack fails; retries only failed channel', async t => {
  const f = fixture(t); f.reachable(false); f.failSlack(true);
  const w = f.create(); await w.tick(); await w.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].channel, 'email');
  assert.equal(f.restarts(), 1); assert.equal(w.status().reachable, false);
  assert.ok(!JSON.stringify(w.status()).includes('secret'));
  f.failSlack(false); f.advance(300001); await f.create().tick();
  assert.equal(f.sent.filter(e => e.message.includes('掉线告警')).length, 2);
  assert.equal(f.sent.filter(e => e.channel === 'email' && e.message.includes('掉线告警')).length, 1);
});

test('restart failures produce one failure alert and obey cooldown; disabled or incomplete channels are never sent', async t => {
  const f = fixture(t); f.config.channels.email.enabled = false; f.config.channels.slack.webhookUrl = '';
  const w = startLoginWatchdog(f.config, { schedule: false, store: f.store, now: () => 1000000,
    getStatus: async () => ({ data: { online: false } }), restart: async () => { throw new Error('secret'); },
    send: async () => { throw new Error('should not send'); } });
  await w.tick(); await w.tick(); await w.tick();
  assert.equal(f.store.read().events.length, 2); assert.match(w.status().lastError, /重启失败/);
  assert.ok(loginAlertChannels(f.config).every(c => !c.ready));
});

test('recovered incidents do not deliver stale alarms when a channel is enabled later', async t => {
  const f = fixture(t); f.config.channels.email.enabled = false; f.failSlack(true);
  const w = f.create(); await w.tick(); await w.tick(); f.advance(60000); f.online(true); f.failSlack(false);
  await w.tick(); assert.equal(f.sent.length, 1); assert.match(f.sent[0].message, /恢复在线/);
  f.config.channels.email.enabled = true; f.advance(300001); await w.tick();
  assert.equal(f.sent.length, 2); assert.match(f.sent[1].message, /恢复在线/);
});
