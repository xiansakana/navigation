import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createAssetHistory, assetDate, startAssetHistory, nextAssetCapture } from './bookkeeping-asset-history.js';
import { assetTrends } from './bookkeeping-analysis.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { saveInvestmentAccount } from '../../shared/investment-accounts.js';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { handleBookkeepingApi } from './bookkeeping.js';

const now = Date.parse('2026-10-15T10:00:00Z');
const accounts = [{id:'cash',currency:'CNY',balance:100,included:true},
  {id:'stock',currency:'USD',balance:200,ledgerBalance:150,balanceSource:'portfolio',included:true}];
const entries = [
  {id:'bill',date:'2026-10-01T12:00:00',type:'支出',amount:10,currency:'CNY',accountId:'cash'},
  {id:'adjust',date:'2026-10-03T12:00:00',type:'余额调整',amount:20,currency:'USD',historicalRate:7,cnyAmount:140,accountId:'stock'}
];
const rates = {CNY:1,USD:7};

test('hybrid history preserves the complete ledger curve and uses actual valuation observations after cutover',()=>{
  const db=new Database(':memory:');
  try {
    const store=createAssetHistory(db);
    assert.equal(store.capture('a',accounts,entries,rates,now),true);
    const result=store.read('a',{},'2026-10-15');
    const legacy=assetTrends(accounts.map(a=>({...a,balance:a.ledgerBalance??a.balance,balanceSource:'ledger'})),entries,'2026-10-15',rates,{end:'2026-10-14'});
    assert.deepEqual(result.points.filter(p=>p.date<'2026-10-15').map(({source,asOf,...p})=>p),legacy.points);
    assert.equal(result.points.at(-1).balance,1500);
    assert.equal(result.points.at(-1).source,'valuation');
    assert.equal(result.valuationCutover,'2026-10-15');
    assert.equal(result.period.closing,1500);
    const frozen=db.prepare('SELECT history FROM bookkeeping_asset_baselines WHERE user_id=?').get('a').history;
    const next=accounts.map(a=>a.id==='stock'?{...a,balance:210,ledgerBalance:999}:a);
    store.capture('a',next,[],{CNY:1,USD:8},now+86400000);
    assert.equal(db.prepare('SELECT history FROM bookkeeping_asset_baselines WHERE user_id=?').get('a').history,frozen);
    const scoped=store.read('a',{start:'2026-10-15',end:'2026-10-16'},'2026-10-16');
    assert.equal(scoped.period.opening,1150);assert.equal(scoped.period.closing,1780);assert.equal(scoped.period.change,630);
    assert.equal(store.read('b'),null);
    const oldRange=store.read('a',{start:'2026-10-01',end:'2026-10-14'},'2026-10-16');
    assert.ok(oldRange.points.every(p=>p.date<'2026-10-15'));
    assert.equal(oldRange.period.change,130);
  } finally {db.close();}
});

test('daily observations update intraday but survive future prices, clock rollback, gaps and missing quotes',()=>{
  const db=new Database(':memory:');
  try {
    const h=createAssetHistory(db);
    h.capture('a',accounts,entries,rates,now);
    h.capture('a',accounts.map(a=>a.id==='stock'?{...a,balance:220}:a),entries,rates,now+3600000);
    assert.equal(h.read('a',{},'2026-10-15').points.at(-1).balance,1640);
    h.capture('a',accounts,entries,rates,now+86400000);
    assert.equal(h.capture('a',accounts,entries,rates,now),false);
    assert.equal(h.read('a',{end:'2026-10-15'},'2026-10-16').points.at(-1).balance,1640);
    assert.equal(h.capture('a',accounts.map(a=>a.id==='stock'?{...a,balance:null}:a),entries,rates,now+2*86400000),false);
    const gap=h.read('a',{start:'2026-10-17',end:'2026-10-18'},'2026-10-18');
    assert.equal(gap.points.at(-1).source,'carried');assert.equal(gap.points.at(-1).asOf,'2026-10-16');
    assert.equal(gap.period.change,0);
    assert.equal(h.read('a',{start:'2026-10-20',end:'2026-10-21'},'2026-10-18').period,null);
    assert.equal(assetDate(Date.parse('2026-10-15T16:00:00Z')),'2026-10-16');
  } finally {db.close();}
});

