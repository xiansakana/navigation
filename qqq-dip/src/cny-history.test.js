import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCnyHistoryLoader, parseCnyHistory } from './cny-history.js';
import { statsFromMarket } from './playbook.js';

const rows = Array.from({ length: 65 }, (_, i) => [
  new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), '3', '3', '4', '2', '100'
]);
const tencent = { data: { sz159509: { qfqday: rows } } };

test('159509 uses its own sorted adjusted history and 60-bar high', () => {
  const candles = parseCnyHistory({ data: { klines: rows.slice().reverse().map((r) => r.join(',')) } }, 'eastmoney');
  candles[0].h = 100; // Outside the 60-bar lookback.
  const stats = statsFromMarket({ symbol: '159509', price: 3, candles });
  assert.equal(stats.H, 4);
  assert.equal(stats.drawdownLive, -25);
  assert.equal(statsFromMarket({ price: 3, candles: [] }).drawdownLive, null);
});

test('history falls back, caches successes, and retries failures', async () => {
  let calls = 0;
  const load = createCnyHistoryLoader(async () => {
    calls++;
    if (calls === 1) throw new Error('unavailable');
    return { data: { klines: rows.map((r) => r.join(',')) } };
  });
  assert.equal((await load()).length, 65);
  await load();
  assert.equal(calls, 2);
  let failingCalls = 0;
  const failing = createCnyHistoryLoader(async () => { failingCalls++; throw new Error('offline'); });
  await assert.rejects(failing(), /offline/);
  await assert.rejects(failing(), /offline/);
  assert.equal(failingCalls, 4);
  assert.equal(parseCnyHistory(tencent, 'tencent').length, 65);
  assert.throws(() => parseCnyHistory({ data: { sz159509: { qfqday: rows.slice(0, 59) } } }, 'tencent'), /不足60/);
});

test('percentage renderer keeps unavailable values distinct from a true zero', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = source.match(/function fmtPct\(n, digits = 2\) \{[\s\S]*?\n\}/)[0];
  const format = vm.runInNewContext(`(${fn})`);
  for (const value of [null, undefined, '', NaN]) assert.equal(format(value), '—');
  assert.equal(format(0), '0.00%');
  assert.equal(format(-25), '-25.00%');
});
