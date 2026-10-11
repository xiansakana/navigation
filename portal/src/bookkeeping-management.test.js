import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { handleBookkeepingApi } from './bookkeeping.js';
const date='2026-10-11T12:00:00';
function setup(fn) {const db=new Database(':memory:');try {fn(createBookkeepingStore(db),db);}finally{db.close();}}
test('category rename, move and merge reclassify entries while preserving financial data',()=>setup((s,db)=>{
  const c=s.catalog, uid='a', accountId=s.saveAccount(uid,{name:'现金',balance:100});
  const a=c.save(uid,{kind:'expense',name:'外食'}), b=c.save(uid,{kind:'expense',name:'食物'});
  const child=c.save(uid,{kind:'expense',parentId:a,name:'午餐'});
  c.save(uid,{kind:'expense',parentId:b,name:'午餐'});
  c.save(uid,{kind:'income',name:'外食'});
  s.saveEntry(uid,{date,type:'支出',amount:10,accountId,category:'外食',subcategory:'午餐'});
  s.saveEntry(uid,{date,type:'收入',amount:5,accountId,category:'外食'});
  const before=db.prepare('SELECT id,amount,source_key,affects_balance,account_id,raw FROM bookkeeping_entries ORDER BY id').all();
  c.save(uid,{name:'餐费'},a);assert.equal(s.entries(uid).find(e=>e.type==='收入').category,'外食');
  c.save(uid,{name:'午饭'},child);assert.equal(s.entries(uid).find(e=>e.type==='支出').subcategory,'午饭');
  assert.throws(()=>c.save(uid,{name:'午餐',parentId:b},child),/已存在/);
  c.merge(uid,a,b);assert.equal(s.entries(uid).find(e=>e.type==='支出').category,'食物');
  const moved=c.list(uid).find(x=>x.id===child);assert.equal(moved.parentId,b);
  const target=c.list(uid).find(x=>x.parentId===b && x.name==='午餐');c.merge(uid,child,target.id);
  assert.equal(s.entries(uid).find(e=>e.type==='支出').subcategory,'午餐');
  assert.deepEqual(db.prepare('SELECT id,amount,source_key,affects_balance,account_id,raw FROM bookkeeping_entries ORDER BY id').all(),before);
  assert.equal(s.accounts(uid)[0].balance,95);
  assert.equal(c.list(uid).find(x=>x.id===b).count,1);
  assert.throws(()=>c.remove(uid,b),/已有账单/);
  const root=c.save(uid,{kind:'expense',name:'新根'});c.save(uid,{name:'新子',parentId:root},target.id);
  assert.equal(s.entries(uid).find(e=>e.type==='支出').category,'新根');
  assert.equal(s.entries(uid).find(e=>e.type==='支出').subcategory,'新子');
}));
test('primary merge deduplicates children and preserves imported identity and snapshot balance',()=>setup((s,db)=>{
  s.importRows('a',[{date,type:'支出',amount:10,category:'旧',subcategory:'子',sourceKey:'one',accountName:'现金',raw:{备注:'原始'}}],[{name:'现金',balance:120}]);
  const c=s.catalog, from=c.list('a').find(x=>x.name==='旧'), to=c.save('a',{kind:'expense',name:'新'});
  c.save('a',{kind:'expense',parentId:to,name:'子'});const eid=s.entries('a')[0].id;
  c.merge('a',from.id,to);assert.equal(c.list('a').filter(x=>x.parentId===to).length,1);
  assert.equal(s.entries('a')[0].id,eid);assert.equal(s.entries('a')[0].category,'新');assert.equal(s.entries('a')[0].historical,true);
  assert.equal(db.prepare('SELECT source_key FROM bookkeeping_entries').get().source_key,'one');
  assert.equal(s.accounts('a')[0].balance,120);
  assert.equal(s.importRows('a',[{date,type:'支出',amount:10,category:'旧',subcategory:'子',sourceKey:'one'}]).duplicates,1);
  assert.equal(c.list('a').some(x=>x.name==='旧'),false);
}));
test('disabled categories allow unchanged historical edits but reject new use; ownership and ordering are isolated',()=>setup(s=>{
  const c=s.catalog, root=c.save('a',{kind:'expense',name:'测试'}), child=c.save('a',{kind:'expense',name:'子',parentId:root});
  const eid=s.saveEntry('a',{date,type:'支出',amount:1,category:'测试',subcategory:'子'});
  c.save('a',{name:'子',parentId:root,archived:true},child);
  assert.throws(()=>s.saveEntry('a',{date,type:'支出',amount:1,category:'测试',subcategory:'子'}),/停用/);
  s.saveEntry('a',{...s.entries('a')[0],amount:2},eid);
  c.save('a',{name:'测试',archived:true},root);
  s.saveEntry('a',{...s.entries('a')[0],note:'历史修改'},eid);
  assert.throws(()=>s.saveEntry('a',{date,type:'支出',amount:1,category:'测试'}),/停用/);
  assert.throws(()=>c.save('b',{name:'窃取'},root),/不存在/);
  const all=c.list('a').map(x=>x.id);assert.throws(()=>c.reorder('b','categories',all),/不一致/);
  c.reorder('a','categories',[...all].reverse());assert.throws(()=>c.reorder('a','categories',[all[0],all[0]]),/无效/);
  assert.throws(()=>c.remove('a',root),/已有账单/);
  const empty=c.save('a',{kind:'expense',name:'空'});c.remove('a',empty);assert.equal(c.list('a').some(x=>x.id===empty),false);
}));
test('group rename and merge, account archiving and sort preserve balances and inclusion',()=>setup((s,db)=>{
  const a=s.saveAccount('a',{name:'现金',group:'现金组',balance:100}), b=s.saveAccount('a',{name:'卡',group:'卡组',balance:-20,accountType:'信用卡'});
  const eid=s.saveEntry('a',{date,type:'支出',amount:10,accountId:a});
  const c=s.catalog, group=c.groupList('a').find(g=>g.name==='现金组');
  c.saveGroup('a',{name:'日常'},group.id);assert.equal(s.accounts('a').find(x=>x.id===a).group,'日常');
  assert.throws(()=>c.removeGroup('a',group.id),/有账户/);
  const target=c.groupList('a').find(g=>g.name==='卡组');c.removeGroup('a',group.id,target.id);
  assert.equal(s.accounts('a').find(x=>x.id===a).group,'卡组');
  s.archiveAccount('a',a,true);assert.equal(s.accounts('a').find(x=>x.id===a).balance,90);assert.equal(s.accounts('a').find(x=>x.id===a).included,true);
  assert.throws(()=>s.saveEntry('a',{date,type:'支出',amount:1,accountId:a}),/归档/);
  s.saveEntry('a',{...s.entries('a')[0],amount:11},eid);assert.equal(s.accounts('a').find(x=>x.id===a).balance,89);
  assert.throws(()=>s.adjust('a',a,{date,balance:10}),/归档/);
  s.saveAccount('a',{name:'现金改名'},a);assert.equal(s.accounts('a').find(x=>x.id===a).archived,true);
  s.archiveAccount('a',a,false);s.saveEntry('a',{date,type:'支出',amount:1,accountId:a});
  s.reorderAccounts('a',[b,a]);assert.equal(createBookkeepingStore(db).accounts('a')[0].id,b);
  assert.throws(()=>s.reorderAccounts('b',[a,b]),/不一致/);assert.throws(()=>s.archiveAccount('b',a,true),/不存在/);
  const before=c.groupList('a').length;assert.throws(()=>s.saveAccount('a',{name:'卡',group:'失败孤儿'}),/已存在/);assert.equal(c.groupList('a').length,before);
  assert.equal(s.accounts('a').find(x=>x.id===a).balance,88);
}));
test('category management and account changes require independent API permissions',async()=>{
  for(const [path,method,permissions] of [['/categories','GET',['bookkeeping:view']],['/categories','POST',['bookkeeping:view','bookkeeping:categories:view']],['/groups','POST',['bookkeeping:view','bookkeeping:accounts:view']],['/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/archive','POST',['bookkeeping:view','bookkeeping:accounts:view']]]) {
    let code;const res={setHeader(){}};await handleBookkeepingApi({method,headers:{}},res,new URL('http://localhost/api/bookkeeping'+path),{userId:'a',permissions},(_,status)=>{code=status;});assert.equal(code,403);
  }
});
test('legacy schema migration is idempotent and leaves money and linkage untouched',()=>{
  const db=new Database(':memory:');try {
    db.exec(`CREATE TABLE bookkeeping_accounts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,group_name TEXT NOT NULL,currency TEXT NOT NULL,opening INTEGER NOT NULL,included INTEGER NOT NULL,credit_limit INTEGER NOT NULL,bill_day INTEGER NOT NULL,due_day INTEGER NOT NULL,note TEXT NOT NULL,snapshot_at TEXT NOT NULL,UNIQUE(user_id,name));INSERT INTO bookkeeping_accounts VALUES('old','a','旧卡','信用账户','USD',-1234,1,100000,1,20,'备注','2026-10-11');`);
    const s=createBookkeepingStore(db);assert.equal(s.accounts('a')[0].balance,-12.34);assert.equal(s.accounts('a')[0].accountType,'信用卡');
    s.archiveAccount('a','old',true);const tree=s.catalog.list('a');s.catalog.remove('a',tree.find(c=>c.kind==='expense' && c.name==='其他').id);
    const again=createBookkeepingStore(db);assert.equal(again.accounts('a')[0].archived,true);assert.equal(again.accounts('a')[0].balance,-12.34);assert.equal(again.catalog.list('a').some(c=>c.kind==='expense' && c.name==='其他'),false);
  }finally{db.close();}
});
