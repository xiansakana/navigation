import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from './quotes.js';
import { evaluate } from './playbook.js';

test('FRED uses a recent window and successful VXN responses are cached', async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  let calls = 0;
  const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.ok(new URL(url).searchParams.has('cosd'));
    return { ok: true, arrayBuffer: async () => Buffer.from(`DATE,VXNCLS\n${date},21.98\n`) };
  };
  const quotes = createQuoteService({});
  const first = await quotes.getVxn();
  assert.equal(first.price, 21.98);
  assert.equal(first.asOf, date);
  assert.equal(first.stale, false);
  assert.deepEqual(await quotes.getVxn(), first);
  assert.equal(calls, 1);
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
  assert.equal(calls, 2);
  const ev = evaluate({ cashUsd: 1000, cashCny: 0, usdCnyRate: 7, vxn: result, qqq: { price: 100, close: 100, candles: [{ h: 100, c: 100 }] } });
  assert.equal(ev.vxn, null);
  assert.equal(ev.vxnGates.t2.ok, false);
  assert.equal(ev.vxnGates.t3.ok, false);
});

test('expired previous VXN is not used when sources fail', async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(createQuoteService({}).getVxn({ price: 40, asOf: '2000-01-01' }), /VXN 不可用/);
});
