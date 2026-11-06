import test from 'node:test';
import assert from 'node:assert/strict';
import { activatePendingOptions } from './pending-options.js';
import { captureExecutionPlan, prepareExecution } from './execution-plan.js';
import { resetRound } from './playbook.js';
import { executionDefaults } from './execution-defaults.js';
import { marketAlertRoutes } from './market-alerts.js';

function fixture() {
  const round = captureExecutionPlan({}, { available: true, tier: 'T2', status: 'confirmed', totalUsd: 1600,
    legs: [{ kind: 'equity', symbol: 'QQQ', currency: 'USD', usd: 1200 },
      { kind: 'call', symbol: 'QQQ', currency: 'USD', usd: 400, skipped: true, otmClass: 'medium' }] });
  const ev = { cashUsd: 500, qqq: { price: 700, lastClose: 700 }, remaining: { left: 400 },
    tiers: [{ id: 'T2', bag: 'left', triggerPrice: 710, status: 'confirmed' }],
    leaps: { expiries: [{ expiry: '2028-01-21' }] },
    suggestedContracts: [{ ticker: 'O:QQQ280121C00950000', strike: 950, expiry: '2028-01-21',
      ask: 3.5, asOf: new Date().toISOString(), sharesPerContract: 100 }] };
  return { round, ev };
}

test('persist budget, activate without cash deduction, and avoid duplicate legs', () => {
  const { round, ev } = fixture();
  const before = JSON.stringify(round);
  const pending = round.executionPlans.T2.legs[1];
  assert.equal(pending.pendingOption, true);
  const ready = activatePendingOptions(round, ev);
  assert.equal(JSON.stringify(round), before);
  assert.equal(ready.round.executionPlans.T2.legs[1].pendingOption, false);
  assert.equal(ready.round.executionPlans.T2.legs[1].usd, 400);
  assert.equal(ready.round.executionPlans.T2.legs[1].spent, 0);
  const again = activatePendingOptions(ready.round, ev);
  assert.equal(again.round.executionPlans.T2.legs.length, 2);
  assert.equal(again.alerts[0].key, ready.alerts[0].key, 'stable reminder survives closed market and deduplicates');
  assert.deepEqual(marketAlertRoutes(ev, ready.round, ready.alerts[0]).map((x) => x.market), ['US']);
  assert.deepEqual(resetRound(ready.round).executionPlans, {});
});

test('price, VXN, quote, cash, bag and cancellation gates keep the budget pending', () => {
  for (const change of [
    (r, e) => { e.qqq.lastClose = 720; }, (r, e) => { e.cashUsd = 100; },
    (r, e) => { e.remaining.left = 100; }, (r, e) => { e.suggestedContracts[0].ask = 16.51; },
    (r, e) => { e.tiers[0].vxnGate = { blocked: true }; },
    (r, e) => { e.tiers[0].status = 'idle'; }, (r, e) => { e.reset = true; },
    (r, e) => { e.fakeRight = true; }, (r) => { r.executionPlans.T2.cancelled = true; },
    (r, e) => { e.suggestedContracts = []; }
  ]) {
    const { round, ev } = fixture(); change(round, ev);
    const result = activatePendingOptions(round, ev);
    assert.equal(result.round.executionPlans.T2.legs[1].pendingOption, true);
    assert.equal(result.alerts.length, 0);
  }
});

test('pending option cannot fetch a fabricated ticker or be booked as a trade', async () => {
  const { round, ev } = fixture();
  const plan = round.executionPlans.T2;
  const result = await executionDefaults({ legs: [plan.legs[1]] }, {});
  assert.match(result.legs[0].error, /预算待用/);
  assert.throws(() => prepareExecution(plan, { planId: plan.id, requestId: 'pending-test-123', reviewed: true,
    filledAt: plan.createdAt, fills: [{ legId: '1', shares: 1, price: 1 }] }, ev,
  { usdCnyRate: 7, cashUsd: 500 }), /预算待用/);
});

function carryFixture() {
  const { round, ev } = fixture();
  const withTarget = captureExecutionPlan(round, { available: true, tier: 'T3', status: 'confirmed', totalUsd: 600,
    legs: [{ kind: 'call', symbol: 'QQQ', currency: 'USD', usd: 600, skipped: true, otmClass: 'medium' }] });
  ev.tiers.push({ id: 'T3', bag: 'left', triggerPrice: 705, status: 'confirmed' });
  ev.suggestedContracts[0].ask = 8.5;
  ev.cashUsd = 3000;
  ev.remaining.left = 3000;
  ev.sameDaySkip = ['T2'];
  return { round: withTarget, ev };
}

