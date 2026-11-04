import test from 'node:test';
import assert from 'node:assert/strict';
import { executionDefaults, suggestedQuantity, createExecutionDefaultsHandler } from './execution-defaults.js';

const now = new Date('2026-11-02T02:00:00Z');
function plan() {
  return { id: 'p', legs: [
    { id: 'cn', symbol: '159509', currency: 'CNY', cny: 1200, spent: 200, expiresAt: '2026-11-03T07:00:00Z' },
    { id: 'us', symbol: 'QQQ', currency: 'USD', usd: 1000, spent: 100, expiresAt: '2026-11-03T21:00:00Z' },
    { id: 'call', symbol: 'QQQ', occSymbol: 'QQQ270115C700', kind: 'call', currency: 'USD', usd: 600, expiresAt: '2026-11-03T21:00:00Z' }
  ] };
}

test('defaults fetch each actual instrument and size remaining budget in native currency', async () => {
  const p = plan();
  const before = JSON.stringify(p);
  const data = await executionDefaults(p, {
    getCnyProxyQuote: async () => ({ price: 3 }), getStock: async (symbol) => { assert.equal(symbol, 'QQQ'); return { price: 90 }; },
    getOptionSnapshot: async (symbol) => { assert.equal(symbol, 'QQQ270115C700'); return { price: 2.5 }; }
  }, now);
  assert.deepEqual(data.legs.map((row) => [row.price, row.shares]), [[3, 300], [90, 10], [2.5, 2]]);
  assert.equal(JSON.stringify(p), before, 'prefilling must never mutate a plan or book a trade');
  assert.equal(suggestedQuantity(p.legs[0], 3, 101), 200);
  assert.equal(suggestedQuantity(p.legs[2], 7), 0);
});

test('bad, stale, previous-close and failed quotes never become defaults', async () => {
  for (const quote of [{ price: 0 }, { price: NaN }, { price: 3, stale: true }, { price: 3, previousCloseOnly: true },
    { price: 3, asOf: '2026-10-30T20:00:00Z' }]) {
    const data = await executionDefaults({ legs: [plan().legs[0]] }, { getCnyProxyQuote: async () => quote }, now);
    assert.ok(data.legs[0].error);
    assert.equal(data.legs[0].price, undefined);
  }
  const data = await executionDefaults(plan(), {
    getCnyProxyQuote: async () => { throw new Error('offline'); }, getStock: async () => ({ price: 90 }),
    getOptionSnapshot: async () => { throw new Error('unavailable'); }
  }, now);
  assert.ok(data.legs[0].error);
  assert.equal(data.legs[1].shares, 10);
  assert.ok(data.legs[2].error);
});

test('closed plans skip quote fetching', async () => {
  for (const p of [{ ...plan(), cancelled: true }, { ...plan(), inFlight: 'request' }]) {
    const result = await executionDefaults(p, {}, now);
    assert.ok(result.legs.every((leg) => leg.error));
  }
  const result = await executionDefaults({ legs: [plan().legs[0]] }, { getCnyProxyQuote: async () => ({ price: 3 }) }, new Date('2026-11-04T00:00:00Z'));
  assert.equal(result.legs[0].shares, 300);
});

test('defaults endpoint rejects missing permissions before fetching or reading a plan', async () => {
  const handler = createExecutionDefaultsHandler({ store: { getRound: () => { throw new Error('must not read'); } } });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ headers: {}, params: { tier: 'T1' } }, res);
  assert.equal(res.code, 403);
});
