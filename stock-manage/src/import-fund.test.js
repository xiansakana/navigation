import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseImportBuffer } from './import-moomoo.js';
import { mergeBbaeTrades } from './import-bbae.js';
import { cashDelta, computePnl, deriveHoldings, normalizeTrade } from './trades.js';
import { tradesWithReinvestmentIncome } from '../../shared/fund-reinvestment.js';

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

test('fund dividends distinguish shares, cash and ambiguous confirmations', () => {
  const reinvestment = [...buy]; reinvestment[3] = '红利发放'; reinvestment[5] = '3.61'; reinvestment[6] = '';
  const cash = [...reinvestment]; cash[5] = '0'; cash[6] = '6.02'; cash[9] = 'contract-2';
  const ambiguous = [...cash]; ambiguous[5] = '3.61'; ambiguous[9] = 'contract-3';
  const result = parse([reinvestment, cash, ambiguous]);
  assert.equal(result.length, 2);
  assert.equal(result.fundImportInfo.excluded[0].count, 1);
  assert.equal(result[0].reinvestedDividend, true);
  assert.equal(cashDelta(result[0]), 0);
  assert.equal(cashDelta(result[1]), 6.02);

  const purchased = normalizeTrade({type:'buy', symbol:'017730.OF', shares:1203.43, price:2, trade_date:'2026-11-01T00:00:00Z'});
  const manual = normalizeTrade({...result[0], trade_date:'2026-11-18T16:11:13+08:00', account_id:'cny'});
  assert.equal(manual.total_amount, 0);
  assert.equal(deriveHoldings([purchased, {...manual, account_id:''}])[0].shares, 1207.04);
  assert.equal(deriveHoldings([purchased, {...manual, account_id:''}])[0].costBasisNative, 2406.86);
  const merged = mergeBbaeTrades([manual], [result[0]], 'cny');
  assert.equal(merged.trades.length, 1);
  assert.equal(merged.summary.updated, 1);
  assert.throws(() => normalizeTrade({...result[0], symbol:'AAPL'}), /场外基金/);
  const priced = normalizeTrade({...manual, reinvestmentNav:1.6656});
  const sale = normalizeTrade({type:'sell', symbol:priced.symbol, shares:3.61, price:2, trade_date:'2026-11-19T00:00:00Z'});
  const pnl = computePnl(tradesWithReinvestmentIncome([priced, {...sale, account_id:'cny'}]), {usdCnyRate:1});
  assert.equal(cashDelta(priced),0);
  assert.equal(pnl.otherAmount,6.01);
  assert.equal(pnl.realizedPL,1.21);
  assert.equal(pnl.netPL,7.22);
});
