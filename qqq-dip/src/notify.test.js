import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendMarketSnapshot } from './notify.js';

test('QQ market snapshot includes price, daily change and drawdown from H', () => {
  const text = appendMarketSnapshot('T2 触发。', {
    price: 475.91,
    changePercent: -2.345,
    drawdownLive: -12,
    H: 540.81
  }, 'QQQ');

  assert.equal(
    text,
    'T2 触发。\n行情：QQQ 现价 475.91｜当日涨跌幅 -2.35%｜相对 H 回撤 -12.00%（H 540.81）'
  );
});

test('QQ market snapshot keeps unavailable quote fields explicit', () => {
  const text = appendMarketSnapshot('开盘摘要', {
    price: 100,
    changePercent: 1.2,
    drawdownLive: null,
    H: null
  }, 'SOXL');

  assert.match(text, /SOXL 现价 100\.00/);
  assert.match(text, /当日涨跌幅 \+1\.20%/);
  assert.match(text, /相对 H 回撤 —（H —）/);
});
