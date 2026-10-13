import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createBookkeepingStore, summarize } from './bookkeeping-store.js';
import { accountLedger } from './bookkeeping-ledger.js';
import { analyzeBookkeeping } from './bookkeeping-analysis.js';

const date='2026-08-31T01:18:59';
test('screenshot imports store the signed adjustment difference, preserve current snapshots, and deduplicate atomically per user',()=>{
  const db=new Database(':memory:');
  try {
    const s=createBookkeepingStore(db),aid=s.saveAccount('a',{name:'证券',currency:'USD',balance:110});
    s.saveEntry('a',{date:'2026-09-01T12:00:00',type:'收入',amount:10,currency:'USD',accountId:aid});
    const before=JSON.stringify(s.accounts('a')), row={accountName:'证券',currency:'USD',date,beforeBalance:90,afterBalance:100,source:'account/image.png'};
    assert.equal(s.importBalanceAdjustments('a',[row]).inserted,1);assert.equal(s.entries('a').length,1);
    assert.equal(s.importBalanceAdjustments('a',[row,row],{apply:true}).inserted,1);
    assert.equal(s.importBalanceAdjustments('a',[row],{apply:true}).duplicates,1);
    assert.equal(JSON.stringify(s.accounts('a')),before);
    const adjustment=s.entries('a').find(e=>e.type==='余额调整');
    assert.equal(adjustment.amount,10);assert.equal(adjustment.historical,true);
    assert.deepEqual(adjustment.balanceCheckpoint,{before:90,after:100});
    const balances=accountLedger(s.entries('a'),s.accounts('a')[0]);
    assert.equal(balances.get(adjustment.id).balanceAfter,100);assert.equal(balances.get(adjustment.id).balanceEstimated,false);
    assert.throws(()=>s.importBalanceAdjustments('a',[{...row,afterBalance:99}],{apply:true}),/不一致/);
    assert.throws(()=>s.importBalanceAdjustments('a',[{...row,date:'2026-08-01T12:00:00'},{...row,currency:'CNY'}],{apply:true}),/货币/);
    assert.equal(s.entries('a').length,2);
    assert.throws(()=>s.importBalanceAdjustments('b',[row],{apply:true}),/不存在/);
    s.saveAccount('b',{name:'证券',currency:'USD',balance:1});assert.equal(s.importBalanceAdjustments('b',[row],{apply:true}).inserted,1);
    // Editing financial data invalidates the observed checkpoint, while note-only edits preserve it.
    s.saveEntry('a',{...adjustment,note:'备注修改'},adjustment.id);
    assert.ok(s.entries('a').find(e=>e.id===adjustment.id).balanceCheckpoint);
    s.saveEntry('a',{...adjustment,amount:12},adjustment.id);
    assert.equal(s.entries('a').find(e=>e.id===adjustment.id).balanceCheckpoint,undefined);
  } finally {db.close();}
});

test('credit adjustments reduce or increase signed debt rather than crediting the displayed debt amount',()=>{
  const db=new Database(':memory:');try {
    const s=createBookkeepingStore(db);s.saveAccount('a',{name:'信用卡',currency:'USD',balance:-0.74});
    s.importBalanceAdjustments('a',[{accountName:'信用卡',currency:'USD',date,beforeBalance:-7.51,afterBalance:-0.74,source:'credit.png'}],{apply:true});
    assert.equal(s.entries('a')[0].amount,6.77);assert.equal(s.accounts('a')[0].balance,-0.74);
  } finally {db.close();}
});

test('historical adjustments change asset curves but no billing totals, categories, cumulative series or missing FX status',()=>{
  const bill={id:'bill',date:'2026-09-01T12:00:00',type:'收入',amount:20,currency:'CNY',accountId:'a',category:'工资'};
  const adjustment={id:'adjustment',date,type:'余额调整',amount:30,currency:'CNY',accountId:'a',category:'余额调整',historical:true};
  const accounts=[{id:'a',currency:'CNY',balance:100,included:true}],settings={rates:{CNY:1}};
  const without=analyzeBookkeeping([bill],[bill],accounts,settings,{},'2026-10-13');
  const withAdjust=analyzeBookkeeping([adjustment,bill],[adjustment,bill],accounts,settings,{},'2026-10-13');
  assert.deepEqual(summarize([adjustment,bill]),summarize([bill]));
  assert.deepEqual(withAdjust.billing,without.billing);assert.deepEqual(withAdjust.equivalentSummary,without.equivalentSummary);
  assert.deepEqual(withAdjust.insights,without.insights);
  assert.equal(withAdjust.asset.points[0].balance,50);assert.equal(without.asset.points[0].balance,80);
  assert.equal(withAdjust.asset.current,100);
  const missing={...adjustment,currency:'USD',fxMissing:true};
  const noFx=analyzeBookkeeping([missing,bill],[missing,bill],accounts,settings,{},'2026-10-13');
  assert.deepEqual(noFx.billing,without.billing);assert.deepEqual(noFx.asset.missingCurrencies,['USD']);
});
