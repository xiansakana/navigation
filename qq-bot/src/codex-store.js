import crypto from 'node:crypto';
import { createConversationStore } from './codex-conversations.js';
import { codexQqChunks } from './codex-text.js';
import { validateAttachments, mergeAttachments } from './codex-media.js';

export function createCodexStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS qq_codex_jobs (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,qq_id TEXT NOT NULL,event_key TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',
    result TEXT NOT NULL DEFAULT '',session_id TEXT NOT NULL DEFAULT '',commit_sha TEXT NOT NULL DEFAULT '',
    cancel INTEGER NOT NULL DEFAULT 0,heartbeat INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS qq_codex_queue ON qq_codex_jobs(state,created_at);
    CREATE TABLE IF NOT EXISTS qq_codex_sessions(user_id TEXT NOT NULL,project TEXT NOT NULL,session_id TEXT NOT NULL,
      PRIMARY KEY(user_id,project));
    CREATE TABLE IF NOT EXISTS qq_codex_events(event_key TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS qq_codex_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,qq_id TEXT NOT NULL,
      message TEXT NOT NULL,created_at INTEGER NOT NULL,next_attempt INTEGER NOT NULL DEFAULT 0);`);
  db.transaction(() => { for (const [table, column, definition] of [
    ['qq_codex_jobs', 'group_id', "TEXT NOT NULL DEFAULT ''"], ['qq_codex_jobs', 'reply_mode', "TEXT NOT NULL DEFAULT 'private'"],
    ['qq_codex_outbox', 'group_id', "TEXT NOT NULL DEFAULT ''"], ['qq_codex_outbox', 'full_result', 'INTEGER NOT NULL DEFAULT 0'],
    ['qq_codex_jobs', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'"], ['qq_codex_jobs', 'artifacts_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['qq_codex_jobs', 'runtime_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['qq_codex_jobs', 'origin', "TEXT NOT NULL DEFAULT 'qq'"], ['qq_codex_jobs', 'conversation_id', "TEXT NOT NULL DEFAULT ''"],
    ['qq_codex_outbox', 'artifact_json', "TEXT NOT NULL DEFAULT ''"], ['qq_codex_outbox', 'source_group_id', "TEXT NOT NULL DEFAULT ''"]
  ]) if (!db.prepare('PRAGMA table_info(' + table + ')').all().some(c => c.name === column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition); }).immediate();
  db.exec(`CREATE TABLE IF NOT EXISTS qq_codex_settings(user_id TEXT PRIMARY KEY,groups_json TEXT NOT NULL DEFAULT '[]',group_reply TEXT NOT NULL DEFAULT 'private');
    CREATE TABLE IF NOT EXISTS qq_codex_group_sessions(user_id TEXT NOT NULL,project TEXT NOT NULL,group_id TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(user_id,project,group_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS qq_codex_pending_files(user_id TEXT NOT NULL,group_id TEXT NOT NULL,attachments_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,group_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS qq_codex_runtime_preferences(user_id TEXT NOT NULL,group_id TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',effort TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,group_id));`);
  const conversations=createConversationStore(db);
  db.exec('CREATE INDEX IF NOT EXISTS qq_codex_conversation_jobs ON qq_codex_jobs(user_id,conversation_id,created_at)');
  return {
    conversations,
    runtime(uid,group='') { const row=db.prepare('SELECT model,effort FROM qq_codex_runtime_preferences WHERE user_id=? AND group_id=?').get(uid,group);return row || {model:'',effort:''}; },
    saveRuntime(uid,group,values) {
      if(!values||typeof values.model!=='string'||typeof values.effort!=='string'||values.model.length>120||values.effort.length>24)throw new Error('模型设置格式无效');
      db.prepare('INSERT INTO qq_codex_runtime_preferences VALUES(?,?,?,?,?) ON CONFLICT(user_id,group_id) DO UPDATE SET model=excluded.model,effort=excluded.effort,updated_at=excluded.updated_at').run(uid,group,values.model,values.effort,Date.now());
      return this.runtime(uid,group);
    },
    recordRuntime(job,values) { db.prepare("UPDATE qq_codex_jobs SET runtime_json=? WHERE id=? AND user_id=? AND state='running'").run(JSON.stringify(values),job.id,job.user_id); },
    settings(uid) {
      const row = db.prepare('SELECT * FROM qq_codex_settings WHERE user_id=?').get(uid);
      return row ? { groups: JSON.parse(row.groups_json), groupReply: row.group_reply } : { groups: [], groupReply: 'private' };
    },
    saveSettings(uid, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式无效');
      if (!Array.isArray(input.groups) || input.groups.length > 20 || input.groups.some(g => typeof g !== 'string' || !/^\d{5,20}$/.test(g))) throw new Error('最多20个群号，每个群号需为5—20位数字');
      if (!['private', 'group'].includes(input.groupReply)) throw new Error('请选择有效的结果发送方式');
      db.prepare('INSERT INTO qq_codex_settings VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET groups_json=excluded.groups_json,group_reply=excluded.group_reply').run(uid, JSON.stringify([...new Set(input.groups)]), input.groupReply);
      return this.settings(uid);
    },
    transaction(fn) { return db.transaction(fn)(); },
    attachments(uid, group = '') {
      const row = db.prepare('SELECT * FROM qq_codex_pending_files WHERE user_id=? AND group_id=? AND created_at>?').get(uid,group,Date.now() - 30 * 60000);
      return row ? JSON.parse(row.attachments_json) : [];
    },
    stageAttachments(uid, group, items) {
      const all = mergeAttachments(this.attachments(uid,group),items);
      db.prepare('INSERT INTO qq_codex_pending_files VALUES(?,?,?,?) ON CONFLICT(user_id,group_id) DO UPDATE SET attachments_json=excluded.attachments_json,created_at=excluded.created_at').run(uid,group,JSON.stringify(all),Date.now());
      return all;
    },
    clearAttachments(uid, group = '') { db.prepare('DELETE FROM qq_codex_pending_files WHERE user_id=? AND group_id=?').run(uid,group); },
    event(key) {
      if (db.prepare('SELECT 1 FROM qq_codex_jobs WHERE event_key=?').get(key)) return false;
      db.prepare('DELETE FROM qq_codex_events WHERE created_at<?').run(Date.now() - 7 * 86400000);
      return db.prepare('INSERT OR IGNORE INTO qq_codex_events VALUES(?,?)').run(key, Date.now()).changes > 0;
    },
    enqueue(uid, qq, key, project, prompt, group = '', attachments = []) {
      return db.transaction(() => {
        if (db.prepare("SELECT count(*) AS n FROM qq_codex_jobs WHERE state IN ('queued','running')").get().n >= 5) throw new Error('队列已满，请稍后再试');
        const id = crypto.randomBytes(8).toString('hex');
        db.prepare('INSERT INTO qq_codex_jobs(id,user_id,qq_id,event_key,project,prompt,created_at,group_id,reply_mode) VALUES(?,?,?,?,?,?,?,?,?)').run(id, uid, qq, key, project, prompt, Date.now(), group, this.settings(uid).groupReply);
        db.prepare('UPDATE qq_codex_jobs SET attachments_json=?,runtime_json=? WHERE id=?').run(JSON.stringify(validateAttachments(attachments)),JSON.stringify(this.runtime(uid,group)),id);
        return id;
      })();
    },
    claim({includeQQ=true}={}) {
      return db.transaction(() => {
        const stale = db.prepare("SELECT * FROM qq_codex_jobs WHERE state='running' AND heartbeat<?").all(Date.now() - 120000);
        for (const job of stale) this.finish(job, { state: 'failed', result: '执行进程已中断，未自动重做。修改和提交保留在开发目录，请先查看状态。' });
        if (db.prepare("SELECT 1 FROM qq_codex_jobs WHERE state='running'").get()) return null;
        const job = db.prepare("SELECT * FROM qq_codex_jobs WHERE state='queued'"+(includeQQ?'':" AND origin='web'")+" ORDER BY created_at,rowid LIMIT 1").get();
        if (!job) return null;
        db.prepare("UPDATE qq_codex_jobs SET state='running',heartbeat=? WHERE id=? AND state='queued'").run(Date.now(), job.id);
        return job;
      })();
    },
    active(uid, group = '') { return db.prepare("SELECT id,project,state,created_at,commit_sha,runtime_json FROM qq_codex_jobs WHERE user_id=? AND group_id=? AND origin='qq' ORDER BY state IN ('queued','running') DESC,created_at DESC,rowid DESC LIMIT 5").all(uid, group); },
    latestResult(uid, group = '') { return db.prepare("SELECT result FROM qq_codex_jobs WHERE user_id=? AND group_id=? AND origin='qq' AND result<>'' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(uid, group)?.result; },
    latestArtifacts(uid, group = '') { const row = db.prepare("SELECT artifacts_json FROM qq_codex_jobs WHERE user_id=? AND group_id=? AND origin='qq' AND result<>'' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(uid,group); return row ? JSON.parse(row.artifacts_json) : []; },
    touch(id) { return db.prepare("UPDATE qq_codex_jobs SET heartbeat=? WHERE id=? AND state='running'").run(Date.now(), id).changes > 0; },
    cancelled(id) { return !!db.prepare('SELECT cancel FROM qq_codex_jobs WHERE id=?').get(id)?.cancel; },
    cancel(uid, group = '') {
      return db.transaction(() => {
        const jobs = db.prepare("SELECT * FROM qq_codex_jobs WHERE user_id=? AND group_id=? AND origin='qq' AND state IN ('queued','running')").all(uid, group);
        for (const job of jobs) {
          if (job.state === 'queued') this.finish(job, { state: 'cancelled', result: '已取消排队任务' });
          else db.prepare('UPDATE qq_codex_jobs SET cancel=1 WHERE id=? AND user_id=?').run(job.id, uid);
        }
        return jobs.length;
      })();
    },
    session(uid, project, group = '') { return group ? db.prepare('SELECT session_id FROM qq_codex_group_sessions WHERE user_id=? AND project=? AND group_id=?').get(uid, project, group)?.session_id : db.prepare('SELECT session_id FROM qq_codex_sessions WHERE user_id=? AND project=?').get(uid, project)?.session_id; },
    saveSession(uid, project, group, value) {
      if (group) db.prepare('INSERT INTO qq_codex_group_sessions VALUES(?,?,?,?) ON CONFLICT(user_id,project,group_id) DO UPDATE SET session_id=excluded.session_id').run(uid, project, group, value);
      else db.prepare('INSERT INTO qq_codex_sessions VALUES(?,?,?) ON CONFLICT(user_id,project) DO UPDATE SET session_id=excluded.session_id').run(uid, project, value);
    },
    captureSession(job, value) {
      db.transaction(() => {
        if (!db.prepare("UPDATE qq_codex_jobs SET session_id=? WHERE id=? AND user_id=? AND state='running'").run(value, job.id, job.user_id).changes) return;
        if(job.origin!=='web')this.saveSession(job.user_id, job.project, job.group_id || '', value);
        conversations.capture(job,value);
      })();
    },
    reset(uid, project, group = '') {
      this.clearAttachments(uid,group);
      if (group) db.prepare('DELETE FROM qq_codex_group_sessions WHERE user_id=? AND project=? AND group_id=?').run(uid, project, group);
      else db.prepare('DELETE FROM qq_codex_sessions WHERE user_id=? AND project=?').run(uid, project);
    },
    finish(job, { state, result, sessionId = job.session_id || '', commit = '', artifacts = [], runtime }) {
      return db.transaction(() => {
        if (!db.prepare("UPDATE qq_codex_jobs SET state=?,result=?,session_id=?,commit_sha=?,finished_at=? WHERE id=? AND state IN ('queued','running')")
          .run(state, result.slice(0, 24000), sessionId, commit, Date.now(), job.id).changes) return;
        if (sessionId && job.origin!=='web') this.saveSession(job.user_id, job.project, job.group_id || '', sessionId);
        if(sessionId)conversations.capture(job,sessionId);
        db.prepare('UPDATE qq_codex_jobs SET artifacts_json=? WHERE id=?').run(JSON.stringify(artifacts),job.id);
        if(job.origin==='web')return;
        const summary = `Codex ${job.id.slice(0, 8)} · ${job.project} · ${{ succeeded: '完成', failed: '失败', cancelled: '已停止' }[state]}`;
        const settings = this.settings(job.user_id), allowed = job.group_id && settings.groups.includes(job.group_id);
        const toGroup = allowed && job.reply_mode === 'group' && settings.groupReply === 'group';
        this.reply(job.user_id, job.qq_id, `${summary}\n${runtime?.model ? '模型：'+runtime.model+' · 强度：'+(runtime.effort || '模型默认')+'\n' : ''}${commit ? 'Git: ' + commit.slice(0, 12) + '\n' : ''}${result}`, toGroup ? job.group_id : '', true);
        for (const artifact of artifacts) this.replyArtifact(job.user_id,job.qq_id,artifact,toGroup ? job.group_id : '',job.group_id || '');
        if (allowed && !toGroup) this.reply(job.user_id, job.qq_id, summary + '\n完整结果将通过私聊发送给发起人。', job.group_id);
      })();
    },
    reply(uid, qq, message, group = '', fullResult = false) {
      for (const text of codexQqChunks(message)) db.prepare('INSERT INTO qq_codex_outbox(user_id,qq_id,message,created_at,group_id,full_result) VALUES(?,?,?,?,?,?)').run(uid, qq, text, Date.now(), group, fullResult ? 1 : 0);
    },
    replyArtifact(uid, qq, artifact, group = '', sourceGroup = '') {
      db.prepare('INSERT INTO qq_codex_outbox(user_id,qq_id,message,created_at,group_id,full_result,artifact_json,source_group_id) VALUES(?,?,?,?,?,1,?,?)').run(uid,qq,'',Date.now(),group,JSON.stringify(artifact),sourceGroup);
    },
    pendingReply() { return db.prepare('SELECT * FROM qq_codex_outbox WHERE next_attempt<=? ORDER BY id LIMIT 1').get(Date.now()); },
    delivered(id) { db.prepare('DELETE FROM qq_codex_outbox WHERE id=?').run(id); },
    retryReply(id) { db.prepare('UPDATE qq_codex_outbox SET next_attempt=? WHERE id=?').run(Date.now() + 30000, id); }
  };
}
