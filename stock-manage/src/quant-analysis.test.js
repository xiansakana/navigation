import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles, DEFAULT_QUANT_CONFIG } from './quant-analysis.js';

function makeCandles(count, start = 100) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * 0.5;
    return {
      timestamp: (index + 1) * 86400000,
      open: close - 0.2,
      high: close + 0.4,
      low: close - 0.4,
      close,
      volume: 1000 + index
    };
  });
}

test('quant analysis returns indicator fields for a sufficiently long series', () => {
  const result = analyzeCandles({
    symbol: 'AAPL',
    name: 'Apple',
    price: 160,
    changePercent: 1.25,
    candles: makeCandles(120)
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.symbol, 'AAPL');
  assert.equal(result.name, 'Apple');
  assert.equal(result.dataPoints, 120);
  assert.equal(result.trend, 'ABOVE_SMA50');
  assert.ok(Number.isFinite(result.rsi));
  assert.ok(Number.isFinite(result.combinedScore));
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(result.signal));
});

test('quant analysis explains insufficient history', () => {
  const result = analyzeCandles({
    symbol: 'IPO',
    candles: makeCandles(30),
    config: DEFAULT_QUANT_CONFIG
  });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.dataPoints, 30);
  assert.match(result.message, /至少需要 50 条/);
  assert.equal(result.rsi, null);
});
