import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHoldingsGroups } from './holdings-table.js';

test('financial sorting aggregates grouped holdings in a common currency and puts missing results last', () => {
  const rows = [
    { symbol: 'A', currency: 'USD', marketValue: 120, marketValueNative: 120, pnl: 20, pnlPct: 20, costBasisNative: 100, dailyPnl: -2, dailyPnlPct: -1.64 },
    { symbol: 'B', groupWith: 'A', currency: 'CNY', marketValue: 10, marketValueNative: 70, pnl: 35, pnlPct: 100, costBasisNative: 35, dailyPnl: 7, dailyPnlPct: 11.11 },
    { symbol: 'C', currency: 'USD', marketValue: 121, marketValueNative: 121, pnl: 30, pnlPct: 32.97, costBasisNative: 91, dailyPnl: 2, dailyPnlPct: 1.68 },
    { symbol: 'D', currency: 'USD', price: 0, marketValue: 0, pnl: null, dailyPnl: null }
  ];
  const ordered = (key, dir) => buildHoldingsGroups(rows, key, dir, { usdCnyRate: 7 }).map(g => g.items.map(h => h.symbol).join(''));
  for (const key of ['pnl', 'pnlPct', 'dailyPnl', 'dailyPnlPct']) {
    assert.deepEqual(ordered(key, -1), ['C', 'AB', 'D']);
    assert.deepEqual(ordered(key, 1), ['AB', 'C', 'D']);
  }
  assert.deepEqual(ordered('position', -1), ['AB', 'C', 'D']);
  assert.deepEqual(ordered('position', 1), ['C', 'AB', 'D']);
});

test('account sorting orders individual rows even when one ticker spans accounts', () => {
  const rows = [
    { symbol: 'A', accountName: '券商 10' },
    { symbol: 'B', accountName: '券商 2' },
    { symbol: 'A', accountName: '券商 2' },
    { symbol: 'C' }
  ];
  const ordered = dir => buildHoldingsGroups(rows, 'account', dir).map(g => g.items[0]);
  assert.deepEqual(ordered(1), [rows[2], rows[1], rows[0], rows[3]]);
  assert.deepEqual(ordered(-1), [rows[0], rows[2], rows[1], rows[3]]);
});

test('merged totals use weighted ratios and sort by the same partial total shown in the table', () => {
  const rows = [
    { symbol: 'A', currency: 'USD', marketValue: 110, marketValueNative: 110, pnl: 10, pnlPct: 10, costBasisNative: 100, dailyPnl: 2, dailyPnlPct: 1.85 },
    { symbol: 'B', groupWith: 'A', currency: 'CNY', marketValue: 918, marketValueNative: 6426, pnl: 126, pnlPct: 2, costBasisNative: 6300 },
    { symbol: 'C', currency: 'USD', marketValue: 100, dailyPnl: 1 },
  ];
  const [group, next] = buildHoldingsGroups(rows, 'dailyPnl', -1, { usdCnyRate: 7 });
  assert.equal(group.key, 'A');
  assert.equal(next.key, 'C');
  assert.deepEqual(group.summary.pnl, { value: 28, count: 2 });
  assert.deepEqual(group.summary.position, { value: 1028, count: 2 });
  assert.equal(group.summary.pnlPct.value.toFixed(2), '2.80');
  assert.deepEqual(group.summary.dailyPnl, { value: 2, count: 1 });
  assert.equal(group.summary.dailyPnlPct.value.toFixed(2), '1.85');
  assert.equal(group.summary.dailyPnlPct.count, 1);
});
