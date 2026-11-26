import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { createBookkeepingStore, summarize, entryDate } from './bookkeeping-store.js';
import { parseIcost, exportIcost, ICOST_HEADERS } from './bookkeeping-import.js';
import { canBookkeep, handleBookkeepingApi, publicAccounts } from './bookkeeping.js';
import { reviewIcostImport } from './bookkeeping-import-review.js';
import { buildMenusFromServices, SYSTEM_PERMISSIONS } from './rbac.js';
import { resolveRoute, resolveProxyContext } from './router.js';

const date = '2026-10-11T12:00:00';
test('linked bookkeeping assets respect stock cash permissions and omit raw portfolio details', () => {
  const linked = { id: 'ledger', balance: 1550, ledgerBalance: 30000, balanceSource: 'portfolio', investment: { id: 'broker', name: 'Broker', cash: 1000, marketValue: 550, positions: [{ symbol: 'AAPL' }], movements: [{ delta: 5 }], missingQuotes: [] } };
  const hidden = publicAccounts([linked], { permissions: ['bookkeeping:view', 'bookkeeping:accounts:view'] })[0];
  assert.equal(hidden.balance, null);
  assert.equal(hidden.investment.permissionMissing, true);
  for (const key of ['cash', 'marketValue', 'positions', 'movements']) assert.equal(hidden.investment[key], undefined);
  assert.equal(hidden.ledgerBalance, undefined);
  const visible = publicAccounts([linked], { permissions: ['service:stock-manage:cash:view'] })[0];
  assert.equal(visible.balance, 1550);
  assert.equal(visible.investment.cash, 1000);
  assert.equal(visible.investment.positions, undefined);
});
function setup() { const db = new Database(':memory:'); return { db, store: createBookkeepingStore(db) }; }
test('reviewed iCost import projects and posts only explicitly selected balance movements',()=>{
  const {db,store}=setup();
  try {
    const options={visible:()=>true,canPost:true,quote:()=>null};
    const accountId=store.saveAccount('a',{name:'5431',balance:-61.83,currency:'USD',snapshotAt:'2026-10-11'});
    store.saveAccount('a',{name:'银行卡',balance:100,currency:'USD',snapshotAt:'2026-11-15'});
    const charge={date:'2026-11-14T09:00:00',type:'支出',amount:7.14,currency:'USD',accountName:'5431',sourceKey:'expense'};
    const rows=[charge,{...charge,amount:1,date:'2026-10-10T09:00:00',sourceKey:'old'},
      {...charge,type:'转账',toAccountName:'银行卡',sourceKey:'transfer'}];
    const review=(decisions,extra={})=>reviewIcostImport(db,store,'a',rows,[],decisions,{...options,...extra});
    const initial=review({});
    assert.equal(initial.unresolved,2);
    assert.deepEqual(initial.candidates.map(row=>[row.index,row.postAllowed,row.historyAllowed,row.defaultDecision]),[[0,true,true,''],[1,false,true,'history'],[2,false,false,'']]);
    const historical=review({0:'history',1:'skip',2:'skip'});
    assert.equal(historical.unresolved,0);
    assert.equal(historical.inserted,1);
    assert.equal(historical.balances[0].after,-61.83);
    const choices={0:'post',2:'skip'}, ready=review(choices);
    assert.equal(ready.unresolved,0);
    assert.deepEqual(ready.balances.map(a=>[a.current,a.change,a.after,a.latest]),[[-61.83,-7.14,-68.97,-68.97]]);
    assert.equal(store.entries('a').length,0);
    assert.throws(()=>review({0:'post',2:'history'},{expected:ready.revision}),/核对/);
    const concurrent=store.saveEntry('a',{date:'2026-11-15T12:00:00',type:'支出',amount:1,currency:'USD',accountId});
    assert.throws(()=>review(choices,{expected:ready.revision}),/核对/);
    store.removeEntry('a',concurrent);
    review(choices,{expected:review(choices).revision});
    assert.equal(store.accounts('a').find(a=>a.name==='5431').balance,-68.97);
    assert.equal(review({2:'skip'}).duplicates,2);
  } finally {db.close();}
});
test('account balances use integer cents, transfers and refunds; changes reverse correctly', () => {
  const { db, store:s } = setup();
  try {
    const a=s.saveAccount('a',{name:'现金',balance:1000}), b=s.saveAccount('a',{name:'信用卡',balance:-100,creditLimit:500,group:'信用账户'});
    const eid=s.saveEntry('a',{date,type:'支出',amount:0.1,currency:'CNY',accountId:a,category:'餐饮'});
    s.saveEntry('a',{date,type:'支出',amount:0.2,accountId:a});
    assert.equal(s.accounts('a')[0].balance,999.7);
    s.saveEntry('a',{date,type:'支出',amount:20,accountId:a},eid); assert.equal(s.accounts('a')[0].balance,979.8);
    s.removeEntry('a',eid); assert.equal(s.accounts('a')[0].balance,999.8);
    s.saveEntry('a',{date,type:'还款',amount:100,accountId:a,toAccountId:b});
    assert.equal(s.accounts('a')[1].balance,0); assert.equal(s.accounts('a')[0].balance,899.8);
    s.saveEntry('a',{date,type:'退款入账',amount:10,accountId:a}); assert.equal(s.accounts('a')[0].balance,909.8);
    const adjustment=s.adjust('a',a,{date,balance:1000});assert.equal(s.accounts('a')[0].balance,1000);s.removeEntry('a',adjustment);assert.equal(s.accounts('a')[0].balance,909.8);
  } finally { db.close(); }
});

