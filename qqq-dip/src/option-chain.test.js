import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCboeCalls, createCboeChainLoader } from './option-chain.js';
import { createQuoteService } from './quotes.js';
import { selectAffordableCall } from './option-selection.js';

const fixture = () => ({ timestamp: '2026-11-20 21:15:00', data: { options: [
  { option: 'QQQ280121C00800000', bid: 8, ask: 9 },
  { option: 'QQQ1280121C00800000', bid: 1, ask: 2 },
  { option: 'QQQ280121P00800000', bid: 1, ask: 2 },
  { option: 'QQQ280121C00900000', bid: 4, ask: 3 },
  { option: 'QQQ280121C00950000', bid: 0, ask: null }
] } });

test('Cboe uses valid standard QQQ call asks and feed timestamp without inventing prices', () => {
  const rows = parseCboeCalls(fixture());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, 'O:QQQ280121C00800000');
  assert.equal(rows[0].strike, 800);
  assert.equal(rows[0].asOf, '2026-11-20T21:15:00Z');
  assert.equal(rows[0].delayed, true);
  const args = { band: { low: 800, high: 800 }, expiries: ['2028-01-21'], budget: 1000 };
  assert.equal(selectAffordableCall(rows, { ...args, now: Date.parse('2026-11-20T22:00:00Z') }).oneContractCost, 900);
  assert.equal(selectAffordableCall(rows, { ...args, now: Date.parse('2026-11-22T22:00:00Z') }).skipped, true);
  assert.throws(() => parseCboeCalls({ data: fixture().data }), /报价时间/);
});

test('Cboe loader coalesces requests, caches and backs off failures', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T22:00:00Z') });
  let calls = 0;
  const load = createCboeChainLoader(async () => { calls++; return fixture(); });
  await Promise.all([load(), load()]);
  await load();
  assert.equal(calls, 1);
  const failed = createCboeChainLoader(async () => { calls++; throw new Error('offline'); });
  await assert.rejects(failed, /offline/);
  await assert.rejects(failed, /offline/);
  assert.equal(calls, 2);
  t.mock.timers.tick(60001);
  await assert.rejects(failed, /offline/);
  assert.equal(calls, 3);
});

test('Polygon access denial falls back to Cboe and suppresses repeated denied requests', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T22:00:00Z') });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let denied = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('polygon.io')) { denied++; return { ok: false, status: 403 }; }
    assert.match(String(url), /cdn.cboe.com/);
    return { ok: true, json: async () => fixture() };
  };
  const service = createQuoteService({ polygonApiKey: 'fixture' });
  for (let i = 0; i < 2; i++) {
    const rows = await service.searchLeapCalls('QQQ', 780, 850, '2028-01-01', '2028-02-01');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'cboe-delayed');
  }
  assert.equal(denied, 1);
  const quote = await service.getOptionSnapshot('QQQ280121C00800000');
  assert.equal(quote.price, 9);
  assert.equal(quote.source, 'cboe-delayed');
  assert.equal(denied, 1);
});
