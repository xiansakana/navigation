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
  const event=(text,messageId='1',extra={})=>({selfId:'2942493314',qqId:'12345678',type:'private',messageId,text,...extra});
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
    assert.doesNotMatch(r.reply,/餐饮|CNY|35|微信/);
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
