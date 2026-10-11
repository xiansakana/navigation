import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createQqBookkeeping, parseQqCommand, internalQqAuthorized } from './bookkeeping-qq.js';
import { createBookkeepingStore } from './bookkeeping-store.js';

function setup() {
  const db=new Database(':memory:'),store=createBookkeepingStore(db);let allowed=true,now=Date.parse('2026-10-11T16:30:00Z');
  const service=createQqBookkeeping(db,{resolveUser:()=>allowed?{permissions:['*']}:null,clock:()=>now});
  const a=store.saveAccount('a',{name:'资金账户-微信',balance:1000}),b=store.saveAccount('a',{name:'支付宝',balance:0}),h=store.saveAccount('a',{name:'港币',currency:'HKD',balance:1000});
  service.save('a',{defaultAccountId:a,groups:'123456',aliases:'微信=资金账户-微信'});
  const event=(text,messageId='1',extra={})=>({selfId:'2942493314',qqId:'12345678',type:'private',messageId,text:!extra.keepLocation && /^(记账|转账)\s/.test(text)?text+' 定位=跳过':text,...extra});
  const bind=()=>service.process(event('绑定记账 '+service.code('a').code,'bind'));
  return {db,store,service,event,bind,a,b,h,deny:()=>{allowed=false;},advance:()=>{now+=700000;}};
}
test('bind code proves QQ ownership, expires and cannot be consumed in groups',()=>{
  const t=setup();try{
    const code=t.service.code('a').code;
    assert.throws(()=>t.service.process(t.event('绑定记账 '+code,'g',{type:'group',groupId:'123456'})),/私聊/);
    t.advance();assert.throws(()=>t.service.process(t.event('绑定记账 '+code)),/过期/);
    t.bind();assert.equal(t.service.status('a').qqId,'12345678');
    assert.throws(()=>t.service.process(t.event('绑定记账 '+t.service.code('b').code,'b')),/其他账号/);
    t.service.unbind('a');assert.equal(t.service.status('a').qqId,'');
  }finally{t.db.close();}
});
test('location before bill is consumed once; missing location reminds, late card only updates location',()=>{
  const t=setup();try{
    t.bind();const loc={latitude:31.2,longitude:121.5,label:'测试餐厅'};
    t.service.process(t.event('','loc',{location:loc}));
    const raw=(text,id,extra={})=>t.event(text,id,{keepLocation:true,...extra});
    t.service.process(raw('记账 支出 20 餐饮 微信','with-location'));
    assert.equal(t.store.entries('a')[0].location,'测试餐厅');
    const r=t.service.process(raw('记账 支出 30 餐饮 微信','missing'));
    assert.match(r.reply,/已保存.*还没有位置/);
    assert.throws(()=>t.service.process(raw('记账 支出 40 餐饮 微信','blocked')),/本指令未入账/);
    const missing=t.store.entries('a').find(e=>e.amount===30);const balance=t.store.accounts('a').find(a=>a.id===t.a).balance;
    const result=t.service.process(raw('','followup',{location:{...loc,label:'第二位置'}}));
    assert.match(result.reply,/已补充/);assert.equal(t.store.entries('a').find(e=>e.id===missing.id).location,'第二位置');
    assert.equal(t.store.accounts('a').find(a=>a.id===t.a).balance,balance);
    assert.equal(t.service.process(raw('','followup',{location:loc})).duplicate,true);
    assert.equal(t.store.entries('a').length,2);
    t.service.process(raw('记账 支出 5 餐饮 微信','skip-pending'));t.service.process(raw('跳过定位','skip'));
    t.service.process(raw('记账 支出 6 餐饮 微信 定位=跳过','explicit-skip'));
  }finally{t.db.close();}
});
test('group standalone cards require pending context and never cross user or chat boundaries',()=>{
  const t=setup();try{
    t.bind();const loc={latitude:31.2,longitude:121.5,label:'群位置'};
    const group=(text,id,extra={})=>t.event(text,id,{type:'group',groupId:'123456',keepLocation:true,...extra});
    assert.equal(t.service.process(group('','no-context',{location:loc,locationOnly:true})).ignored,true);
    t.service.process(group('记账 支出 10 餐饮 微信','g-bill'));
    assert.equal(t.service.process(group('','other-user',{qqId:'87654321',location:loc,locationOnly:true})).ignored,true);
    t.service.process(t.event('','private-card',{location:{...loc,label:'私聊位置'}}));
    assert.equal(t.store.entries('a')[0].location,'');
    t.service.process(group('','g-card',{location:loc,locationOnly:true}));assert.equal(t.store.entries('a')[0].location,'群位置');
    t.service.process(group('记账定位','prepare'));t.service.process(group('','prepared-card',{location:loc,locationOnly:true}));
    t.advance();const r=t.service.process(group('记账 支出 15 餐饮 微信','expired'));
    assert.match(r.reply,/还没有位置/);assert.equal(t.store.entries('a').find(e=>e.amount===15).location,'');
    assert.throws(()=>t.service.process(group('','bad-card',{location:{latitude:91,longitude:121}})),/坐标/);
  }finally{t.db.close();}
});
test('explicit backfill checks same sender and conversation, and cannot change money',()=>{
  const t=setup();try{
    t.bind();t.service.process(t.event('记账 支出 12 餐饮 微信','bill'));
    const eid=t.store.entries('a')[0].id;
    assert.throws(()=>t.service.process(t.event('补充位置 '+eid,'g',{type:'group',groupId:'123456'})),/本聊天/);
    t.service.process(t.event('补充位置 '+eid,'select'));
    t.service.process(t.event('','card',{location:{latitude:31,longitude:121,label:'补充位置'}}));
    assert.equal(t.store.entries('a')[0].amount,12);assert.equal(t.store.entries('a')[0].location,'补充位置');
    t.service.process(t.event('撤销 '+eid,'remove'));assert.throws(()=>t.service.process(t.event('补充位置 '+eid,'deleted')),/本聊天/);
  }finally{t.db.close();}
});
test('QQ bills update balances once, survive recreated service, and undo only own QQ bills',()=>{
  const t=setup();try{
    t.bind();const first=t.service.process(t.event('记账 支出 35 餐饮 微信 备注=午餐'));
    assert.equal(t.store.accounts('a').find(a=>a.id===t.a).balance,965);
    const again=createQqBookkeeping(t.db,{resolveUser:()=>({permissions:['*']})}).process(t.event('记账 支出 35 餐饮 微信 备注=午餐'));
    assert.equal(again.duplicate,true);assert.equal(t.store.entries('a').length,1);
    const e=t.store.entries('a')[0];assert.equal(e.date.slice(0,10),'2026-10-12');assert.equal(e.note,'午餐');
    t.service.ack(first.eventKey);assert.equal(t.service.process(t.event('记账 支出 35 餐饮 微信')).sent,true);
    t.service.process(t.event('撤销 '+e.id,'undo'));assert.equal(t.store.accounts('a').find(a=>a.id===t.a).balance,1000);
    assert.throws(()=>t.service.process(t.event('撤销 '+e.id,'undo2')),/不存在/);
    const web=t.store.saveEntry('a',{date:'2026-10-11T12:00:00',type:'支出',amount:2,accountId:t.a});
    assert.throws(()=>t.service.process(t.event('撤销 '+web,'web')),/只能撤销/);
  }finally{t.db.close();}
});
test('group authorization, sender isolation and permission revocation cover retries',()=>{
  const t=setup();try{
    t.bind();assert.throws(()=>t.service.process(t.event('记账 支出 35 餐饮','g',{type:'group',groupId:'999999'})),/未授权/);
    assert.throws(()=>t.service.process(t.event('记账 支出 35 餐饮','x',{qqId:'87654321',type:'group',groupId:'123456'})),/尚未绑定/);
    const r=t.service.process(t.event('记账 支出 35 餐饮','g',{type:'group',groupId:'123456'}));
    assert.doesNotMatch(r.reply,/餐饮|CNY|微信/);
    t.deny();assert.throws(()=>t.service.process(t.event('记账 支出 35 餐饮','g',{type:'group',groupId:'123456'})),/权限/);
    assert.equal(t.store.entries('a').length,1);
  }finally{t.db.close();}
});
test('foreign transfer validation is atomic, aliases and date/currency errors never insert',()=>{
  const t=setup();try{
    t.bind();
    let i=0;
    for(const text of ['记账 支出 120 HKD 餐饮 微信','记账 支出 5 不存在 微信','记账 支出 5 餐饮 微信 日期=2026-02-30','转账 500 微信 到 港币','记账 支出 5 餐饮 微信 多余','记账 支出 0 餐饮'])assert.throws(()=>t.service.process(t.event(text,'invalid-'+i++)));
    assert.equal(t.store.entries('a').length,0);
    t.service.process(t.event('转账 500 微信 到 港币 到账=550','transfer'));
    assert.equal(t.store.accounts('a').find(a=>a.id===t.a).balance,500);assert.equal(t.store.accounts('a').find(a=>a.id===t.h).balance,1550);
    t.service.process(t.event('记账 支出 120 HKD 购物 港币 日期=2026-10-10','hkd'));
    assert.equal(t.store.entries('a').find(e=>e.currency==='HKD').amount,120);
    assert.throws(()=>t.service.save('a',{aliases:'微信=不存在'}),/不存在/);
    assert.throws(()=>t.service.save('a',{defaultAccountId:'foreign'}),/默认账户/);
  }finally{t.db.close();}
});
test('archived accounts, guest permissions and public spoofing fail closed',()=>{
  const t=setup();try{
    t.bind();t.store.archiveAccount('a',t.a,true);assert.throws(()=>t.service.process(t.event('记账 支出 5 餐饮 微信')),/账户/);
    const guest=createQqBookkeeping(t.db,{resolveUser:()=>({permissions:['*'],isGuest:true})});assert.throws(()=>guest.code('a'),/权限/);
    assert.equal(internalQqAuthorized({socket:{remoteAddress:'8.8.8.8'},headers:{authorization:'Bearer spoof'}}),false);
  }finally{t.db.close();}
});
