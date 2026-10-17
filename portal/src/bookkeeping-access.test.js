import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLoggedInPermissions } from './auth.js';
import { resolveUserPermissions, getVisibleMenus, buildMenusFromServices } from './rbac.js';
import { canBookkeep, handleBookkeepingApi } from './bookkeeping.js';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';

test('bookkeeping entry is visible without granting access to its data', async () => {
  const menus = buildMenusFromServices([]);
  for (const permissions of [[], ['bookkeeping:view'], ['*']]) {
    assert.ok(getVisibleMenus({ menus }, permissions).some(m => m.serviceId === 'bookkeeping'));
  }
  assert.ok(!getVisibleMenus({ menus: menus.map(m => ({ ...m, enabled: false })) }, []).length);
  let collected = false;
  await handleBookkeepingApi({ method: 'GET' }, { setHeader() {} }, new URL('http://localhost/api/bookkeeping/state'),
    { userId: 'guest', isGuest: true, permissions: ['*'] }, (_, status) => { collected = true; assert.equal(status, 403); });
  assert.ok(collected);
});

test('signed-in members get their own bookkeeping features even when registered with the guest role',()=>{
  const data={roles:[{id:'role_guest',permissions:['service:stock-manage:view']}],menus:buildMenusFromServices([])};
  const user={id:'member',username:'member',roleIds:['role_guest'],enabled:true};
  const before=JSON.stringify(data),permissions=resolveLoggedInPermissions(data,user);
  for (const p of ['view','entries:edit','accounts:edit','analysis:view','import:edit','qq:edit']) assert.ok(permissions.includes('bookkeeping:'+p));
  assert.ok(getVisibleMenus(data,permissions).some(m=>m.serviceId==='bookkeeping'));
  assert.ok(!permissions.includes('service:stock-manage:cash:view'));
  assert.ok(!permissions.includes('admin:access'));
  assert.deepEqual(resolveUserPermissions(data,user),['service:stock-manage:view']);
  assert.equal(JSON.stringify(data),before);
  assert.ok(!resolveLoggedInPermissions(data,{...user,username:'guest'}).includes('bookkeeping:view'));
  assert.ok(!resolveLoggedInPermissions(data,{...user,username:'visitor'},{auth:{guestUsername:'visitor'}}).includes('bookkeeping:view'));
  assert.deepEqual(resolveLoggedInPermissions(data,{...user,enabled:false}),[]);
  assert.deepEqual(resolveLoggedInPermissions(data,null),[]);
});

test('default personal access keeps entries, assets and preferences isolated and blocks guests',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bookkeeping-access-')),previous=process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH=path.join(dir,'test.db');
  try {
    const store=createBookkeepingStore(getDatabase());
    const a=store.saveAccount('a',{name:'私人现金',balance:99});
    const entry=store.saveEntry('a',{date:'2026-10-16T12:00:00',type:'支出',amount:1,accountId:a});
    store.savePeriodPreferences('a',{kind:'range',anchor:'2026-10-16',rangeStart:'2026-10-01',rangeEnd:'2026-10-16'});
    const session=userId=>({userId,username:userId,isGuest:false,permissions:resolveLoggedInPermissions({roles:[]},{id:userId,username:userId})});
    const call=async(url,method='GET',data=null,ctx=session('b'))=>{
      let status,result;
      const req={method,headers:{},async *[Symbol.asyncIterator](){if(data)yield Buffer.from(JSON.stringify(data));}};
      await handleBookkeepingApi(req,{setHeader(){}},new URL('http://localhost/api/bookkeeping'+url),ctx,(_,s,b)=>{status=s;result=b;});
      return {status,result};
    };
    const own=await call('/state');assert.equal(own.status,200);assert.deepEqual(own.result.accounts,[]);assert.deepEqual(own.result.entries,[]);
    assert.equal((await call('/entries/'+entry)).status,404);
    const detail=await call('/entries/'+entry,'GET',null,session('a'));
    assert.equal(detail.status,200);assert.equal(detail.result.entry.id,entry);
    assert.equal(detail.result.entry.cnyAmount,1);
    assert.equal(detail.result.entry.balanceCheckpoint,undefined);
    assert.equal((await call('/preferences')).result.period,null);
    const foreign=await call('/state?accountId='+a);assert.deepEqual(foreign.result.entries,[]);
    const edit=await call('/entries/'+entry,'PUT',{date:'2026-10-16T12:00:00',type:'支出',amount:2,accountId:a});assert.notEqual(edit.status,200);
    assert.equal(store.entries('a')[0].amount,1);
    const created=await call('/accounts','POST',{name:'自己的现金',balance:20,userId:'a'});
    assert.equal(created.status,201);
    const recorded=await call('/entries','POST',{date:'2026-10-16T12:00:00',type:'支出',amount:2,accountId:created.result.id,userId:'a'});
    assert.equal(recorded.status,201);
    assert.equal(store.accounts('b')[0].balance,18);
    assert.equal(store.entries('b')[0].id,recorded.result.id);
    assert.equal(store.accounts('a').length,1);assert.equal(store.entries('a')[0].amount,1);
    const guest=await call('/state','GET',null,{userId:'guest',isGuest:true,permissions:['*']});assert.equal(guest.status,403);
    const anonymous=await call('/state','GET',null,{});assert.equal(anonymous.status,403);
  } finally {
    closeDatabase();if(previous==null)delete process.env.NAVIGATION_DB_PATH;else process.env.NAVIGATION_DB_PATH=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
