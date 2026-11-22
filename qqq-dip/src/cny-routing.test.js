import test from 'node:test';
import assert from 'node:assert/strict';
import { premiumStatus, selectCnyFunds, routeCnyBudget, refreshCnyPlan, validateCnyLeg } from './cny-routing.js';
import { createCnyFundLoader } from './cny-fund-quotes.js';
import { buildBuyPreview, evaluate } from './playbook.js';
import { captureExecutionPlan, prepareExecution } from './execution-plan.js';
import { legsToTradeInputs } from '../../shared/db/portfolio-bridge.js';

const now = new Date('2026-11-20T06:00:00Z');
const quote = (premium) => ({ price: 1 + premium / 100, nav: 1, navDate: '2026-11-19', asOf: now.toISOString() });
const funds = (primary = 26, a = 5, b = 8) => ({ '159509': quote(primary), '513850': quote(a), '161128': quote(b) });
const previewInput = (quotes) => ({ primary: { tier: 'T1' }, tiers: [
  { id: 'T1', status: 'confirmed', bag: 'left', usd: 1000, pctB: .06 }
], cashUsd: 0, cashCny: 7000, usdCnyRate: 7, qqq: { price: 90, H: 100 },
remaining: { left: 10000 }, leaps: {}, now, cnyFunds: quotes });

test('25% and 10% boundaries are inclusive and missing or stale data fails closed', () => {
  assert.deepEqual(selectCnyFunds(funds(25), now).map((r) => r.symbol), ['159509']);
  assert.deepEqual(selectCnyFunds(funds(25.001), now).map((r) => r.symbol), ['513850', '161128']);
  assert.equal(selectCnyFunds(funds(26, 10, 10), now).some((r) => r.blocked), false);
  assert.equal(selectCnyFunds(funds(26, 10.001), now)[0].blocked, true);
  assert.equal(selectCnyFunds({}, now)[0].blocked, true);
  for (const bad of [{ ...quote(1), nav: null }, { ...quote(1), navDate: '2026-10-01' },
    { ...quote(1), asOf: '2026-10-01' }, { ...quote(1), price: Infinity }]) {
    assert.equal(premiumStatus(bad, now).valid, false);
  }
});

test('half budget stays reserved for blocked alternative and every buy uses 100-share lots', () => {
  const rows = routeCnyBudget(7000.01, 1000, funds(26, 11, 9), now);
  assert.deepEqual(rows.map((r) => r.cny), [3500.01, 3500]);
  assert.deepEqual(rows.map((r) => r.usd), [500, 500]);
  const preview = buildBuyPreview(previewInput(funds(26, 11, 9)));
  assert.deepEqual(preview.legs.map((r) => r.symbol), ['513850', '161128']);
  assert.equal(preview.legs[0].skipped, true);
  assert.equal(preview.legs[0].shares, 0);
  assert.equal(preview.cashPlan.useCny, 3500);
  assert.equal(preview.legs[1].shares % 100, 0);
  assert.equal(preview.legs[1].cny, 3500);
  const plan = captureExecutionPlan({}, preview, now);
  assert.equal(plan.executionPlans.T1.legs.length, 2, 'blocked half remains a persistent plan leg');
});

test('refreshing a partial plan preserves original spend, receipts, USD legs and total budget', () => {
  const plan = { id: 'plan', totalUsd: 1500, receipts: { previous: 'at' }, legs: [
    { id: '0', kind: 'equity', symbol: '159509', currency: 'CNY', cny: 7000, usd: 1000, spent: 1400 },
    { id: '1', kind: 'call', symbol: 'QQQ', currency: 'USD', usd: 500 }
  ] };
  const original = JSON.stringify(plan);
  const next = refreshCnyPlan(plan, funds(), now);
  assert.equal(JSON.stringify(plan), original);
  assert.equal(next.totalUsd, 1500);
  assert.deepEqual(next.receipts, plan.receipts);
  assert.deepEqual(next.legs[1], plan.legs[1]);
  assert.equal(next.legs[0].cny, 1400);
  assert.equal(next.legs[0].spent, 1400);
  assert.equal(next.legs[0].complete, true);
  assert.deepEqual(next.legs.slice(2).map((r) => r.cny), [2800, 2800]);
  assert.equal(next.legs.reduce((s, l) => s + l.usd, 0), 1500);
  assert.throws(() => refreshCnyPlan({ ...plan, cancelled: true }, funds(), now), /不可调整/);
  assert.throws(() => refreshCnyPlan({ ...plan, inFlight: 'x' }, funds(), now), /不可调整/);
});

test('server execution checks selected symbol, cap and lot size and bridge keeps correct names', () => {
  const input = previewInput(funds());
  const preview = buildBuyPreview(input);
  const plan = captureExecutionPlan({}, preview, new Date(now - 60000)).executionPlans.T1;
  const ev = { ...input, round: {}, tiers: [{ id: 'T1', status: 'confirmed', bag: 'left' }] };
  const body = { planId: plan.id, requestId: 'request-123', reviewed: true, filledAt: now.toISOString(),
    fills: [{ legId: '0', shares: 100, price: 1.05 }] };
  const cash = { cashCny: 7000, cashUsd: 0, usdCnyRate: 7 };
  const result = prepareExecution(plan, body, ev, cash, now);
  assert.equal(result.cashCny, 105);
  assert.equal(legsToTradeInputs(result.legs)[0].name, '美国50ETF易方达');
  assert.throws(() => prepareExecution(plan, { ...body, fills: [{ legId: '0', shares: 101, price: 1 }] }, ev, cash, now), /100份/);
  assert.throws(() => prepareExecution(plan, { ...body, fills: [{ legId: '0', shares: 100, price: 1.101 }] }, ev, cash, now), /溢价上限/);
  assert.throws(() => validateCnyLeg({ symbol: '159509' }, funds(), now), /不符合/);
  assert.throws(() => validateCnyLeg({ symbol: '513850' }, funds(20), now), /不符合/);
});

test('published NAV failures never reuse a guessed NAV, and loader preserves source dates', async () => {
  const loader = createCnyFundLoader(async () => ({ Data: { LSJZList: [{ DWJZ: '2.5', FSRQ: '2026-11-19' }] } }),
    async () => 'v_sh513850="1~name~513850~2.7~~~~~~~~~~~~~~~~~~~~~~~~~~~20261120140000~";',
    async () => ({ ...quote(20), symbol: '159509' }));
  const value = await loader('159509');
  assert.equal(value.nav, 2.5);
  assert.equal(value.navDate, '2026-11-19');
  const failure = createCnyFundLoader(async () => { throw new Error('offline'); },
    async () => '', async () => quote(20));
  assert.equal((await failure('159509')).nav, null);
});

test('existing lots value each CNY instrument using its own price', () => {
  const ev = evaluate({ now, cnyFunds: funds(), cashUsd: 1000, qqq: { price: 90, candles: [{ h: 100, c: 90 }] },
    lots: [{ id: 'lot', symbol: '513850', type: 'equity', cost: 1, shares: 100, originalShares: 100 }] });
  assert.equal(ev.lots[0].multiple, 1.05);
});
