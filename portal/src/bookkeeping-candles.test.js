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
    assert.deepEqual([...rows].map(r => [r.start, r.open, r.high, r.low, r.close, r.count].join('|')), [
      '2026-10-05|10|30|5|5|3',
      '2026-10-12|20|25|20|25|2'
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

function page(points) {
  const dom = new JSDOM(fs.readFileSync(new URL('../public/bookkeeping/index.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' });
  const w = dom.window;
  const $ = id => w.document.getElementById(id);
  const state = { analysis: { billing: { missingCurrencies: [], granularity: 'day', points }, insights: [], comparisonNote: '', asset: { points: [], historyMode: 'hybrid', missingCurrencies: [], note: '' } } };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.eval(candlesSource);
  w.eval(analysisSource);
  const money = (amount, currency) => currency + ' ' + Number(amount).toFixed(2);
  const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const drills = [];
  const controller = w.createBookkeepingAnalysis({
    $, esc, money, m: (a, c) => '<span data-money>' + money(a, c) + '</span>', can: () => true,
    load() {}, tab: name => drills.push(name), getState: () => state,
    periods: { focusDate: data => drills.push(data), restore() {} }
  });
  controller.render();
  return { dom, w, $, controller, drills };
}

test('the bookkeeping trend card opens as candlesticks and can switch back to lines', () => {
  const points = Array.from({ length: 14 }, (_, i) => ({
    date: new Date(Date.parse('2026-10-05T12:00:00Z') + i * 86400000).toISOString().slice(0, 10),
    currency: 'CNY', income: 100 + i, expense: 40 + i, cumulative: 60 + i * 2
  }));
  const f = page(points);
  try {
    const host = f.$('billing-charts');
    assert.equal(host.querySelector('[data-chart-mode="candle"]').getAttribute('aria-pressed'), 'true');
    assert.equal(host.querySelectorAll('polyline').length, 0);
    const candles = [...host.querySelectorAll('[data-chart-series="cumulative"] .bk-candle')];
    assert.ok(candles.length >= 2, 'two weeks of daily points should form at least two candles');
    const title = candles[0].querySelector('title').textContent;
    assert.match(title, /开 .* 高 .* 低 .* 收 /);
    assert.match(title, /个数据点/);
    assert.match(host.textContent, /每根 K 线按「周」聚合/);
    // Direction, not series colour: 阳线绿、阴线红（与股票模块一致）。
    const up = host.querySelector('[data-chart-series="cumulative"] .bk-candle[data-dir="up"] rect');
    assert.ok(up, 'a rising period should render an up candle');
    assert.equal(up.getAttribute('fill'), 'var(--green)');
    assert.equal(up.getAttribute('stroke'), 'var(--green)');
    assert.equal(host.querySelector('.bk-series-toggle[data-candle="1"]')?.dataset.candle, '1');
    // Candles are drillable exactly like the old data points.
    const rect = candles[0].querySelector('rect[data-drill]');
    assert.ok(rect, 'candle bodies keep the period drill-down');
    rect.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true }));
    assert.equal(f.drills[0].flow, 'net');

    host.querySelector('[data-chart-mode="line"]').click();
    assert.equal(host.querySelectorAll('.bk-candle').length, 0);
    assert.equal(host.querySelectorAll('polyline').length, 3);
    host.querySelector('[data-chart-mode="candle"]').click();
    assert.ok(host.querySelectorAll('.bk-candle').length >= 2);
    assert.equal(host.querySelector('.bk-chart-modes [aria-pressed="true"]').dataset.chartMode, 'candle');
  } finally { f.dom.window.close(); }
});

test('a falling period draws a red candle', () => {
  const points = Array.from({ length: 10 }, (_, i) => ({
    date: new Date(Date.parse('2026-10-05T12:00:00Z') + i * 86400000).toISOString().slice(0, 10),
    currency: 'CNY', income: 0, expense: 50, cumulative: 1000 - i * 40
  }));
  const f = page(points);
  try {
    const down = f.$('billing-charts').querySelector('[data-chart-series="cumulative"] .bk-candle[data-dir="down"] rect');
    assert.ok(down, 'a declining period should render a down candle');
    assert.equal(down.getAttribute('fill'), 'var(--red)');
    assert.match(down.closest('.bk-candle').querySelector('title').textContent, /区间收低/);
  } finally { f.dom.window.close(); }
});
