import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from './quotes.js';
import { evaluate } from './playbook.js';
import { expectedVxnSession, parseVxnClose } from './vxn-session.js';

const now = new Date('2026-11-06T02:25:00Z');

test('Black Friday VXN rolls to the new session at 13:15 Eastern and accepts the Cboe close', () => {
  const before = new Date('2026-11-27T18:14:59Z');
  const after = new Date('2026-11-27T18:16:00Z');
  const row = { index: 'VXN', last_trade_time: '2026-11-27T12:15:01.404000-06:00',
    close: 33.34, current_price: 33.34, prev_day_close: 38.53 };
  assert.equal(expectedVxnSession(before), '2026-11-25');
  assert.equal(expectedVxnSession(after), '2026-11-27');
  assert.equal(parseVxnClose({ data: row }, after).price, 33.34);
  assert.throws(() => parseVxnClose({ data: { ...row, last_trade_time: '2026-11-27T12:14:59-06:00' } }, after), /未取得/);
});

test('Cboe daily fallback accepts only the expected VXN session', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-28T04:00:00Z') });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const previous = { price: 38.53, asOf: '2026-11-25', source: 'fred' };
  let csv = 'DATE,OPEN,HIGH,LOW,CLOSE\n11/25/2026,41.15,44.18,38.27,38.53\n';
  globalThis.fetch = async (url) => new URL(url).pathname.endsWith('VXN_History.csv')
    ? { ok: true, arrayBuffer: async () => Buffer.from(csv) }
    : { ok: false, status: 403 };
  assert.equal((await createQuoteService({}).getVxn(previous)).stale, true);
  csv += '11/27/2026,36.28,37.74,33.15,33.34\n';
  const quote = await createQuoteService({}).getVxn(previous);
  assert.deepEqual([quote.asOf, quote.price, quote.source, quote.stale], ['2026-11-27', 33.34, 'cboe', false]);
});

test('Cboe midnight rollover retains the finished session only when the close fields agree', () => {
  const afterRollover = new Date('2026-11-06T06:38:54Z');
  const row = { index: 'VXN', close: 38.26, prev_day_close: 38.26, current_price: 38.26,
    last_trade_time: '2026-11-05T00:00:00-06:00' };
  assert.equal(parseVxnClose({ data: row }, afterRollover).asOf, '2026-11-05');
  assert.equal(parseVxnClose({ data: row }, afterRollover).price, 38.26);
  assert.throws(() => parseVxnClose({ data: { ...row, current_price: 36 } }, afterRollover), /未取得/);
  assert.throws(() => parseVxnClose({ data: row }, now), /未取得/);
});

test('failed refresh preserves a verified close until the next session is due, including after restart', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  const previous = { price: 38.26, asOf: '2026-11-05', source: 'cboe',
    fetchedAt: '2026-11-06T02:00:00Z', stale: true, warning: 'previous refresh failed' };
  const service = createQuoteService({});
  const value = await service.getVxn(previous);
  assert.equal(value.price, 38.26);
  assert.equal(value.stale, false);
  assert.equal(value.fetchedAt, previous.fetchedAt);
  assert.equal(value.warning, undefined);
  t.mock.timers.setTime(Date.parse('2026-11-06T21:16:00Z'));
  assert.equal((await service.getVxn()).stale, true);
});

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
  assert.equal(calls, 3);
  context.mock.timers.setTime(Date.parse('2026-11-06T21:16:00Z'));
  const late = await quotes.getVxn();
  assert.equal(late.stale, true, 'a cached previous session must expire at the next VXN close');
});

test('source failures preserve bounded previous VXN and back off retries', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now });
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 403 }; };
  const previous = { price: 40, source: 'fred', asOf: '2026-11-04' };
  const quotes = createQuoteService({});
  const result = await quotes.getVxn(previous);
  assert.equal(result.price, 40);
  assert.equal(result.stale, true);
  assert.match(result.warning, /FRED.*Yahoo/);
  await quotes.getVxn(previous);
  assert.equal(calls, 4);
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
