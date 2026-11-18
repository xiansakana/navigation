import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseImportBuffer } from './import-moomoo.js';
import { mergeBbaeTrades } from './import-bbae.js';
import { deriveHoldings } from './trades.js';

const columns = ['成交日期','基金代码','基金名称','操作','委托数量','成交数量','成交金额','基金公司','基金账号','合同编号'];
function parse(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, ...rows]), 'Sheet1');
  return parseImportBuffer(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}
const buy = ['2026-11-18','017730','嘉实全球产业升级股票发起式（QDII）A','申购','0.00','167.30','500.00','嘉实基金','fund-account','contract-1'];

test('fund confirmations preserve exact cash and confirmed units with stable contract deduplication', () => {
  const incoming = parse([buy]);
  assert.equal(incoming[0].symbol, '017730.OF');
  assert.equal(incoming[0].shares, 167.3);
  assert.equal(incoming[0].total_amount, 500);
  assert.equal(incoming[0].price * incoming[0].shares, 500);
  assert.equal(incoming[0].broker_net, -500);
  const first = mergeBbaeTrades([], incoming, 'cny');
  assert.equal(deriveHoldings(first.trades)[0].shares, 167.3);
  const repeated = mergeBbaeTrades(first.trades, parse([buy]), 'cny');
  assert.equal(repeated.summary.skipped, 1);
  const sell = [...buy]; sell[0] = '2026-11-19'; sell[3] = '赎回'; sell[5] = '67.30'; sell[6] = '210.00'; sell[9] = 'contract-2';
  const combined = mergeBbaeTrades(first.trades, parse([sell]), 'cny');
  assert.ok(Math.abs(deriveHoldings(combined.trades)[0].shares - 100) < 1e-8);
  assert.equal(combined.trades[1].broker_net, 210);
  assert.equal(parse([[...buy.slice(0,3), '转换出', ...buy.slice(4)]]).fundImportInfo.excluded[0].count, 1);
  assert.throws(() => parse([buy, buy]), /重复/);
  assert.throws(() => parse([[...buy.slice(0,5), '0', ...buy.slice(6)]]), /无效/);
});