test('incomplete FX and redacted investment balances cannot initialize or expose a history',()=>{
  const db=new Database(':memory:');
  try {
    const h=createAssetHistory(db);
    assert.equal(h.capture('a',accounts,entries,{CNY:1},now),false);
    assert.equal(h.read('a'),null);
    assert.equal(h.capture('a',accounts.map(({ledgerBalance,...a})=>({...a,balance:null})),entries,rates,now),false);
    assert.equal(h.read('a'),null);
  } finally {db.close();}
});

test('background collection runs safely before any investment accounts exist',async()=>{
  const db=new Database(':memory:');
  const worker=startAssetHistory(db,{refresh:async()=>{throw new Error('not needed');}});
  try {await worker.collect();} finally {worker.stop();db.close();}
});

test('state API restores owned linked asset history without exposing it to users lacking stock cash permission',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'asset-history-')),prior=process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH=path.join(dir,'test.db');
  try {
    const db=getDatabase(),store=createBookkeepingStore(db);
    const aid=store.saveAccount('history-a',{name:'证券',currency:'CNY',balance:150});
    saveInvestmentAccount(db,'history-a',{name:'证券',currency:'CNY',bookkeepingId:aid,baselineCash:100});
    const basic=['bookkeeping:view','bookkeeping:accounts:view','bookkeeping:analysis:view'];
    const get=async(userId,permissions,query='')=>{
      let status,data;
      await handleBookkeepingApi({method:'GET',headers:{}},{setHeader(){}},new URL('http://localhost/api/bookkeeping/state'+query),{userId,permissions},(_,s,b)=>{status=s;data=b;});
      assert.equal(status,200);return data;
    };
    const allowed=await get('history-a',[...basic,'service:stock-manage:cash:view']);
    assert.equal(allowed.analysis.investmentReturns,null);
    const returnsAllowed=await get('history-a',[...basic,'bookkeeping:accounts:returns:view','service:stock-manage:cash:view']);
    assert.ok(returnsAllowed.analysis.investmentReturns);
    assert.equal(returnsAllowed.analysis.investmentReturns.period,null);
    assert.equal(allowed.analysis.asset.historyMode,'hybrid');
    assert.equal(allowed.accounts[0].balance,100);
    assert.equal(allowed.analysis.asset.points.at(-1).balance,100);
    assert.equal(allowed.analysis.asset.period.closingSource,'current');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookkeeping_asset_snapshots').get().n,0);
    createAssetHistory(db).capture('history-a',store.accounts('history-a'),[],{CNY:1});
    const saved=db.prepare('SELECT * FROM bookkeeping_asset_snapshots').get();
    const refreshed=await get('history-a',[...basic,'service:stock-manage:cash:view']);
    assert.equal(refreshed.analysis.asset.points.at(-1).balance,100);
    assert.deepEqual(db.prepare('SELECT * FROM bookkeeping_asset_snapshots').get(),saved);
    const hidden=await get('history-a',basic);
    assert.equal((await get('history-a',[...basic,'bookkeeping:accounts:returns:view'])).analysis.investmentReturns,null);
    assert.equal(hidden.analysis.asset.historyMode,undefined);
    assert.deepEqual(hidden.analysis.asset.points,[]);
    assert.equal(hidden.accounts[0].balance,null);
    const other=await get('history-b',[...basic,'service:stock-manage:cash:view']);
    assert.deepEqual(other.accounts,[]);assert.deepEqual(other.analysis.asset.points,[]);
    const returnPermissions=[...basic,'bookkeeping:accounts:returns:view','service:stock-manage:cash:view'];
    assert.equal((await get('history-a',returnPermissions,'?investmentHistory=1')).analysis.investmentReturns.trading,undefined);
    const trading=await get('history-a',[...returnPermissions,'service:stock-manage:trades:view'],'?investmentHistory=1');
    // No trades: authorisation succeeds without issuing market-data requests.
    assert.equal(trading.analysis.investmentReturns.trading,null);
    db.prepare('UPDATE investment_accounts SET bookkeeping_id=NULL WHERE user_id=?').run('history-a');
    assert.equal((await get('history-a',[...basic,'bookkeeping:accounts:returns:view'])).analysis.investmentReturns,null);
  } finally {
    closeDatabase();if(prior==null)delete process.env.NAVIGATION_DB_PATH;else process.env.NAVIGATION_DB_PATH=prior;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('today estimate reconciles period and chart boundaries without modifying frozen history or daily observations',()=>{
  const db=new Database(':memory:');
  try {
    const h=createAssetHistory(db);
    h.capture('a',accounts,entries,rates,now);
    const saved=db.prepare('SELECT * FROM bookkeeping_asset_snapshots').all();
    const baseline=db.prepare('SELECT * FROM bookkeeping_asset_baselines').get();
    const current=1460.25,today='2026-10-16';
    for(const filter of [{month:'2026-10'},{start:today,end:today},{start:'2026-10-01',end:'2026-12-31'},{}]) {
      const result=h.read('a',filter,today,current);
      assert.equal(result.period.closing,current);
      assert.equal(result.period.closingAsOf,today);
      assert.equal(result.period.closingSource,'current');
      assert.equal(result.points[0].date,result.period.openingAsOf);
      assert.equal(result.points[0].periodBoundary,'opening');
      assert.equal(result.points[0].balance,result.period.opening);
      assert.equal(result.points.at(-1).date,result.period.end);
      assert.equal(result.points.at(-1).balance,current);
      assert.equal(Math.round((result.points.at(-1).balance-result.points[0].balance)*100)/100,result.period.change);
    }
    const historical=h.read('a',{start:'2026-10-15',end:'2026-10-15'},today,99999);
    assert.equal(historical.period.closing,1500);
    assert.equal(historical.period.closingSource,'valuation');
    assert.ok(historical.points.every(p=>p.source!=='current'));
    assert.equal(h.read('a',{start:'2026-10-17',end:'2026-10-20'},today,current).period,null);
    assert.equal(h.read('a',{},today,0).period.closing,0);
    assert.notEqual(h.read('a',{},today,null).period.closingSource,'current');
    // An intraday read also replaces an existing observation only in the response.
    assert.equal(h.read('a',{},'2026-10-15',1400).period.closing,1400);
    assert.deepEqual(db.prepare('SELECT * FROM bookkeeping_asset_snapshots').all(),saved);
    assert.deepEqual(db.prepare('SELECT * FROM bookkeeping_asset_baselines').get(),baseline);
  } finally {db.close();}
});

test('daily collector waits until Beijing 23:59 and saves once per day, including after restarts',async()=>{
  const db=new Database(':memory:'),store=createBookkeepingStore(db);
  const aid=store.saveAccount('daily',{name:'证券',currency:'CNY',balance:150});
  const investmentId=saveInvestmentAccount(db,'daily',{name:'证券',currency:'CNY',bookkeepingId:aid,baselineCash:100});
  let clock=Date.parse('2026-10-15T15:58:00Z'),refreshes=0,delay;
  const config={clock:()=>clock,refresh:async()=>{refreshes++;},schedule:(_,ms)=>{delay=ms;return {unref(){}};},cancel(){}};
  const worker=startAssetHistory(db,config);
  try {
    assert.equal(delay,60000);
    await worker.collect();
    assert.equal(refreshes,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookkeeping_asset_snapshots').get().n,0);
    clock+=60000;await worker.collect();
    assert.equal(refreshes,1);
    const first=db.prepare('SELECT * FROM bookkeeping_asset_snapshots').get();
    assert.equal(first.date,'2026-10-15');assert.equal(first.balance,100);
    saveInvestmentAccount(db,'daily',{baselineCash:200},investmentId);
    clock+=30000;await worker.collect();
    assert.equal(refreshes,1);
    assert.deepEqual(db.prepare('SELECT * FROM bookkeeping_asset_snapshots').get(),first);
    const restarted=startAssetHistory(db,config);
    try {await restarted.collect();assert.equal(refreshes,1);} finally {restarted.stop();}
    assert.equal(nextAssetCapture(clock),Date.parse('2026-10-16T15:59:00Z'));
    clock=Date.parse('2026-10-16T10:00:00Z');await worker.collect();
    assert.equal(refreshes,1);
    clock=Date.parse('2026-10-16T15:59:00Z');await worker.collect();
    assert.equal(refreshes,2);
    assert.deepEqual(db.prepare('SELECT balance FROM bookkeeping_asset_snapshots ORDER BY date').all().map(r=>r.balance),[100,200]);
  } finally {worker.stop();db.close();}
});
