import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createCodexStore} from './codex-store.js';
import {quotaGate,createTodoScheduler} from './codex-todos.js';

const Database=createRequire(new URL('../../portal/package.json',import.meta.url))('better-sqlite3');
const catalog={models:[{id:'test',efforts:['low','high'],defaultEffort:'low'}],defaults:{model:'test',effort:'low'}};
const usage=(used=20,reset=Date.now()+120000)=>({rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:used,windowDurationMins:300,resetsAt:reset/1000},secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:(reset+86400000)/1000}}}});
const values=(title='one',extra={})=>({title,project:'navigation',prompt:'Do '+title,runtime:{model:'test',effort:'low'},autoRun:true,...extra});

test('existing todos migrate with immediate scheduling and repeated initialization preserves plans',()=>{
  const db=new Database(':memory:');
  try{
    const store=createCodexStore(db),row=store.todos.create('u','12345678',values());
    db.exec('ALTER TABLE codex_todos DROP COLUMN scheduled_at');
    const migrated=createCodexStore(db);assert.equal(migrated.todos.get('u',row.id).scheduled_at,0);
    migrated.todos.edit('u',row.id,values('one',{scheduledAt:Date.now()+3600000}));
    assert.equal(createCodexStore(db).todos.get('u',row.id).scheduled_at,migrated.todos.get('u',row.id).scheduled_at);
  }finally{db.close();}
});

test('quota gate uses the ordinary bucket, checks all windows and never assumes a timestamp means reset',()=>{
  const now=Date.now(),snapshot=usage(100,now+120000);snapshot.rateLimitsByLimitId.reserve={primary:{usedPercent:0}};
  assert.equal(quotaGate(snapshot,now).available,false);assert.equal(quotaGate(snapshot,now).resetAt,now+120000);
  assert.equal(quotaGate(snapshot,now+180000).available,false);assert.equal(quotaGate(usage(20),now).available,true);
  assert.equal(quotaGate({rateLimitsByLimitId:{reserve:{primary:{usedPercent:0}}}},now).available,false);
  assert.equal(quotaGate({rateLimits:{limitId:'reserve',primary:{usedPercent:0}}},now).available,false);
  assert.equal(quotaGate({rateLimits:{primary:{usedPercent:null}}},now).available,false);
  snapshot.rateLimitsByLimitId.codex.secondary.usedPercent=100;
  assert.equal(quotaGate(snapshot,now).resetAt,snapshot.rateLimitsByLimitId.codex.secondary.resetsAt*1000);
});

test('todos persist without jobs while depleted, then dispatch once in order and preserve paused work across restart',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db);let now=Date.now(),used=100,reads=0;
  const first=store.todos.create('u','12345678',values()),second=store.todos.create('u','12345678',values('two'));
  const make=()=>createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readCatalog:async()=>catalog,readUsage:async()=>{reads++;return usage(used,now+120000);},now:()=>now});
  let scheduler=make();
  try{
    await scheduler.tick();assert.equal(store.todos.get('u',first.id).state,'waiting_quota');assert.equal(db.prepare('SELECT count(*) AS n FROM qq_codex_jobs').get().n,0);
    await scheduler.tick();assert.equal(reads,1);
    store.todos.pause('u',second.id);now+=180000;used=20;scheduler=make();await scheduler.tick();await scheduler.tick();
    assert.equal(db.prepare('SELECT count(*) AS n FROM qq_codex_jobs').get().n,1);
    const job=store.claim();assert.equal(job.todo_id,first.id);assert.equal(job.prompt,'Do one');
    store.captureSession(job,'todo-thread');store.finish(job,{state:'succeeded',result:'done',sessionId:'todo-thread'});
    store.todos.reconcile(now);assert.equal(store.todos.get('u',first.id).state,'succeeded');assert.equal(store.pendingReply(),undefined);
    assert.equal(createCodexStore(db).todos.get('u',second.id).state,'paused');
    store.todos.resume('u',second.id);await make().tick();assert.equal(store.todos.get('u',second.id).state,'queued');
    assert.notEqual(store.todos.get('u',first.id).conversation_id,store.todos.get('u',second.id).conversation_id);
  }finally{db.close();}
});

test('quota failure continues the existing thread, while ordinary failures block later tasks until handled',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db);let now=Date.now();
  const first=store.todos.create('u','12345678',values()),second=store.todos.create('u','12345678',values('two'));
  const scheduler=createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readCatalog:async()=>catalog,readUsage:async()=>usage(),now:()=>now});
  try{
    await scheduler.tick();let job=store.claim();store.captureSession(job,'interrupted-thread');store.finish(job,{state:'failed',result:'limit',sessionId:'interrupted-thread',failureKind:'quota'});
    store.todos.reconcile(now);assert.equal(store.todos.get('u',first.id).state,'waiting_quota');
    await scheduler.tick();assert.equal(store.todos.get('u',second.id).state,'pending');
    now+=70000;await scheduler.tick();job=store.claim();assert.equal(job.todo_id,first.id);assert.match(job.prompt,/从中断处继续/);assert.equal(store.conversations.get('u',job.conversation_id).session_id,'interrupted-thread');
    store.finish(job,{state:'failed',result:'Git conflict'});store.todos.reconcile(now);await scheduler.tick();assert.equal(store.todos.get('u',first.id).state,'failed');assert.equal(store.todos.get('u',second.id).state,'pending');
    store.todos.pause('u',first.id);await scheduler.tick();assert.equal(store.todos.get('u',second.id).state,'queued');
  }finally{db.close();}
});

