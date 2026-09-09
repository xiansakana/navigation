import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAShareSymbol,
  ashareExchange,
  normalizeSymbol,
  inferMarket,
  inferCurrency,
  holdingTypeForSymbol
} from './markets.js';

test('isAShareSymbol accepts bare and decorated codes', () => {
  assert.equal(isAShareSymbol('159509'), true);
  assert.equal(isAShareSymbol('sz159509'), true);
  assert.equal(isAShareSymbol('SH510300'), true);
  assert.equal(isAShareSymbol('600519.SS'), true);
  assert.equal(isAShareSymbol('000001.SZ'), true);
  assert.equal(isAShareSymbol('QQQ'), false);
  assert.equal(isAShareSymbol('QQQ270115C00700000'), false);
});

test('ashareExchange maps SH vs SZ', () => {
  assert.equal(ashareExchange('159509'), 'sz');
  assert.equal(ashareExchange('510300'), 'sh');
  assert.equal(ashareExchange('600519'), 'sh');
  assert.equal(ashareExchange('000001'), 'sz');
  assert.equal(ashareExchange('300750'), 'sz');
});

test('normalizeSymbol and inferMarket', () => {
  assert.equal(normalizeSymbol('sz159509'), '159509');
  assert.equal(normalizeSymbol('qqq'), 'QQQ');
  assert.equal(inferMarket('159509'), 'CN');
  assert.equal(inferMarket('QQQ'), 'US');
  assert.equal(inferMarket('QQQ270115C700'), 'OPTION');
  assert.equal(inferCurrency('159509'), 'CNY');
  assert.equal(inferCurrency('QQQ'), 'USD');
  assert.equal(inferCurrency('QQQ', 'CNY'), 'CNY');
  assert.equal(holdingTypeForSymbol('159509'), 'ashare');
  assert.equal(holdingTypeForSymbol('AAPL'), 'stock');
});
