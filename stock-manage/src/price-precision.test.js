import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { normalizeTrade, deriveHoldings, applyCashDelta, roundPrice } from './trades.js';
import { parseImportBuffer } from './import-moomoo.js';
import { formatPrice, priceInputValue } from '../public/js/price-format.js';

test('three-decimal ETF and option trades retain price, cost and cash consistency', () => {
  for (const [symbol, shares, amount] of [['159509', 1000, 1234], ['QQQ261009C600', 10, 1234]]) {
    const trade = normalizeTrade({ symbol, type: 'buy', shares, price: '1.234', commission: 0.56 });
    assert.equal(trade.price, 1.234);
    assert.equal(trade.total_amount, amount);
    assert.equal(deriveHoldings([trade])[0].avgCost, 1.234);
    const cash = applyCashDelta({ cashUsd: 5000, cashCny: 5000 }, trade);
    assert.equal(symbol === '159509' ? cash.cashCny : cash.cashUsd, 3765.44);
  }
  const rounded = normalizeTrade({ symbol: 'AAPL', type: 'buy', shares: 1000, price: 1.2346 });
  assert.equal(rounded.price, 1.235);
  assert.equal(rounded.total_amount, 1235);
  assert.equal(roundPrice(1.234), 1.234);
});

test('Moomoo and both backup layouts preserve third-decimal prices', () => {
  const layouts = [
    [['方向', '代码', '名称', '交易状态', '成交价格', '成交金额', '成交数量', '成交时间', '合计费用'],
      ['买入', 'AAPL', 'Apple', '全部成交', 1.234, 123.4, 100, '2026-10-02 10:00:00', 0.56]],
    [['时间', '类型', '其它类别', '代码', '名称', '股数', '价格', '金额', '手续费'],
      ['2026-10-02', '买入', '', 'AAPL', 'Apple', 100, 1.234, 123.4, 0.56]],
    [['时间', '类型', '代码', '名称', '股数', '价格', '金额', '手续费'],
      ['2026-10-02', '买入', 'AAPL', 'Apple', 100, 1.234, 123.4, 0.56]]
  ];
  for (const rows of layouts) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '交易记录');
    const [trade] = parseImportBuffer(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    assert.equal(trade.price, 1.234);
    assert.equal(trade.total_amount, 123.4);
    assert.equal(trade.commission, 0.56);
  }
});

test('price display pads three decimals and leaves missing prices empty', () => {
  assert.equal(formatPrice(1.234, 'CNY'), '¥1.234');
  assert.equal(formatPrice(600, 'USD'), '$600.000');
  assert.equal(formatPrice(0.125), '0.125');
  assert.equal(formatPrice(1234.5678), '1,234.568');
  assert.equal(priceInputValue(1.2), '1.200');
  for (const value of [null, undefined, '', ' ', NaN, Infinity]) {
    assert.equal(formatPrice(value), '—');
    assert.equal(priceInputValue(value), '');
  }
});
