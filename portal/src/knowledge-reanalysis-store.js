import crypto from 'node:crypto';

const active = ['queued', 'processing', 'uploading', 'importing', 'deleting'];
const now = () => new Date().toISOString();
export function createReanalysisStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_reanalyses(document_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,run_id TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_note_versions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,document_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_versions_owner ON knowledge_note_versions(user_id,document_id,created_at);`);
  const row = (uid, id) => db.prepare('SELECT * FROM knowledge_documents WHERE user_id=? AND id=?').get(uid, id);
  const get = (uid, id) => db.prepare('SELECT run_id AS runId,mode,state FROM knowledge_reanalyses WHERE user_id=? AND document_id=?').get(uid, id);
  function snapshot(r) {
    const value = Object.fromEntries(['title', 'notes', 'transcript_json', 'frames_json', 'provenance_json', 'duration', 'language'].map(k => [k, r[k]]));
    db.prepare('INSERT INTO knowledge_note_versions VALUES(?,?,?,?,?)').run(crypto.randomBytes(16).toString('hex'), r.user_id, r.id, JSON.stringify(value), now());
    db.prepare('DELETE FROM knowledge_note_versions WHERE user_id=? AND document_id=? AND id NOT IN (SELECT id FROM knowledge_note_versions WHERE user_id=? AND document_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10)').run(r.user_id, r.id, r.user_id, r.id);
  }
  return {
    get,
    list(uid, id) { return db.prepare('SELECT id,snapshot_json,created_at FROM knowledge_note_versions WHERE user_id=? AND document_id=? ORDER BY created_at DESC,rowid DESC').all(uid, id).map(r => { const s = JSON.parse(r.snapshot_json); return { id: r.id, createdAt: r.created_at, title: s.title, notes: s.notes, provenance: JSON.parse(s.provenance_json) }; }); },
    schedule(uid, id, revision, mode, settings) {
      return db.transaction(() => {
        const r = row(uid, id);
        if (!r || !['ready', 'failed'].includes(r.status) || !r.notes || r.revision !== revision) throw Object.assign(new Error('笔记不存在、已更新或正在处理中，请刷新后重试'), { status: 409 });
        if (!['reuse', 'full'].includes(mode)) throw new Error('重新分析方式无效');
        if (mode === 'reuse' && (!r.duration || !JSON.parse(r.transcript_json).length && !JSON.parse(r.frames_json).length)) throw new Error('没有可复用的转写或关键画面，请选择重新提取原视频');
        snapshot(r);
        const runId = crypto.randomBytes(16).toString('hex');
        db.prepare('INSERT INTO knowledge_reanalyses VALUES(?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET run_id=excluded.run_id,mode=excluded.mode,state=excluded.state').run(id, uid, runId, mode, 'pending');
        db.prepare("UPDATE knowledge_documents SET status='queued',stage=?,backend=?,model_settings_json=?,error='',lease=NULL,worker_id='',processing_phase='',progress=0,revision=revision+1,updated_at=? WHERE user_id=? AND id=?")
          .run(mode === 'reuse' ? '等待GPU工作器重新分析 · 复用转写与画面' : '等待GPU工作器重新提取原视频', settings.backend, JSON.stringify(settings), now(), uid, id);
        return runId;
      }).immediate();
    },
    complete(uid, id) { db.prepare("UPDATE knowledge_reanalyses SET state='done' WHERE user_id=? AND document_id=?").run(uid, id); },
    restore(uid, id, versionId, revision) {
      return db.transaction(() => {
        const r = row(uid, id), v = db.prepare('SELECT snapshot_json FROM knowledge_note_versions WHERE user_id=? AND document_id=? AND id=?').get(uid, id, versionId);
        if (!r || !v) throw Object.assign(new Error('笔记或历史版本不存在'), { status: 404 });
        if (active.includes(r.status) || r.revision !== revision) throw Object.assign(new Error('笔记正在处理或已更新，请刷新后再恢复'), { status: 409 });
        const s = JSON.parse(v.snapshot_json); snapshot(r);
        db.prepare("UPDATE knowledge_documents SET notes=?,transcript_json=?,frames_json=?,provenance_json=?,duration=?,language=?,status='ready',stage='已恢复历史版本',error='',progress=100,lease=NULL,worker_id='',processing_phase='',revision=revision+1,updated_at=? WHERE user_id=? AND id=?")
          .run(s.notes, s.transcript_json, s.frames_json, s.provenance_json, s.duration, s.language, now(), uid, id);
        db.prepare("UPDATE knowledge_reanalyses SET state='restored' WHERE user_id=? AND document_id=?").run(uid, id);
      }).immediate();
    },
    remove(uid, id) { db.prepare('DELETE FROM knowledge_note_versions WHERE user_id=? AND document_id=?').run(uid, id); db.prepare('DELETE FROM knowledge_reanalyses WHERE user_id=? AND document_id=?').run(uid, id); }
  };
}
