import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrade,
  applyCashDelta,
  undoCashDelta,
  enrichHoldings,
  deriveHoldings,
  computeSymbolSummaries,
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

function summaryTrade(type, shares, price, day, extras = {}) {
  return normalizeTrade({ type, symbol: 'AAPL', shares, price, commission: 0,
    trade_date: `2026-09-${day}T12:00:00Z`, ...extras });
}

test('summary keeps real historical names when later trades only contain the symbol', () => {
  const trades = [summaryTrade('buy', 1, 100, '01', { name: 'Apple Inc.' }), summaryTrade('sell', 1, 120, '10')];
  const [row] = computeSymbolSummaries(trades, { startDate: '2026-09-10' });
  assert.equal(row.name, 'Apple Inc.');
  const [fallback] = computeSymbolSummaries([summaryTrade('buy', 1, 100, '01')], { quotes: { AAPL: { name: 'Apple Inc.' } } });
  assert.equal(fallback.name, 'Apple Inc.');
  const [missing] = computeSymbolSummaries([summaryTrade('buy', 1, 100, '01')]);
  assert.equal(missing.name, '');
});

test('summary return matches pre-window buys after pre-window sales', () => {
  const trades = [summaryTrade('buy', 10, 100, '01'), summaryTrade('sell', 5, 110, '02'),
    summaryTrade('sell', 5, 120, '10', { commission: 1 })];
  const [row] = computeSymbolSummaries(trades, { startDate: '2026-09-10', endDate: '2026-09-10' });
  assert.equal(row.totalBuyAmount, 0);
  assert.equal(row.netPnl, 99);
  assert.equal(row.soldCostAmount, 500);
  assert.equal(row.netPnlRate, 19.8);
  assert.equal(row.pnlRateUnavailableReason, null);
});

test('summary denominator excludes unsold purchases and uses FIFO across option lots', () => {
  const [equity] = computeSymbolSummaries([summaryTrade('buy', 10, 100, '01'), summaryTrade('sell', 4, 120, '10')]);
  assert.equal(equity.soldCostAmount, 400);
  assert.equal(equity.netPnlRate, 20);
  const symbol = 'QQQ261009C600';
  const [option] = computeSymbolSummaries([summaryTrade('buy', 2, 1, '01', { symbol }),
    summaryTrade('buy', 2, 2, '02', { symbol }), summaryTrade('sell', 3, 2, '10', { symbol })]);
  assert.equal(option.soldCostAmount, 400);
  assert.equal(option.netPnl, 200);
  assert.equal(option.netPnlRate, 50);
});

test('summary return uses matching USD-converted cost for CNY trades', () => {
  const symbol = '159509';
  const [row] = computeSymbolSummaries([summaryTrade('buy', 1000, 1.234, '01', { symbol }),
    summaryTrade('sell', 1000, 1.5, '10', { symbol, commission: 7 })], { usdCnyRate: 7 });
  assert.equal(row.soldCostAmount, roundMoney(1234 / 7));
  assert.equal(row.netPnl, 37);
  assert.equal(row.netPnlRate, 20.99);
});

test('missing purchase costs and unsold holdings leave the return unavailable', () => {
  for (const trades of [[summaryTrade('sell', 1, 120, '10')],
    [summaryTrade('buy', 1, 100, '01'), summaryTrade('sell', 2, 120, '10')]]) {
    const [row] = computeSymbolSummaries(trades);
    assert.equal(row.netPnlRate, null);
    assert.equal(row.pnlRateUnavailableReason, 'missing-buy-cost');
  }
  const [unsold] = computeSymbolSummaries([summaryTrade('buy', 1, 100, '01')]);
  assert.equal(unsold.netPnlRate, null);
  assert.equal(unsold.pnlRateUnavailableReason, 'no-sold-cost');
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
  assert.equal(ashare.pnl, 100); // 本币盈亏
  assert.equal(ashare.dailyPnl, 100); // 本币当日盈亏
  assert.equal(enriched.unrealizedCny, 100);
  assert.equal(enriched.ashareMvNative, 1500);
  assert.ok(enriched.ashareMv > 0);
  assert.equal(enriched.cashUsdEq, cashUsdEquivalent(100, 700, 7));
  assert.equal(enriched.totalAssets, roundMoney(enriched.totalMv + enriched.cashUsdEq));
  // QQQ 10*420=4200 + cash 100 = 4300 USD assets; 159509 1500 + cash 700 = 2200 CNY
  assert.equal(enriched.assetsUsd, 4300);
  assert.equal(enriched.assetsCny, 2200);
  assert.equal(enriched.totalAssetsCny, roundMoney(4300 * 7 + 2200));
});
