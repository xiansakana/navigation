import test from 'node:test';
import assert from 'node:assert/strict';
import { UndercutMonitor } from './undercut-monitor.js';

test('listing quantities reach alerts and notifications and refresh without duplicate notifications', async function(t) {
  var bazaarQuantity = 1200;
  var marketAmount = 7;
  var messages = [];
  t.mock.method(globalThis, 'fetch', async function(url, options) {
    var address = String(url);
    var data;
    if (address.includes('/api/business-events')) {
      messages.push(JSON.parse(options.body).message);
      data = { ok: true };
    } else if (address.includes('/user/basic')) {
      data = { player_id: 123 };
    } else if (address.includes('/user/itemmarket')) {
      data = { itemmarket: [{ id: 1, item: { id: 100, name: 'Market item' }, price: 200, amount: marketAmount, available: 99 }] };
    } else if (address.includes('/user/bazaar')) {
      data = { bazaar: [{ ID: 101, name: 'Bazaar item', price: 200, quantity: bazaarQuantity }] };
    } else if (address.includes('/market/100/itemmarket')) {
      data = { itemmarket: { listings: [{ price: 100 }] } };
    } else {
      assert.match(address, /101\?limit=100$/);
      data = { listings: [{ player_id: 456, player_name: 'Seller', price: 100 }] };
    }
    return { ok: true, json: async function() { return data; } };
  });
  var watcher = { id: 'w1', label: 'Account', apiKey: 'test', watchBazaar: true, watchItemMarket: true };
  var config = { undercut: { watchers: [watcher] }, notify: { qq: { url: 'http://127.0.0.1:8787', token: 'test' } } };
  var monitor = new UndercutMonitor(function() { return config; });
  await monitor.scanWatcher(config, watcher);
  assert.equal(monitor.getAllAlerts().find(a => a.source === 'Bazaar').quantity, 1200);
  assert.equal(monitor.getAllAlerts().find(a => a.source === 'Item Market').quantity, 7);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /你的在售数量：7 件/);
  assert.match(messages[1], /你的在售数量：1,200 件/);

  bazaarQuantity = 0;
  marketAmount = undefined;
  await monitor.scanWatcher(config, watcher);
  var alerts = monitor.getAllAlerts();
  assert.equal(alerts.find(a => a.source === 'Bazaar').quantity, 0);
  assert.equal(alerts.find(a => a.source === 'Item Market').quantity, null);
  assert.match(monitor.buildAlertText(alerts.find(a => a.source === 'Item Market')), /你的在售数量：未知/);
  assert.match(monitor.buildAlertText(alerts.find(a => a.source === 'Bazaar')), /你的在售数量：0 件/);
  assert.equal(messages.length, 2);
});
