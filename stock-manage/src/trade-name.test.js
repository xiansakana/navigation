import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNamedTrade, needsTradeName, backfillTradeName } from './trade-name.js';

const input = { type: 'buy', symbol: 'sz159509', shares: 100, price: 1.234 };

test('bulk name backfill changes only missing names and preserves all trade fields', () => {
  const names = new Map([['159509', '纳指科技ETF景顺']]);
  for (const name of [undefined, '', '  ', 'sz159509', '159509']) {
    const trade = { ...input, id: 'trade-1', name, total_amount: 123.4, trade_date: '2026-09-01' };
    assert(needsTradeName(trade));
    assert.deepEqual(backfillTradeName(trade, names), { ...trade, name: '纳指科技ETF景顺' });
  }
  for (const trade of [{ ...input, name: '自定义名称' }, { ...input, type: 'other', name: '' }]) {
    assert.equal(backfillTradeName(trade, names), trade);
  }
  assert.equal(backfillTradeName(input, new Map()), input);
});

test('blank trade name is resolved using the normalized market symbol', async () => {
  const trade = await normalizeNamedTrade({ ...input, name: '  ' }, async (symbol) => {
    assert.equal(symbol, '159509');
    return { name: '纳指科技ETF' };
  });
  assert.equal(trade.name, '纳指科技ETF');
  assert.equal(trade.price, 1.234);
  assert.equal(trade.total_amount, 123.4);
});

test('manual names and other income do not trigger market lookups', async () => {
  const unexpectedLookup = () => { assert.fail('Unexpected market lookup'); };
  assert.equal((await normalizeNamedTrade({ ...input, name: ' 我的名称 ' }, unexpectedLookup)).name, '我的名称');
  assert.equal((await normalizeNamedTrade({ type: 'other', other_category: '股息', total_amount: 5 }, unexpectedLookup)).name, '股息');
});

test('unavailable or missing market names do not block saving trades', async () => {
  for (const getQuote of [async () => { throw new Error('offline'); }, async () => ({}), async () => ({ name: ' ' })]) {
    const trade = await normalizeNamedTrade(input, getQuote);
    assert.equal(trade.name, '159509');
    assert.equal(trade.total_amount, 123.4);
  }
});
