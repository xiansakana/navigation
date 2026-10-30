import test from 'node:test';
import assert from 'node:assert/strict';
import { cnMarketStatus, nextCnSessionEnd, nextCnExecutionBar } from './cn-market-hours.js';
import { captureExecutionPlan, prepareExecution, canExecutePlan, executionPlanState, commitExecution } from './execution-plan.js';

const signalTime = new Date('2026-10-08T21:00:00Z');
const fillTime = new Date('2026-10-09T02:00:00Z');
const preview = { available: true, tier: 'T2', totalUsd: 8000, status: 'confirmed', legs: [
  { symbol: '159509', currency: 'CNY', kind: 'equity', cny: 7000, usd: 1000 },
  { symbol: 'QQQ', currency: 'USD', kind: 'equity', usd: 7000 }
] };
const evaluation = { tiers: [{ id: 'T2', status: 'confirmed', bag: 'left' }], round: {}, remaining: { left: 8000 } };
const cash = { cashUsd: 10000, cashCny: 10000, usdCnyRate: 7 };

test('CN backtest fill cannot use an A-share close preceding the US signal', () => {
  const bar = (time, price) => ({ t: Date.parse(time) / 1000, o: price });
  const bars = [bar('2026-09-30T06:59Z', 2), bar('2026-10-01T01:30Z', 2.1),
    bar('2026-10-08T01:30Z', 2.5), bar('2026-10-08T04:00Z', 2.6)];
  assert.equal(nextCnExecutionBar('2026-09-30T21:00Z', bars).o, 2.5);
  assert.equal(nextCnExecutionBar('2026-10-08T21:00Z', bars), null);
  assert.throws(() => nextCnExecutionBar('2025-10-01T21:00Z', bars), /日历未维护/);
});
function fixture() {
  const plan = captureExecutionPlan({}, preview, signalTime).executionPlans.T2;
  return { plan, body: { tier: 'T2', planId: plan.id, requestId: 'request-123', reviewed: true, filledAt: fillTime.toISOString(),
    fills: [{ legId: '0', shares: 100, price: 2, commission: 1, complete: true }] } };
}

test('CN calendar handles lunch, weekends, holiday, make-up workday and unknown years', () => {
  for (const date of ['2026-10-09T04:30Z', '2026-10-10T02:00Z', '2026-10-01T02:00Z', '2026-02-23T02:00Z']) {
    assert.equal(cnMarketStatus(new Date(date)).open, false, date);
  }
  assert.equal(cnMarketStatus(fillTime).open, true);
  assert.equal(cnMarketStatus(new Date('2026-10-09T07:00Z')).open, false);
  assert.equal(cnMarketStatus(new Date('2027-01-04T02:00Z')).known, false);
  assert.equal(nextCnSessionEnd(new Date('2026-09-30T21:00Z')), '2026-10-08T07:00:00.000Z');
});

test('signals create one immutable plan without executions or cash deduction', () => {
  const round = captureExecutionPlan({}, preview, signalTime);
  assert.equal(round.executed, undefined);
  assert.equal(round.executionPlans.T2.legs[0].spent, 0);
  assert.equal(captureExecutionPlan(round, preview, fillTime), round);
  assert.deepEqual(captureExecutionPlan({}, { ...preview, pendingClose: true }), {});
  assert.equal(round.executionPlans.T2.legs[0].expiresAt, '2026-10-09T07:00:00.000Z');
  assert.equal(round.executionPlans.T2.legs[1].expiresAt, '2026-10-09T20:00:00.000Z');
});

test('one filled leg leaves the other pending, with exact native currency spend', () => {
  const { plan, body } = fixture();
  const fill = prepareExecution(plan, body, evaluation, cash, fillTime);
  assert.equal(fill.cashCny, 201);
  assert.equal(fill.cashUsd, 0);
  assert.equal(fill.plan.legs[0].complete, true);
  assert.equal(fill.plan.legs[1].complete, false);
  assert.equal(executionPlanState(fill.plan, fillTime), '部分成交');
  assert.equal(plan.legs[0].spent, 0);
});

test('non-trading fills, missing review, invalid quantities and over-budget fills are rejected', () => {
  const { plan, body } = fixture();
  for (const change of [{ filledAt: '2026-10-09T04:30Z' }, { reviewed: false },
    { fills: [{ legId: '0', shares: 1, price: 2 }] }, { fills: [{ legId: '0', shares: 100, price: 80 }] }]) {
    assert.throws(() => prepareExecution(plan, { ...body, ...change }, evaluation, cash, new Date('2026-10-09T06:00Z')));
  }
});

test('replay, crash journal, cancelled plan and stale signal fail safely', () => {
  const { plan, body } = fixture();
  assert.deepEqual(prepareExecution({ ...plan, receipts: { 'request-123': true } }, body, evaluation, cash, fillTime), { duplicate: true });
  assert.throws(() => prepareExecution({ ...plan, inFlight: 'other' }, body, evaluation, cash, fillTime), /核对/);
  assert.throws(() => prepareExecution({ ...plan, cancelled: true }, body, evaluation, cash, fillTime), /结束/);
  assert.throws(() => prepareExecution(plan, body, { ...evaluation, reset: true }, cash, fillTime), /失效/);
  assert.throws(() => prepareExecution(plan, body, evaluation, { ...cash, cashCny: 1 }, fillTime), /现金不足/);
});

test('execution permissions fail closed, preserving the existing tier-exec permission', () => {
  assert.equal(canExecutePlan(''), false);
  assert.equal(canExecutePlan(Buffer.from('[]').toString('base64url')), false);
  assert.equal(canExecutePlan(Buffer.from('["service:qqq-dip:tier-exec:edit"]').toString('base64url')), true);
});

test('commit persists partial leg state and receipt; interruption leaves retry guard', () => {
  const { plan, body } = fixture();
  let round = { executionPlans: { T2: plan } };
  let writeCount = 0;
  let execution;
  const store = { getRound: () => structuredClone(round), setRound: (value) => { round = structuredClone(value); },
    markExecuted: (_, value) => { execution = value; } };
  const prepared = prepareExecution(plan, body, evaluation, cash, fillTime);
  commitExecution(store, body, prepared, () => { writeCount++; return { trades: [] }; });
  assert.equal(execution.complete, false);
  assert.equal(round.executionPlans.T2.legs[0].complete, true);
  assert.equal(round.executionPlans.T2.legs[1].spent, 0);
  assert.equal(prepareExecution(round.executionPlans.T2, body, evaluation, cash, fillTime).duplicate, true);
  assert.equal(writeCount, 1);
  const usTime = new Date('2026-10-09T14:00Z');
  const nextBody = { ...body, requestId: 'request-456', filledAt: usTime.toISOString(), fills: [{ legId: '1', shares: 1, price: 100 }] };
  const next = prepareExecution(round.executionPlans.T2, nextBody, evaluation, cash, usTime);
  assert.throws(() => commitExecution(store, nextBody, next, () => { throw new Error('disk write failed'); }), /disk/);
  assert.equal(round.executionPlans.T2.inFlight, 'request-456');
  assert.throws(() => prepareExecution(round.executionPlans.T2, nextBody, evaluation, cash, usTime), /核对/);
});
