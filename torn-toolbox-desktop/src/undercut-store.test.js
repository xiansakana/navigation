import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createUndercutStore } from './undercut-store.js';
import { UndercutMonitor } from './undercut-monitor.js';
const require = createRequire(import.meta.url), Database = require('../../portal/node_modules/better-sqlite3');

test('undercut restart preserves active alerts and invalidates snapshot on watcher key changes', () => {
  const db = new Database(':memory:'), store = createUndercutStore(db), watcher = { id: 'a', apiKey: '1234567890abcdef', enabled: true };
  try {
    store.save(watcher, { activeKeys: new Set(['market:1']), alertMap: new Map([['market:1', { key: 'market:1' }]]), pendingMarket:new Map([['im-2',{signature:'test',firstSeenAt:1000,marketCacheAt:1000}]]) });
    const monitor = new UndercutMonitor(() => ({ undercut: { watchers: [watcher] } }), { store });
    assert.ok(monitor.ensureWatcherState('a').activeKeys.has('market:1'));
    assert.equal(monitor.getAllAlerts().length, 1);
    assert.equal(monitor.ensureWatcherState('a').pendingMarket.get('im-2').firstSeenAt,1000);
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


test('same Bazaar alert stays deduplicated after a missing result and restart', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = createUndercutStore(db);
  const watcher = { id: 'a', label: 'Account', apiKey: 'test', watchBazaar: true, watchItemMarket: false };
  const config = { undercut: { watchers: [watcher] }, notify: { qq: { url: 'http://127.0.0.1:8787/notify', token: 'test' } } };
  let now = 1000, price = 100;
  let ownListings = [{ id: 101, price: 200 }];
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const pathname = new URL(address).pathname;
    if (pathname === '/api/business-events') messages.push(JSON.parse(options.body).message);
    const data = pathname.endsWith('/basic') ? { player_id: 1 }
      : pathname.endsWith('/bazaar') ? { bazaar: { items: ownListings } }
      : pathname.endsWith('/101') ? { listings: price ? [{ player_id: 2, price, quantity: 8 }] : [] }
      : { ok: true };
    return { ok: true, json: async () => data };
  });
  const create = () => new UndercutMonitor(() => config, { store, now: () => now });
  let monitor = create();
  await monitor.scanWatcher(config, watcher);
  assert.equal(messages.length, 1);
  price = 0;
  now += 60;
  await monitor.scanWatcher(config, watcher);
  assert.equal(monitor.getAllAlerts().length, 0);
  ownListings = [];
  await monitor.scanWatcher(config, watcher);
  monitor = create();
  ownListings = [{ id: 101, price: 200 }];
  price = 100;
  await monitor.scanWatcher(config, watcher);
  assert.equal(monitor.getAllAlerts().length, 1);
  assert.equal(messages.length, 1);

  price = 0;
  await monitor.scanWatcher(config, watcher);
  price = 90;
  await monitor.scanWatcher(config, watcher);
  assert.equal(messages.length, 2, 'different competing price can alert after recovery');
  price = 0;
  await monitor.scanWatcher(config, watcher);
  price = 100;
  now += 6 * 3600;
  await monitor.scanWatcher(config, watcher);
  assert.equal(messages.length, 3, 'an identical recurrence after the window may alert');
});
