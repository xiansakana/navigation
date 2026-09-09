import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrade,
  applyCashDelta,
  undoCashDelta,
  enrichHoldings,
  deriveHoldings,
  cashUsdEquivalent,
  roundMoney
} from './trades.js';

test('normalizeTrade infers CNY for A-share', () => {
  const t = normalizeTrade({
    type: 'buy',
    symbol: 'sz159509',
    shares: 100,
    price: 1.23,
    commission: 0.5
  });
  assert.equal(t.symbol, '159509');
  assert.equal(t.currency, 'CNY');
  assert.equal(t.total_amount, 123);
});

test('applyCashDelta deducts CNY pocket for A-share buys', () => {
  const trade = normalizeTrade({
    type: 'buy',
    symbol: '159509',
    shares: 1000,
    price: 1,
    commission: 5
  });
  const next = applyCashDelta({ cashUsd: 1000, cashCny: 5000, usdCnyRate: 7 }, trade);
  assert.equal(next.cashUsd, 1000);
  assert.equal(next.cashCny, 3995);
  const undone = undoCashDelta(next, trade);
  assert.equal(undone.cashCny, 5000);
});

test('enrichHoldings converts CNY market value to USD', () => {
  const holdings = deriveHoldings([
    normalizeTrade({ type: 'buy', symbol: '159509', shares: 1000, price: 1.4, commission: 0 }),
    normalizeTrade({ type: 'buy', symbol: 'QQQ', shares: 10, price: 400, commission: 0 })
  ]);
  const enriched = enrichHoldings(
    holdings,
    {
      '159509': { price: 1.5, change: 0.1, changePercent: 7 },
      QQQ: { price: 420, change: 2, changePercent: 0.5 }
    },
    { cashUsd: 100, cashCny: 700, usdCnyRate: 7 }
  );
  const ashare = enriched.rows.find((r) => r.symbol === '159509');
  assert.equal(ashare.currency, 'CNY');
  assert.equal(ashare.marketValueNative, 1500);
  assert.equal(ashare.marketValue, roundMoney(1500 / 7));
  assert.ok(enriched.ashareMv > 0);
  assert.equal(enriched.cashUsdEq, cashUsdEquivalent(100, 700, 7));
  assert.equal(enriched.totalAssets, roundMoney(enriched.totalMv + enriched.cashUsdEq));
});