test('editing a purchase can post and update one dated refund without changing the purchase amount',()=>{
  const {db,store}=setup();
  try{
    const u='a',accountId=store.saveAccount(u,{name:'银行卡',balance:100});
    const id=store.saveEntry(u,{date,type:'支出',amount:15,accountId,category:'购物',discount:3});
    const refundDate='2026-10-12T11:15:00';
    const original=()=>store.entries(u).find(e=>e.id===id);
    store.saveEntry(u,{...original(),refund:10},id);
    assert.equal(store.accounts(u)[0].balance,85);
    assert.throws(()=>store.saveEntry(u,{...original(),refund:16,refundDate},id),/不超过原支出/);
    assert.equal(store.entries(u).length,1);
    const post=()=>store.saveEntry(u,{...original(),refund:10,refundDate},id);
    post(); post();
    const refund=store.entries(u).find(e=>e.type==='退款入账');
    assert.deepEqual([refund.date,refund.amount,refund.accountId,refund.category],[refundDate,10,accountId,'购物']);
    assert.equal(original().refundPostedAt,refundDate);
    assert.equal(store.entries(u).length,2);
    assert.equal(store.accounts(u)[0].balance,95);
    assert.equal(summarize(store.entries(u)).totals.CNY.expense,5);
    store.saveEntry(u,{...original(),refund:15,refundDate},id);
    assert.equal(store.entries(u).find(e=>e.type==='退款入账').id,refund.id);
    assert.equal(store.accounts(u)[0].balance,100);
    assert.equal(original().amount,15);
  }finally{db.close();}
});
test('user isolation guards IDs, settings and account deletion',()=>{
  const {db,store:s}=setup();try{
    const aid=s.saveAccount('a',{name:'资产',balance:20});
    assert.deepEqual(s.accounts('b'),[]);
    assert.throws(()=>s.saveEntry('b',{date,type:'支出',amount:1,accountId:aid}),/不属于/);
    assert.throws(()=>s.saveAccount('b',{name:'x'},aid),/不存在/);
    const eid=s.saveEntry('a',{date,type:'支出',amount:1,accountId:aid});
    assert.throws(()=>s.removeEntry('b',eid),/不存在/);assert.throws(()=>s.removeAccount('a',aid),/存在账单/);
    assert.throws(()=>s.saveEntry('b',{date,type:'收入',amount:1},eid),/不存在/);
    s.saveSettings('a',{rates:{CNY:1,USD:7},budgets:{'2026-10':100}});assert.deepEqual(s.settings('b'),{rates:{CNY:1},budgets:{}});
  }finally{db.close();}
});
test('foreign exchange transfers require destination amount and do not mix currencies',()=>{
  const {db,store:s}=setup();try{
    const a=s.saveAccount('a',{name:'CNY',balance:700}),b=s.saveAccount('a',{name:'USD',currency:'USD',balance:0});
    assert.throws(()=>s.saveEntry('a',{date,type:'转账',amount:700,accountId:a,toAccountId:b}),/到账金额/);
    s.saveEntry('a',{date,type:'转账',amount:700,accountId:a,toAccountId:b,toAmount:100});
    assert.equal(s.accounts('a')[0].balance,0);assert.equal(s.accounts('a')[1].balance,100);
    assert.equal(summarize(s.entries('a')).totals.CNY.expense,0);
    assert.throws(()=>s.saveEntry('a',{date,type:'支出',amount:1,currency:'USD',accountId:a}),/货币/);
  }finally{db.close();}
});
test('historical imports preserve snapshots, duplicate multiplicity, and atomic validation',()=>{
  const {db,store:s}=setup();try{
    const snapshot={name:'账户',currency:'USD',balance:100,included:false};
    const row={date,type:'支出',amount:10,currency:'CNY',accountName:'账户',sourceKey:'one',raw:{金额:-10}};
    assert.deepEqual(s.importRows('a',[row],[snapshot]),{inserted:1,duplicates:0,createdAccounts:1});
    assert.equal(s.accounts('a')[0].balance,100);assert.equal(s.entries('a')[0].currency,'CNY');
    assert.deepEqual(s.importRows('a',[row,{...row,sourceKey:'two'}],[{...snapshot,balance:1000}]),{inserted:1,duplicates:1,createdAccounts:0});
    assert.equal(s.accounts('a')[0].balance,100);
    assert.throws(()=>s.importRows('a',[{...row,sourceKey:'three'},{...row,date:'bad',sourceKey:'four'}]),/日期/);assert.equal(s.entries('a').length,2);
    const eid=s.entries('a')[0].id;s.saveEntry('a',{...s.entries('a')[0],amount:12},eid);assert.equal(s.accounts('a')[0].balance,100);
  }finally{db.close();}
});
test('statistics avoid transfer/refund double counting and split currencies',()=>{
  const entry=(type,amount,currency='CNY',extra={})=>({date,type,amount,currency,category:'测试',...extra});
  const stats=summarize([entry('支出',100,'CNY',{refund:10,discount:5}),entry('退款入账',10),entry('已报销',20),entry('报销入账',20),entry('收入',150),entry('转账',1000,'CNY',{fee:2}),entry('余额调整',30),entry('支出',3,'USD')]);
  assert.equal(stats.totals.CNY.expense,92);assert.equal(stats.totals.CNY.income,150);assert.equal(stats.totals.CNY.net,58);assert.equal(stats.totals.USD.expense,3);
});
test('iCost parsing recognizes original columns and keeps identical-row multiplicity',async()=>{
  const w=new ExcelJS.Workbook(),s=w.addWorksheet('收支账单');s.addRow(ICOST_HEADERS);
  const r=['2026/10/11 12:00:00','支出',-12.5,'餐饮','','','','备注','CNY','','个人账本'];s.addRow(r);s.addRow(r);
  const parsed=await parseIcost(Buffer.from(await w.xlsx.writeBuffer()));assert.equal(parsed.rows.length,2);assert.notEqual(parsed.rows[0].sourceKey,parsed.rows[1].sourceKey);assert.equal(parsed.errors.length,0);
  const roundtrip=await parseIcost(await exportIcost(parsed.rows));assert.equal(roundtrip.rows[0].amount,12.5);
  s.addRow(['2026/02/30 12:00:00','支出',-2,'餐饮','','','','','CNY','','个人账本']);
  const invalid=await parseIcost(Buffer.from(await w.xlsx.writeBuffer()));assert.equal(invalid.errors.length,1);assert.equal(invalid.errors[0].line,4);
  s.addRow(['2026/10/11 12:00:00','支出',0,'购物','','','','全额优惠','CNY','','个人账本']);
  const zero=await parseIcost(Buffer.from(await w.xlsx.writeBuffer()));assert.ok(zero.rows.some(r=>r.amount===0));
  await assert.rejects(()=>parseIcost(Buffer.from('not an xlsx')),/合法 XLSX/);
  assert.throws(()=>entryDate('2026-02-30T12:00:00'),/无效/);
});
test('guests and read-only users cannot write; new namespace is never proxied',async()=>{
  assert.equal(canBookkeep({userId:'guest',isGuest:true,permissions:['*']}),false);
  assert.equal(canBookkeep({userId:'a',permissions:['bookkeeping:view']},'entries:edit'),false);
  const req={method:'POST',headers:{}},res={setHeader(){}};
  let status;const json=(_,s)=>{status=s;};
  await handleBookkeepingApi(req,res,new URL('http://localhost/api/bookkeeping/entries'),{userId:'a',permissions:['bookkeeping:view']},json);assert.equal(status,403);
  await handleBookkeepingApi(req,res,new URL('http://localhost/api/bookkeeping/state'),{userId:'guest',isGuest:true,permissions:['*']},json);assert.equal(status,403);
  const crossSite={method:'POST',headers:{host:'localhost',origin:'http://evil.test'},url:'/api/bookkeeping/entries'};
  await handleBookkeepingApi(crossSite,res,new URL('http://localhost/api/bookkeeping/entries'),{userId:'a',permissions:['*']},json);assert.equal(status,403);
  assert.equal(resolveRoute([], '/api/bookkeeping/state','GET').kind,'portal-api');
  assert.equal(resolveProxyContext([{id:'napcat',type:'proxy',path:'/napcat'}],'/api/bookkeeping/state',{referer:'http://localhost/napcat/'}),null);
  const menu=buildMenusFromServices([]).find(m=>m.serviceId==='bookkeeping');assert.equal(menu.permission,'bookkeeping:view');
  assert.ok(SYSTEM_PERMISSIONS.filter(p=>p.id.startsWith('bookkeeping:')).every(p=>p.permissionPath[0]==='首页'));
});
