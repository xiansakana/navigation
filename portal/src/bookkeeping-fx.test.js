import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { effectiveBookkeepingFx, refreshBookkeepingFx } from './bookkeeping-fx.js';
import { handleBookkeepingApi } from './bookkeeping.js';

test('automatic reference rates persist per user and manual edits preserve the automatic snapshot',async()=>{
  const db=new Database(':memory:'),store=createBookkeepingStore(db);
  try{
    store.saveSettings('a',{rates:{USD:6.8,HKD:0.8},budgets:{'2026-10':100}});
    const quote={rate:7,source:'fred',asOf:'2026-10-09',fetchedAt:new Date().toISOString(),stale:false};
    const fx=await refreshBookkeepingFx(store,'a',{getRates:async()=>({quotes:{USD:quote},errors:['HKD 汇率暂时无法更新']})});
    assert.equal(fx.rates.USD,7);assert.equal(fx.quotes.HKD.source,'manual');assert.equal(store.settings('b').autoRates,undefined);
    store.saveSettings('a',{rates:{USD:6.9},budgets:{'2026-10':200}});assert.equal(store.settings('a').autoRates.USD.rate,7);
    const failed=await refreshBookkeepingFx(store,'a',{getRates:async()=>({quotes:{},errors:['USD 汇率暂时无法更新']})});
    assert.equal(failed.rates.USD,6.9);assert.equal(failed.quotes.USD.mode,'fallback');
    store.saveSettings('a',{rates:{CNY:1}});const cached=effectiveBookkeepingFx(store.settings('a'));assert.equal(cached.rates.USD,7);assert.equal(cached.quotes.USD.stale,true);
  }finally{db.close();}
});
test('outdated persisted quotes expose their status; missing quotes are not replaced with guessed values',()=>{
  const now=Date.parse('2026-10-11T12:00:00Z');const result=effectiveBookkeepingFx({rates:{CNY:1},autoRates:{USD:{rate:7,source:'fred',asOf:'2026-10-01',fetchedAt:'2026-10-10T12:00:00Z'}}},now);
  assert.equal(result.quotes.USD.stale,true);assert.equal(result.quotes.HKD,undefined);assert.equal(result.rates.HKD,undefined);
});
test('refresh action has a dedicated API permission and excludes guests',async()=>{
  let status;const json=(_res,s)=>{status=s;},res={setHeader(){}};
  await handleBookkeepingApi({method:'POST',headers:{}},res,new URL('http://localhost/api/bookkeeping/fx/refresh'),{userId:'a',permissions:['bookkeeping:view','bookkeeping:entries:edit']},json);assert.equal(status,403);
  await handleBookkeepingApi({method:'GET',headers:{}},res,new URL('http://localhost/api/bookkeeping/fx'),{userId:'guest',isGuest:true,permissions:['*']},json);assert.equal(status,403);
});
