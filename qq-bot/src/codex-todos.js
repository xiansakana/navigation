import crypto from 'node:crypto';
import { readCodexUsage } from './codex-usage.js';
import { readCodexCatalog, resolveRuntime } from './codex-control.js';

export function quotaGate(snapshot, now = Date.now()) {
  const mapped=snapshot?.rateLimitsByLimitId;
  const bucket=mapped&&Object.keys(mapped).length ? mapped.codex : snapshot?.rateLimits;
  const windows=bucket&&(!bucket.limitId||bucket.limitId==='codex')?[bucket.primary,bucket.secondary].filter(Boolean):[];
  const valid=windows.filter(w=>Number.isFinite(w.usedPercent)&&w.usedPercent>=0&&w.usedPercent<=100);
  const blocked=valid.filter(w=>w.usedPercent>=100);
  if(blocked.length || bucket?.rateLimitReachedType) {
    const reset=Math.max(0,...blocked.map(w=>Number.isFinite(w.resetsAt)?w.resetsAt*1000:0));
    return {available:false,reason:'Codex 额度不足，等待恢复',resetAt:reset>now?reset:0,nextCheckAt:Math.min(now+300000,Math.max(now+60000,reset+5000))};
  }
  if(!windows.length||valid.length!==windows.length)return {available:false,reason:'额度信息不完整，等待复核',resetAt:0,nextCheckAt:now+60000};
  return {available:true,reason:'额度可用',resetAt:0,nextCheckAt:now};
}

