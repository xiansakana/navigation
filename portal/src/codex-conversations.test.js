import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createCodexStore } from '../../qq-bot/src/codex-store.js';
import { handleCodexCliApi } from './codex-cli.js';

const Database=createRequire(import.meta.url)('better-sqlite3');
test('conversation API isolates owners/projects/groups, enforces actions and CSRF, and deduplicates sends',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db);
  const catalog={models:[{id:'test',efforts:['low','high'],defaultEffort:'low'}],defaults:{model:'test',effort:'low'}};
  let projects=['navigation'],catalogHook=()=>{};
  const setup=uid=>({config:{},configured:true,qqId:'12345678',enabled:true,projects:uid==='owner'?projects:['other']});
  const dependencies={store,setup,catalog:async()=>{catalogHook();return catalog;}};
  const server=http.createServer((req,res)=>void handleCodexCliApi(req,res,new URL(req.url,'http://localhost'),JSON.parse(req.headers['x-test-session'] || '{"userId":"owner","permissions":["*"]}'),(r,s,b)=>{r.writeHead(s,{'Content-Type':'application/json'});r.end(JSON.stringify(b));},dependencies));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const request=async(path='',method='GET',body,session,origin)=>{
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/codex-cli/conversations'+path,{method,headers:{...(session?{'X-Test-Session':JSON.stringify(session)}:{}),...(origin?{Origin:origin}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json()};
  };
  try {
    const viewer={userId:'owner',permissions:['codex-cli:view','codex-cli:sessions:view','qq-codex:execute']};
    assert.equal((await request('', 'GET',undefined,{userId:'owner',permissions:['codex-cli:view']})).status,403);
    assert.equal((await request('','POST',{project:'navigation'},viewer)).status,403);
    assert.equal((await request('','POST',{project:'navigation'},undefined,'https://evil.test')).status,403);
    assert.equal((await request('','POST',{project:'other'})).status,400);
    const created=await request('','POST',{project:'navigation'});assert.equal(created.status,201);const id=created.body.conversation.id;
    assert.equal((await request('/'+id,'GET',undefined,{userId:'other',permissions:['*']})).status,404);
    for(const [suffix,method,body] of [['','PATCH',{title:'new'}],['/messages','POST',{prompt:'hi'}],['/stop','POST',{}]])assert.equal((await request('/'+id+suffix,method,body,viewer)).status,403);
    const body={prompt:'hello',model:'test',effort:'high',requestId:crypto.randomUUID()};
    assert.equal((await request('/'+id+'/messages','POST',{...body,effort:'max'})).status,400);
    const sent=await request('/'+id+'/messages','POST',body);assert.equal(sent.status,202);
    assert.equal((await request('/'+id+'/messages','POST',body)).body.jobId,sent.body.jobId);
    assert.equal((await request('/'+id+'/messages','POST',{...body,requestId:crypto.randomUUID()})).status,400);
    let detail=(await request('/'+id)).body;assert.equal(detail.jobs.length,1);assert.equal(detail.jobs[0].runtime.effort,'high');
    assert.equal(store.cancel('owner'),0);assert.equal(store.active('owner').length,0);
    assert.equal((await request('/'+id,'PATCH',{archived:true})).status,400);
    assert.equal((await request('/'+id+'/stop','POST',{})).body.count,1);
    assert.equal((await request('/'+id)).body.jobs[0].state,'cancelled');assert.equal(store.pendingReply(),undefined);
    assert.equal((await request('/'+id,'PATCH',{title:'改名',archived:true})).status,200);
    assert.equal((await request('/'+id+'/messages','POST',{...body,requestId:crypto.randomUUID()})).status,400);
    await request('/'+id,'PATCH',{archived:false});
    projects=[];assert.equal((await request('/'+id)).status,404);assert.equal((await request()).body.conversations.length,0);
    projects=['navigation'];catalogHook=()=>{projects=[];};assert.equal((await request('/'+id+'/messages','POST',{...body,requestId:crypto.randomUUID()})).status,403);
    projects=['navigation'];catalogHook=()=>{};
    store.saveSettings('owner',{groups:['33333333'],groupReply:'private'});
    const qqJob=store.enqueue('owner','12345678','qq-job','navigation','QQ history','33333333');
    const job=store.claim();assert.equal(job.id,qqJob);store.finish(job,{state:'succeeded',result:'answer',sessionId:'qq-thread'});
    const visible=(await request()).body.conversations;assert.equal(visible.filter(c=>c.source==='qq').length,1);
    store.saveSettings('owner',{groups:[],groupReply:'private'});
    assert.equal((await request('/'+visible.find(c=>c.source==='qq').id)).status,404);
    assert.equal((await request()).body.conversations.filter(c=>c.source==='qq').length,0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM qq_codex_jobs WHERE origin='web'").get().n,1);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}
});

test('QQ history imports are stable and running thread capture merges queued entries; web results stay off QQ',()=>{
  const db=new Database(':memory:'),s=createCodexStore(db),c=s.conversations;
  try {
    s.enqueue('u','12345678','first','navigation','first');let job=s.claim();
    const first=c.list('u')[0].id;s.captureSession(job,'thread');s.finish(job,{state:'succeeded',result:'one',sessionId:'thread'});
    s.enqueue('u','12345678','second','navigation','second');job=s.claim();c.list('u');s.captureSession(job,'thread');s.finish(job,{state:'succeeded',result:'two',sessionId:'thread'});
    assert.equal(c.list('u').length,1);assert.equal(c.list('u')[0].id,first);assert.equal(c.jobs('u',first).length,2);
    assert.equal(c.list('other').length,0);
    db.prepare('DELETE FROM qq_codex_outbox').run();
    const web=c.create('u','navigation');c.enqueue('u','12345678',web.id,{prompt:'web',runtime:{model:'test',effort:'low'},requestId:crypto.randomUUID()});job=s.claim();
    c.progress(job,{type:'item.started',item:{type:'command_execution',command:'SECRET_COMMAND',aggregated_output:'SECRET_OUTPUT'}});
    c.progress(job,{type:'item.completed',item:{type:'agent_message',text:'working'}});
    assert.doesNotMatch(JSON.stringify(c.jobs('u',web.id)),/SECRET_COMMAND|SECRET_OUTPUT/);
    s.captureSession(job,'web-thread');s.finish(job,{state:'succeeded',result:'done',sessionId:'web-thread'});
    assert.equal(c.get('u',web.id).session_id,'web-thread');assert.equal(s.session('u','navigation'),'thread');assert.equal(s.pendingReply(),undefined);
    assert.equal(createCodexStore(db).conversations.jobs('u',web.id)[0].result,'done');
  } finally {db.close();}
});
