import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createCodexStore} from '../../qq-bot/src/codex-store.js';
import {createKnowledgeStore} from './knowledge-store.js';
import {createServerSessions} from './codex-server-sessions.js';
import {handleCodexCliApi} from './codex-cli.js';
const Database=createRequire(import.meta.url)('better-sqlite3');
const upload={title:'Video lesson',topic:'',tags:[],bytes:24,originalName:'lesson.mp4',mimeType:'video/mp4',backend:'codex'};
const input={id:'12345678-1234-1234-1234-123456789abc',prompt:'PRIVATE TRANSCRIPT',result:'',state:'running',model:'test',sessionId:''};
const options={config:{binary:'test-history-'+Math.random()},all:true,canKnowledge:true,canKnowledgePrompts:true};
test('knowledge call records preserve attempts, reject changed identities, and keep deleted/other owners private',async()=>{
  const db=new Database(':memory:');createCodexStore(db);const k=createKnowledgeStore(db),s=createServerSessions(db);
  try{
    k.heartbeatWorker('owner',{workerId:'gpu',capabilities:{media:{ready:true,detail:'cuda'},codex:{ready:true}}});
    const d=k.create('owner',upload);k.enqueue('owner',d.id);const job=k.claim('owner',['codex'],'gpu');
    k.codexCalls.record('owner',job,input);k.codexCalls.record('owner',job,{...input,state:'succeeded',result:'Saved answer',sessionId:'thread'});
    k.codexCalls.record('owner',job,input);
    assert.throws(()=>k.codexCalls.record('owner',job,{...input,prompt:'changed'}));
    const own={...options,all:false};
    assert.equal((await s.list('other',own)).conversations.length,0);
    assert.equal(await s.detail('other','knowledge-'+d.id,own),null);
    const detail=await s.detail('owner','knowledge-'+d.id,own);assert.equal(detail.jobs.length,1);assert.equal(detail.jobs[0].result,'Saved answer');assert.equal(detail.jobs[0].state,'succeeded');assert.equal(detail.conversation.readOnly,true);
    const restricted=await s.detail('owner','knowledge-'+d.id,{...own,canKnowledgePrompts:false});assert.doesNotMatch(JSON.stringify(restricted),/PRIVATE TRANSCRIPT|Saved answer/);
    db.prepare("UPDATE knowledge_documents SET status='failed' WHERE id=?").run(d.id);k.retry('owner',d.id,'codex');const retry=k.claim('owner',['codex'],'gpu');k.codexCalls.record('owner',retry,input);
    assert.equal((await s.detail('owner','knowledge-'+d.id,own)).jobs.length,2);
    k.fail('owner',d.id,retry.lease,'failed');k.remove('owner',d.id);
    assert.equal((await s.list('owner',own)).conversations.length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_codex_calls').get().n,0);
  }finally{db.close();}
});
test('native history includes programmatic sources, paginates, deduplicates linked threads and exposes only user/assistant content',async()=>{
  const db=new Database(':memory:');createCodexStore(db);const calls=[];
  const thread={id:'native-thread',preview:'Native history',cwd:'/srv/project',createdAt:1700000000,updatedAt:1700000001,model:'test',status:{type:'notLoaded'}};
  const s=createServerSessions(db,{client:async(c,work)=>work({call:async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/list')return {data:[thread],nextCursor:params.cursor?null:'page2'};
    if(method==='thread/read')return {thread};
    return {data:[{id:'turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:'Question'}]},{type:'agentMessage',text:'Answer'},{type:'commandExecution',command:'SECRET COMMAND',aggregatedOutput:'SECRET OUTPUT'},{type:'reasoning',text:'SECRET REASONING'}]}],nextCursor:'older'};
  }})});
  try{
    assert.equal((await s.list('u',{...options,all:false})).conversations.length,0);assert.equal(calls.length,0);
    const list=await s.list('u',options);assert.equal(list.conversations[0].source,'cli');assert.equal(list.nextCursor,'page2');assert.ok(calls[0].params.sourceKinds.includes('exec'));
    assert.equal((await s.list('u',{...options,excludeSessionIds:['native-thread']})).conversations.length,0);
    assert.equal((await s.list('u',{...options,cursor:'page2'})).nextCursor,null);
    assert.equal(await s.detail('u','cli-native-thread',{...options,all:false}),null);
    const d=await s.detail('u','cli-native-thread',options);assert.equal(d.jobs[0].prompt,'Question');assert.equal(d.jobs[0].result,'Answer');assert.equal(d.nextCursor,'older');assert.doesNotMatch(JSON.stringify(d),/SECRET/);
    assert.ok(calls.every(c=>!c.method.includes('resume')&&!c.method.includes('start')));
    const broken=createServerSessions(db,{client:async()=>{throw new Error('SECRET');}});
    assert.doesNotMatch(JSON.stringify(await broken.list('u',{...options,config:{binary:'broken'}})),/SECRET/);
  }finally{db.close();}
});
test('unrecorded ephemeral history shows saved notes honestly; module read authorization is independent of QQ provisioning',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db),k=createKnowledgeStore(db);const d=k.create('owner',upload);
  db.prepare("UPDATE knowledge_documents SET attempt=1,status='ready',notes='Legacy saved notes' WHERE id=?").run(d.id);
  const external=createServerSessions(db,{client:async(c,work)=>work({call:async()=>({data:[],nextCursor:null})})});
  const server=http.createServer((req,res)=>void handleCodexCliApi(req,res,new URL(req.url,'http://localhost'),JSON.parse(req.headers['x-session']),
    (r,s,b)=>{r.writeHead(s,{'Content-Type':'application/json'});r.end(JSON.stringify(b));},{store,external,setup:()=>({config:{},configured:false,enabled:true,projects:[]})}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const member={userId:'owner',permissions:['codex-cli:view','codex-cli:sessions:view','knowledge:view','knowledge:notes:view']};
  const request=async(path='',method='GET',session=member)=>{
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/codex-cli/conversations'+path,{method,headers:{'X-Session':JSON.stringify(session)}});return {status:r.status,body:await r.json()};
  };
  try{
    assert.equal((await request()).body.conversations[0].source,'knowledge');
    const detail=await request('/knowledge-'+d.id);assert.equal(detail.body.jobs[0].result,'Legacy saved notes');assert.equal(detail.body.conversation.readOnly,true);
    assert.equal((await request('/knowledge-'+d.id,'GET',{...member,userId:'other'})).status,404);
    assert.equal((await request('/cli-unknown')).status,404);
    assert.equal((await request('/knowledge-'+d.id+'/messages','POST',{userId:'owner',permissions:['*']})).status,403);
    assert.equal((await request('','GET',{...member,permissions:member.permissions.filter(p=>p!=='knowledge:notes:view')})).body.conversations.length,0);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});
