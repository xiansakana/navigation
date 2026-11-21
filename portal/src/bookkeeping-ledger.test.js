import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountLedger } from './bookkeeping-ledger.js';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { handleBookkeepingApi } from './bookkeeping.js';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { saveInvestmentAccount } from '../../shared/investment-accounts.js';

const date='2026-10-11T12:00:00';
test('observed credit balances carry forward across later bills despite a different current snapshot',()=>{
  const account={id:'credit',currency:'USD',balance:-1.38};
  const entries=[
    {id:'bus',date:'2026-07-19T19:24:27',type:'支出',currency:'USD',amount:0.44,accountId:'credit',historical:true},
    {id:'metro',date:'2026-07-19T18:45:35',type:'支出',currency:'USD',amount:0.31,accountId:'credit',historical:true},
    {id:'adjust',date:'2026-07-11T10:56:59',type:'余额调整',currency:'USD',amount:6.77,accountId:'credit',historical:true,balanceCheckpoint:{before:-7.51,after:-0.74}},
    {id:'old',date:'2026-07-11T10:56:07',type:'支出',currency:'USD',amount:7.51,accountId:'credit',historical:true}
  ];
  const balances=accountLedger(entries,account);
  assert.deepEqual(entries.map(e=>balances.get(e.id).balanceAfter),[-1.49,-1.05,-0.74,-7.51]);
  assert.equal(account.balance,-1.38);
  assert.equal(balances.get('adjust').balanceEstimated,false);
  const nextCheckpoint={id:'next',date,type:'余额调整',currency:'USD',amount:0.11,accountId:'credit',balanceCheckpoint:{before:-1.49,after:-1.38}};
  const later={id:'later',date,type:'收入',currency:'USD',amount:1,accountId:'credit'};
  const multiple=accountLedger([later,nextCheckpoint,...entries],account);
  assert.equal(multiple.get('next').balanceAfter,-1.38);
  assert.equal(multiple.get('later').balanceAfter,-0.38);
  assert.equal(multiple.get('metro').balanceAfter,-1.05);
});

test('account running balances include fees, incoming transfers, refunds and signed adjustments in stable store order',()=>{
  const db=new Database(':memory:');
  try {
    const s=createBookkeepingStore(db), a=s.saveAccount('a',{name:'现金',balance:100}), b=s.saveAccount('a',{name:'卡',balance:0});
    const save=(type,amount,extra={})=>s.saveEntry('a',{date,type,amount,accountId:a,...extra});
    const expense=save('支出',10,{fee:1}), income=save('收入',20,{fee:2}), transfer=save('转账',5,{toAccountId:b,fee:1}), refund=save('退款入账',3), adjustment=save('余额调整',-4);
    const balances=accountLedger(s.entries('a'),s.accounts('a').find(x=>x.id===a));
    assert.deepEqual([expense,income,transfer,refund,adjustment].map(id=>balances.get(id).balanceAfter),[89,107,101,104,100]);
    assert.equal(balances.get(expense).balanceEstimated,false);
    const receipt=accountLedger(s.entries('a'),s.accounts('a').find(x=>x.id===b));
    assert.equal(receipt.get(transfer).balanceAfter,5);assert.equal(receipt.size,1);
    s.saveEntry('a',{date,type:'支出',amount:20,accountId:a},expense);
    const edited=accountLedger(s.entries('a'),s.accounts('a').find(x=>x.id===a));
    assert.equal(edited.get(expense).balanceAfter,91);
    s.removeEntry('a',expense);
    assert.equal(accountLedger(s.entries('a'),s.accounts('a').find(x=>x.id===a)).get(adjustment).balanceAfter,111);
  } finally { db.close(); }
});

test('historical snapshots reverse complete account history and cross-currency actual receipts beat estimates',()=>{
  const account={id:'usd',currency:'USD',balance:100};
  const entries=[
    {id:'live',date,type:'收入',currency:'USD',amount:10,accountId:'usd'},
    {id:'receipt',date,type:'转账',currency:'CNY',amount:70,toAccountId:'usd',toAmount:9,historical:true,fee:3},
    {id:'estimated',date,type:'转账',currency:'CNY',amount:70,toAccountId:'usd',toAmount:null,historical:true},
    {id:'expense',date,type:'支出',currency:'CNY',amount:35,fee:7,accountId:'usd',historical:true},
    {id:'old',date,type:'支出',currency:'USD',amount:2,accountId:'usd',historical:true}
  ];
  const quotes=(currency,d)=>{assert.equal(d,date.slice(0,10));return {rate:currency==='CNY'?1:7};};
  const balances=accountLedger(entries,account,quotes);
  assert.deepEqual(entries.map(e=>balances.get(e.id).balanceAfter),[100,90,81,71,77]);
  assert.equal(balances.get('live').balanceEstimated,false);
  assert.equal(balances.get('receipt').balanceEstimated,true);
  assert.equal(balances.get('old').balanceCurrency,'USD');
  const missing=accountLedger(entries,account,()=>null);
  assert.equal(missing.get('estimated').balanceAfter,81);
  assert.equal(missing.get('expense').balanceAfter,null);
  assert.equal(missing.get('old').balanceAfter,null);
  assert.equal(accountLedger(entries,null,quotes).size,0);
});

