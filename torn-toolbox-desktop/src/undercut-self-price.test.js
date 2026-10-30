import test from 'node:test';
import assert from 'node:assert/strict';
import { marketLowestCompetitor } from './torn-api.js';
import { UndercutMonitor } from './undercut-monitor.js';
const own = (id, price, amount = 5, uid = null) => ({ id, item: { id: 100, name: 'Poison Mistletoe', uid }, price, amount });
test('anonymous price aggregates subtract all own lots and never classify own cheaper lot as competitor', () => {
  assert.equal(marketLowestCompetitor([{ price: 100, amount: 5 }, { price: 200, amount: 3 }], [own(1, 100), own(2, 200, 3)]), null);
  const low = marketLowestCompetitor([{ price: 100, amount: 8 }, { price: 200, amount: 3 }], [own(1, 100), own(2, 200, 3)]);
  assert.equal(low.price, 100); assert.equal(low.quantity, 3); assert.deepEqual(low.coveredOwnListings, ['1', '2']);
  assert.equal(marketLowestCompetitor([{ price: 100, amount: 3 }, { price: 100, amount: 5 }], [own(1, 100)]).quantity, 3, 'subtract own budget once across same-price rows');
});
test('unique item UID excludes own listing even after price changes; unknown/invalid rows cannot create bogus zero prices', () => {
  const low = marketLowestCompetitor([{ price: 100, amount: 1, item_details: { uid: 777 } }, { price: 150, amount: 1, item_details: { uid: 888 } }], [own(1, 200, 1, 777)]);
  assert.equal(low.price, 150); assert.deepEqual(low.coveredOwnListings, [], 'public own price disagrees with own snapshot');
  assert.equal(marketLowestCompetitor([{ price: 100 }], [own(1, 100)]), null);
  assert.equal(marketLowestCompetitor([{ price: 0, amount: 1 }, { price: Infinity, amount: 1 }, { price: 5, amount: -1 }]), null);
});
function fixture(t) {
  let now = 1000, ownRows = [own(1, 200)], rows = [{ price: 100, amount: 7 }, { price: 200, amount: 5 }], cacheAt = 1000, cacheDelay = 30;
  const messages = [], requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url); requests.push(u.pathname);
    if (u.pathname === '/api/business-events') { messages.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; }
    let data;
    if (u.pathname === '/v2/user/itemmarket') data = { itemmarket: ownRows };
    else if (u.pathname === '/v2/market/100/itemmarket') data = { itemmarket: { listings: rows, cache_timestamp: cacheAt, cache_delay: cacheDelay } };
    else throw Error('Unexpected test request: ' + u.pathname);
    return { ok: true, json: async () => data };
  });
  const watcher = { id: 'a', label: 'Account', apiKey: '1234567890abcdef', watchItemMarket: true, watchBazaar: false };
  const config = { undercut: { watchers: [watcher] }, notify: { qq: { url: 'http://127.0.0.1:8787', token: 'fixture' } } };
  const monitor = new UndercutMonitor(() => config, { now: () => now });
  return { monitor, messages, requests, scan: () => monitor.scanWatcher(config, watcher), set: values => { now = values.now ?? now; ownRows = values.ownRows ?? ownRows; rows = values.rows ?? rows; cacheAt = 'cacheAt' in values ? values.cacheAt : cacheAt; cacheDelay = values.cacheDelay ?? cacheDelay; } };
}
test('self repricing mismatch waits even beyond the minimum delay and clears when own cache catches up', async t => {
  const f = fixture(t); f.set({ ownRows: [own(1, 86883333)], rows: [{ price: 84999995, amount: 5 }] });
  await f.scan(); assert.equal(f.messages.length, 0);
  f.set({ now: 1120, cacheAt: 1120 }); await f.scan(); assert.equal(f.messages.length, 0, 'stale own price absent from public snapshot is not confirmed');
  f.set({ ownRows: [own(1, 84999995)], now: 1180, cacheAt: 1180 }); await f.scan();
  assert.equal(f.messages.length, 0); assert.equal(f.monitor.ensureWatcherState('a').pendingMarket.size, 0); assert.equal(f.monitor.getAllAlerts().length, 0);
});
test('genuine lower competitor requires a newer cached snapshot and stays deduplicated afterwards', async t => {
  const f = fixture(t); await f.scan(); assert.equal(f.messages.length, 0);
  f.set({ now: 1061 }); await f.scan(); assert.equal(f.messages.length, 0, 'same cache is not a second observation');
  f.set({ now: 1062, cacheAt: 1062 }); await f.scan(); assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].message, /7 件/); assert.equal(f.monitor.getAllAlerts()[0].myPrice, 200);
  f.set({ now: 1125, cacheAt: 1125 }); await f.scan(); assert.equal(f.messages.length, 1);
});
test('own price changes restart confirmation; latest own price is used when a real competitor persists', async t => {
  const f = fixture(t); await f.scan();
  f.set({ now: 1060, cacheAt: 1060, ownRows: [own(1, 150)], rows: [{ price: 100, amount: 7 }, { price: 150, amount: 5 }] }); await f.scan(); assert.equal(f.messages.length, 0);
  f.set({ now: 1120, cacheAt: 1120 }); await f.scan(); assert.equal(f.messages.length, 1); assert.equal(f.monitor.getAllAlerts()[0].myPrice, 150);
});
test('all own price tiers are reconciled together and only remaining competitor quantity is reported', async t => {
  const f = fixture(t); f.set({ ownRows: [own(1, 200, 3), own(2, 100)], rows: [{ price: 100, amount: 5 }, { price: 200, amount: 3 }] });
  await f.scan(); assert.equal(f.messages.length, 0); assert.equal(f.requests.filter(p => p.includes('/market/')).length, 1, 'shared item cache is reconciled once');
  f.set({ now: 1060, cacheAt: 1060, rows: [{ price: 100, amount: 8 }, { price: 200, amount: 3 }] }); await f.scan(); assert.equal(f.messages.length, 0);
  f.set({ now: 1120, cacheAt: 1120 }); await f.scan(); assert.equal(f.messages.length, 1); assert.equal(f.monitor.getAllAlerts()[0].undercutQuantity, 3);
});


test('missing market cache timestamps are not accepted as confirmation; valid cache metadata starts a fresh wait', async t => {
  const f = fixture(t); f.set({cacheAt:null}); await f.scan();f.set({now:1120});await f.scan();assert.equal(f.messages.length,0);
  f.set({now:1180,cacheAt:1180});await f.scan();assert.equal(f.messages.length,0);
  f.set({now:1240,cacheAt:1240});await f.scan();assert.equal(f.messages.length,1);
});
