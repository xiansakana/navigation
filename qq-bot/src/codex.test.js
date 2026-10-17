import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { codexEvent, createCodexService, authorizedCodexUser } from './codex.js';
import { createCodexStore } from './codex-store.js';
import { normalizeConfig, publicConfig, applyPublicConfig } from './config.js';
import { createQqCommandReceiver } from './bookkeeping.js';
import { SYSTEM_PERMISSIONS } from '../../portal/src/rbac.js';

const Database = createRequire(new URL('../../portal/package.json', import.meta.url))('better-sqlite3');
const event = text => ({post_type:'message',message_type:'private',user_id:12345678,self_id:22222222,message_id:42,message:[{type:'text',data:{text}}]});
function fixture(execute) {
  const db = new Database(':memory:'), store = createCodexStore(db), sent = [];
  const config = normalizeConfig({codex:{enabled:true,defaultProject:'navigation',projects:{navigation:{directory:path.resolve(os.tmpdir(),'codex-test'),remote:'git@example.com:repo.git'}}}});
  const user = {userId:'u1',qqId:'12345678',projects:['navigation']};
  let allowed = true;
  const service = createCodexService({getConfig:()=>config,store,authorize:qq=>allowed&&qq===user.qqId?user:null,send:async(c,target,text)=>{sent.push({target,text});},execute});
  return {db,store,config,service,sent,revoke:()=>{allowed=false;},close:()=>{service.stop();db.close();}};
}

test('QQ Codex accepts explicit private text only; group, self, attachments and ordinary chats cannot execute',()=>{
  assert.equal(codexEvent(event('hello')),null);
  assert.equal(codexEvent({...event('codex test'),message_type:'group'}),null);
  assert.equal(codexEvent({...event('codex test'),user_id:22222222}),null);
  assert.equal(codexEvent({...event('codex test'),message:[...event('codex test').message,{type:'image',data:{}}]}),null);
  assert.equal(codexEvent({...event('codex test'),message:'codex test'}),null);
  assert.equal(codexEvent(event('/codex navigation test')).text,'navigation test');
  assert.equal(codexEvent(event('codex test\nnext')).text,'test\nnext');
});

test('queue is deduplicated durably, respects whitelist and resumes only its own QQ session',async()=>{
  const seen=[]; const f=fixture(async(c,j,s)=>{seen.push({j,s});return {result:'任务完成',sessionId:'session-owner',commit:'abc123'};});
  try {
    await f.service.receive({...event('codex test'),user_id:87654321}); assert.equal(f.store.active('u1').length,0);
    await f.service.receive(event('codex navigation 检查代码')); await f.service.receive(event('codex navigation 检查代码'));
    assert.equal(f.store.active('u1').length,1);
    f.service.start(); await f.service.tick(); assert.equal(seen.length,1);assert.equal(seen[0].s,undefined);
    await f.service.receive({...event('codex 继续'),message_id:43}); await f.service.tick();
    assert.equal(seen[1].s,'session-owner'); assert.equal(f.store.active('other').length,0);
    await f.service.deliver(); assert.equal(f.sent[0].target.type,'private');assert.equal(f.sent[0].target.userId,'12345678');
    await f.service.receive({...event('codex 结果'),message_id:44}); assert.ok(f.store.latestResult('u1'));
    const recreated=createCodexStore(f.db);assert.equal(recreated.event('22222222:12345678:42'),false);
  } finally {f.close();}
});

test('private provisioning is not exposed or writable through public notification config',()=>{
  const c=normalizeConfig({codex:{enabled:true,binary:'/private/bin',allowedUsers:[{userId:'u',qqId:'12345678'}],projects:{private:{remote:'secret'}}}});
  assert.equal(publicConfig(c).codex,undefined);
  assert.deepEqual(applyPublicConfig(c,{codex:{enabled:false,allowedUsers:[{userId:'attacker'}]}}).codex,c.codex);
  assert.deepEqual(SYSTEM_PERMISSIONS.find(p=>p.id==='qq-codex:execute').permissionPath,['首页','通知管理','QQ Codex','执行任务']);
});

