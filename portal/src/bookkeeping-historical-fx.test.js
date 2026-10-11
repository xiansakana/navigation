import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {createHistoricalFx,parseHistoricalFx} from './bookkeeping-historical-fx.js';
const csv='observation_date,DEXCHUS,DEXHKUS,DEXUSEU,DEXJPUS\n2026-10-01,7,7.8,1.1,140\n2026-10-02,7.1,7.9,1.2,142\n2026-10-05,7.2,8,1.1,144';
test('historical FX uses same-day crosses, never future rates, and carries latest prior trading day',async()=>{
 const db=new Database(':memory:');try{let calls=0;const fx=createHistoricalFx(db,{request:async()=>{calls++;return csv;}});await fx.ensure([{currency:'USD',date:'2026-10-04'}]);
 assert.equal(fx.quote('USD','2026-10-01').rate,7);assert.equal(fx.quote('USD','2026-10-04').rate,7.1);assert.equal(fx.quote('USD','2026-10-04').date,'2026-10-02');assert.equal(fx.quote('HKD','2026-10-04').rate,7.1/7.9);assert.equal(fx.quote('EUR','2026-10-04').rate,7.1*1.2);assert.equal(fx.quote('USD','2026-09-30'),null);assert.equal(fx.quote('USD','2026-11-01'),null);
 await fx.ensure([{currency:'USD',date:'2026-10-04'}]);assert.equal(calls,1);const e=fx.enrich({currency:'USD',amount:10,fee:1,date:'2026-10-04T12:00:00'});assert.equal(e.cnyAmount,71);assert.equal(e.cnyFee,7.1);assert.equal(e.fxMissing,false);
 }finally{db.close();}
});
test('history failures remain missing and missing cross quotes are not mixed across dates',async()=>{
 const rows=parseHistoricalFx('observation_date,DEXCHUS,DEXHKUS\n2026-10-01,7,.\n2026-10-02,.,7.8');assert.equal(rows.some(r=>r.currency==='HKD'),false);
 const db=new Database(':memory:');try{const fx=createHistoricalFx(db,{request:async()=>{throw Error('offline');}});await fx.ensure([{currency:'HKD',date:'2026-10-01'}]);assert.equal(fx.enrich({currency:'HKD',amount:1,date:'2026-10-01'}).fxMissing,true);}finally{db.close();}
});