export function createTodoStore(db, conversations) {
  db.exec(`CREATE TABLE IF NOT EXISTS codex_todos (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,qq_id TEXT NOT NULL,project TEXT NOT NULL,title TEXT NOT NULL,prompt TEXT NOT NULL,
    request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
    runtime_json TEXT NOT NULL DEFAULT '{}',conversation_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'paused',
    sort_order INTEGER NOT NULL,job_id TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,
    next_check_at INTEGER NOT NULL DEFAULT 0,reset_at INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,request_id));
    CREATE INDEX IF NOT EXISTS codex_todos_owner ON codex_todos(user_id,sort_order);
    CREATE INDEX IF NOT EXISTS codex_todos_due ON codex_todos(state,next_check_at);`);
  db.transaction(()=>{if(!db.prepare('PRAGMA table_info(codex_todos)').all().some(c=>c.name==='scheduled_at'))db.exec('ALTER TABLE codex_todos ADD COLUMN scheduled_at INTEGER NOT NULL DEFAULT 0');}).immediate();
  const get=(uid,id)=>db.prepare('SELECT t.*,j.state AS job_state FROM codex_todos t LEFT JOIN qq_codex_jobs j ON j.id=t.job_id AND j.user_id=t.user_id WHERE t.user_id=? AND t.id=?').get(uid,id);
  return {
    get,
    reconcile(now=Date.now()) {
      db.transaction(()=>{
        const rows=db.prepare("SELECT t.*,j.state AS job_state,j.failure_kind FROM codex_todos t JOIN qq_codex_jobs j ON j.id=t.job_id AND j.user_id=t.user_id WHERE t.state IN ('queued','running','paused')").all();
        for(const row of rows){
          if(row.state==='paused'&&row.job_state!=='succeeded')continue;
          let state=row.job_state,note='',next=0;
          if(state==='failed'&&row.failure_kind==='quota'){state='waiting_quota';note='执行中额度耗尽，等待恢复后继续';next=now+60000;}
          else if(state==='failed'&&row.failure_kind==='authorization'){state='paused';note='执行授权已撤销，自动执行已暂停';}
          else if(state==='failed')note='任务失败，请查看会话后决定是否重试';
          else if(state==='cancelled'){state='paused';note='已停止，已有修改保留';}
          if(state!==row.state)db.prepare('UPDATE codex_todos SET state=?,note=?,next_check_at=?,updated_at=? WHERE id=? AND user_id=?').run(state,note,next,now,row.id,row.user_id);
        }
      }).immediate();
    },
    list(uid) {this.reconcile();return db.prepare('SELECT t.*,j.state AS job_state FROM codex_todos t LEFT JOIN qq_codex_jobs j ON j.id=t.job_id AND j.user_id=t.user_id WHERE t.user_id=? ORDER BY t.sort_order,t.created_at').all(uid);},
    create(uid,qq,values) {
      return db.transaction(()=>{
        const requestId=values.requestId || crypto.randomUUID(),fingerprint=crypto.createHash('sha256').update(JSON.stringify([values.project,values.title,values.prompt,values.runtime,values.conversationId || '',values.autoRun,...(values.scheduledAt?[values.scheduledAt]:[])])).digest('hex');
        const previous=db.prepare('SELECT id,payload_hash FROM codex_todos WHERE user_id=? AND request_id=?').get(uid,requestId);
        if(previous){if(previous.payload_hash!==fingerprint)throw new Error('此请求已保存其他内容，请刷新列表后再新增');return get(uid,previous.id);}
        if(db.prepare('SELECT count(*) AS n FROM codex_todos WHERE user_id=?').get(uid).n>=200)throw new Error('最多保留200条待办，请先删除不再需要的记录');
        const id=crypto.randomUUID(),now=Date.now(),order=db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM codex_todos WHERE user_id=?').get(uid).n;
        db.prepare('INSERT INTO codex_todos(id,user_id,qq_id,project,title,prompt,request_id,payload_hash,runtime_json,conversation_id,state,sort_order,created_at,updated_at,scheduled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id,uid,qq,values.project,values.title,values.prompt,requestId,fingerprint,JSON.stringify(values.runtime),values.conversationId || '',values.autoRun?'pending':'paused',order,now,now,values.scheduledAt || 0);
        return get(uid,id);
      }).immediate();
    },
    edit(uid,id,values) {
      return db.transaction(()=>{
        const row=get(uid,id);if(!row||row.job_id||!['pending','waiting_quota','paused'].includes(row.state))throw new Error('仅尚未开始执行的待办可以编辑指令');
        db.prepare("UPDATE codex_todos SET project=?,title=?,prompt=?,runtime_json=?,conversation_id=?,state=?,scheduled_at=?,next_check_at=0,reset_at=0,note='',updated_at=? WHERE user_id=? AND id=?")
          .run(values.project,values.title,values.prompt,JSON.stringify(values.runtime),values.conversationId || '',values.autoRun?'pending':'paused',values.scheduledAt || 0,Date.now(),uid,id);
        return get(uid,id);
      }).immediate();
    },
    pause(uid,id) {
      return db.transaction(()=>{
        const row=get(uid,id);if(!row||['succeeded','cancelled'].includes(row.state))throw new Error('此待办已经结束');
        db.prepare("UPDATE qq_codex_jobs SET cancel=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,result=CASE WHEN state='queued' THEN '已暂停待办' ELSE result END,finished_at=CASE WHEN state='queued' THEN ? ELSE finished_at END WHERE id=? AND user_id=? AND state IN ('queued','running')").run(Date.now(),row.job_id,uid);
        db.prepare("UPDATE codex_todos SET state='paused',note='已暂停自动执行',updated_at=? WHERE user_id=? AND id=?").run(Date.now(),uid,id);return get(uid,id);
      }).immediate();
    },
    resume(uid,id) {
      return db.transaction(()=>{
        const row=get(uid,id);if(!row||!['paused','failed'].includes(row.state)||['queued','running','succeeded'].includes(row.job_state))throw new Error('请等待任务停止后再恢复，已完成的待办不能重做');
        db.prepare("UPDATE codex_todos SET state='pending',next_check_at=0,reset_at=0,note='',updated_at=? WHERE user_id=? AND id=?").run(Date.now(),uid,id);return get(uid,id);
      }).immediate();
    },
    remove(uid,id) {
      db.transaction(()=>{
        const row=get(uid,id);if(!row||['queued','running'].includes(row.state)||['queued','running'].includes(row.job_state))throw new Error('请先暂停并等待执行结束');
        db.prepare('DELETE FROM codex_todos WHERE user_id=? AND id=?').run(uid,id);
      }).immediate();
    },
    move(uid,id,direction) {
      db.transaction(()=>{
        const row=get(uid,id);if(!row||!['pending','waiting_quota','paused'].includes(row.state))throw new Error('此待办不能调整顺序');
        const other=db.prepare("SELECT * FROM codex_todos WHERE user_id=? AND state IN ('pending','waiting_quota','paused') AND sort_order "+(direction==='up'?'<':'>')+' ? ORDER BY sort_order '+(direction==='up'?'DESC':'ASC')+' LIMIT 1').get(uid,row.sort_order);
        if(other){const set=db.prepare('UPDATE codex_todos SET sort_order=? WHERE user_id=? AND id=?');set.run(other.sort_order,uid,id);set.run(row.sort_order,uid,other.id);}
      }).immediate();return get(uid,id);
    },
    due(now) {this.reconcile(now);return db.prepare("SELECT t.* FROM codex_todos t WHERE t.state IN ('pending','waiting_quota') AND t.next_check_at<=? AND t.scheduled_at<=? AND NOT EXISTS(SELECT 1 FROM codex_todos p WHERE p.user_id=t.user_id AND p.sort_order<t.sort_order AND p.state IN ('pending','waiting_quota','queued','running','failed') AND (p.state NOT IN ('pending','waiting_quota') OR p.scheduled_at<=?)) ORDER BY t.sort_order,t.created_at LIMIT 20").all(now,now,now);},
    defer(reason,next,reset=0,now=Date.now()) {db.prepare("UPDATE codex_todos SET state='waiting_quota',note=?,next_check_at=?,reset_at=?,updated_at=? WHERE state IN ('pending','waiting_quota') AND next_check_at<=? AND scheduled_at<=?").run(reason,next,reset,now,now,now);},
    fail(row,note,state='failed') {db.prepare("UPDATE codex_todos SET state=?,note=?,updated_at=? WHERE id=? AND user_id=? AND state IN ('pending','waiting_quota')").run(state,note,Date.now(),row.id,row.user_id);},
    promote(row,runtime,now,includeQQ=true) {
      return db.transaction(()=>{
        const fresh=get(row.user_id,row.id);if(!fresh||!['pending','waiting_quota'].includes(fresh.state)||fresh.next_check_at>now||fresh.scheduled_at>now)return null;
        if(['project','title','prompt','runtime_json','conversation_id','sort_order','scheduled_at','updated_at'].some(key=>fresh[key]!==row[key]))return null;
        if(db.prepare("SELECT 1 FROM codex_todos WHERE user_id=? AND sort_order<? AND state IN ('pending','waiting_quota','queued','running','failed') AND (state NOT IN ('pending','waiting_quota') OR scheduled_at<=?) LIMIT 1").get(row.user_id,fresh.sort_order,now))return null;
        if(db.prepare("SELECT 1 FROM qq_codex_jobs WHERE state='running' OR (state='queued' AND "+(includeQQ?'1':"origin='web'")+") LIMIT 1").get())return null;
        let conversation=fresh.conversation_id&&conversations.get(row.user_id,fresh.conversation_id);
        if(!conversation)conversation=conversations.create(row.user_id,row.project,('Todo · '+row.title).slice(0,80));
        const previous=fresh.job_id&&db.prepare('SELECT session_id FROM qq_codex_jobs WHERE id=? AND user_id=?').get(fresh.job_id,row.user_id);
        const prompt=previous?.session_id ? '继续本待办上次中断的任务。先核对已完成的修改、提交与外部操作，从中断处继续，避免重复已经完成的操作。\n\n原始指令：\n'+fresh.prompt : fresh.prompt;
        const job=conversations.enqueue(row.user_id,row.qq_id,conversation.id,{prompt,runtime,requestId:'todo-'+row.id+'-'+fresh.attempts});
        db.prepare('UPDATE qq_codex_jobs SET todo_id=? WHERE id=? AND user_id=?').run(row.id,job,row.user_id);
        db.prepare("UPDATE codex_todos SET state='queued',conversation_id=?,job_id=?,attempts=attempts+1,next_check_at=0,reset_at=0,note='',updated_at=? WHERE id=? AND user_id=?").run(conversation.id,job,Date.now(),row.id,row.user_id);
        return job;
      }).immediate();
    }
  };
}

export function createTodoScheduler({store,getConfig,authorize,readUsage=readCodexUsage,readCatalog=readCodexCatalog,now=Date.now,includeQQ=()=>true}) {
  let cached=null;
  return {async tick(){
    if(store.hasActiveJobs(includeQQ()))return;
    const time=now(),rows=store.todos.due(time);if(!rows.length)return;
    const row=rows.find(todo=>{
      if(authorize(todo))return true;
      store.todos.fail(todo,'账号、项目、会话或自动执行权限已撤销','paused');return false;
    });if(!row)return;
    let gate;
    try {
      if(cached&&cached.nextCheckAt>time)gate=cached;
      else gate=quotaGate(await readUsage(getConfig()),time);
    } catch {gate={available:false,reason:'额度查询暂不可用，将自动复查',nextCheckAt:time+60000,resetAt:0};}
    if(!gate.available){cached=gate;store.todos.defer(gate.reason,gate.nextCheckAt,gate.resetAt,time);return;}
    cached=null;
    try {
      const catalog=await readCatalog(getConfig()),runtime=resolveRuntime(getConfig(),JSON.parse(row.runtime_json),catalog);
      if(!authorize(row)){store.todos.fail(row,'自动执行授权已撤销','paused');return;}
      store.todos.promote(row,runtime,now(),includeQQ());
    } catch {store.todos.fail(row,'无法开始任务，请检查模型设置、会话状态与服务器连接后重试');}
  }};
}
