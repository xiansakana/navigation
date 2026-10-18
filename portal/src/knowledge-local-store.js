import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export function createLocalInputStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_local_inputs (
    document_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,worker_id TEXT NOT NULL,
    ticket_hash TEXT NOT NULL,expires INTEGER NOT NULL,sha256 TEXT NOT NULL DEFAULT '');`);
  const get = (uid, id) => db.prepare('SELECT * FROM knowledge_local_inputs WHERE user_id=? AND document_id=?').get(uid, id);
  return {
    get,
    offer(uid, id, workerId) {
      const doc = db.prepare('SELECT * FROM knowledge_documents WHERE user_id=? AND id=?').get(uid, id);
      const worker = db.prepare('SELECT * FROM knowledge_worker_instances WHERE user_id=? AND worker_id=? AND last_seen>?').get(uid, workerId, new Date(Date.now() - 90000).toISOString());
      const caps = worker && JSON.parse(worker.capabilities_json);
      if (!doc || doc.status !== 'uploading' || !caps?.media?.ready || caps.media.detail !== 'cuda' || !caps[doc.backend]?.ready) throw new Error('没有可用的本机GPU工作器');
      const ticket = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO knowledge_local_inputs VALUES (?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET worker_id=excluded.worker_id,ticket_hash=excluded.ticket_hash,expires=excluded.expires,sha256=excluded.sha256')
        .run(id, uid, workerId, hash(ticket), Date.now() + 600000, '');
      return { ticket, workerId };
    },
    verify(uid, id, workerId, ticket, sha256) {
      const row = get(uid, id), doc = db.prepare('SELECT * FROM knowledge_documents WHERE user_id=? AND id=?').get(uid, id);
      if (!row || !doc || !['uploading', 'queued'].includes(doc.status) || row.worker_id !== workerId || row.expires < Date.now() || row.ticket_hash !== hash(ticket)) throw new Error('本机接收授权已失效');
      if (sha256 !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('本机视频校验值无效');
        db.prepare('UPDATE knowledge_local_inputs SET sha256=?,ticket_hash=? WHERE document_id=? AND user_id=?').run(sha256, '', id, uid);
      }
      return { bytes: doc.byte_size };
    },
    forget(uid, id, workerId) { db.prepare('DELETE FROM knowledge_local_inputs WHERE user_id=? AND document_id=? AND worker_id=?').run(uid, id, workerId); },
    remove(uid, id) { db.prepare('DELETE FROM knowledge_local_inputs WHERE user_id=? AND document_id=?').run(uid, id); }
  };
}
