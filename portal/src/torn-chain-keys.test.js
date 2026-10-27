import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ChainMonitor, chainConfig, createChainStore } from './torn-chain-monitor.js';

const keys = ['1234567890abcdef', 'abcdef1234567890', 'fedcba0987654321'];
const empty = { warfarechains: [], _metadata: { links: { next: null } } };
function setup(t, request, options = {}) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = createChainStore(db); store.save('a', { apiKeys: keys });
  const m = new ChainMonitor({ uid: 'a', store, request, schedule: () => 1, cancel: () => {}, ...options });
  t.after(() => m.stop()); return { m, store };
}
const info = key => ({ info: { user: { id: key === keys[2] ? 2 : 1 } } });
test('Chain multi-key config migrates legacy keys, deduplicates, preserves and clears all', t => {
  assert.deepEqual(chainConfig({}, { apiKey: keys[0] }).apiKeys, [keys[0]]);
  const saved = chainConfig({ apiKeys: keys.join('\n') + ',' + keys[0] });
  assert.deepEqual(saved.apiKeys, keys);
  assert.deepEqual(chainConfig({ minHits: 200 }, saved).apiKeys, keys);
  assert.deepEqual(chainConfig({ apiKey: '' }, saved).apiKeys, []);
  assert.deepEqual(chainConfig({ apiKeys: [] }, saved).apiKeys, []);
  for (const apiKeys of [null, false, [1], ['bad'], Array(11).fill(keys[0])]) assert.throws(() => chainConfig({ apiKeys }));
  const { store } = setup(t, async () => empty);
  assert.deepEqual(store.get('a').config.apiKeys, keys);
  assert.deepEqual(store.get('b').config.apiKeys, []);
});
test('Chain rotates verified distinct accounts and uses same-account standby after rejection', async t => {
  const calls = []; let reject = false;
  const { m, store } = setup(t, async (path, key, signal, policy) => {
    calls.push({ path, key }); assert.equal(policy.scope, 'chain:a'); assert.equal(policy.spacingMs, 2000);
    if (path === 'key/info') return info(key);
    if (reject && key === keys[0]) throw Object.assign(new Error('bad'), { apiCode: 13, fatal: true });
    return empty;
  });
  m.start(); await m.promise; await m.scan();
  assert.deepEqual(calls.filter(c => c.path !== 'key/info').map(c => c.key), [keys[0], keys[2]]);
  reject = true; await m.scan();
  assert.deepEqual(calls.filter(c => c.path !== 'key/info').slice(-2).map(c => c.key), [keys[0], keys[2]]);
  await m.scan(); assert.equal(calls.at(-1).key, keys[1]);
  assert.deepEqual(m.status().skippedKeys, [{ index: 1, code: 13, reason: 'API 错误 13' }]);
  assert.equal(m.status().availableKeyCount, 2); assert.equal(m.status().ownerCount, 2);
  assert.equal(store.get('a').config.apiKeys.length, 3);
});
test('Chain skips bad and unverified owners, stops when exhausted and redacts every key', async t => {
  const { m } = setup(t, async (path, key) => {
    if (key === keys[0]) throw Object.assign(new Error(keys.join(' ')), { apiCode: 2, fatal: true });
    if (key === keys[1]) return {};
    if (path === 'key/info') return info(key);
    throw Object.assign(new Error(keys.join(' ')), { apiCode: 18, fatal: true });
  });
  m.start(); await m.promise; assert.equal(m.running, false);
  assert.equal(m.status().skippedKeys.length, 3); assert.equal(m.status().availableKeyCount, 0);
  assert.match(m.status().error, /所有 API Key/);
  for (const key of keys) assert.ok(!JSON.stringify(m.status()).includes(key));
  assert.equal(m.safeError(new Error(keys.join(' '))), '[Key] [Key] [Key]');
  m.request = async path => path === 'key/info' ? info(keys[0]) : empty;
  m.start(); await m.promise; assert.equal(m.running, true); assert.deepEqual(m.status().skippedKeys, []);
});
test('Chain rate limits retry the same key and bans never switch keys', async t => {
  const work = [], waits = []; let limited = true;
  const { m } = setup(t, async (path, key) => {
    if (path === 'key/info') return info(key);
    work.push(key);
    if (limited) { limited = false; throw Object.assign(new Error('limited'), { apiCode: 5, fatal: true }); }
    return empty;
  }, { wait: async ms => { waits.push(ms); } });
  m.start(); await m.promise;
  assert.deepEqual(work, [keys[0], keys[0]]); assert.deepEqual(waits, [65000]);
  m.request = async (path, key) => { work.push(key); throw Object.assign(new Error('IP blocked'), { apiCode: 8, fatal: true }); };
  await m.scan(); assert.equal(m.running, false); assert.equal(work.length, 3); assert.deepEqual(m.status().skippedKeys, []);
});