test('securities cash reverses settlements, matches duplicate interest, and identifies missing actual receipts',()=>{
  const account={id:'ledger',currency:'USD',balance:2000,balanceSource:'portfolio',investment:{id:'broker',cash:600}};
  const rows=[
    {id:'interest',date:'2026-10-06T12:00:00',type:'收入',category:'利息',currency:'USD',accountId:'ledger',amount:25},
    {id:'beforeSettle',date:'2026-10-04T12:00:00',type:'收入',currency:'USD',accountId:'ledger',amount:10},
    {id:'nonCash',date:'2026-10-03T12:00:00',type:'余额调整',currency:'USD',accountId:'ledger',amount:900},
    {id:'unknown',date:'2026-10-02T12:00:00',type:'转账',currency:'CNY',toAccountId:'ledger',amount:300},
    {id:'earliest',date:'2026-10-01T12:00:00',type:'收入',currency:'USD',accountId:'ledger',amount:10}
  ];
  const trade={account_id:'broker',symbol:'SPY',currency:'USD'};
  const trades=[
    {...trade,type:'buy',total_amount:200,commission:2,trade_date:'2026-10-01T13:00:00Z',cash_effective_at:'2026-10-05T13:00:00Z',historicalBackfill:true},
    {...trade,type:'other',total_amount:25,other_category:'利息',trade_date:'2026-10-06T13:00:00Z'},
    {...trade,type:'sell',total_amount:300,trade_date:'2026-10-08T13:00:00Z'}
  ];
  const balances=accountLedger(rows,account,()=>null,{trades,now:Date.parse('2026-10-07T00:00:00Z')});
  assert.deepEqual(rows.map(e=>balances.get(e.id).balanceAfter),[600,777,767,767,null]);
  assert.equal(balances.get('earliest').balanceIssue,'缺实际到账金额及历史汇率');
  assert.equal(balances.get('interest').balanceKind,'cash');
  assert.equal(balances.get('interest').balanceEstimated,true);
  const fx=(currency,date)=>{ assert.equal(date,'2026-10-02'); return {rate:currency==='CNY'?1:6}; };
  const estimated=accountLedger(rows,account,fx,{trades,now:Date.parse('2026-10-07T00:00:00Z')});
  assert.equal(estimated.get('earliest').balanceAfter,717);
  assert.equal(estimated.get('earliest').balanceNote,'到账额按历史汇率估算');
  assert.equal(estimated.get('beforeSettle').balanceNote,undefined);
  const actual=accountLedger(rows.map(e=>e.id==='unknown'?{...e,toAmount:45}:e),account,()=>{throw Error('actual receipt must win');},{trades,now:Date.parse('2026-10-07T00:00:00Z')});
  assert.equal(actual.get('earliest').balanceAfter,722);
  assert.equal(accountLedger(rows,account,()=>null).get('interest').balanceAfter,null);
});

test('state API balances survive date/type filters and pagination and require owned account plus accounts permission',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bookkeeping-ledger-')), previous=process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH=path.join(dir,'test.db');
  try {
    const s=createBookkeepingStore(getDatabase()), a=s.saveAccount('ledger-a',{name:'现金',balance:100});
    const expense=s.saveEntry('ledger-a',{date:'2026-10-01T12:00:00',type:'支出',amount:10,accountId:a});
    s.saveEntry('ledger-a',{date,type:'收入',amount:20,accountId:a});
    s.importBalanceAdjustments('ledger-a',[{accountName:'现金',currency:'CNY',date:'2026-09-01T12:00:00',beforeBalance:80,afterBalance:100,source:'screenshot.png'}],{apply:true});
    const foreign=s.saveAccount('ledger-b',{name:'其他人',balance:999});
    s.saveEntry('ledger-b',{date,type:'收入',amount:1,accountId:foreign});
    const get=async(query,permissions=['bookkeeping:view','bookkeeping:accounts:view'],route='state')=>{
      let data,code;
      await handleBookkeepingApi({method:'GET',headers:{}},{setHeader(){}},new URL('http://localhost/api/bookkeeping/'+route+'?'+query),{userId:'ledger-a',permissions},(_,status,body)=>{code=status;data=body;});
      assert.equal(code,200);return data;
    };
    const filtered=await get('accountId='+a+'&start=2026-10-01&end=2026-10-01&type=支出');
    assert.equal(filtered.entries[0].id,expense);assert.equal(filtered.entries[0].balanceAfter,90);
    const paged=await get('accountId='+a+'&offset=1&limit=1');assert.equal(paged.entries[0].balanceAfter,90);
    const latest=await get('accountId='+a+'&limit=1');assert.equal(latest.entries[0].balanceAfter,110);
    for(const data of [await get('accountId='+a,['bookkeeping:view','bookkeeping:analysis:view']),await get('')]) {
      assert.ok(data.entries.every(e=>!Object.hasOwn(e,'balanceAfter') && !Object.hasOwn(e,'balanceCurrency') && !Object.hasOwn(e,'balanceCheckpoint')));
    }
    assert.deepEqual((await get('accountId='+foreign)).entries,[]);
    const b=s.saveAccount('ledger-a',{name:'证券',balance:2000});
    const cashBill=s.saveEntry('ledger-a',{date,type:'收入',amount:20,accountId:b});
    saveInvestmentAccount(getDatabase(),'ledger-a',{name:'券商',currency:'CNY',baselineCash:100,bookkeepingId:b});
    const authorized=['bookkeeping:view','bookkeeping:accounts:view','service:stock-manage:cash:view','service:stock-manage:trades:view'];
    const securities=await get('accountId='+b,authorized);
    assert.equal(securities.entries[0].balanceKind,'cash');
    assert.equal(securities.entries[0].balanceAfter,100);
    assert.equal((await get('accountId='+b,authorized,'entries/'+cashBill)).entry.balanceAfter,100);
    assert.equal((await get('accountId='+b)).entries[0].balanceAfter,null);
    assert.equal((await get('accountId='+b,['bookkeeping:view'],'entries/'+cashBill)).entry.balanceKind,undefined);
  } finally {
    closeDatabase();if(previous==null)delete process.env.NAVIGATION_DB_PATH;else process.env.NAVIGATION_DB_PATH=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
