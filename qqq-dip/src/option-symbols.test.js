import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from './quotes.js';

test('plan OCC and Polygon option tickers keep the actual strike when fetching quotes', () => {
  const quotes = createQuoteService({});
  for (const symbol of ['QQQ270115C700', 'QQQ270115C00700000', 'O:QQQ270115C00700000']) {
    assert.equal(quotes.parseOptionSymbol(symbol).strike, '700');
    assert.equal(quotes.toPolygonOptionSymbol(symbol), 'O:QQQ270115C00700000');
  }
  assert.equal(quotes.toPolygonOptionSymbol('QQQ270115P00700500'), 'O:QQQ270115P00700500');
  assert.equal(quotes.parseOptionSymbol('bad'), null);
});
