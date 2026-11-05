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
