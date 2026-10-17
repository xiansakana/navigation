import crypto from 'node:crypto';

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
  return {
    transaction(fn) { return db.transaction(fn)(); },
    event(key) {
      if (db.prepare('SELECT 1 FROM qq_codex_jobs WHERE event_key=?').get(key)) return false;
      db.prepare('DELETE FROM qq_codex_events WHERE created_at<?').run(Date.now() - 7 * 86400000);
      return db.prepare('INSERT OR IGNORE INTO qq_codex_events VALUES(?,?)').run(key, Date.now()).changes > 0;
    },
    enqueue(uid, qq, key, project, prompt) {
      return db.transaction(() => {
        if (db.prepare("SELECT count(*) AS n FROM qq_codex_jobs WHERE state IN ('queued','running')").get().n >= 5) throw new Error('队列已满，请稍后再试');
        const id = crypto.randomBytes(8).toString('hex');
        db.prepare('INSERT INTO qq_codex_jobs(id,user_id,qq_id,event_key,project,prompt,created_at) VALUES(?,?,?,?,?,?,?)').run(id, uid, qq, key, project, prompt, Date.now());
        return id;
      })();
    },
    claim() {
      return db.transaction(() => {
        const stale = db.prepare("SELECT * FROM qq_codex_jobs WHERE state='running' AND heartbeat<?").all(Date.now() - 120000);
        for (const job of stale) this.finish(job, { state: 'failed', result: '执行进程已中断，未自动重做。修改和提交保留在开发目录，请先查看状态。' });
        if (db.prepare("SELECT 1 FROM qq_codex_jobs WHERE state='running'").get()) return null;
        const job = db.prepare("SELECT * FROM qq_codex_jobs WHERE state='queued' ORDER BY created_at,rowid LIMIT 1").get();
        if (!job) return null;
        db.prepare("UPDATE qq_codex_jobs SET state='running',heartbeat=? WHERE id=? AND state='queued'").run(Date.now(), job.id);
        return job;
      })();
    },
    active(uid) { return db.prepare("SELECT id,project,state,created_at,commit_sha FROM qq_codex_jobs WHERE user_id=? ORDER BY state IN ('queued','running') DESC,created_at DESC,rowid DESC LIMIT 5").all(uid); },
    latestResult(uid) { return db.prepare("SELECT result FROM qq_codex_jobs WHERE user_id=? AND result<>'' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(uid)?.result; },
    touch(id) { return db.prepare("UPDATE qq_codex_jobs SET heartbeat=? WHERE id=? AND state='running'").run(Date.now(), id).changes > 0; },
    cancelled(id) { return !!db.prepare('SELECT cancel FROM qq_codex_jobs WHERE id=?').get(id)?.cancel; },
    cancel(uid) {
      return db.transaction(() => {
        const jobs = db.prepare("SELECT * FROM qq_codex_jobs WHERE user_id=? AND state IN ('queued','running')").all(uid);
        for (const job of jobs) {
          if (job.state === 'queued') this.finish(job, { state: 'cancelled', result: '已取消排队任务' });
          else db.prepare('UPDATE qq_codex_jobs SET cancel=1 WHERE id=? AND user_id=?').run(job.id, uid);
        }
        return jobs.length;
      })();
    },
    session(uid, project) { return db.prepare('SELECT session_id FROM qq_codex_sessions WHERE user_id=? AND project=?').get(uid, project)?.session_id; },
    captureSession(job, value) {
      db.transaction(() => {
        if (!db.prepare("UPDATE qq_codex_jobs SET session_id=? WHERE id=? AND user_id=? AND state='running'").run(value, job.id, job.user_id).changes) return;
        db.prepare('INSERT INTO qq_codex_sessions VALUES(?,?,?) ON CONFLICT(user_id,project) DO UPDATE SET session_id=excluded.session_id').run(job.user_id, job.project, value);
      })();
    },
    reset(uid, project) { db.prepare('DELETE FROM qq_codex_sessions WHERE user_id=? AND project=?').run(uid, project); },
    finish(job, { state, result, sessionId = job.session_id || '', commit = '' }) {
      return db.transaction(() => {
        if (!db.prepare("UPDATE qq_codex_jobs SET state=?,result=?,session_id=?,commit_sha=?,finished_at=? WHERE id=? AND state IN ('queued','running')")
          .run(state, result.slice(0, 24000), sessionId, commit, Date.now(), job.id).changes) return;
        if (sessionId) db.prepare('INSERT INTO qq_codex_sessions VALUES(?,?,?) ON CONFLICT(user_id,project) DO UPDATE SET session_id=excluded.session_id').run(job.user_id, job.project, sessionId);
        this.reply(job.user_id, job.qq_id, `Codex ${job.id.slice(0, 8)} · ${job.project} · ${{ succeeded: '完成', failed: '失败', cancelled: '已停止' }[state]}\n${commit ? 'Git: ' + commit.slice(0, 12) + '\n' : ''}${result}`);
      })();
    },
    reply(uid, qq, message) {
      const text = String(message).replace(/\[CQ:/gi, '［CQ:').slice(0, 10000);
      for (let i = 0; i < text.length; i += 1500) db.prepare('INSERT INTO qq_codex_outbox(user_id,qq_id,message,created_at) VALUES(?,?,?,?)').run(uid, qq, text.slice(i, i + 1500), Date.now());
    },
    pendingReply() { return db.prepare('SELECT * FROM qq_codex_outbox WHERE next_attempt<=? ORDER BY id LIMIT 1').get(Date.now()); },
    delivered(id) { db.prepare('DELETE FROM qq_codex_outbox WHERE id=?').run(id); },
    retryReply(id) { db.prepare('UPDATE qq_codex_outbox SET next_attempt=? WHERE id=?').run(Date.now() + 30000, id); }
  };
}
