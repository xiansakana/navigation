import crypto from 'node:crypto';

const timingFields = ['upload_started_at', 'upload_ms', 'verification_started_at', 'verification_ms'];
const writableFields = new Set(['state', 'sha1', 'sha256', 'verified_at', 'error', 'next_retry', ...timingFields]);
const projectSource = s => s ? { provider: '115', state: s.state, error: s.error, verifiedAt: s.verified_at,
  timings: { uploadMs: s.state === 'uploading' && s.upload_started_at ? Date.now() - s.upload_started_at : s.upload_ms,
    verificationMs: s.state === 'verifying' && s.verification_started_at ? Date.now() - s.verification_started_at : s.verification_ms } } : { provider: 'local', state: 'local' };

function normalizeSource(row) {
  if (!row) return row;
  for (const field of ['attempts', 'heartbeat', 'next_retry', 'byte_size', ...timingFields]) {
    if (row[field] !== undefined) row[field] = Number(row[field]);
  }
  return row;
}

export function createPostgresKnowledgeSourceStore(db) {
  const scoped = 'user_id=$1 AND document_id=$2';
  async function get(uid, id) {
    const { rows: [row] } = await db.query('SELECT * FROM navigation.knowledge_sources WHERE ' + scoped, [uid, id]);
    return normalizeSource(row);
  }
  return {
    get,
    async public(uid, id) { return projectSource(await get(uid, id)); },
    async add(uid, id, objectPath, state = 'waiting') {
      await db.query(`INSERT INTO navigation.knowledge_sources(document_id,user_id,object_path,state)
        VALUES($2,$1,$3,$4) ON CONFLICT(document_id) DO NOTHING`, [uid, id, objectPath, state]);
    },
    async enqueue(uid, id) {
      await db.query("UPDATE navigation.knowledge_sources SET state='pending' WHERE " + scoped + " AND state='waiting'", [uid, id]);
    },
    async retry(uid, id) {
      const result = await db.query("UPDATE navigation.knowledge_sources SET state='pending',attempts=0,next_retry=0,error='' WHERE " + scoped + " AND state='failed'", [uid, id]);
      return result.rowCount === 1;
    },
    deleting(uid, id) {
      return db.transaction(async client => {
        await client.query('SELECT id FROM navigation.knowledge_documents WHERE user_id=$1 AND id=$2 FOR UPDATE', [uid, id]);
        const { rows: [row] } = await client.query('SELECT lease,heartbeat FROM navigation.knowledge_sources WHERE ' + scoped + ' FOR UPDATE', [uid, id]);
        if (!row) return false;
        if (row.lease && Number(row.heartbeat) > Date.now() - 120000) throw Object.assign(new Error('原视频正在保存至115，请稍后删除'), { status: 409 });
        await client.query("UPDATE navigation.knowledge_sources SET state='deleting',lease=NULL,attempts=0,next_retry=0 WHERE " + scoped, [uid, id]);
        await client.query("UPDATE navigation.knowledge_documents SET status='deleting',lease=NULL WHERE user_id=$1 AND id=$2", [uid, id]);
        return true;
      });
    },
    async claim() {
      const now = Date.now(), lease = crypto.randomBytes(24).toString('hex');
      const { rows: [row] } = await db.query(`WITH candidate AS (
        SELECT s.document_id,s.heartbeat AS previous_heartbeat,d.byte_size,d.original_name FROM navigation.knowledge_sources s
        JOIN navigation.knowledge_documents d ON d.id=s.document_id AND d.user_id=s.user_id
        WHERE s.state IN ('pending','uploading','verifying','verified','failed','deleting')
          AND (s.attempts<5 OR s.state IN ('uploading','verifying','verified')) AND s.next_retry<=$1
          AND (s.lease IS NULL OR s.heartbeat<$2)
        ORDER BY (s.state='deleting') DESC,s._sqlite_rowid LIMIT 1 FOR UPDATE OF s SKIP LOCKED)
        UPDATE navigation.knowledge_sources s SET lease=$3,heartbeat=$1,attempts=s.attempts+1
        FROM candidate WHERE s.document_id=candidate.document_id
        RETURNING s.*,candidate.byte_size,candidate.original_name,candidate.previous_heartbeat`,
      [now, now - 120000, lease]);
      if (!row) return null;
      const { previous_heartbeat, ...source } = normalizeSource(row);
      return { ...source, heartbeat: Number(previous_heartbeat), attempts: source.attempts - 1 };
    },
    async update(s, values) {
      const entries = Object.entries(values).filter(([key]) => writableFields.has(key));
      const fields = entries.map(([key], index) => key + '=$' + (index + 5));
      const result = await db.query('UPDATE navigation.knowledge_sources SET ' + ['heartbeat=$4', ...fields].join(',') + ' WHERE ' + scoped + ' AND lease=$3',
        [s.user_id, s.document_id, s.lease, Date.now(), ...entries.map(([, value]) => value)]);
      return result.rowCount === 1;
    },
    async release(s) {
      await db.query('UPDATE navigation.knowledge_sources SET lease=NULL WHERE ' + scoped + ' AND lease=$3', [s.user_id, s.document_id, s.lease]);
    },
    async remove(uid, id) {
      await db.query('DELETE FROM navigation.knowledge_sources WHERE ' + scoped, [uid, id]);
    },
  };
}

export function createSourceStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_sources (
    document_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,object_path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting',sha1 TEXT NOT NULL DEFAULT '',sha256 TEXT NOT NULL DEFAULT '',
    verified_at TEXT,error TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,
    lease TEXT,heartbeat INTEGER NOT NULL DEFAULT 0,next_retry INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS knowledge_source_queue ON knowledge_sources(state,next_retry);`);
  const columns = new Set(db.prepare('PRAGMA table_info(knowledge_sources)').all().map(c => c.name));
  for (const column of timingFields) {
    if (!columns.has(column)) db.exec(`ALTER TABLE knowledge_sources ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  const get = (uid, id) => db.prepare('SELECT * FROM knowledge_sources WHERE user_id=? AND document_id=?').get(uid, id);
  return {
    get,
    public(uid, id) {
      return projectSource(get(uid, id));
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
      const entries = Object.entries(values).filter(([key]) => writableFields.has(key));
      return db.prepare('UPDATE knowledge_sources SET heartbeat=?' + entries.map(([key]) => ',' + key + '=?').join('') + ' WHERE document_id=? AND lease=?')
        .run(Date.now(), ...entries.map(([, value]) => value), s.document_id, s.lease).changes > 0;
    },
    release(s) { db.prepare('UPDATE knowledge_sources SET lease=NULL WHERE document_id=? AND lease=?').run(s.document_id, s.lease); },
    remove(uid, id) { db.prepare('DELETE FROM knowledge_sources WHERE user_id=? AND document_id=?').run(uid, id); }
  };
}
