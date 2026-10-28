import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { investmentReturns } from './bookkeeping-investment-returns.js';
import { createAssetHistory } from './bookkeeping-asset-history.js';

const account=(id,balance,currency='CNY',rate=1)=>({id,balance,currency,rate,source:'ledger'});
const observation=(date,accounts,source='valuation')=>({date,accounts,source,capturedAt:date+'T15:59:00Z'});
const bill=(type,amount,accountId='cash',other={})=>({date:'2026-10-27T12:00:00',type,amount,accountId,currency:'CNY',...other});
const calculate=(observations,bills=[],filter={},events=[])=>investmentReturns(observations,bills,filter,'2026-10-28',events);

test('returns remove income, net spending, transfers and adjustments but keep valuation changes',()=>{
  const observations=[observation('2026-10-26',[account('cash',1000),account('stock',1000)]),observation('2026-10-28',[account('cash',1100),account('stock',1200)],'current')];
  const result=calculate(observations,[bill('收入',200),bill('支出',100),bill('退款',20),bill('余额调整',30),bill('转账',50,'cash',{toAccountId:'stock',fee:5})]);
  assert.equal(result.period.assetChange,300);assert.equal(result.period.netFlow,115);assert.equal(result.period.adjustments,30);assert.equal(result.period.profit,155);
  assert.deepEqual(result.points.map(p=>p.profit),[0,155]);assert.equal(result.period.provisional,true);assert.equal(result.period.partial,false);
});

test('account boundary transfers use original bill-day FX, internal FX principal stays inside investment result',()=>{
  const observations=[observation('2026-10-26',[account('stock',100,'USD',7)]),observation('2026-10-28',[account('stock',120,'USD',7.2)])];
  const result=calculate(observations,[bill('转账',140,'outside',{toAccountId:'stock',toAmount:20,toHistoricalRate:7}),bill('转账',1,'stock',{currency:'USD',historicalRate:7,toAccountId:'outside',fee:0.1})]);
  assert.equal(result.period.assetChange,164);assert.equal(result.period.netFlow,132.3);assert.equal(result.period.profit,31.7);
  const invalid=calculate(observations,[bill('转账',140,'outside',{toAccountId:'stock'})]);
  assert.equal(invalid.period,null);assert.match(invalid.note,/缺少到账金额/);
});

test('old reconstructed history never becomes returns; ranges clip to actual observations without inventing days',()=>{
  const observations=[observation('2026-10-26',[account('cash',100)]),observation('2026-10-28',[account('cash',110)])];
  const result=calculate(observations,[],{start:'2025-07-01',end:'2026-10-31'});
  assert.equal(result.period.partial,true);assert.equal(result.period.openingAsOf,'2026-10-26');assert.equal(result.period.profit,10);assert.equal(result.points.length,2);
  assert.equal(calculate(observations,[],{month:'2026-09'}).period,null);
  assert.equal(calculate(observations,[],{start:'2026-10-29'}).period,null);
  assert.equal(calculate(observations.slice(0,1)).period,null);
  const gap=calculate(observations,[],{start:'2026-10-27',end:'2026-10-27'});assert.equal(gap.period,null);
  const missingOpening=calculate([observation('2026-10-24',[account('cash',90)]),...observations],[bill('收入',20,'cash',{date:'2026-10-25T12:00:00'})],{start:'2026-10-26'});
  assert.equal(missingOpening.period.openingAsOf,'2026-10-26');assert.equal(missingOpening.period.profit,10);assert.equal(missingOpening.period.partial,true);
});

test('missing FX, unknown account attribution, historical imports and cash reconciliation never create fake profit',()=>{
  const observations=[observation('2026-10-26',[account('cash',100)]),observation('2026-10-28',[account('cash',110)])];
  for(const [bills,reason] of [[[bill('支出',1,'cash',{currency:'HKD',fxMissing:'HKD'})],/历史汇率/],[[bill('收入',1,null)],/未关联账户/],[[bill('支出',1,'cash',{historical:true})],/历史导入/]]){
    const result=calculate(observations,bills);assert.equal(result.period,null);assert.match(result.note,reason);
  }
  assert.equal(calculate(observations,[],{},[{at:'2026-10-27T01:00:00Z'}]).period,null);
  assert.equal(calculate(observations,[],{},[{at:'2026-10-25T01:00:00Z'}]).period.profit,10);
  assert.equal(calculate([observations[0],observation('2026-10-28',[account('other',110)])]).period,null);
  assert.equal(calculate([observations[0],observation('2026-10-28',[account('cash',null)])]).period,null);
});

test('daily snapshot integration scopes account details exactly, stays immutable and isolates users',()=>{
  const db=new Database(':memory:');
  try {
    const h=createAssetHistory(db),rates={CNY:1,USD:7};
    const accounts=[{id:'cash',currency:'CNY',balance:100,included:true},{id:'social',currency:'CNY',group:'社保公积金等',balance:500,included:true},{id:'stock',currency:'USD',balance:100,ledgerBalance:90,balanceSource:'portfolio',included:true}];
    h.capture('a',accounts,[],rates,Date.parse('2026-10-26T15:59:00Z'));
    h.capture('a',accounts.map(a=>({...a,balance:a.balance+10})),[],rates,Date.parse('2026-10-27T15:59:00Z'));
    const before=db.prepare('SELECT * FROM bookkeeping_asset_snapshots').all();
    const current=accounts.map(a=>({...a,balance:a.balance+20}));
    const full=h.returns('a',{},'2026-10-28',current,[],rates);
    const scoped=h.returns('a',{},'2026-10-28',current,[],rates,['social']);
    assert.equal(full.period.profit,180);assert.equal(scoped.period.profit,160);assert.equal(scoped.period.provisional,true);
    assert.equal(h.returns('b',{},'2026-10-28',current,[],rates).period,null);
    assert.deepEqual(db.prepare('SELECT * FROM bookkeeping_asset_snapshots').all(),before);
    assert.equal(h.returns('a',{month:'2026-09'},'2026-10-28',current,[],rates).period,null);
  } finally {db.close();}
});

test('cash rebases start a new comparable segment and displayed bridge reconciles to the cent',()=>{
  const observations=['2026-10-25','2026-10-26','2026-10-27','2026-10-28'].map((d,i)=>observation(d,[account('cash',100+i*10)]));
  const result=calculate(observations,[],{},[{at:'2026-10-26T01:00:00Z'}]);
  assert.equal(result.period.openingAsOf,'2026-10-26');assert.equal(result.period.profit,20);assert.equal(result.period.partial,true);
  const small=calculate([observation('2026-10-26',[account('cash',100)]),observation('2026-10-28',[account('cash',100.1)])],[bill('收入',0.01,'cash',{currency:'USD',historicalRate:1.5}),bill('余额调整',0.01,'cash',{currency:'USD',historicalRate:1.5})]);
  const p=small.period;assert.equal(p.profit,0.06);assert.equal(Math.round((p.assetChange-p.netFlow-p.adjustments)*100)/100,p.profit);
});
