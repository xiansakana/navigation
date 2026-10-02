import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressResolver, formatAddress, parseCoordinates } from './blog-address.js';
import { handleBlogApi } from './blog.js';
import { isPortalApi } from './router.js';

const data = { features: [{ properties: { countrycode: 'CN', state: '上海市', city: '黄浦区', district: '南京东路街道', name: '西藏南路' } }] };

test('addresses keep administrative areas and street, deduplicate and validate coordinates', () => {
  assert.equal(formatAddress(data), '上海市 · 黄浦区 · 南京东路街道 · 西藏南路');
  assert.equal(formatAddress({ features: [{ properties: { state: '上海市', city: '上海市', countrycode: 'CN', street: '中山路', name: '中山路' } }] }), '上海市 · 中山路');
  assert.equal(formatAddress({ features: [] }), '');
  for (const query of ['', 'latitude=&longitude=2', 'latitude=NaN&longitude=2', 'latitude=91&longitude=2', 'latitude=2&longitude=181']) {
    assert.throws(() => parseCoordinates(new URLSearchParams(query)), /坐标无效/);
  }
  assert.deepEqual(parseCoordinates(new URLSearchParams('latitude=31.2&longitude=121.5')), { latitude: 31.2, longitude: 121.5 });
});

test('resolver coalesces, caches, spaces requests, bounds cache and recovers from upstream failure', async () => {
  let calls = 0, time = 1000;
  const starts = [];
  const resolver = createAddressResolver({ cacheLimit: 1, spacingMs: 1100, now: () => time,
    sleep: async ms => { time += ms; }, fetchImpl: async url => {
      calls++; starts.push(time);
      assert.equal(url.hostname, 'photon.komoot.io');
      return { ok: true, json: async () => data };
    } });
  const a = { latitude: 31.2, longitude: 121.5 }, b = { latitude: 31.3, longitude: 121.5 };
  const [first, duplicate] = await Promise.all([resolver(a), resolver(a)]);
  assert.equal(first, duplicate); assert.equal(calls, 1);
  await resolver(a); assert.equal(calls, 1);
  await resolver(b); await resolver(a); assert.equal(calls, 3);
  assert.ok(starts[1] - starts[0] >= 1100);
  let failures = 0;
  const failing = createAddressResolver({ spacingMs: 0, fetchImpl: async () => { failures++; throw new Error('offline'); } });
  await assert.rejects(failing(a), /offline/);
  assert.equal(await failing(a), ''); assert.equal(failures, 1);
});

test('location route uses blog view permission and rejects malformed input before database access', async () => {
  const replies = [];
  const json = (_, status, body) => replies.push({ status, body });
  const req = { method: 'GET' };
  await handleBlogApi(req, {}, new URL('https://saoyu.fun/api/blog/location?latitude=1&longitude=2'), { permissions: [] }, json, {});
  assert.equal(replies.pop().status, 403);
  await handleBlogApi(req, {}, new URL('https://saoyu.fun/api/blog/location?latitude=bad&longitude=2'), { permissions: ['blog:feed:view'] }, json, {});
  assert.equal(replies.pop().status, 400);
  assert.equal(isPortalApi('/api/blog/location', 'GET'), true);
  assert.equal(isPortalApi('/api/blog/location', 'POST'), false);
});
