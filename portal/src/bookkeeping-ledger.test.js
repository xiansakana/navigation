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

const date='2026-10-11T12:00:00';
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
    const get=async(query,permissions=['bookkeeping:view','bookkeeping:accounts:view'])=>{
      let data,code;
      await handleBookkeepingApi({method:'GET',headers:{}},{setHeader(){}},new URL('http://localhost/api/bookkeeping/state?'+query),{userId:'ledger-a',permissions},(_,status,body)=>{code=status;data=body;});
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
  } finally {
    closeDatabase();if(previous==null)delete process.env.NAVIGATION_DB_PATH;else process.env.NAVIGATION_DB_PATH=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