test('pause stops only the linked job, ownership/order are isolated, and permission revocation prevents dispatch',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db);
  try{
    const a=store.todos.create('u','12345678',values()),b=store.todos.create('u','12345678',values('two')),other=store.todos.create('other','87654321',values('other'));
    assert.equal(store.todos.get('other',a.id),undefined);store.todos.move('u',b.id,'up');assert.equal(store.todos.list('u')[0].id,b.id);assert.equal(store.todos.list('other')[0].id,other.id);
    let allowed=true;
    const scheduler=createTodoScheduler({store,getConfig:()=>({}),authorize:row=>row.user_id==='u'&&allowed,readUsage:async()=>usage(),readCatalog:async()=>{allowed=false;return catalog;}});
    await scheduler.tick();assert.equal(store.todos.get('u',b.id).state,'paused');assert.equal(db.prepare('SELECT count(*) AS n FROM qq_codex_jobs').get().n,0);
    store.todos.resume('u',b.id);
    const fresh=createTodoScheduler({store,getConfig:()=>({}),authorize:row=>row.user_id==='u',readUsage:async()=>usage(),readCatalog:async()=>catalog});
    await fresh.tick();const job=store.claim();store.todos.pause('u',b.id);assert.equal(store.cancelled(job.id),true);assert.throws(()=>store.todos.resume('u',b.id),/等待任务停止/);
    store.finish(job,{state:'cancelled',result:'stopped'});assert.equal(store.todos.get('u',a.id).state,'pending');store.todos.resume('u',b.id);assert.equal(store.todos.get('u',b.id).state,'pending');
  }finally{db.close();}
});

test('unknown quota/network errors defer instead of launching, and stale interrupted jobs never auto-replay',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db);
  try{
    const row=store.todos.create('u','12345678',values());let now=Date.now();
    await createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readUsage:async()=>{throw new Error('private token diagnostic');},now:()=>now}).tick();
    assert.match(store.todos.get('u',row.id).note,/暂不可用/);assert.doesNotMatch(store.todos.get('u',row.id).note,/private token/);
    now+=70000;await createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readUsage:async()=>usage(),readCatalog:async()=>catalog,now:()=>now}).tick();
    const job=store.claim();db.prepare('UPDATE qq_codex_jobs SET heartbeat=0 WHERE id=?').run(job.id);store.claim();store.todos.reconcile();
    assert.equal(store.todos.get('u',row.id).state,'failed');assert.equal(store.todos.due(now).length,0);
  }finally{db.close();}
});

test('dispatch rechecks edited payloads and priorities after async quota/catalog reads',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db);
  try{
    const first=store.todos.create('u','12345678',values()),second=store.todos.create('u','12345678',values('two'));
    await createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readUsage:async()=>usage(),readCatalog:async()=>{store.todos.edit('u',first.id,values('changed'));return catalog;}}).tick();
    assert.equal(db.prepare('SELECT count(*) AS n FROM qq_codex_jobs').get().n,0);
    await createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readUsage:async()=>usage(),readCatalog:async()=>{store.todos.move('u',second.id,'up');return catalog;}}).tick();
    assert.equal(db.prepare('SELECT count(*) AS n FROM qq_codex_jobs').get().n,0);
    await createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readUsage:async()=>usage(),readCatalog:async()=>catalog}).tick();
    assert.equal(store.claim().todo_id,second.id);
  }finally{db.close();}
});


test('scheduled work waits durably, skips future predecessors, checks quota at due time and survives pause/resume',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db);let now=Date.now(),reads=0,used=20;
  const future=now+3600000;
  const first=store.todos.create('u','12345678',values('future',{scheduledAt:future}));
  const make=()=>createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readCatalog:async()=>catalog,readUsage:async()=>{reads++;return usage(used,now+120000);},now:()=>now});
  try{
    await make().tick();assert.equal(reads,0);assert.equal(createCodexStore(db).todos.get('u',first.id).scheduled_at,future);
    store.todos.pause('u',first.id);store.todos.resume('u',first.id);await make().tick();assert.equal(reads,0);
    const second=store.todos.create('u','12345678',values('ready'));
    await make().tick();assert.equal(store.todos.get('u',second.id).state,'queued');assert.equal(store.todos.get('u',first.id).state,'pending');
    const job=store.claim();store.finish(job,{state:'succeeded',result:'done'});
    now=future-1;await make().tick();assert.equal(reads,1);
    now=future;used=100;await make().tick();assert.equal(store.todos.get('u',first.id).state,'waiting_quota');
    now+=180000;used=20;await make().tick();assert.equal(store.claim().todo_id,first.id);
  }finally{db.close();}
});

test('quota deferral does not touch future plans and async schedule edits cannot start early',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db);const now=Date.now(),future=now+3600000;
  try{
    const a=store.todos.create('u','12345678',values('ready')),b=store.todos.create('u','12345678',values('future',{scheduledAt:future}));
    store.todos.defer('quota',now+60000,0,now);assert.equal(store.todos.get('u',b.id).state,'pending');
    store.todos.edit('u',a.id,values('ready'));
    await createTodoScheduler({store,getConfig:()=>({}),authorize:()=>true,readUsage:async()=>usage(),readCatalog:async()=>{store.todos.edit('u',a.id,values('ready',{scheduledAt:future}));return catalog;},now:()=>now}).tick();
    assert.equal(db.prepare('SELECT count(*) AS n FROM qq_codex_jobs').get().n,0);
    store.todos.edit('u',a.id,values('ready',{scheduledAt:0}));assert.equal(store.todos.due(now)[0].id,a.id);
  }finally{db.close();}
});
