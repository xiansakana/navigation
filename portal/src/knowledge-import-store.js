import crypto from 'node:crypto';

export function createImportStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_imports (
    document_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,url TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
    lease TEXT,heartbeat INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_import_queue ON knowledge_imports(state,created_at);`);
  const get = (uid, id) => db.prepare('SELECT * FROM knowledge_imports WHERE user_id=? AND document_id=?').get(uid, id);
  return {
    get,
    add(uid, id, url) { db.prepare('INSERT INTO knowledge_imports(document_id,user_id,url,created_at) VALUES (?,?,?,?)').run(id, uid, url, Date.now()); },
    claim() {
      return db.transaction(() => {
        const row = db.prepare(`SELECT i.* FROM knowledge_imports i JOIN knowledge_documents d ON d.id=i.document_id AND d.user_id=i.user_id
          WHERE d.status='importing' AND (i.state='pending' OR i.state='downloading' AND i.heartbeat<?) ORDER BY i.created_at LIMIT 1`).get(Date.now() - 120000);
        if (!row) return null;
        const lease = crypto.randomBytes(24).toString('hex');
        db.prepare("UPDATE knowledge_imports SET state='downloading',lease=?,heartbeat=? WHERE document_id=?").run(lease, Date.now(), row.document_id);
        return { ...row, lease };
      }).immediate();
    },
    touch(row) { return db.prepare("UPDATE knowledge_imports SET heartbeat=? WHERE document_id=? AND lease=? AND state='downloading'").run(Date.now(), row.document_id, row.lease).changes > 0; },
    done(row) { return db.prepare("UPDATE knowledge_imports SET state='done',lease=NULL WHERE document_id=? AND lease=?").run(row.document_id, row.lease).changes > 0; },
    fail(row) { return db.prepare("UPDATE knowledge_imports SET state='failed',lease=NULL WHERE document_id=? AND lease=?").run(row.document_id, row.lease).changes > 0; },
    retry(uid, id) { return db.prepare("UPDATE knowledge_imports SET state='pending',lease=NULL WHERE user_id=? AND document_id=? AND state='failed'").run(uid, id).changes > 0; },
    remove(uid, id) { db.prepare('DELETE FROM knowledge_imports WHERE user_id=? AND document_id=?').run(uid, id); }
  };
}
