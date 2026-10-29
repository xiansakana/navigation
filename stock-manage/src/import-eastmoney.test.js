import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseEastmoneyBuffer, mergeEastmoneyTrades } from './import-eastmoney.js';
import { parseImportBuffer } from './import-moomoo.js';
import { cashDelta, deriveHoldings, computePnl } from './trades.js';

const columns = ['交收日期','发生日期','发生时间','证券代码','证券名称','交易类别','成交数量','成交均价','成交金额','发生金额','佣金','其他费用','印花税','过户费','成交编号','流水号','股东账号','币种'];
const row = { 交收日期:'2026-10-23',发生日期:'2026-10-23',发生时间:'13:45:37',证券代码:'501225',证券名称:'全球芯片LOF',交易类别:'证券买入',成交数量:200,成交均价:3.554,成交金额:710.8,发生金额:-710.98,佣金:0.15,其他费用:0.03,印花税:0,过户费:0,成交编号:'000123',流水号:'000456',股东账号:'A',币种:'人民币' };
function buffer(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns,...rows.map(r=>columns.map(k=>r[k]))]), 'Sheet1');
  return XLSX.write(book,{type:'buffer',bookType:'xlsx'});
}
test('Eastmoney keeps exact cash, fees, Chinese names, leading zero IDs and settlement date', () => {
  const [t] = parseImportBuffer(buffer([row]));
  assert.equal(t.broker,'eastmoney'); assert.equal(t.name,row.证券名称);
  assert.equal(t.total_amount,710.8); assert.equal(t.commission,0.18); assert.equal(cashDelta(t),-710.98);
  assert.equal(t.trade_date,'2026-10-23T05:45:37.000Z');
  const sell = {...row,交易类别:'证券卖出',发生金额:710.62};
  assert.equal(cashDelta(parseEastmoneyBuffer(buffer([sell]))[0]),710.62);
  assert.throws(()=>parseEastmoneyBuffer(buffer([{...row,发生金额:-710.8}])),/不一致/);
  assert.throws(()=>parseEastmoneyBuffer(buffer([{...row,交收日期:'2026-02-30'}])),/日期/);
  assert.throws(()=>parseEastmoneyBuffer(buffer([{...row,发生时间:'24:00:00'}])),/时间/);
  assert.throws(()=>parseEastmoneyBuffer(buffer([{...row,佣金:-1}])),/费用/);
});
test('dividends and interest are income, principal and transfers remain explicitly excluded', () => {
  const dividend = {...row,交易类别:'红利入账',成交数量:1000,成交均价:0.012,成交金额:12,发生金额:12,佣金:0,其他费用:0};
  const interest = {...dividend,交易类别:'利息归本',证券代码:'--',证券名称:'--',发生金额:0.14};
  const ignored = ['天天宝申购','天天宝赎回','银行转证券','证券转银行','报价融券回购','报价融券购回','台账间现金划转存','台账间现金划转取','未知业务'].map(交易类别=>({...row,交易类别}));
  const parsed = parseEastmoneyBuffer(buffer([dividend,interest,...ignored]));
  assert.equal(parsed.length,2); assert.equal(parsed.importInfo.sourceCount,11);
  assert.equal(parsed.importInfo.excluded.length,9); assert.deepEqual(deriveHoldings(parsed),[]);
  assert.equal(parsed[0].other_category,'股息'); assert.equal(parsed[1].other_category,'利息');
  assert.equal(parsed[1].symbol,'OTHER');
});
test('new bond payment and receipt form one costed buy, missing linkage never becomes zero cost', () => {
  const payment = {...row,交易类别:'配售缴款',证券代码:'754019',证券名称:'曙26发债',成交数量:10,成交均价:100,成交金额:1000,发生金额:-1000,佣金:0,其他费用:0,交收日期:'2026-07-17',发生日期:'2026-07-15'};
  const receipt = {...payment,交易类别:'新股入账',证券代码:'113708',证券名称:'曙26转债',成交金额:0,发生金额:0,成交均价:0,交收日期:'2026-08-05'};
  const parsed = parseEastmoneyBuffer(buffer([receipt,payment]));
  assert.equal(parsed.length,1); assert.equal(parsed[0].symbol,'113708');
  assert.equal(parsed[0].price,100); assert.equal(parsed[0].total_amount,1000); assert.equal(cashDelta(parsed[0]),-1000);
  assert.equal(deriveHoldings(parsed)[0].avgCost,100);
  const sell = {...parsed[0],id:'sale',type:'sell',price:120,total_amount:1200,trade_date:'2026-08-06T00:00:00Z'};
  assert.equal(computePnl([...parsed,sell],{usdCnyRate:1}).realizedPL,200);
  assert.equal(parseEastmoneyBuffer(buffer([payment])).length,0);
  assert.match(parseEastmoneyBuffer(buffer([receipt])).importInfo.warnings.join(''),/缺少缴款/);
  assert.throws(()=>mergeEastmoneyTrades([{...parsed[0],broker_order_key:undefined,trade_date:'2026-08-05T07:00:00Z'}],parsed,'a'),/新债/);
});
test('overlapping exports are idempotent, updates retain IDs and unassigned/ambiguous history blocks duplication', () => {
  const incoming = parseEastmoneyBuffer(buffer([row]));
  const first = mergeEastmoneyTrades([],incoming,'a');
  assert.equal(first.summary.added,1); assert.match(first.trades[0].id,/^eastmoney-/);
  assert.equal(mergeEastmoneyTrades(first.trades,incoming,'a').summary.skipped,1);
  assert.equal(mergeEastmoneyTrades(first.trades,incoming,'b').summary.added,1);
  const corrected = parseEastmoneyBuffer(buffer([{...row,佣金:0.17,发生金额:-711}]));
  const changed = mergeEastmoneyTrades(first.trades,corrected,'a');
  assert.equal(changed.summary.updated,1); assert.equal(changed.trades[0].id,first.trades[0].id);
  const manual = {...incoming[0],id:'manual',broker_order_key:undefined};
  assert.equal(mergeEastmoneyTrades([manual],incoming,'a').summary.unassigned,1);
  assert.throws(()=>parseEastmoneyBuffer(buffer([row,row])),/重复/);
});
