import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCandles,
  backtestCandles,
  bollingerBands,
  DEFAULT_QUANT_CONFIG,
  normalizeQuantConfig,
  rsi
} from './quant-analysis.js';

function candles(count, valueAt = (index) => 100 + index * 0.4) {
  return Array.from({ length: count }, (_, index) => {
    const close = valueAt(index);
    return {
      timestamp: Date.UTC(2025, 0, index + 1),
      open: close - 0.2,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000 + index
    };
  });
}

test('normalizes unsafe strategy parameters', () => {
  const config = normalizeQuantConfig({
    rsiPeriod: 999,
    rsiOversold: 80,
    rsiOverbought: 20,
    macdFast: 90,
    macdSlow: 4,
    sellThreshold: -9
  });
  assert.equal(config.rsiPeriod, 50);
  assert.equal(config.rsiOversold, DEFAULT_QUANT_CONFIG.rsiOversold);
  assert.equal(config.rsiOverbought, DEFAULT_QUANT_CONFIG.rsiOverbought);
  assert.equal(config.macdFast, DEFAULT_QUANT_CONFIG.macdFast);
  assert.equal(config.macdSlow, DEFAULT_QUANT_CONFIG.macdSlow);
  assert.equal(config.sellThreshold, -1);
});

test('computes RSI and Bollinger series', () => {
  const closes = candles(60).map((item) => item.close);
  const rsiValues = rsi(closes, 14);
  const bands = bollingerBands(closes, 20, 2);
  assert.equal(rsiValues.length, closes.length);
  assert.equal(rsiValues.at(-1), 100);
  assert.ok(Number.isFinite(bands.upper.at(-1)));
  assert.ok(bands.upper.at(-1) > bands.middle.at(-1));
  assert.ok(bands.middle.at(-1) > bands.lower.at(-1));
});

test('returns a complete signal for sufficient daily candles', () => {
  const result = analyzeCandles({
    symbol: 'AAPL',
    name: 'Apple',
    price: 152,
    changePercent: 1.25,
    candles: candles(120),
    historySource: 'polygon',
    quoteSource: 'finnhub'
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.symbol, 'AAPL');
  assert.equal(result.dataPoints, 120);
  assert.equal(result.historySource, 'polygon');
  assert.equal(result.trend, 'ABOVE_SMA50');
  assert.ok(Number.isFinite(result.rsi));
  assert.ok(Number.isFinite(result.macd));
  assert.ok(Number.isFinite(result.bollingerPosition));
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(result.signal));
});

test('returns an explanatory hold result for insufficient history', () => {
  const result = analyzeCandles({ symbol: 'IPO', candles: candles(20) });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.signal, 'HOLD');
  assert.equal(result.dataPoints, 20);
  assert.match(result.message, /历史数据不足/);
});

test('backtests candles and returns an equity curve', () => {
  const result = backtestCandles({
    symbol: 'AAPL',
    candles: candles(180, (index) => 100 + Math.sin(index / 8) * 12 + index * 0.08),
    initialCapital: 10000
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.initialCapital, 10000);
  assert.ok(result.equityCurve.length > 100);
  assert.ok(Number.isFinite(result.finalEquity));
  assert.ok(Number.isFinite(result.maxDrawdown));
  assert.ok(Array.isArray(result.trades));
  assert.ok(result.trades.every((trade) => ['BUY', 'SELL'].includes(trade.side)));
});
