import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { analyticsScope, scopedBills, SOCIAL_ACCOUNT_GROUP } from './bookkeeping-scope.js';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { createAssetHistory } from './bookkeeping-asset-history.js';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { handleBookkeepingApi } from './bookkeeping.js';

test('scope defaults off, supports all/individual/none and validates account ownership and group',()=>{
  const db=new Database(':memory:');
  try {
    const s=createBookkeepingStore(db),p=s.saveAccount('a',{name:'公积金',group:SOCIAL_ACCOUNT_GROUP,balance:200}),m=s.saveAccount('a',{name:'医保',group:SOCIAL_ACCOUNT_GROUP,balance:300}),cash=s.saveAccount('a',{name:'现金',balance:100});
    const other=s.saveAccount('b',{name:'他人的公积金',group:SOCIAL_ACCOUNT_GROUP,balance:999});
    assert.deepEqual(analyticsScope(s.accounts('a')).excludedAccountIds,[]);
    assert.deepEqual(analyticsScope(s.accounts('a')).selectedAccountIds,[p,m]);
    s.saveSettings('a',{budgets:{'2026-10':100},rates:{USD:7}});
    s.saveAnalysisScope('a',{enabled:true,accountIds:[p]});
    assert.deepEqual(analyticsScope(s.accounts('a'),s.settings('a').analysisScope).excludedAccountIds,[p]);
    assert.equal(s.settings('a').budgets['2026-10'],100);assert.equal(s.settings('a').rates.USD,7);
    assert.equal(s.settings('b').analysisScope,undefined);
    assert.throws(()=>s.saveAnalysisScope('a',{enabled:true,accountIds:[other]}),/当前用户/);
    assert.throws(()=>s.saveAnalysisScope('a',{enabled:true,accountIds:[cash]}),/分组/);
    assert.throws(()=>s.saveAnalysisScope('a',{enabled:'false',accountIds:[]}),/布尔/);
    assert.deepEqual(analyticsScope(s.accounts('a'),s.saveAnalysisScope('a',{enabled:true,accountIds:[]})).excludedAccountIds,[]);
    assert.deepEqual(analyticsScope(s.accounts('a'),s.saveAnalysisScope('a',{enabled:true,accountIds:null})).excludedAccountIds,[p,m]);
    assert.deepEqual(analyticsScope(s.accounts('a'),s.saveAnalysisScope('a',{enabled:false,accountIds:[p]})).excludedAccountIds,[]);
    const entries=[{accountId:p,type:'收入'},{accountId:cash,toAccountId:p,type:'转账',fee:2},{accountId:p,toAccountId:cash,type:'转账',fee:3},{accountId:null,type:'收入'}];
    assert.deepEqual(scopedBills(entries,new Set([p])),[entries[1],entries[3]]);
  } finally {db.close();}
});

test('account exclusion uses frozen components and snapshot details without mutating full history',()=>{
  const db=new Database(':memory:');
  try {
    const h=createAssetHistory(db),time=Date.parse('2026-10-15T10:00:00Z');
    const accounts=[{id:'cash',currency:'CNY',balance:100,included:true},{id:'pension',group:SOCIAL_ACCOUNT_GROUP,currency:'CNY',balance:200,included:true},{id:'stock',currency:'USD',balance:200,ledgerBalance:150,balanceSource:'portfolio',included:true}];
    const entries=[{date:'2026-10-02T12:00:00',type:'收入',amount:50,currency:'CNY',accountId:'pension'}],rates={CNY:1,USD:7};
    h.capture('a',accounts,entries,rates,time);
    const frozen=db.prepare('SELECT * FROM bookkeeping_asset_baselines').get(),snapshots=db.prepare('SELECT * FROM bookkeeping_asset_snapshots').all();
    const full=h.read('a',{start:'2026-10-01'},'2026-10-16',1700);
    const filtered=h.read('a',{start:'2026-10-01'},'2026-10-16',1500,{excludedAccountIds:['pension'],accounts,entries,rates});
    assert.equal(filtered.period.closing,1500);assert.equal(filtered.period.opening,full.period.opening-150);
    assert.equal(filtered.points.find(p=>p.date==='2026-10-15').balance,1500);
    assert.equal(filtered.points.at(-1).balance-filtered.points[0].balance,filtered.period.change);
    assert.equal(filtered.scopeEstimatedBefore,undefined);
    assert.deepEqual(db.prepare('SELECT * FROM bookkeeping_asset_baselines').get(),frozen);
    assert.deepEqual(db.prepare('SELECT * FROM bookkeeping_asset_snapshots').all(),snapshots);
    // Simulate the legacy aggregate-only baseline already stored before account splits existed.
    const legacy=JSON.parse(frozen.history);delete legacy.accountHistories;
    db.prepare('UPDATE bookkeeping_asset_baselines SET history=?').run(JSON.stringify(legacy));
    const estimated=h.read('a',{start:'2026-10-01'},'2026-10-16',1500,{excludedAccountIds:['pension'],accounts,entries,rates});
    assert.equal(estimated.period.opening,filtered.period.opening);assert.equal(estimated.scopeEstimatedBefore,'2026-10-15');
    assert.match(estimated.note,/属于估算/);
    assert.deepEqual(h.read('a',{start:'2026-10-01'},'2026-10-16',1700).points,full.points);
  } finally {db.close();}
});

