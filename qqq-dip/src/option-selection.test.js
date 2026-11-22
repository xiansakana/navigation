import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAffordableCall } from './option-selection.js';
import { buildBuyPreview } from './playbook.js';
import { captureExecutionPlan } from './execution-plan.js';
import { executionDefaults } from './execution-defaults.js';
import { createQuoteService } from './quotes.js';

const now = Date.now();
const expiry = '2028-01-21';
const option = (strike, ask, extra = {}) => ({ ticker: `O:QQQ280121C${String(strike * 1000).padStart(8, '0')}`,
  strike, ask, expiry, sharesPerContract: 100, asOf: new Date(now).toISOString(), ...extra });
const config = { band: { low: 875, high: 980 }, expiries: [expiry], budget: 400, now };
const ev = { primary: { tier: 'T2' }, tiers: [{ id: 'T2', status: 'confirmed', usd: 1600, pctB: .08, bag: 'left' }],
  B: 20000, cashUsd: 20000, cashCny: 0, usdCnyRate: 7, qqq: { price: 700, H: 800 },
  remaining: { left: 8000, crisis: 6000, right: 6000 }, leaps: { expiries: [{ expiry }] } };

test('T3 preview shows pending carry and gap without transferring funds or mixing deep calls', () => {
  const input = { ...ev, primary: { tier: 'T3' }, tiers: [
    { id: 'T3', status: 'confirmed', usd: 2449.43, pctB: .1, bag: 'left' }
  ], round: { executionPlans: { T2: { legs: [
    { kind: 'call', currency: 'USD', otmClass: 'medium', usd: 349.92, pendingOption: true }
  ] } } } };
  const before = JSON.stringify(input);
  const preview = buildBuyPreview(input, [option(900, 12.22)]);
  const medium = preview.legs.find((leg) => leg.otmClass === 'medium');
  const deep = preview.legs.find((leg) => leg.otmClass === 'deep');
  assert.match(medium.carryInfo, /待顺延（尚未划转）.*T2 \$349.92.*\$1207.22.*还差 \$14.78/);
  assert.equal(medium.usd, 857.3);
  assert.equal(deep.carryInfo, undefined);
  assert.equal(JSON.stringify(input), before);
  input.round.executionPlans.T2.cancelled = true;
  assert.equal(buildBuyPreview(input, []).legs.find((leg) => leg.otmClass === 'medium').carryInfo, undefined);
  delete input.round.executionPlans.T2.cancelled;
  input.round.executionPlans.T3 = { legs: [
    { kind: 'call', otmClass: 'medium', usd: 1207.22, budgetCarryIns: [{ tier: 'T2', usd: 349.92 }] }
  ] };
  assert.match(buildBuyPreview(input, []).legs.find((leg) => leg.otmClass === 'medium').carryInfo,
    /已顺延至本计划.*计划合计 \$1207.22/);
});

test('T2 16.51 premium needs $1651; a $400 budget must skip instead of sizing fractions', () => {
  const selection = selectAffordableCall([option(875, 16.51)], config);
  assert.equal(selection.skipped, true);
  assert.equal(selection.shares, 0);
  assert.equal(selection.minimumCost, 1651);
  const preview = buildBuyPreview(ev, [option(875, 16.51)]);
  assert.equal(preview.legs.find((l) => l.kind === 'call').skipped, true);
  assert.equal(preview.cashPlan.useUsd, 1200);
  assert.equal(preview.cashPlan.remainUsd, 18800);
  const plan = captureExecutionPlan({}, preview).executionPlans.T2;
  assert.equal(plan.legs.find((l) => l.kind === 'call').pendingOption, true);
  assert.equal(plan.totalUsd, 1600);
});

test('choose an affordable candidate within the allowed band and expiry only', () => {
  const list = [option(925, 16.51), option(950, 3.5), option(1000, .1),
    option(920, .1, { expiry: '2026-12-18' })];
  const result = selectAffordableCall(list, config);
  assert.equal(result.contract.strike, 950);
  assert.equal(result.shares, 1);
  const preview = buildBuyPreview(ev, list);
  const leg = preview.legs.find((l) => l.kind === 'call');
  assert.equal(leg.strike, 950);
  assert.equal(leg.oneContractCost, 350);
  assert.equal(leg.shares, 1);
  assert.equal(captureExecutionPlan({}, preview).executionPlans.T2.legs.at(-1).occSymbol, list[1].ticker);
});

test('unknown, stale, future, nonstandard or out-of-band quotes never become affordable recommendations', () => {
  for (const item of [option(925, 0), option(925, NaN), option(925, 1, { asOf: null }),
    option(925, 1, { asOf: new Date(now - 86400001).toISOString() }),
    option(925, 1, { asOf: new Date(now + 300001).toISOString() }),
    option(925, 1, { sharesPerContract: 150 }), option(1000, .1)]) {
    assert.equal(selectAffordableCall([item], config).skipped, true);
  }
  assert.equal(buildBuyPreview(ev, []).legs.at(-1).skipped, true);
});

test('existing plans report insufficient funds without changing the selected contract or budget', async () => {
  const plan = { legs: [{ id: 'call', kind: 'call', occSymbol: 'QQQ280121C00875000', currency: 'USD', usd: 400, spent: 0 }] };
  const before = JSON.stringify(plan);
  const result = await executionDefaults(plan, { getOptionSnapshot: async () => ({ price: 16.51 }) });
  assert.equal(result.legs[0].shares, 0);
  assert.equal(result.legs[0].oneContractCost, 1651);
  assert.match(result.legs[0].warning, /不足一张/);
  assert.equal(JSON.stringify(plan), before);
});

test('chain snapshots preserve ask, timestamp, multiplier and later pages for selection', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const parsed = new URL(url);
    assert.match(parsed.pathname, /snapshot\/options\/QQQ/);
    assert.equal(parsed.searchParams.get('apiKey'), 'test-key');
    const c = option(calls === 1 ? 925 : 950, calls === 1 ? 16.51 : 3.5);
    const payload = { results: [{ details: { ticker: c.ticker, strike_price: c.strike,
      expiration_date: expiry, shares_per_contract: 100 },
    last_quote: { ask: c.ask, midpoint: 1, last_updated: Math.floor(now / 1000) * 1e9 } }],
    ...(calls === 1 ? { next_url: 'https://api.polygon.io/v3/snapshot/options/QQQ?cursor=next' } : {}) };
    return { ok: true, json: async () => payload };
  };
  const rows = await createQuoteService({ polygonApiKey: 'test-key' }).searchLeapCalls('QQQ', 875, 980, expiry, expiry);
  assert.equal(calls, 2);
  assert.equal(rows[0].ask, 16.51);
  assert.equal(rows[0].asOf, new Date(Math.floor(now / 1000) * 1000).toISOString());
  assert.equal(selectAffordableCall(rows, config).contract.strike, 950);
});
