import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandles, chooseCandleBucket } from '../public/js/pnl-viz.js';

const days = (count, start = '2025-01-01') => Array.from({ length: count }, (_, index) => (
  new Date(Date.parse(start + 'T12:00:00Z') + index * 86400000).toISOString().slice(0, 10)
));

test('the profit chart picks a candle period that matches the range length', () => {
  assert.equal(chooseCandleBucket(days(90)).unit, 'week');
  assert.equal(chooseCandleBucket(days(400)).unit, 'month');
  assert.equal(chooseCandleBucket(days(1200)).unit, 'quarter');
  assert.equal(chooseCandleBucket([]).unit, 'week');
  assert.equal(chooseCandleBucket(['2026-01-02']).unit, 'week');
});

test('candles aggregate cumulative net profit into open, high, low and close', () => {
  const points = [
    { date: '2026-10-05', cumulativeNet: 100 },
    { date: '2026-10-06', cumulativeNet: 40 },
    { date: '2026-10-07', cumulativeNet: 160 },
    { date: '2026-10-08', cumulativeNet: 120 },
    { date: '2026-10-12', cumulativeNet: -20 },
    { date: '2026-10-13', cumulativeNet: 30 }
  ];
  const candles = buildCandles(points, { unit: 'week' });
  assert.equal(candles.length, 2);
  assert.deepEqual(
    candles.map((candle) => [candle.start, candle.open, candle.high, candle.low, candle.close, candle.count].join('|')),
    ['2026-10-05|100|160|40|120|4', '2026-10-12|-20|30|-20|30|2']
  );
  assert.equal(candles[0].short, '10-05');
  assert.match(candles[0].long, /起一周/);
});

test('a gap in the series does not create a flat candle', () => {
  const candles = buildCandles([
    { date: '2026-10-05', cumulativeNet: 10 },
    { date: '2026-10-06', cumulativeNet: null },
    { date: '2026-10-07' }
  ], { unit: 'week' });
  assert.equal(candles.length, 1);
  assert.equal(candles[0].count, 1);
  assert.equal(candles[0].open, candles[0].close);
});
