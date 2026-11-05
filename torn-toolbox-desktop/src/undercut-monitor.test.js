import test from 'node:test';
import assert from 'node:assert/strict';
import { UndercutMonitor } from './undercut-monitor.js';
import { fetchUserItemMarket } from './torn-api.js';

test('a hung scan times out, releases its lock and recovers without accepting late results', async t => {
  let release, saves = 0;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { release = resolve; }));
  const config = { undercut: { intervalSeconds:30, watchers:[{id:'w',label:'Account',apiKey:'test',watchBazaar:false,watchItemMarket:true}] } };
  const monitor = new UndercutMonitor(() => config, { scanTimeoutMs:30, store:{load:()=>null,save:()=>{saves++;}} });
  monitor.running = true;
  const job = monitor.runOnce();
  assert.equal(monitor.getState().nextScanAt,null);
  await assert.rejects(job,/扫描超时/);
  assert.equal(monitor.checking,false);assert.ok(monitor.nextScanAt>Date.now());
  assert.match(monitor.getState().lastScanError,/超时/);
  release({ok:true,json:async()=>({itemmarket:[]})});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(saves,0);
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({itemmarket:[]})}));
  await monitor.runOnce();assert.equal(monitor.checks,2);assert.equal(monitor.lastScanError,'');assert.equal(saves,1);monitor.stop();
});

test('repeated full market pages fail explicitly instead of scanning forever', async t => {
  const rows=Array.from({length:100},(_,i)=>({id:i+1}));let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:true,json:async()=>({itemmarket:rows})};});
  await assert.rejects(fetchUserItemMarket('test'),/分页重复/);assert.equal(calls,2);
});

test('competitor listing quantities reach alerts and notifications and refresh without duplicate notifications', async function(t) {
  var bazaarQuantity = 1200;
  var marketAmount = 7;
  var messages = [], now = 1000;
  t.mock.method(globalThis, 'fetch', async function(url, options) {
    var address = String(url);
    var data;
    if (address.includes('/api/business-events')) {
      messages.push(JSON.parse(options.body).message);
      data = { ok: true };
    } else if (address.includes('/user/basic')) {
      data = { player_id: 123 };
    } else if (address.includes('/user/itemmarket')) {
      data = { itemmarket: [{ id: 1, item: { id: 100, name: 'Market item' }, price: 200, amount: 999, available: 99 }] };
    } else if (address.includes('/user/bazaar')) {
      data = { bazaar: [{ ID: 101, name: 'Bazaar item', price: 200, quantity: 999 }] };
    } else if (address.includes('/market/100/itemmarket')) {
      data = { itemmarket: { cache_timestamp: now, listings: [{price:200,amount:999}, { price: 150, amount: 555 }, { price: 100, amount: marketAmount }] } };
    } else {
      assert.match(address, /101\?limit=100$/);
      data = { listings: [{ player_id: 456, player_name: 'Seller', price: 100, quantity: bazaarQuantity }] };
    }
    return { ok: true, json: async function() { return data; } };
  });
  var watcher = { id: 'w1', label: 'Account', apiKey: 'test', watchBazaar: true, watchItemMarket: true };
  var config = { undercut: { watchers: [watcher] }, notify: { qq: { url: 'http://127.0.0.1:8787', token: 'test' } } };
  var monitor = new UndercutMonitor(function() { return config; }, { now: () => now });
  await monitor.scanWatcher(config, watcher);
  assert.equal(messages.length,1,'Bazaar stays immediate; new market alert waits for cache confirmation');
  now=1060;await monitor.scanWatcher(config, watcher);
  assert.equal(monitor.getAllAlerts().find(a => a.source === 'Bazaar').undercutQuantity, 1200);
  assert.equal(monitor.getAllAlerts().find(a => a.source === 'Item Market').undercutQuantity, 7);
  assert.equal(messages.length, 2);
  assert.match(messages[1], /压价挂单数量：7 件/);
  assert.match(messages[0], /压价挂单数量：1,200 件/);

  bazaarQuantity = 0;
  marketAmount = undefined;
  await monitor.scanWatcher(config, watcher);
  var alerts = monitor.getAllAlerts();
  assert.equal(alerts.find(a => a.source === 'Bazaar').undercutQuantity, 0);
  assert.equal(alerts.find(a => a.source === 'Item Market').undercutQuantity, null);
  assert.match(monitor.buildAlertText(alerts.find(a => a.source === 'Item Market')), /压价挂单数量：未知/);
  assert.match(monitor.buildAlertText(alerts.find(a => a.source === 'Bazaar')), /压价挂单数量：0 件/);
  assert.equal(messages.length, 2);
});
