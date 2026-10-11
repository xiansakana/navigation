import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTradeReview } from './trade-review.js';
import { renderTradeReview } from '../public/js/trade-review.js';

const trade = (id, type, date, shares, amount, commission = 0, symbol = 'AAPL', currency = 'USD') => ({ id, type, trade_date: date + 'T04:00:00Z', shares, price: amount / shares, total_amount: amount, commission, symbol, currency, name: symbol });
const report = (trades, options) => computeTradeReview(trades, options).currencies.find((r) => r.currency === 'USD');

test('matches purchases before the window and consumes earlier sales before realizing selected sales', () => {
  const rows = [trade('1', 'buy', '2026-01-01', 10, 100, 10), trade('2', 'sell', '2026-01-10', 4, 60, 4), trade('3', 'sell', '2026-02-01', 3, 60, 3), trade('4', 'sell', '2026-03-01', 3, 90, 3)];
  const result = report(rows, { startDate: '2026-02-01', endDate: '2026-02-28' });
  assert.equal(result.count, 1);
  assert.equal(result.realized, 24);
  assert.equal(result.realizedFees, 6);
  assert.equal(result.windowFees, 3);
  assert.equal(result.openCost, 30);
  assert.equal(result.openBuyFees, 3);
  assert.equal(result.open[0].shares, 3);
});

test('separates native currencies and uses recorded amounts instead of rounded display prices', () => {
  const rows = [trade('1', 'buy', '2026-01-01', 3, 10.01, 1), trade('2', 'sell', '2026-01-02', 3, 20, 1), trade('3', 'buy', '2026-01-01', 10, 100, 1, '600000', 'CNY'), trade('4', 'sell', '2026-01-02', 10, 90, 1, '600000', 'CNY')];
  rows[0].price = 3.33;
  const result = computeTradeReview(rows);
  assert.equal(result.currencies.find((r) => r.currency === 'USD').realized, 7.99);
  assert.equal(result.currencies.find((r) => r.currency === 'CNY').realized, -12);
});

test('unmatched and partial sales do not inflate win rates or count unknown proceeds as profit', () => {
  const result = report([trade('1', 'sell', '2026-01-01', 2, 40, 2), trade('2', 'buy', '2026-01-02', 1, 10, 1), trade('3', 'sell', '2026-01-03', 2, 40, 2)]);
  assert.equal(result.count, 0);
  assert.equal(result.winRate, null);
  assert.equal(result.partialSales, 1);
  assert.equal(result.unmatched.length, 2);
  assert.equal(result.realized, 8);
});

test('user-corrected TEM buy and sell produce 64.05 net profit', () => {
  const result = report([trade('1079', 'buy', '2025-06-02', 1, 195, 2.97, 'TEM250606C60'), { ...trade('1078', 'sell', '2025-06-02', 1, 265, 2.98, 'TEM250606C60'), trade_date: '2025-06-02T04:03:25Z' }]);
  assert.equal(result.realized, 64.05);
  assert.equal(result.realizedFees, 5.95);
  assert.equal(result.unmatched.length, 0);
  assert.equal(result.assets[0].key, 'option');
});

test('reports duplicate other income without deleting it and filters categories independently of inventory', () => {
  const other = { ...trade('1', 'other', '2026-01-01', 0, 5, 0, ''), other_category: '卡券' };
  const result = report([other, { ...other, id: '2' }, { ...other, id: '3', total_amount: -1, other_category: '税' }], { otherCategory: '卡券' });
  assert.equal(result.otherNet, 10);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.duplicateAmount, 5);
});

test('rejects invalid windows and handles empty or buy-only samples', () => {
  for (const options of [{ startDate: '2026-02-30' }, { startDate: '2026-02-01', endDate: '2026-01-01' }]) assert.throws(() => computeTradeReview([], options));
  assert.equal(computeTradeReview([]).currencies.length, 0);
  const result = report([trade('1', 'buy', '2026-01-01', 2, 10, 1)]);
  assert.equal(result.realized, 0);
  assert.equal(result.profitFactor, null);
  assert.equal(result.openBuyFees, 1);
});

test('renderer escapes names and hides derived review numbers when pnl visibility is off', () => {
  const rows = [trade('1', 'buy', '2026-01-01', 1, 100), { ...trade('2', 'sell', '2026-01-02', 1, 4321), name: '<script>alert(1)</script>' }];
  const data = computeTradeReview(rows);
  const visible = renderTradeReview(data);
  assert.ok(visible.includes('&lt;script&gt;'));
  assert.ok(!visible.includes('<script>'));
  const hidden = renderTradeReview(data, 'USD', false);
  assert.ok(!hidden.includes('4,221'));
  assert.ok(hidden.includes('盈亏数据已隐藏'));
});

test('distribution counts reconcile for fractional fills and floating-point flat profits', () => {
  const rows = [trade('1', 'buy', '2026-01-01', 3, 0.3), trade('2', 'sell', '2026-01-02', 1, 0.1), trade('3', 'sell', '2026-02-02', 2, 0.2)];
  const result = report(rows);
  assert.equal(result.flat, 2);
  assert.equal(result.bins.reduce((sum, bin) => sum + bin.count, 0), result.count);
  assert.equal(result.bins.find((b) => b.key === '持平').count, 2);
});
