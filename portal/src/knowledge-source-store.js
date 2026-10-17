import crypto from 'node:crypto';

export function createSourceStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_sources (
    document_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,object_path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting',sha1 TEXT NOT NULL DEFAULT '',sha256 TEXT NOT NULL DEFAULT '',
    verified_at TEXT,error TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,
    lease TEXT,heartbeat INTEGER NOT NULL DEFAULT 0,next_retry INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS knowledge_source_queue ON knowledge_sources(state,next_retry);`);
  const columns = new Set(db.prepare('PRAGMA table_info(knowledge_sources)').all().map(c => c.name));
  for (const column of ['upload_started_at', 'upload_ms', 'verification_started_at', 'verification_ms']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE knowledge_sources ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  const get = (uid, id) => db.prepare('SELECT * FROM knowledge_sources WHERE user_id=? AND document_id=?').get(uid, id);
  return {
    get,
    public(uid, id) {
      const s = get(uid, id);
      return s ? { provider: '115', state: s.state, error: s.error, verifiedAt: s.verified_at,
        timings: { uploadMs: s.state === 'uploading' && s.upload_started_at ? Date.now() - s.upload_started_at : s.upload_ms,
          verificationMs: s.state === 'verifying' && s.verification_started_at ? Date.now() - s.verification_started_at : s.verification_ms } } : { provider: 'local', state: 'local' };
    },
    add(uid, id, objectPath, state = 'waiting') { db.prepare('INSERT OR IGNORE INTO knowledge_sources(document_id,user_id,object_path,state) VALUES (?,?,?,?)').run(id, uid, objectPath, state); },
    enqueue(uid, id) { db.prepare("UPDATE knowledge_sources SET state='pending' WHERE user_id=? AND document_id=? AND state='waiting'").run(uid, id); },
    retry(uid, id) { return db.prepare("UPDATE knowledge_sources SET state='pending',attempts=0,next_retry=0,error='' WHERE user_id=? AND document_id=? AND state='failed'").run(uid, id).changes > 0; },
    deleting(uid, id) {
      return db.transaction(() => {
        const s = get(uid, id);
        if (!s) return false;
        if (s.lease && s.heartbeat > Date.now() - 120000) throw Object.assign(new Error('原视频正在保存至115，请稍后删除'), { status: 409 });
        db.prepare("UPDATE knowledge_sources SET state='deleting',lease=NULL,attempts=0,next_retry=0 WHERE user_id=? AND document_id=?").run(uid, id);
        db.prepare("UPDATE knowledge_documents SET status='deleting',lease=NULL WHERE user_id=? AND id=?").run(uid, id);
        return true;
      })();
    },
    claim() {
      return db.transaction(() => {
        const time = Date.now();
        const s = db.prepare(`SELECT s.*,d.byte_size,d.original_name FROM knowledge_sources s JOIN knowledge_documents d ON d.id=s.document_id AND d.user_id=s.user_id
          WHERE s.state IN ('pending','uploading','verifying','verified','failed','deleting') AND (s.attempts<5 OR s.state IN ('uploading','verifying','verified')) AND s.next_retry<=?
          AND (s.lease IS NULL OR s.heartbeat<?) ORDER BY s.state='deleting' DESC,s.rowid LIMIT 1`).get(time, time - 120000);
        if (!s) return null;
        const lease = crypto.randomBytes(24).toString('hex');
        db.prepare('UPDATE knowledge_sources SET lease=?,heartbeat=?,attempts=attempts+1 WHERE document_id=?').run(lease, time, s.document_id);
        return { ...s, lease };
      })();
    },
    update(s, values) {
      const allowed = ['state', 'sha1', 'sha256', 'verified_at', 'error', 'next_retry', 'upload_started_at', 'upload_ms', 'verification_started_at', 'verification_ms'];
      const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
      return db.prepare('UPDATE knowledge_sources SET heartbeat=?' + entries.map(([key]) => ',' + key + '=?').join('') + ' WHERE document_id=? AND lease=?')
        .run(Date.now(), ...entries.map(([, value]) => value), s.document_id, s.lease).changes > 0;
    },
    release(s) { db.prepare('UPDATE knowledge_sources SET lease=NULL WHERE document_id=? AND lease=?').run(s.document_id, s.lease); },
    remove(uid, id) { db.prepare('DELETE FROM knowledge_sources WHERE user_id=? AND document_id=?').run(uid, id); }
  };
}
