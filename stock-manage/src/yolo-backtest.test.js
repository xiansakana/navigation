import test from 'node:test';
import assert from 'node:assert/strict';
import { backtestYoloDataset } from './yolo-backtest.js';

function capture(time, spot, bid, ask = bid + 0.05) {
  return {
    marketDate: '2026-09-22', capturedAt: `2026-09-22T${time}:00-04:00`, underlyingPrice: spot,
    quotes: [{ optionSymbol: 'O:QQQ260923C00600000', right: 'C', strike: 600,
      expiration: '2026-09-23', bid, ask, delta: 0.45 }]
  };
}

test('backtest buys ask, sells observed bid and includes commissions', () => {
  const result = backtestYoloDataset([
    capture('09:30', 600, 0.9, 1.0),
    capture('09:45', 601.2, 0.95, 1.0),
    capture('10:00', 603, 1.60, 1.65)
  ], { targetDelta: 0.45, minMovePct: 0.001, initialCapital: 100000 });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, 'profit target');
  assert.equal(result.trades[0].entryAsk, 1);
  assert.equal(result.trades[0].exitBid, 1.6);
  assert.ok(result.trades[0].netPnl < result.trades[0].grossPnl);
});

test('backtest records stop gaps at the actual bid', () => {
  const result = backtestYoloDataset([
    capture('09:30', 600, 0.9, 1.0),
    capture('09:45', 601.2, 0.95, 1.0),
    capture('09:50', 599, 0.4, 0.45)
  ], { minMovePct: 0.001 });
  assert.equal(result.trades[0].reason, 'premium stop');
  assert.equal(result.trades[0].optionReturn, -0.6);
});

test('backtest skips days without a sufficient opening move', () => {
  const result = backtestYoloDataset([
    capture('09:30', 600, 0.9, 1.0), capture('09:45', 600.2, 0.95, 1.0)
  ], { minMovePct: 0.0015 });
  assert.equal(result.trades.length, 0);
});
