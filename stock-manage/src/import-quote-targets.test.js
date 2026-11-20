import test from 'node:test';
import assert from 'node:assert/strict';
import { changedHoldingSymbols } from './import-quote-targets.js';

test('import refresh candidates include new and materially changed holdings without duplicate or cash-only work', () => {
  const trade = (id, symbol, commission = 0) => ({ id, symbol, type: 'buy', shares: 1, commission });
  const unchanged = trade('1', 'AAPL');
  const before = [unchanged, trade('2', 'TSM'), trade('3', 'MSFT'), trade('4', 'QQQ')];
  const after = [
    { ...unchanged, name: 'Apple', historicalBackfill: false },
    trade('2', 'TSM', 1), trade('3', 'NVDA'), trade('5', 'NVDA'),
    { id: 'cash', symbol: 'OTHER', type: 'other', total_amount: 5 }
  ];
  assert.deepEqual([...changedHoldingSymbols(before, after)].sort(), ['MSFT', 'NVDA', 'QQQ', 'TSM']);
});
