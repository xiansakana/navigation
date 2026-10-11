import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { analyzeBookkeeping, assetTrends } from './bookkeeping-analysis.js';
import { createBookkeepingStore, summarize } from './bookkeeping-store.js';
const day='2026-10-11',date=day+'T12:00:00', settings={budgets:{'2026-10':100}};
const e=(type,amount,extra={})=>({date,type,amount,currency:'CNY',category:'餐饮',fee:0,...extra});
test('billing trends reconcile refunds and fees, zero-fill days, and separate currencies',()=>{
  const entries=[e('支出',50),e('收入',100),e('退款入账',10),e('转账',1000,{fee:2}),e('余额调整',100),e('支出',3,{currency:'USD'})];
  const result=analyzeBookkeeping(entries,entries,null,settings,{month:'2026-10'},day);
  const cny=result.billing.points.filter(p=>p.currency==='CNY');assert.equal(cny.length,11);assert.equal(cny[0].income,0);assert.equal(cny.at(-1).expense,42);assert.equal(cny.at(-1).cumulative,58);
  assert.equal(result.billing.points.filter(p=>p.currency==='USD').at(-1).cumulative,-3);
  assert.equal(result.insights.find(i=>i.currency==='CNY').net,58);assert.equal(result.asset,null);
  assert.equal(result.insights[0].comparison,null);
});
test('complete month comparison uses matching book scope and partial category views do not claim total budget',()=>{
  const prior=[e('支出',40,{date:'2026-09-10T12:00:00',book:'个人'}),e('支出',1000,{date:'2026-09-10T12:00:00',book:'其他'})];
  const current=[e('支出',80,{book:'个人'})];
  const result=analyzeBookkeeping(current,[...current,...prior],null,settings,{month:'2026-10',book:'个人'},'2026-11-02');
  assert.equal(result.insights[0].comparison.expense,40);assert.equal(result.insights[0].comparison.change,1);assert.equal(result.insights[0].budget,0);
  const focused=analyzeBookkeeping(current,[...current,...prior],null,settings,{month:'2026-10',day},'2026-11-02');assert.equal(focused.insights[0].comparison,null);
});
test('asset history excludes imported bills, honors inclusion, and reconciles cross-currency transfers and adjustments',()=>{
  const accounts=[{id:'a',currency:'CNY',opening:100,included:true,snapshotAt:day},{id:'b',currency:'CNY',opening:20,included:true,snapshotAt:day},{id:'c',currency:'USD',opening:30,included:true,snapshotAt:day},{id:'x',currency:'CNY',opening:999,included:false,snapshotAt:day}];
  const entries=[e('支出',10000,{accountId:'a',historical:true}),e('支出',10,{accountId:'a',date:'2026-10-12T12:00:00'}),e('转账',20,{accountId:'a',toAccountId:'b',fee:1,date:'2026-10-13T12:00:00'}),e('转账',70,{accountId:'a',toAccountId:'c',toAmount:10,date:'2026-10-14T12:00:00'}),e('余额调整',-5,{accountId:'b',date:'2026-10-15T12:00:00'})];
  const result=assetTrends(accounts,entries,'2026-10-16');assert.equal(result.points.filter(p=>p.currency==='CNY')[0].balance,120);assert.equal(result.points.filter(p=>p.currency==='CNY').at(-1).balance,34);assert.equal(result.points.filter(p=>p.currency==='USD').at(-1).balance,40);
  assert.ok(result.points.every(p=>p.date>=day));
});
test('drill filters reproduce category and daily totals including refund, reimbursement and transfer fees',()=>{
  const db=new Database(':memory:');try {
    const s=createBookkeepingStore(db),a=s.saveAccount('a',{name:'现金',balance:200}),b=s.saveAccount('a',{name:'卡',balance:0});
    s.saveEntry('a',e('支出',50,{accountId:a}));s.saveEntry('a',e('退款入账',10,{accountId:a}));s.saveEntry('a',e('收入',100,{accountId:a,category:'其他'}));s.saveEntry('a',e('转账',10,{accountId:a,toAccountId:b,category:'转账',fee:2}));
    const all=s.entries('a'), category=s.entries('a',{flow:'expense',category:'餐饮',day});assert.equal(category.length,2);assert.equal(summarize(category).totals.CNY.expense,40);
    const expense=s.entries('a',{flow:'expense',day});assert.equal(expense.length,3);assert.equal(summarize(expense).totals.CNY.expense,summarize(all).totals.CNY.expense);
    assert.equal(s.entries('a',{flow:'income'}).length,1);assert.equal(s.entries('b',{flow:'expense',day}).length,0);assert.equal(s.entries('a',{through:'2026-10-10',flow:'net'}).length,0);assert.throws(()=>s.entries('a',{flow:'invalid'}),/无效/);
  }finally{db.close();}
});
test('asset baselines with different dates show only jointly traceable dates and apply earlier live deltas once',()=>{
  const result=assetTrends([{id:'a',currency:'CNY',included:true,opening:100,snapshotAt:'2026-10-01'},{id:'b',currency:'CNY',included:true,opening:20,snapshotAt:'2026-10-11'}],[e('支出',10,{date:'2026-10-05T12:00:00',accountId:'a'}),e('收入',5,{accountId:'b'})],day);
  assert.deepEqual(result.points,[{date:day,currency:'CNY',balance:115}]);
});
