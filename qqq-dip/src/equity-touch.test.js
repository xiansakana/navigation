import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './playbook.js';
import { captureExecutionPlan, prepareExecution } from './execution-plan.js';
import { activatePendingOptions } from './pending-options.js';
import { latestCompletedSession, marketStatus } from './market-hours.js';
import { createQuoteService } from './quotes.js';
import { expectedVxnSession } from './vxn-session.js';

const cash = { cashUsd: 20000, cashCny: 0, usdCnyRate: 7 };
const candle = (date, close) => ({ t: Date.parse(`${date}T05:00:00Z`) / 1000, h: 100, l: close, c: close });
const yesterday = candle('2026-11-04', 90);
function evaluateAt(now, extra = {}) {
  return evaluate({ ...cash, now, rth: marketStatus(now).rth, sessionDate: marketStatus(now).ymd,
    expectedCloseDate: latestCompletedSession(now), vxn: { price: 27, asOf: expectedVxnSession(now) },
    qqq: { price: 87, asOf: now.toISOString(), candles: [yesterday] }, ...extra });
}

test('fresh US touch manually opens equity only, then activates the original option budget at confirmed close', (t) => {
  const now = new Date('2026-11-05T16:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const ev = evaluateAt(now);
  assert.equal(ev.buyPreview.tier, 'T2');
  assert.equal(ev.buyPreview.equityMarket, 'US');
  assert.deepEqual(captureExecutionPlan({}, ev.buyPreview, now), {});
  const round = captureExecutionPlan({}, ev.buyPreview, now, { manual: true });
  const plan = round.executionPlans.T2;
  const stock = plan.legs.find((l) => l.kind === 'equity');
  const option = plan.legs.find((l) => l.kind === 'call');
  assert.equal(option.pendingOption, true);
  const fill = { planId: plan.id, requestId: 'test-touch', reviewed: true, filledAt: now.toISOString(),
    fills: [{ legId: stock.id, price: 87, shares: 3 }] };
  const prepared = prepareExecution(plan, fill, ev, cash, now);
  assert.equal(prepared.usd, 261);
  assert.throws(() => prepareExecution(plan, { ...fill, fills: [{ ...fill.fills[0], price: 89 }] }, ev, cash, now), /高于/);
  assert.throws(() => prepareExecution(plan, { ...fill, fills: [{ ...fill.fills[0], legId: option.id }] }, ev, cash, now), /待用/);
  assert.throws(() => prepareExecution(plan, fill, evaluateAt(now, { qqq: { price: 89, asOf: now.toISOString(), candles: [yesterday] } }), cash, now), /信号/);
  round.executionPlans.T2 = prepared.plan;
  round.executed = { T2: { usd: 261, complete: false } };
  const after = new Date('2026-11-05T21:16:00Z');
  t.mock.timers.setTime(after.getTime());
  const confirmed = evaluateAt(after, { round, qqq: { price: 87, candles: [yesterday, candle('2026-11-05', 87)] } });
  confirmed.suggestedContracts = [{ ticker: 'O:QQQ280121C00115000', expiry: '2028-01-21', strike: 115, ask: 1, asOf: after.toISOString() }];
  const updated = activatePendingOptions(round, confirmed).round.executionPlans.T2;
  assert.equal(updated.id, plan.id);
  assert.equal(updated.legs[0].spent, 261);
  assert.equal(updated.legs[1].usd, option.usd);
  assert.equal(updated.legs[1].pendingOption, false);
  assert.equal(captureExecutionPlan(round, confirmed.buyPreview, after), round);
});

test('delayed US daily bar stays pending and CN requires a fresh local quote and the last regular close-time quote', () => {
  const now = new Date('2026-11-06T02:00:00Z');
  const qqq = { price: 87, asOf: '2026-11-05T21:00:00Z', candles: [yesterday] };
  const cnyProxy = { price: 3, asOf: now.toISOString() };
  const ev = evaluateAt(now, { qqq, cnyProxy, cashCny: 70000 });
  assert.equal(ev.closeDataPending, true);
  assert.equal(ev.buyPreview.equityMarket, 'CN');
  assert.equal(ev.tiers.find((x) => x.id === 'T2').closeConfirmed, false);
  assert.equal(evaluateAt(now, { qqq: { ...qqq, asOf: '2026-11-05T22:00:00Z' }, cnyProxy }).buyPreview.equityMarket, null);
  assert.equal(evaluateAt(now, { qqq, cnyProxy: { ...cnyProxy, asOf: '2026-11-06T01:55:00Z' } }).buyPreview.equityMarket, null);
  const plan = captureExecutionPlan({}, ev.buyPreview, now, { manual: true }).executionPlans.T2;
  const leg = plan.legs.find((l) => l.currency === 'CNY');
  const fill = { planId: plan.id, requestId: 'test-cn-touch', reviewed: true, filledAt: now.toISOString(),
    fills: [{ legId: leg.id, price: 3, shares: 100 }] };
  assert.equal(prepareExecution(plan, fill, ev, { ...cash, cashCny: 70000 }, now).cashCny, 300);
  assert.throws(() => prepareExecution(plan, { ...fill, fills: [{ ...fill.fills[0], shares: 101 }] }, ev, { ...cash, cashCny: 70000 }, now), /100份/);
});

test('daily cache rechecks at US close and retries a late daily bar within the same UTC date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T20:59:00Z') });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const rows = calls >= 3 ? [yesterday, candle('2026-11-05', 87)] : [yesterday];
    return { ok: true, json: async () => ({ results: rows.map((row) => ({ ...row, t: row.t * 1000 })) }) };
  };
  const quotes = createQuoteService({ polygonApiKey: 'fixture' });
  assert.equal((await quotes.getCandles('QQQ')).at(-1).c, 90);
  t.mock.timers.setTime(Date.parse('2026-11-05T21:00:00Z'));
  assert.equal((await quotes.getCandles('QQQ')).at(-1).c, 90);
  assert.equal(calls, 2);
  t.mock.timers.tick(121000);
  assert.equal((await quotes.getCandles('QQQ')).at(-1).c, 87);
  assert.equal(calls, 3);
});