test('Portal account and explicit Codex permission are rechecked independently of QQ allowlist',()=>{
  const db=new Database(':memory:');db.exec('CREATE TABLE rbac_snapshot(id INTEGER PRIMARY KEY,payload TEXT)');
  const c={allowedUsers:[{userId:'u',qqId:'12345678',projects:['navigation']}]};
  const rbac={users:[{id:'u',username:'owner',roleIds:['r']}],roles:[{id:'r',permissions:[]}]};
  const save=()=>db.prepare('INSERT OR REPLACE INTO rbac_snapshot VALUES(1,?)').run(JSON.stringify(rbac));
  try {
    save(); assert.equal(authorizedCodexUser(c,'12345678',db),null);
    rbac.roles[0].permissions=['qq-codex:execute'];save();assert.equal(authorizedCodexUser(c,'12345678',db).userId,'u');
    rbac.users[0].enabled=false;save();assert.equal(authorizedCodexUser(c,'12345678',db),null);
  } finally {db.close();}
});

test('stop aborts active execution and cancels queued jobs without replaying changes',async()=>{
  let started;const running=new Promise(resolve=>{started=resolve;});
  const f=fixture(async(c,j,s,{signal})=>{started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));});
  try {
    await f.service.receive(event('codex task'));f.service.start();const tick=f.service.tick();await running;
    await f.service.receive({...event('codex task2'),message_id:43});
    await f.service.receive({...event('codex 停止'),message_id:44});await tick;
    assert.equal(f.store.active('u1').filter(j=>j.state==='cancelled').length,2);
  } finally {f.close();}
});

test('failed replies remain pending and authorization revocation drops delivery',async()=>{
  const f=fixture();try {
    await f.service.receive(event('codex 帮助'));f.revoke();await f.service.deliver();assert.equal(f.sent.length,0);assert.equal(f.store.pendingReply(),undefined);
    f.store.reply('u1','12345678','[CQ:at,qq=all]');assert.ok(f.store.pendingReply().message.startsWith('［CQ:'));
  }finally {f.close();}
});

test('outbox retries transport errors without repeating an already accepted task',async()=>{
  const f=fixture();let fail=true,sent=0;
  const service=createCodexService({getConfig:()=>f.config,store:f.store,authorize:()=>({userId:'u1',projects:['navigation']}),log:{error(){}},send:async()=>{if(fail)throw new Error('offline');sent++;}});
  try {
    await service.receive(event('codex 帮助'));await service.deliver();assert.equal(sent,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM qq_codex_outbox').get().n,1);
    fail=false;f.db.prepare('UPDATE qq_codex_outbox SET next_attempt=0').run();await service.deliver();assert.equal(sent,1);assert.equal(f.store.pendingReply(),undefined);
    assert.throws(()=>f.store.transaction(()=>{f.store.event('rollback');throw new Error('interrupt');}),/interrupt/);
    assert.equal(f.store.event('rollback'),true);
  } finally {service.stop();f.close();}
});

test('stale executions are marked interrupted rather than automatically executed again',()=>{
  const f=fixture();try {
    f.store.enqueue('u1','12345678','one','navigation','task');const job=f.store.claim();
    f.db.prepare('UPDATE qq_codex_jobs SET heartbeat=0').run();assert.equal(f.store.claim(),null);
    assert.equal(f.store.active('u1')[0].state,'failed');assert.match(f.store.latestResult('u1'),/中断/);
    assert.equal(f.store.session('other','navigation'),undefined);
  }finally {f.close();}
});

test('real authenticated WebSocket routes Codex commands even with bookkeeping disabled',async()=>{
  const f=fixture();const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  f.config.bookkeeping={enabled:false,wsUrl:'ws://127.0.0.1:'+server.address().port};f.config.napcat.accessToken='private-ws';f.config.server.notifyToken='private-notify';
  let done;const received=new Promise(resolve=>{done=resolve;});
  const receiver=createQqCommandReceiver({getConfig:()=>f.config,send:async()=>{},onEvent:async e=>{const result=await f.service.receive(e);done();return result;}});
  server.on('connection',(socket,req)=>{assert.equal(req.headers.authorization,'Bearer private-ws');socket.send(JSON.stringify(event('codex navigation inspect')));});
  try {receiver.start();await received;assert.equal(f.store.active('u1').length,1);}
  finally {receiver.stop();for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));f.close();}
});
