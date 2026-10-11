import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { createBookkeepingStore, summarize, entryDate } from './bookkeeping-store.js';
import { parseIcost, exportIcost, ICOST_HEADERS } from './bookkeeping-import.js';
import { canBookkeep, handleBookkeepingApi } from './bookkeeping.js';
import { buildMenusFromServices, SYSTEM_PERMISSIONS } from './rbac.js';
import { resolveRoute, resolveProxyContext } from './router.js';

const date = '2026-10-11T12:00:00';
function setup() { const db = new Database(':memory:'); return { db, store: createBookkeepingStore(db) }; }
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
