import test from 'node:test';
import assert from 'node:assert/strict';
import { qqCommandEvent, createQqCommandReceiver } from './bookkeeping.js';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
const event={post_type:'message',message_type:'private',user_id:12345678,self_id:2942493314,message_id:42,message:[{type:'text',data:{text:'记账 支出 35 餐饮 微信'}}]};
test('group writes require real bot mention; self, ordinary chat and media are ignored',()=>{
  assert.equal(qqCommandEvent(event).qqId,'12345678');
  assert.equal(qqCommandEvent({...event,message_type:'group',group_id:123456}),null);
  assert.ok(qqCommandEvent({...event,message_type:'group',group_id:123456,message:[{type:'at',data:{qq:event.self_id}},...event.message]}));
  assert.equal(qqCommandEvent({...event,user_id:event.self_id}),null);
  assert.equal(qqCommandEvent({...event,message:[{type:'text',data:{text:'普通聊天'}}]}),null);
  assert.equal(qqCommandEvent({...event,message_type:'group',message:'[CQ:at,qq=2942493314] 记账 支出 35 餐饮'}),null);
  assert.equal(qqCommandEvent({...event,message:[...event.message,{type:'image',data:{}}]}),null);
});
test('receiver sends correct reply target, then acknowledges; persisted duplicate sends no reply',async()=>{
  const requests=[],sent=[],config={bookkeeping:{enabled:true},server:{notifyToken:'secret'},channels:{qq:{enabled:true}}};
  const receiver=createQqCommandReceiver({getConfig:()=>config,send:async(c,e,m)=>sent.push({e,m}),request:async(url,opts)=>{
    requests.push(JSON.parse(opts.body));assert.equal(opts.headers.Authorization,'Bearer secret');return {ok:true,json:async()=>({ok:true,reply:'已记账',eventKey:'key',sent:requests.length>2})};
  }});
  await receiver.receive(event);assert.equal(sent.length,1);assert.equal(sent[0].e.type,'private');assert.deepEqual(requests[1],{ack:'key'});
  await receiver.receive(event);assert.equal(sent.length,1);
  config.bookkeeping.enabled=false;await receiver.receive(event);assert.equal(requests.length,3);
});
test('failed delivery is not acknowledged; concurrent redelivery is deduplicated',async()=>{
  let calls=0;const config={bookkeeping:{enabled:true},server:{notifyToken:'secret'},channels:{qq:{enabled:true}}};
  const receiver=createQqCommandReceiver({getConfig:()=>config,log:{error:()=>{}},send:async()=>{throw new Error('offline');},request:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {ok:true,json:async()=>({ok:true,reply:'已记账',eventKey:'key'})};}});
  await Promise.all([receiver.receive(event),receiver.receive(event)]);assert.equal(calls,1);assert.match(receiver.status().lastError,/投递失败/);
});
test('real WebSocket receives group event with bearer auth and delivers one group receipt',async()=>{
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
  let auth,received,ack;
  const delivered=new Promise(resolve=>{received=resolve;});
  const receiver=createQqCommandReceiver({getConfig:()=>({bookkeeping:{enabled:true,wsUrl:'ws://127.0.0.1:'+server.address().port},napcat:{accessToken:'ws-secret'},server:{notifyToken:'portal-secret'},channels:{qq:{enabled:true}}}),
    request:async(url,opts)=>{const body=JSON.parse(opts.body);if(body.ack)ack=body.ack;return {ok:true,json:async()=>({ok:true,reply:'已记账',eventKey:'ws-event'})};},
    send:async(c,e,m)=>{received({e,m});}});
  server.on('connection',(socket,req)=>{auth=req.headers.authorization;socket.send(JSON.stringify({...event,message_type:'group',group_id:123456,message:[{type:'at',data:{qq:event.self_id}},...event.message]}));});
  try{
    receiver.start();const result=await Promise.race([delivered,new Promise((_,reject)=>setTimeout(()=>reject(new Error('WS timeout')),2000).unref())]);
    assert.equal(auth,'Bearer ws-secret');assert.equal(result.e.type,'group');assert.equal(result.e.groupId,'123456');assert.equal(result.e.qqId,'12345678');
    await new Promise(r=>setTimeout(r,10));assert.equal(ack,'ws-event');assert.equal(receiver.status().connected,true);
  }finally{receiver.stop();for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve));}
});
