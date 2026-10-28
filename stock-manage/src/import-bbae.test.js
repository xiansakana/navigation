import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseBbaeBuffer, mergeBbaeTrades } from './import-bbae.js';
import { parseImportBuffer } from './import-moomoo.js';
const headers = ['订单状态','方向','期权代码','成交价','成交数量','总计','下单时间','成交时间'];
const row = ['已成','卖出','QQQ261028C720','$3.880',2,'$773.96','2026/10/27 23:06:26','2026/10/27 23:06:26'];
function buffer(rows, columns = headers) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, ...rows]), '订单');
  return XLSX.write(book, { type:'buffer', bookType:'xlsx' });
}
test('BBAE exact net proceeds determine option multiplier, all fees and Beijing time', () => {
  const [t] = parseImportBuffer(buffer([row, ['已撤','卖出','QQQ261028C720','','','$0.00','','']]));
  assert.equal(t.total_amount, 776); assert.equal(t.commission, 2.04);
  assert.equal(t.total_amount - t.commission, 773.96);
  assert.equal(t.trade_date, '2026-10-27T15:06:26.000Z');
  assert.equal(parseBbaeBuffer(buffer([row]))[0].id, t.id);
  const buy = parseBbaeBuffer(buffer([['已成','买入','QQQ261028C720','$2.600',3,'$783.03',row[6],row[7]]]))[0];
  assert.equal(buy.total_amount, 780); assert.equal(buy.commission, 3.03);
});
test('stock orders use multiplier one, exclude unfilled orders and include executed partial cancellations', () => {
  const columns = headers.map(x=>x==='期权代码'?'股票代码':x);
  const [t] = parseBbaeBuffer(buffer([['部成已撤','买入','GOOG','$328.935',2,'$658.87',row[6],row[7]]], columns));
  assert.equal(t.total_amount,657.87);assert.equal(t.commission,1);
  assert.deepEqual(parseBbaeBuffer(buffer([['已撤','买入','GOOG','','','$0.00','','']],columns)),[]);
});
test('BBAE duplicate imports are idempotent and cumulative fills update within the selected account', () => {
  const [t] = parseBbaeBuffer(buffer([row]));
  const first=mergeBbaeTrades([], [t], 'a');
  const second=mergeBbaeTrades(first.trades,[t],'a');
  assert.deepEqual(second.summary,{added:0,updated:0,skipped:1});assert.equal(second.trades.length,1);
  const partial={...t,shares:1,total_amount:388,commission:1.02};
  const started=mergeBbaeTrades([], [partial], 'a');
  const complete=mergeBbaeTrades(started.trades,[t],'a');
  assert.equal(complete.summary.updated,1);assert.equal(complete.trades.length,1);assert.equal(complete.trades[0].id,started.trades[0].id);
  const other=mergeBbaeTrades(first.trades,[t],'b');
  assert.equal(other.summary.added,1);assert.notEqual(other.trades[0].id,other.trades[1].id);
});
test('manual matches retain IDs and names; ambiguous records and invalid source data reject atomically', () => {
  const [t] = parseBbaeBuffer(buffer([row]));
  const manual={...t,id:'manual',name:'QQQ Call',account_id:'a',commission:2.02,broker_order_key:undefined,trade_date:'2026-10-27T15:06:00.000Z'};
  const plan=mergeBbaeTrades([manual],[t],'a');
  assert.equal(plan.summary.updated,1);assert.equal(plan.trades[0].id,'manual');assert.equal(plan.trades[0].name,'QQQ Call');assert.equal(manual.commission,2.02);
  assert.throws(()=>mergeBbaeTrades([manual,{...manual,id:'another'}],[t],'a'),/多条历史记录/);
  assert.throws(()=>mergeBbaeTrades([],[t],''),/请选择/);
  const rounded = {...manual,trade_date:'2026-10-27T15:07:00.000Z'};
  assert.equal(mergeBbaeTrades([rounded],[t],'a').summary.updated,1);
  const unassigned = mergeBbaeTrades([{...manual,account_id:undefined}],[t],'a');
  assert.equal(unassigned.summary.unassigned,1);assert.equal(unassigned.summary.added,0);assert.equal(unassigned.trades.length,1);
  assert.throws(()=>parseBbaeBuffer(buffer([[...row.slice(0,2),'QQQ261028PC720',...row.slice(3)]])),/成交数据无效/);
  assert.throws(()=>parseBbaeBuffer(buffer([row,row])),/无法安全区分/);
  assert.throws(()=>parseBbaeBuffer(buffer([[...row.slice(0,5),'$999.00',...row.slice(6)]])),/矛盾/);
});
