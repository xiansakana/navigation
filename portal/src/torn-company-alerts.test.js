import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { companyRules, companySignals, createCompanyAlertsStore, CompanyAlertsMonitor } from './torn-company-alerts-monitor.js';
import { createCompanyAlertsService } from './torn-company-alerts.js';
const profile = { id: 1, name: 'Company', rating: 9, trains: 12, upgrades: { storage_capacity: 1000 } }, key = '1234567890abcdef';
const now = Date.parse('2026-11-05T17:00:00Z') / 1000;
test('rules independently validate thresholds and preserve other tabs',()=>{
 const r=companyRules({salary:{enabled:true,days:5}});assert.equal(r.salary.days,5);assert.equal(r.training.hours,2);
 for(const x of [{salary:{days:-1}},{training:{hours:25}},{stock:{low:95,high:5}},{stock:{low:''}}])assert.throws(()=>companyRules(x));
});
test('salary uses exact last action timestamp, ignores missing/future time, and links the employee',()=>{
 const data={profile,employees:[{id:5,name:'Offline',last_action:{timestamp:now-4*86400}},{id:6,last_action:{timestamp:now-3*86400}},{id:7,last_action:{timestamp:now+1}},{id:8}]};
 const rows=companySignals('salary',{days:3},data,now);assert.equal(rows.length,1);assert.equal(rows[0].employeeId,5);assert.match(rows[0].message,/XID=5/);
});
test('training warns only within lead window and only when projected total exceeds 20',()=>{
 const r=companySignals('training',{hours:2},{profile},now);assert.equal(r.length,1);assert.equal(r[0].overflow,1);assert.equal(r[0].settlement,now+3600);
 assert.equal(companySignals('training',{hours:.5},{profile},now).length,0);
 assert.equal(companySignals('training',{hours:2},{profile:{...profile,trains:11}},now).length,0);
 assert.equal(companySignals('training',{hours:2},{profile},now+3600).length,0,'18:00 starts next settlement day');
 assert.equal(companySignals('training',{hours:24},{profile},now+3600)[0].settlement,now+3600+86400);
 assert.throws(()=>companySignals('training',{hours:2},{profile:{...profile,trains:null}},now));
});
test('stock uses sum of current stock divided by capacity, strict boundaries, and no on-order stock',()=>{
 const run=n=>companySignals('stock',{low:5,high:95},{profile,stock:[{in_stock:n,on_order:10000}]},now);
 assert.equal(run(950).length,0);assert.equal(run(50).length,0);assert.equal(run(951)[0].side,'high');assert.equal(run(49)[0].side,'low');
 assert.equal(companySignals('stock',{low:5,high:95},{profile,stock:[]},now).length,0);
 assert.throws(()=>companySignals('stock',{low:5,high:95},{profile:{...profile,upgrades:{}},stock:[{in_stock:2}]},now));
});
test('per-user durable dedup suppresses salary/training replay; stock can rearm after recovery',()=>{
 const db=new Database(':memory:'),s=createCompanyAlertsStore(db),w={id:'w',label:'Director'};
 try{const row={key:'salary:1:5:123',message:'offline'};assert.equal(s.commit('a','w:salary',[row],'salary',w,now).length,1);s.commit('a','w:salary',[],'salary',w,now);assert.equal(createCompanyAlertsStore(db).commit('a','w:salary',[row],'salary',w,now).length,0);assert.equal(s.get('b').history.length,0);
 const stock={key:'stock:1:high'};assert.equal(s.commit('a','w:stock',[stock],'stock',w,now).length,1);assert.equal(s.commit('a','w:stock',[stock],'stock',w,now).length,0);s.commit('a','w:stock',[],'stock',w,now);assert.equal(s.commit('a','w:stock',[stock],'stock',w,now).length,1);
 }finally{db.close();}
});
test('monitor reuses one profile, uses shared request scope, persists before notify and never replays failures',async()=>{
 const db=new Database(':memory:'),store=createCompanyAlertsStore(db),sent=[],calls=[];
 store.save('a',{rules:companyRules({salary:{enabled:true},training:{enabled:true},stock:{enabled:true}}),watchers:[{id:'w',label:'Director',apiKey:key}],intervalSeconds:60});
 const m=new CompanyAlertsMonitor({uid:'a',store,now:()=>now,request:async(p,k,signal,policy)=>{calls.push(p);assert.equal(policy.scope,'company-alerts:a');assert.equal(k,key);return p.endsWith('profile')?{profile}:p.endsWith('employees')?{employees:[{id:5,name:'Worker',last_action:{timestamp:now-4*86400}}]}:{stock:[{in_stock:990}]};},notify:async r=>{assert.ok(store.get('a').history.find(h=>h.key===r.key));sent.push(r);throw Error('failure');},schedule:()=>1,cancel() {}});
 try{m.start();await m.promise;assert.equal(sent.length,3);assert.equal(calls.filter(p=>p.endsWith('profile')).length,1);await m.scan();assert.equal(sent.length,3);assert.match(m.state.notificationError,/投递失败/);}finally{m.stop();db.close();}
});
test('API hides keys, checks each tab and rejects guest, unauthorized writes and cross-origin',async()=>{
 const db=new Database(':memory:'),store=createCompanyAlertsStore(db),svc=createCompanyAlertsService({store,roster:()=>[{id:'w',label:'Director',apiKey:key}],authorize:()=>true,notify:async()=>({sent:1})});
 const call=async(path,method='GET',body,permissions=['*'],isGuest=false,origin)=>{const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);req.method=method;req.headers={host:'test',...(origin?{origin}:{})};let result;await svc.handle(req,{setHeader(){}},new URL('http://test/api/torn-company-alerts/'+path),{userId:'a',permissions,isGuest},(_,status,data)=>result={status,data});return result;};
 try{assert.equal((await call('config','POST',{watcherIds:['w'],rules:{training:{enabled:true}}})).status,200);const d=await call('state');assert.equal(d.status,200);assert.ok(!JSON.stringify(d).includes(key));assert.equal(d.data.config.rules.training.enabled,true);
 assert.equal((await call('config','POST',{},['*'],true)).status,403);
 assert.equal((await call('training/notifications','PUT',{},['torn-company-alerts:view','torn-company-alerts:training:view'])).status,403);
 assert.equal((await call('config','POST',{rules:{stock:{enabled:true}}},['torn-company-alerts:view','torn-company-alerts:config:edit'])).status,403);
 assert.equal((await call('config','POST',{},['*'],false,'https://evil.test')).status,403);
 }finally{db.close();}
});
