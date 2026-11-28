import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const candlesSource = fs.readFileSync(new URL('../public/bookkeeping/candles.js', import.meta.url), 'utf8');
const analysisSource = fs.readFileSync(new URL('../public/bookkeeping/analysis.js', import.meta.url), 'utf8');

function api() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(candlesSource);
  return { dom, candles: dom.window.bkCandles };
}

test('candle period widens as the series gets longer', () => {
  const { dom, candles } = api();
  try {
    const days = (n, start = '2025-01-01') => Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.parse(start + 'T12:00:00Z') + i * 86400000);
      return d.toISOString().slice(0, 10);
    });
    assert.equal(candles.chooseBucket(days(10)).unit, 'week');
    assert.equal(candles.chooseBucket(days(365)).unit, 'month');
    assert.equal(candles.chooseBucket(days(1095)).unit, 'quarter');
    // Monthly points are far apart, so even a short list needs a wider period.
    assert.equal(candles.chooseBucket(['2025-01-01', '2025-02-01', '2025-03-01']).unit, 'quarter');
    // A single point has no spacing to measure; keep the narrowest period.
    assert.equal(candles.chooseBucket(['2025-01-01']).unit, 'week');
  } finally { dom.window.close(); }
});

test('each candle carries open, high, low and close from the points it groups', () => {
  const { dom, candles } = api();
  try {
    const points = [
      { date: '2026-10-05', balance: 10 },
      { date: '2026-10-07', balance: 30 },
      { date: '2026-10-09', balance: 5 },
      { date: '2026-10-12', balance: 20 },
      { date: '2026-10-13', balance: 25 }
    ];
    const rows = candles.buildCandles(points, 'balance', { unit: 'week' });
    assert.equal(rows.length, 2);
    assert.equal(rows.length, 2);
    // 开 = 上一个观测值（K 线惯例），所以第二根从上一根的收盘 5 起跳。
    assert.deepEqual([...rows].map(r => [r.start, r.open, r.high, r.low, r.close, r.count].join('|')), [
      '2026-10-05|10|30|5|5|3',
      '2026-10-12|5|25|5|25|2'
    ]);
  } finally { dom.window.close(); }
});

test('missing values leave gaps instead of inventing a flat candle', () => {
  const { dom, candles } = api();
  try {
    const points = [
      { date: '2026-10-05', total: 10 },
      { date: '2026-10-06', total: null },
      { date: '2026-10-07', total: undefined },
      { date: '2026-10-08', total: 40 }
    ];
    const rows = candles.buildCandles(points, 'total', { unit: 'week' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].open, 10);
    assert.equal(rows[0].close, 40);
    assert.equal(rows[0].count, 2);
    assert.equal(candles.buildCandles([], 'total', { unit: 'week' }).length, 0);
  } finally { dom.window.close(); }
});

test('buckets align to calendar boundaries, not to the first data point', () => {
  const { dom, candles } = api();
  try {
    assert.equal(candles.bucketKey('2026-10-01', 'week'), '2026-09-28'); // Thursday → Monday
    assert.equal(candles.bucketKey('2026-10-05', 'week'), '2026-10-05');
    assert.equal(candles.bucketKey('2026-11-30', 'month'), '2026-11-01');
    assert.equal(candles.bucketKey('2026-11-30', 'quarter'), '2026-10-01');
    assert.equal(candles.bucketKey('2026-08-15', 'half'), '2026-07-01');
    assert.equal(candles.bucketKey('2026-08-15', 'year'), '2026-01-01');
    assert.equal(candles.bucketLabel('2026-10-01', 'quarter'), '2026 Q4');
  } finally { dom.window.close(); }
});
