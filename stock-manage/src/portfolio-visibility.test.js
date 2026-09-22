import test from 'node:test';
import assert from 'node:assert/strict';
import { redactPortfolioCash } from './portfolio-visibility.js';

test('redacts cash and cash-derived asset totals without mutating the portfolio', () => {
  const portfolio = {
    cash: 1500,
    cashUsd: 1000,
    cashCny: 3500,
    usdCnyRate: 7,
    holdings: [{ symbol: 'AAPL' }],
    summary: {
      cashUsdEq: 1500,
      totalAssets: 12000,
      totalAssetsCny: 84000,
      assetsUsd: 9000,
      assetsCny: 21000,
      stockMv: 10500,
      totalPnl: 800
    }
  };

  const result = redactPortfolioCash(portfolio);
  assert.equal(result.cashVisible, false);
  assert.equal('cash' in result, false);
  assert.equal('cashUsd' in result, false);
  assert.equal('cashCny' in result, false);
  assert.equal('cashUsdEq' in result.summary, false);
  assert.equal('totalAssets' in result.summary, false);
  assert.equal('totalAssetsCny' in result.summary, false);
  assert.equal('assetsUsd' in result.summary, false);
  assert.equal('assetsCny' in result.summary, false);
  assert.equal(result.summary.stockMv, 10500);
  assert.equal(result.summary.totalPnl, 800);
  assert.equal(portfolio.cashUsd, 1000);
  assert.equal(portfolio.summary.totalAssets, 12000);
});
