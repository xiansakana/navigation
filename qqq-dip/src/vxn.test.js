import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from './quotes.js';
import { evaluate } from './playbook.js';

const now = new Date('2026-11-06T02:25:00Z');

test('Cboe latest closing observation supersedes a stale FRED value', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).hostname, 'cdn.cboe.com');
    return { ok: true, json: async () => ({ data: { index: 'VXN', current_price: 38.26, close: 38.26,
      last_trade_time: '2026-11-05T15:15:01.239000-06:00' } }) };
  };
  const q = await createQuoteService({}).getVxn({ price: 25.08, asOf: '2026-11-04', source: 'fred' });
  assert.deepEqual([q.price, q.asOf, q.source, q.stale], [38.26, '2026-11-05', 'cboe', false]);
});

test('FRED uses a recent window and successful VXN responses are cached', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now });
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  let calls = 0;
  const date = '2026-11-05';
  globalThis.fetch = async (url, options) => {
    calls += 1;
    if (new URL(url).hostname === 'cdn.cboe.com') return { ok: false, status: 403 };
    assert.ok(new URL(url).searchParams.has('cosd'));
    assert.equal(options.headers['User-Agent'], 'curl/8.5.0');
    return { ok: true, arrayBuffer: async () => Buffer.from(`DATE,VXNCLS\n${date},21.98\n`) };
  };
  const quotes = createQuoteService({});
  const first = await quotes.getVxn();
  assert.equal(first.price, 21.98);
  assert.equal(first.asOf, date);
  assert.equal(first.stale, false);
  assert.deepEqual(await quotes.getVxn(), first);
  assert.equal(calls, 2);
  context.mock.timers.setTime(Date.parse('2026-11-06T21:16:00Z'));
  const late = await quotes.getVxn();
  assert.equal(late.stale, true, 'a cached previous session must expire at the next VXN close');
});

test('source failures preserve bounded previous VXN and back off retries', async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 403 }; };
  const previous = { price: 40, source: 'fred', asOf: new Date(Date.now() - 86400000).toISOString().slice(0, 10) };
  const quotes = createQuoteService({});
  const result = await quotes.getVxn(previous);
  assert.equal(result.price, 40);
  assert.equal(result.stale, true);
  assert.match(result.warning, /FRED.*Yahoo/);
  await quotes.getVxn(previous);
  assert.equal(calls, 3);
  const ev = evaluate({ cashUsd: 1000, cashCny: 0, usdCnyRate: 7, vxn: result, qqq: { price: 100, close: 100, candles: [{ h: 100, c: 100 }] } });
  assert.equal(ev.vxn, null);
  assert.equal(ev.vxnGates.t2.ok, false);
  assert.equal(ev.vxnGates.t3.ok, false);
});

test('expired previous VXN is not used when sources fail', async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(createQuoteService({}).getVxn({ price: 40, asOf: '2000-01-01' }), /VXN .*收盘不可用/);
});

test('persisted old VXN cannot pass the option gate before the first refresh', () => {
  const result = evaluate({ now, expectedCloseDate: '2026-11-05', vxn: { price: 40, asOf: '2026-11-04', stale: false } });
  assert.equal(result.vxn, null);
  assert.equal(result.vxnStale, true);
  assert.equal(result.vxnGates.t2.ok, false);
  assert.equal(result.vxnGates.t3.ok, false);
});
