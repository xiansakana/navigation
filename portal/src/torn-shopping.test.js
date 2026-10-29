import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { shoppingConfig, createShoppingStore, lowListings, ShoppingMonitor } from './torn-shopping-monitor.js';
import { Readable } from 'node:stream';
import { canTornShopping, createTornShoppingService } from './torn-shopping.js';

test('shopping round intervals accept 1–9 seconds and retain validation', () => {
  for (const intervalSeconds of [1, 2, 9, 10, 3600]) assert.equal(shoppingConfig({ intervalSeconds }).intervalSeconds, intervalSeconds);
  for (const intervalSeconds of [0, -1, 1.5, 3601]) assert.throws(() => shoppingConfig({ intervalSeconds }), /1–3600/);
});
test('shopping thresholds are independent, validated and saved per user', () => {
  const db = new Database(':memory:'); const store = createShoppingStore(db);
  try {
    store.save('a', { apiKey: '1234567890abcdef', items: [{ id: 1, market: 100, bazaar: 80 }] });
    assert.equal(store.get('a').config.items[0].bazaar, 80); assert.equal(store.get('b').config.items.length, 0);
    assert.equal(shoppingConfig({ items: [{ id: 1, market: '', bazaar: 10 }] }).items[0].market, null);
    for (const input of [{ items: [{ id: 1 }] }, { items: [{ id: 1, market: -1 }] }, { items: [{ id: 1, market: 1 }, { id: 1, bazaar: 2 }] }]) assert.throws(() => shoppingConfig(input));
    assert.equal(canTornShopping({ userId: 'a', isGuest: true, permissions: ['*'] }, 'control:edit'), false);
    const rows = [{ price: 80, amount: 2 }, { price: 100, amount: 3 }, { price: 101, amount: 1 }];
    assert.equal(lowListings(rows, 'market', 100, { id: 1, name: 'Test' }).length, 2);
    assert.match(lowListings([{ price: 80, quantity: 1, player_id: 123 }], 'bazaar', 80, { id: 1 })[0].link, /userId=123/);
  } finally { db.close(); }
});
test('shopping alerts link both sources and persist dedup across restart without real delivery', async () => {
  const db = new Database(':memory:'), store = createShoppingStore(db), sent = [];
  store.save('a', { apiKey: '1234567890abcdef', items: [{ id: 1, name: 'Test', market: 100, bazaar: 80 }] });
  let price = 100;
  const monitor = new ShoppingMonitor({ uid: 'a', store, request: async () => ({ itemmarket: { listings: [{ price, amount: 3 }] } }), bazaar: async () => [{ price: 80, quantity: 2, player_id: 123 }], notify: async row => sent.push(row), schedule: () => 1, cancel: () => {} });
  try {
    monitor.start(); await monitor.promise; assert.equal(sent.length, 2);
    assert.ok(sent.every(row => row.link.startsWith('https://www.torn.com/')));
    await monitor.scan(); assert.equal(sent.length, 2);
    monitor.stop(); monitor.start(); await monitor.promise; assert.equal(sent.length, 2);
    price = 99; await monitor.scan(); assert.equal(sent.length, 3);
    store.clear('a'); await monitor.scan(); assert.equal(sent.length, 3);
  } finally { monitor.stop(); db.close(); }
});

test('shopping API strips keys and rejects guest writes and foreign origins', async () => {
  const db = new Database(':memory:'), store = createShoppingStore(db); store.save('a', { apiKey: '1234567890abcdef' });
  const service = createTornShoppingService({ store });
  const call = async (route, method='GET', guest=false, origin) => {
    const req=Readable.from([Buffer.from('{}')]);req.method=method;req.headers={host:'test',...(origin?{origin}:{})};let result;
    await service.handle(req,{setHeader(){}},new URL('http://test/api/torn-shopping/'+route),{userId:'a',isGuest:guest,permissions:['*']},(_,status,data)=>{result={status,data};});return result;
  };
  try { const state=await call('state');assert.equal(state.status,200);assert.ok(!JSON.stringify(state).includes('1234567890abcdef'));assert.ok(!('apiKeys' in state.data.config));assert.equal((await call('config','POST',true)).status,403);assert.equal((await call('config','POST',false,'https://evil.test')).status,403); } finally {db.close();}
});

test('item catalog requires its own permission, normalizes data and isolates cache by user and keys', async () => {
  const db=new Database(':memory:'),store=createShoppingStore(db);store.save('a',{apiKey:'1234567890abcdef'});store.save('b',{apiKey:'abcdef1234567890'});let calls=0;
  const service=createTornShoppingService({store,request:async(path,key)=>{assert.equal(path,'torn/items');calls++;return {items:{1:{name:key==='1234567890abcdef'?'First':'Second'}}};}});
  const call=async(uid='a',permissions=['*'])=>{const req=Readable.from([]);req.method='GET';req.headers={host:'test'};let result;await service.handle(req,{setHeader(){}},new URL('http://test/api/torn-shopping/items'),{userId:uid,permissions},(_,status,data)=>{result={status,data};});return result;};
  try{
    assert.equal((await call('a',['torn-shopping:view','torn-shopping:config:edit'])).status,403);assert.equal(calls,0);
    const first=await call();assert.equal(first.data.items[0].id,1);assert.equal(first.data.items[0].name,'First');assert.equal(calls,1);
    await call();assert.equal(calls,1);assert.equal((await call('b')).data.items[0].name,'Second');assert.equal(calls,2);
    store.save('a',{apiKey:'abcdef1234567890'});assert.equal((await call()).data.items[0].name,'Second');assert.equal(calls,3);
    assert.equal((await call('c')).status,400);
  }finally{db.close();}
});