test('API scopes statistics, assets and drill-through while ordinary details remain complete',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bookkeeping-scope-')),prior=process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH=path.join(dir,'test.db');
  try {
    const s=createBookkeepingStore(getDatabase()),uid='scope-owner';
    const cash=s.saveAccount(uid,{name:'现金',balance:100}),p=s.saveAccount(uid,{name:'公积金',group:SOCIAL_ACCOUNT_GROUP,balance:500});
    s.saveEntry(uid,{date:'2026-10-02T12:00:00',type:'收入',amount:100,currency:'CNY',accountId:p,category:'工资'});
    s.saveEntry(uid,{date:'2026-10-03T12:00:00',type:'支出',amount:10,currency:'CNY',accountId:cash,category:'餐饮'});
    const session={userId:uid,permissions:['bookkeeping:view','bookkeeping:accounts:view','bookkeeping:analysis:view']};
    const request=async(method,route,payload,as=session)=>{
      const req=Readable.from(payload?[Buffer.from(JSON.stringify(payload))]:[]);req.method=method;req.headers={host:'localhost',origin:'http://localhost'};
      let result;await handleBookkeepingApi(req,{setHeader(){}},new URL('http://localhost/api/bookkeeping/'+route),as,(_,status,data)=>{result={status,data};});return result;
    };
    const original=(await request('GET','state')).data;
    assert.equal(original.analysisScope.enabled,false);assert.equal(original.analysis.asset.current,690);
    assert.equal((await request('PUT','analysis-scope',{enabled:true,accountIds:[p]})).status,200);
    const filtered=(await request('GET','state')).data;
    assert.equal(filtered.equivalentSummary.totals.CNY.income,100);assert.equal(filtered.count,2);
    assert.equal(filtered.analysis.equivalentSummary.totals.CNY.income,0);assert.equal(filtered.analysis.asset.current,90);
    const drill=(await request('GET','state?analysisScope=1')).data;assert.equal(drill.count,1);assert.equal(drill.entries[0].accountId,cash);
    const denied=await request('PUT','analysis-scope',{enabled:true,accountIds:[p]},{userId:uid,permissions:['bookkeeping:view']});assert.equal(denied.status,403);
    const other=(await request('GET','state',null,{...session,userId:'other-owner'})).data;assert.equal(other.analysisScope.enabled,false);assert.deepEqual(other.accounts,[]);
    await request('PUT','analysis-scope',{enabled:false,accountIds:[p]});assert.equal((await request('GET','state')).data.analysis.asset.current,original.analysis.asset.current);
  } finally {closeDatabase();if(prior==null)delete process.env.NAVIGATION_DB_PATH;else process.env.NAVIGATION_DB_PATH=prior;fs.rmSync(dir,{recursive:true,force:true});}
});

test('filtered multi-currency snapshots round the retained subtotal once instead of subtracting from an already rounded total',()=>{
  const db=new Database(':memory:');
  try {
    const h=createAssetHistory(db),accounts=[{id:'cash',currency:'CNY',balance:1,included:true},{id:'social',group:SOCIAL_ACCOUNT_GROUP,currency:'USD',balance:0.01,included:true},{id:'stock',currency:'USD',balance:0.15,ledgerBalance:0.15,balanceSource:'portfolio',included:true}],rates={CNY:1,USD:6.7};
    h.capture('a',accounts,[],rates,Date.parse('2026-10-15T10:00:00Z'));
    const result=h.read('a',{start:'2026-10-15',end:'2026-10-15'},'2026-10-16',2.01,{excludedAccountIds:['social'],accounts,entries:[],rates});
    assert.equal(result.period.closing,2.01);
    assert.equal(db.prepare('SELECT balance FROM bookkeeping_asset_snapshots').get().balance,2.07);
  } finally {db.close();}
});
