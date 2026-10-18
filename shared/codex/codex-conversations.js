import crypto from 'node:crypto';

// Only threads linked to this application's authenticated owner are exposed.
export function createConversationStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS codex_conversations (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project TEXT NOT NULL,title TEXT NOT NULL,
    source TEXT NOT NULL,group_id TEXT NOT NULL DEFAULT '',session_id TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS codex_conversations_owner ON codex_conversations(user_id,updated_at);
    CREATE TABLE IF NOT EXISTS codex_job_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS codex_progress_job ON codex_job_progress(job_id,id);`);
  const get = (uid,id) => db.prepare('SELECT * FROM codex_conversations WHERE user_id=? AND id=?').get(uid,id);
  return {
    get,
    importQQ(uid) {
      db.transaction(() => {
        const rows = db.prepare("SELECT * FROM qq_codex_jobs WHERE user_id=? AND origin='qq' AND conversation_id='' ORDER BY created_at,rowid LIMIT 1000").all(uid);
        for (const job of rows) {
          const existing = job.session_id && db.prepare("SELECT id FROM codex_conversations WHERE user_id=? AND project=? AND group_id=? AND session_id=? ORDER BY created_at LIMIT 1").get(uid,job.project,job.group_id,job.session_id);
          const id = existing?.id || 'qq-' + job.id;
          if (!existing) db.prepare('INSERT OR IGNORE INTO codex_conversations(id,user_id,project,title,source,group_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(id,uid,job.project,job.prompt.replace(/^__(usage|sync)__$/,'状态查询').slice(0,80),'qq',job.group_id,job.session_id,job.created_at,job.finished_at || job.created_at);
          db.prepare('UPDATE qq_codex_jobs SET conversation_id=? WHERE id=?').run(id,job.id);
          db.prepare('UPDATE codex_conversations SET updated_at=MAX(updated_at,?) WHERE id=? AND user_id=?').run(job.finished_at || job.created_at,id,uid);
        }
      })();
    },
    list(uid) {
      this.importQQ(uid);
      return db.prepare(`SELECT c.*, (SELECT state FROM qq_codex_jobs j WHERE j.conversation_id=c.id AND j.user_id=c.user_id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS state
        FROM codex_conversations c WHERE user_id=? ORDER BY updated_at DESC,id LIMIT 500`).all(uid);
    },
    create(uid,project,title='新会话') {
      const id=crypto.randomUUID(),now=Date.now();
      db.prepare('INSERT INTO codex_conversations(id,user_id,project,title,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,uid,project,title,'web',now,now);
      return get(uid,id);
    },
    update(uid,id,{title,archived}) {
      db.prepare('UPDATE codex_conversations SET title=COALESCE(?,title),archived=COALESCE(?,archived),updated_at=? WHERE user_id=? AND id=?')
        .run(title ?? null,archived === undefined ? null : Number(archived),Date.now(),uid,id);
      return get(uid,id);
    },
    jobs(uid,id) {
      return db.prepare('SELECT id,prompt,state,result,session_id,commit_sha,runtime_json,origin,cancel,created_at,finished_at FROM (SELECT rowid AS sequence,* FROM qq_codex_jobs WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500) ORDER BY created_at,sequence').all(uid,id)
        .map(job=>({...job,runtime:JSON.parse(job.runtime_json),progress:db.prepare('SELECT id,kind,text,created_at FROM codex_job_progress WHERE job_id=? ORDER BY id').all(job.id)}));
    },
    enqueue(uid,qq,id,{prompt,runtime,requestId}) {
      return db.transaction(() => {
        const prior=db.prepare('SELECT id,conversation_id FROM qq_codex_jobs WHERE user_id=? AND event_key=?').get(uid,'web:'+uid+':'+requestId);
        if(prior){if(prior.conversation_id!==id)throw new Error('请求标识已用于其他会话');return prior.id;}
        const conversation=get(uid,id);
        if(!conversation || conversation.archived)throw new Error('会话不存在或已归档');
        if(db.prepare("SELECT 1 FROM qq_codex_jobs WHERE user_id=? AND conversation_id=? AND state IN ('queued','running')").get(uid,id))throw new Error('请等待本轮完成，或先停止任务');
        if(db.prepare("SELECT count(*) AS n FROM qq_codex_jobs WHERE state IN ('queued','running')").get().n>=5)throw new Error('队列已满，请稍后再试');
        const job=crypto.randomBytes(8).toString('hex'),now=Date.now();
        db.prepare("INSERT INTO qq_codex_jobs(id,user_id,qq_id,event_key,project,prompt,created_at,runtime_json,origin,conversation_id) VALUES(?,?,?,?,?,?,?,?,'web',?)")
          .run(job,uid,qq,'web:'+uid+':'+requestId,conversation.project,prompt,now,JSON.stringify(runtime),id);
        db.prepare("UPDATE codex_conversations SET updated_at=?,title=CASE WHEN title='新会话' THEN ? ELSE title END WHERE user_id=? AND id=?").run(now,prompt.replace(/\s+/g,' ').slice(0,60),uid,id);
        return job;
      })();
    },
    capture(job,sessionId) {
      // The portal may have imported a queued QQ turn before its CLI thread was known.
      const linked=db.prepare('SELECT conversation_id FROM qq_codex_jobs WHERE id=? AND user_id=?').get(job.id,job.user_id)?.conversation_id || job.conversation_id;
      let id=linked;
      if(job.origin!=='web'&&id) {
        const existing=db.prepare("SELECT id FROM codex_conversations WHERE user_id=? AND project=? AND group_id=? AND session_id=? AND source='qq' AND id<>? ORDER BY created_at LIMIT 1").get(job.user_id,job.project,job.group_id || '',sessionId,id);
        if(existing) {
          db.prepare('UPDATE qq_codex_jobs SET conversation_id=? WHERE id=? AND user_id=?').run(existing.id,job.id,job.user_id);
          db.prepare('DELETE FROM codex_conversations WHERE id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM qq_codex_jobs WHERE conversation_id=?)').run(id,job.user_id,id);
          id=existing.id;
        }
      }
      db.prepare('UPDATE codex_conversations SET session_id=?,updated_at=? WHERE user_id=? AND id=?').run(sessionId,Date.now(),job.user_id,id || '');
    },
    progress(job,event) {
      const labels={command_execution:'执行命令',file_change:'更新文件',mcp_tool_call:'调用工具',web_search:'搜索资料',todo_list:'更新计划',reasoning:'分析任务'};
      let kind='',text='';
      if(event.type==='turn.started'){kind='status';text='Codex 已开始处理';}
      if(event.type==='item.completed'&&event.item?.type==='agent_message'){kind='message';text=String(event.item.text || '').slice(0,20000);}
      else if(['item.started','item.completed'].includes(event.type)&&labels[event.item?.type]){
        kind='activity';text=labels[event.item.type]+(event.type==='item.completed'?' · 完成':' · 进行中');
        if(event.item.type==='todo_list')text+='\n'+(event.item.items || []).slice(0,20).map(i=>(i.completed?'✓ ':'○ ')+String(i.text).slice(0,200)).join('\n');
      }
      if(!kind||!text)return;
      if(db.prepare('SELECT count(*) AS n FROM codex_job_progress WHERE job_id=?').get(job.id).n>=150)return;
      db.prepare('INSERT INTO codex_job_progress(job_id,kind,text,created_at) VALUES(?,?,?,?)').run(job.id,kind,text,Date.now());
    },
    stop(uid,id) {
      const jobs=db.prepare("SELECT id,state FROM qq_codex_jobs WHERE user_id=? AND conversation_id=? AND state IN ('queued','running')").all(uid,id);
      for(const job of jobs) db.prepare("UPDATE qq_codex_jobs SET cancel=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,result=CASE WHEN state='queued' THEN '已取消排队任务' ELSE result END,finished_at=CASE WHEN state='queued' THEN ? ELSE finished_at END WHERE id=? AND user_id=?")
        .run(Date.now(),job.id,uid);
      return jobs.length;
    }
  };
}
