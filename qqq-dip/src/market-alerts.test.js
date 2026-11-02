import test from 'node:test';
import assert from 'node:assert/strict';
import { alertMarketOpen, marketAlertRoutes, migrateMarketDeliveries } from './market-alerts.js';

const alert = { key: 'T1', event: 'T1', symbol: 'QQQ' };
const ev = { tiers: [{ id: 'T1', status: 'confirmed' }] };
function plan() {
  return { executionPlans: { T1: { legs: [
    { symbol: '159509', currency: 'CNY', cny: 1000, expiresAt: '2026-11-02T07:00:00Z' },
    { symbol: 'QQQ', currency: 'USD', usd: 100, expiresAt: '2026-11-02T21:00:00Z' }
  ] } } };
}

test('market sessions exclude CN lunch/auction/holidays and follow US DST', () => {
  for (const date of ['2026-11-02T01:29:00Z', '2026-11-02T04:00:00Z',
    '2026-11-01T02:00:00Z', '2026-10-01T02:00:00Z', '2027-01-04T02:00:00Z']) {
    assert.equal(alertMarketOpen('CN', new Date(date)), false, date);
  }
  assert.equal(alertMarketOpen('CN', new Date('2026-11-02T01:30:00Z')), true);
  assert.equal(alertMarketOpen('CN', new Date('2026-11-02T05:00:00Z')), true);
  assert.equal(alertMarketOpen('US', new Date('2026-10-30T13:30:00Z')), true);
  assert.equal(alertMarketOpen('US', new Date('2026-11-02T13:30:00Z')), false);
  assert.equal(alertMarketOpen('US', new Date('2026-11-02T14:30:00Z')), true);
});

test('plan legs route independently, excluding fills, cancellation, expiry and lost signals', () => {
  const now = new Date('2026-11-02T02:00:00Z');
  const round = plan();
  assert.deepEqual(marketAlertRoutes(ev, round, alert, now).map((r) => r.market), ['CN', 'US']);
  round.executionPlans.T1.legs[0].complete = true;
  assert.deepEqual(marketAlertRoutes(ev, round, alert, now).map((r) => r.market), ['US']);
  round.executionPlans.T1.cancelled = true;
  assert.deepEqual(marketAlertRoutes(ev, round, alert, now), []);
  assert.deepEqual(marketAlertRoutes(ev, plan(), alert, new Date('2026-11-03T02:00:00Z')), []);
  assert.deepEqual(marketAlertRoutes({ ...ev, reset: true }, plan(), alert, now), []);
  assert.deepEqual(marketAlertRoutes({ ...ev, sameDaySkip: ['T1'] }, plan(), alert, now), []);
  assert.deepEqual(marketAlertRoutes({ tiers: [{ id: 'T1', status: 'executed' }] }, plan(), alert, now), []);
});

test('selling follows the instrument market, not cash currency or signal benchmark', () => {
  const sell = { key: 'lot:profit', event: 'takeProfit', symbol: 'QQQ' };
  assert.deepEqual(marketAlertRoutes({ lots: [{ id: 'lot', symbol: '159509' }] }, {}, sell), [
    { market: 'CN', symbols: ['159509'] }
  ]);
  assert.equal(marketAlertRoutes({}, {}, { ...sell, symbol: 'SOXL' })[0].market, 'US');
});

test('migration preserves in-session delivery only for its market, and persists across reload', () => {
  const round = { firedAlerts: { T1: '2026-11-02T02:00:00Z' } };
  const actions = [{ type: 'notify', tier: 'T1', ts: '2026-11-02T02:00:01Z', payload: { key: 'T1', sent: ['Slack'] } }];
  migrateMarketDeliveries(round, [alert], actions, new Date('2026-11-02T03:00:00Z'));
  assert.ok(round.marketDeliveries['T1:CN']);
  assert.equal(round.marketDeliveries['T1:US'], undefined);
  const reloaded = JSON.parse(JSON.stringify(round));
  migrateMarketDeliveries(reloaded, [alert], [], new Date('2026-11-03T03:00:00Z'));
  assert.deepEqual(reloaded, round);
});