test('400 + 600 rolls once to the next eligible same-class leg and preserves total plan budget', (t) => {
  const now = new Date('2026-11-06T15:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const { round, ev } = carryFixture();
  const input = captureExecutionPlan(round, { available: true, tier: 'T4', status: 'confirmed', totalUsd: 600,
    legs: [{ kind: 'call', symbol: 'QQQ', currency: 'USD', usd: 600, skipped: true, otmClass: 'medium' }] });
  ev.tiers.push({ id: 'T4', bag: 'left', triggerPrice: 700, status: 'confirmed' });
  const result = activatePendingOptions(input, ev);
  const { T2, T3, T4 } = result.round.executionPlans;
  assert.equal(T2.legs[1].budgetCarryOut.tier, 'T3');
  assert.equal(T2.legs[1].complete, true);
  assert.equal(T2.legs[1].usd, 0);
  assert.equal(T3.legs[0].usd, 1000);
  assert.equal(T3.legs[0].shares, 1);
  assert.equal(T3.legs[0].budgetCarryIns[0].usd, 400);
  assert.equal(T4.legs[0].usd, 600, 'a newly affordable T3 cannot be rolled onward');
  assert.equal(T2.totalUsd + T3.totalUsd + T4.totalUsd, 2800);
  assert.match(result.alerts[0].message, /T2 \$400\.00/);
  const repeat = activatePendingOptions(result.round, ev);
  assert.equal(repeat.round.executionPlans.T3.legs[0].budgetCarryIns.length, 1);
  assert.equal(repeat.alerts[0].key, result.alerts[0].key);
  const fill = { planId: T3.id, requestId: 'carry-fill-test', reviewed: true, filledAt: now.toISOString(),
    fills: [{ legId: '0', shares: 1, price: 8.5, commission: 2 }] };
  assert.equal(prepareExecution(T3, fill, ev, { usdCnyRate: 7, cashUsd: 3000 }, now).usd, 852);
  assert.throws(() => prepareExecution(T3, { ...fill, fills: [{ ...fill.fills[0], commission: 151 }] },
    ev, { usdCnyRate: 7, cashUsd: 3000 }, now), /含费用/);
});

test('missing quotes, insufficient combined budget, cross-bag or different type never move budgets', () => {
  for (const change of [
    (r, e) => { e.suggestedContracts = []; },
    (r, e) => { e.suggestedContracts[0].ask = 16.51; },
    (r, e) => { e.tiers[1].bag = 'crisis'; e.remaining.crisis = 3000; },
    (r) => { r.executionPlans.T3.legs[0].otmClass = 'deep'; },
    (r, e) => { e.tiers[1].vxnGate = { blocked: true }; },
    (r, e) => { e.tiers[1].pendingClose = true; },
    (r) => { r.executionPlans.T2.legs[1].spent = 1; },
    (r) => { r.executionPlans.T3.legs[0].spent = 1; },
    (r) => { r.executionPlans.T2.inFlight = 'unreconciled'; },
    (r) => { r.executionPlans.T3.cancelled = true; }
  ]) {
    const { round, ev } = carryFixture();
    change(round, ev);
    const { round: next } = activatePendingOptions(round, ev);
    assert.equal(next.executionPlans.T2.legs[1].usd, 400);
    assert.equal(next.executionPlans.T3.legs[0].usd, 600);
  }
});

test('an existing target keeps its contract and later credits cannot fund an earlier fill', (t) => {
  const before = new Date('2026-11-06T15:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: before });
  const { round, ev } = carryFixture();
  const plan = round.executionPlans.T3;
  const leg = plan.legs[0];
  Object.assign(leg, { usd: 1450, pendingOption: false, skipped: false, occSymbol: ev.suggestedContracts[0].ticker });
  plan.totalUsd = 1450;
  const now = new Date('2026-11-06T15:05:00Z');
  t.mock.timers.setTime(now.getTime());
  const updated = activatePendingOptions(round, ev).round.executionPlans.T3;
  assert.equal(updated.legs[0].occSymbol, leg.occSymbol);
  assert.equal(updated.legs[0].shares, 2);
  const fill = { planId: plan.id, requestId: 'carry-dated-fill', reviewed: true, filledAt: before.toISOString(),
    fills: [{ legId: '0', shares: 2, price: 8.5 }] };
  const cash = { usdCnyRate: 7, cashUsd: 3000 };
  assert.throws(() => prepareExecution(updated, fill, ev, cash, now), /预算/);
  assert.equal(prepareExecution(updated, { ...fill, filledAt: now.toISOString() }, ev, cash, now).usd, 1700);
});
