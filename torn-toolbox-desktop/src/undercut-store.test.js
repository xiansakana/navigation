import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createUndercutStore } from './undercut-store.js';
import { UndercutMonitor } from './undercut-monitor.js';
const require = createRequire(import.meta.url), Database = require('../../portal/node_modules/better-sqlite3');

test('undercut restart preserves active alerts and invalidates snapshot on watcher key changes', () => {
  const db = new Database(':memory:'), store = createUndercutStore(db), watcher = { id: 'a', apiKey: '1234567890abcdef', enabled: true };
  try {
    store.save(watcher, { activeKeys: new Set(['market:1']), alertMap: new Map([['market:1', { key: 'market:1' }]]) });
    const monitor = new UndercutMonitor(() => ({ undercut: { watchers: [watcher] } }), { store });
    assert.ok(monitor.ensureWatcherState('a').activeKeys.has('market:1'));
    assert.equal(monitor.getAllAlerts().length, 1);
    assert.equal(store.load({ ...watcher, apiKey: 'different-key' }), null);
    assert.equal(store.load({ ...watcher, id: 'b' }), null);
    assert.ok(!db.prepare('SELECT snapshot,key_hash FROM torn_undercut_runtime').get().key_hash.includes(watcher.apiKey));
  } finally { db.close(); }
});

test('undercut prevents overlapping scan rounds and releases the guard on failure', async () => {
  const monitor = new UndercutMonitor(() => ({})); let release, calls = 0;
  monitor.scanOnce = async () => { calls++; await new Promise(resolve => { release = resolve; }); };
  const pending = monitor.runOnce(); await monitor.runOnce(); assert.equal(calls, 1);
  release(); await pending; assert.equal(monitor.checking, false);
  monitor.scanOnce = async () => { throw Error('failed'); };
  await assert.rejects(monitor.runOnce(), /failed/); assert.equal(monitor.checking, false);
});
