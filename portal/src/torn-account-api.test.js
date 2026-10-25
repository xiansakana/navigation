import test from 'node:test';
import assert from 'node:assert/strict';
import { createTornAccountClient } from './torn-chain-monitor.js';

const keys = ['1234567890abcdef', 'abcdef1234567890', 'fedcba0987654321'];
const response = data => ({ ok: true, status: 200, json: async () => data });

test('verified owners share serialized Chain/faction lanes; distinct accounts proceed independently', { timeout: 5000 }, async t => {
  const calls = [], identities = [], starts = [];
  let release, entered;
  const holding = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const client = createTornAccountClient({ spacingMs: 0, globalSpacingMs: 0, fetchImpl: async url => {
    const u = new URL(url), key = u.searchParams.get('key');
    if (u.pathname === '/v2/key/info') { identities.push(key); return response({ info: { user: { id: key === keys[2] ? 2 : 1 } } }); }
    calls.push(key); starts.push(Date.now());
    if (u.pathname.endsWith('/chain')) { entered(); await holding; }
    return response({ ok: true });
  } });
  const work = [];
  t.after(async () => { release(); await Promise.allSettled(work); });
  await Promise.all(keys.map(key => client('key/info', key)));
  work.push(client('faction/10/chain', keys[0])); await started;
  work.push(client('user/10/profile', keys[1]));
  work.push(client('user/10/profile', keys[2]));
  await work[2];
  assert.deepEqual(calls, [keys[0], keys[2]], 'same-owner request waits behind Chain, other account does not');
  release(); await Promise.all(work);
  assert.deepEqual(calls, [keys[0], keys[2], keys[1]]);
  assert.equal(identities.length, 3);
});

test('same-owner keys observe a shared time budget rather than multiplying it', async () => {
  const starts = [];
  const client = createTornAccountClient({ spacingMs: 35, globalSpacingMs: 0, fetchImpl: async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/info')) return response({ info: { user: { id: 1 } } });
    starts.push(Date.now()); return response({ ok: true });
  } });
  await Promise.all(keys.slice(0, 2).map(key => client('key/info', key)));
  await Promise.all([client('user/10/profile', keys[0]), client('user/10/profile', keys[1])]);
  assert.ok(starts[1] - starts[0] >= 30, JSON.stringify(starts));
});

test('identity is single-flight and aborted queued work never reaches the network', async () => {
  let identities = 0, requests = 0;
  const client = createTornAccountClient({ spacingMs: 30, globalSpacingMs: 0, fetchImpl: async url => {
    if (new URL(url).pathname.endsWith('/info')) { identities++; return response({ info: { user: { id: 1 } } }); }
    requests++; return response({});
  } });
  await Promise.all([client('key/info', keys[0]), client('key/info', keys[0])]);
  const stop = new AbortController();
  const first = client('user/10/profile', keys[0]);
  const next = assert.rejects(client('user/10/faction', keys[0], stop.signal), { name: 'AbortError' }); stop.abort();
  await Promise.all([first, next]);
  assert.equal(identities, 1); assert.equal(requests, 1);
});

test('unverified identity and rate limits stop work without trying another credential', async () => {
  const invalid = createTornAccountClient({ spacingMs: 0, globalSpacingMs: 0, fetchImpl: async () => response({ info: { user: {} } }) });
  await assert.rejects(invalid('user/10/profile', keys[0]), /所属账号/);
  let calls = 0;
  const limited = createTornAccountClient({ spacingMs: 0, globalSpacingMs: 0, fetchImpl: async url => {
    calls++;
    if (new URL(url).pathname.endsWith('/info')) return response({ info: { user: { id: 1 } } });
    return { status: 429, ok: false };
  } });
  await assert.rejects(limited('user/10/profile', keys[0]), /限流/);
  await assert.rejects(limited('user/10/profile', keys[1]), /冷却/);
  assert.equal(calls, 2);
  const daily = createTornAccountClient({ spacingMs: 0, globalSpacingMs: 0, fetchImpl: async url => response(new URL(url).pathname.endsWith('/info') ? { info: { user: { id: 1 } } } : { error: { code: 14 } }) });
  await assert.rejects(daily('user/10/profile', keys[0]), error => error.fatal && error.apiCode === 14);
});

test('cooldown metadata honors Retry-After and distinguishes account limits from IP bans', async () => {
  for (const code of [5, 8, 'http429']) {
    let calls = 0;
    const client = createTornAccountClient({ spacingMs: 0, globalSpacingMs: 0, fetchImpl: async url => {
      calls++;
      if (new URL(url).pathname.endsWith('/info')) return response({ info: { user: { id: 1 } } });
      return code === 'http429' ? { status: 429, ok: false, headers: new Headers({ 'Retry-After': '90' }) } : response({ error: { code } });
    } });
    await assert.rejects(client('user/10/profile', keys[0]), error => code === 'http429' ? error.rateLimited && error.retryAfterMs === 90000 : error.apiCode === code);
    await assert.rejects(client('user/10/profile', keys[0]), error => error.localCooldown && (code === 8 ? !error.rateLimited && error.apiCode === 8 : error.rateLimited && error.retryAfterMs > (code === 'http429' ? 80000 : 50000)));
    assert.equal(calls, 2);
  }
});

test('default account request spacing is two seconds for shared Chain and faction work', async () => {
  const starts = [];
  const client = createTornAccountClient({ fetchImpl: async url => {
    if (new URL(url).pathname.endsWith('/info')) return response({ info: { user: { id: 1 } } });
    starts.push(performance.now()); return response({});
  } });
  await client('faction/10/chain', keys[0]);
  await client('user/10/profile', keys[0]);
  assert.ok(starts[1] - starts[0] >= 1950, 'default shared spacing must remain approximately 2000ms');
});

test('configured shared-owner intervals use the slower active scope and release stopped scopes', async () => {
  const times = [];
  const client = createTornAccountClient({ spacingMs: 0, globalSpacingMs: 0, fetchImpl: async url => {
    if (new URL(url).pathname.endsWith('/info')) return response({ info: { user: { id: 1 } } });
    times.push(performance.now()); return response({});
  } });
  await client('user/10/profile', keys[0], undefined, { scope: 'chain:a', spacingMs: 0 });
  await client('user/10/profile', keys[0], undefined, { scope: 'factions:a', spacingMs: 80 });
  await client('user/10/profile', keys[0], undefined, { scope: 'chain:a', spacingMs: 0 });
  assert.ok(times[1] - times[0] >= 70); assert.ok(times[2] - times[1] >= 70);
  client.release('factions:a');
  await client('user/10/profile', keys[0], undefined, { scope: 'chain:a', spacingMs: 0 });
  assert.equal(times.length, 4);
});
