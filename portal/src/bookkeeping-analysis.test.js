import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { analyzeBookkeeping, assetTrends } from './bookkeeping-analysis.js';
import { createBookkeepingStore, summarize } from './bookkeeping-store.js';
const day='2026-10-11',date=day+'T12:00:00', settings={budgets:{'2026-10':100}};
const e=(type,amount,extra={})=>({date,type,amount,currency:'CNY',category:'餐饮',fee:0,...extra});
test('billing trends reconcile refunds and fees, zero-fill days, and combine currencies into CNY',()=>{
  const entries=[e('支出',50),e('收入',100),e('退款入账',10),e('转账',1000,{fee:2}),e('余额调整',100),e('支出',3,{currency:'USD'})];
  const result=analyzeBookkeeping(entries,entries,null,settings,{month:'2026-10'},day,{CNY:1,USD:7});
  const cny=result.billing.points.filter(p=>p.currency==='CNY');assert.equal(cny.length,11);assert.equal(cny[0].income,0);assert.equal(cny.at(-1).expense,63);assert.equal(cny.at(-1).cumulative,37);
  assert.equal(result.billing.points.length,11);assert.ok(result.billing.points.every(p=>p.currency==='CNY'));
  assert.equal(result.insights.find(i=>i.currency==='CNY').net,37);assert.equal(result.asset,null);
  assert.equal(result.insights[0].comparison,null);
});
test('complete month comparison uses matching book scope and partial category views do not claim total budget',()=>{
  const prior=[e('支出',40,{date:'2026-09-10T12:00:00',book:'个人'}),e('支出',1000,{date:'2026-09-10T12:00:00',book:'其他'})];
  const current=[e('支出',80,{book:'个人'})];
  const result=analyzeBookkeeping(current,[...current,...prior],null,settings,{month:'2026-10',book:'个人'},'2026-11-02');
  assert.equal(result.insights[0].comparison.expense,40);assert.equal(result.insights[0].comparison.change,1);assert.equal(result.insights[0].budget,0);
  const focused=analyzeBookkeeping(current,[...current,...prior],null,settings,{month:'2026-10',day},'2026-11-02');assert.equal(focused.insights[0].comparison,null);
});
test('reverse asset history includes imported bills and anchors to current CNY equivalent balance',()=>{
  const accounts=[{id:'a',currency:'CNY',balance:100,included:true},{id:'b',currency:'CNY',balance:20,included:true},{id:'c',currency:'USD',balance:30,included:true},{id:'x',currency:'CNY',balance:999,included:false}];
  const entries=[e('支出',10,{date:'2026-10-01T12:00:00',accountId:'a',historical:true}),e('收入',5,{date:'2026-10-02T12:00:00',accountId:'b',historical:true}),e('转账',20,{accountId:'a',toAccountId:'b',fee:1}),e('支出',3,{currency:'USD',accountId:'c',historical:true}),e('支出',500,{accountId:'x',historical:true})];
  const result=assetTrends(accounts,entries,day,{CNY:1,USD:7});
  assert.equal(result.points[0].balance,357);assert.equal(result.points[0].date,'2026-09-30');assert.equal(result.points.at(-1).balance,330);assert.ok(result.points.every(p=>p.currency==='CNY'));
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
test('historical cross-currency internal transfers cancel principal, while external transfers and fees remain',()=>{
  const accounts=[{id:'a',currency:'CNY',balance:70,included:true},{id:'b',currency:'USD',balance:10,included:true},{id:'x',currency:'USD',balance:100,included:false}];
  const entries=[e('转账',70,{accountId:'a',toAccountId:'b',toAmount:null,historical:true,fee:2}),e('转账',7,{accountId:'a',toAccountId:'x',toAmount:1,historical:true}),e('收入',5,{accountId:null,historical:true})];
  const result=assetTrends(accounts,entries,day,{CNY:1,USD:7});assert.equal(result.points.at(-1).balance,140);assert.equal(result.points[0].balance,144);assert.equal(result.estimatedTransfers,1);assert.equal(result.unlinkedEntries,1);
});
test('missing FX blocks equivalent totals and asset curves rather than silently dropping foreign currencies',()=>{
  const entries=[e('支出',3,{currency:'USD'})],accounts=[{id:'a',currency:'USD',balance:10,included:true}];
  const result=analyzeBookkeeping(entries,entries,accounts,settings,{},day,{CNY:1});assert.deepEqual(result.billing.points,[]);assert.deepEqual(result.billing.missingCurrencies,['USD']);assert.deepEqual(result.asset.points,[]);assert.deepEqual(result.asset.missingCurrencies,['USD']);
});
test('actual cross-currency destination amounts and linked adjustments reverse exactly',()=>{
  const result=assetTrends([{id:'a',currency:'CNY',balance:70,included:true},{id:'b',currency:'USD',balance:10,included:true}],[e('转账',70,{accountId:'a',toAccountId:'b',toAmount:9,fee:1}),e('余额调整',-5,{accountId:'a'})],day,{CNY:1,USD:7});
  assert.equal(result.points[0].balance,153);assert.equal(result.points.at(-1).balance,140);
});
test('CNY aggregates honor per-bill historical rates rather than current rates and date bounds crop asset history',()=>{
 const entries=[e('支出',10,{currency:'USD',date:'2026-10-01T12:00:00',cnyAmount:60,cnyFee:0,historicalRate:6}),e('支出',10,{currency:'USD',date:'2026-10-02T12:00:00',cnyAmount:70,cnyFee:0,historicalRate:7})];
 const result=analyzeBookkeeping(entries,entries,null,settings,{start:'2026-10-01',end:'2026-10-02'},day,{CNY:1,USD:8});assert.equal(result.equivalentSummary.totals.CNY.expense,130);assert.equal(result.billing.points.length,2);
 const assets=assetTrends([{id:'a',currency:'CNY',included:true,balance:100}],entries,day,{CNY:1,USD:8},{start:'2026-10-01',end:'2026-10-02'});assert.deepEqual(assets.points,[{date:'2026-10-01',currency:'CNY',balance:170},{date:'2026-10-02',currency:'CNY',balance:100}]);
});
test('inclusive start/end filtering works across months and rejects reversed or impossible dates',()=>{
 const db=new Database(':memory:');try{const s=createBookkeepingStore(db);s.saveEntry('a',e('支出',1,{date:'2026-09-30T12:00:00'}));s.saveEntry('a',e('支出',2,{date:'2026-10-01T12:00:00'}));assert.equal(s.entries('a',{start:'2026-09-30',end:'2026-10-01'}).length,2);assert.equal(s.entries('a',{start:'2026-10-01',end:'2026-10-01'}).length,1);assert.throws(()=>s.entries('a',{start:'2026-10-02',end:'2026-10-01'}),/不能晚于/);assert.throws(()=>s.entries('a',{start:'2026-02-30'}),/日期/);}finally{db.close();}
});
test('long custom ranges aggregate partial boundary months without adding out-of-range days',()=>{
 const entries=[e('支出',10,{date:'2026-01-15T12:00:00'}),e('收入',30,{date:'2026-04-05T12:00:00'})];
 const result=analyzeBookkeeping(entries,entries,null,settings,{start:'2026-01-15',end:'2026-04-05'},day,{CNY:1});assert.equal(result.billing.granularity,'month');assert.equal(result.billing.points.length,4);assert.equal(result.billing.points[0].expense,10);assert.equal(result.billing.points.at(-1).cumulative,20);
});
