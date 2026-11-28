import { randomBytes } from 'node:crypto';
import { MAX_VIDEO_BYTES } from './knowledge-store.js';
import { lockKnowledgeUploadAdmission } from './knowledge-postgres-uploads.js';

export function createPostgresKnowledgeImports(db) {
  return {
    async get(uid, id) {
      const { rows: [row] } = await db.query('SELECT * FROM navigation.knowledge_imports WHERE user_id=$1 AND document_id=$2', [uid, id]);
      return row && { ...row, heartbeat: Number(row.heartbeat), created_at: Number(row.created_at) };
    },
    async progress(job, bytes) {
      await db.query(`UPDATE navigation.knowledge_documents d SET stage=$4,updated_at=$5
        WHERE d.user_id=$1 AND d.id=$2 AND d.status='importing' AND EXISTS (
          SELECT 1 FROM navigation.knowledge_imports i WHERE i.user_id=d.user_id AND i.document_id=d.id AND i.lease=$3)`,
      [job.user_id, job.document_id, job.lease, '下载B站视频 · ' + (bytes / 1024 ** 2).toFixed(1) + ' MB', new Date().toISOString()]);
    },
    async claim() {
      const time = Date.now(), lease = randomBytes(24).toString('hex');
      const { rows: [row] } = await db.query(`WITH next AS (
        SELECT i.document_id FROM navigation.knowledge_imports i
        JOIN navigation.knowledge_documents d ON d.user_id=i.user_id AND d.id=i.document_id
        WHERE d.status='importing' AND (i.state='pending' OR (i.state='downloading' AND i.heartbeat<$1))
        ORDER BY i.created_at,i._sqlite_rowid LIMIT 1 FOR UPDATE OF i SKIP LOCKED
      )
      UPDATE navigation.knowledge_imports i SET state='downloading',lease=$2,heartbeat=$3
      FROM next WHERE i.document_id=next.document_id RETURNING i.*`, [time - 120000, lease, time]);
      return row ? { ...row, heartbeat: Number(row.heartbeat), created_at: Number(row.created_at) } : null;
    },
    async touch(job) {
      const result = await db.query(`UPDATE navigation.knowledge_imports SET heartbeat=$4
        WHERE user_id=$1 AND document_id=$2 AND lease=$3 AND state='downloading' AND heartbeat>=$5`,
      [job.user_id, job.document_id, job.lease, Date.now(), Date.now() - 120000]);
      return result.rowCount === 1;
    },
    complete(job, hashes, media = {}, publish) {
      if (!Number.isSafeInteger(hashes.bytes) || hashes.bytes < 12 || hashes.bytes > MAX_VIDEO_BYTES ||
          !/^[a-f0-9]{64}$/.test(hashes.sha256 || '')) throw new Error('导入视频大小或校验值无效');
      return db.transaction(async client => {
        await lockKnowledgeUploadAdmission(client);
        const { rows: [document] } = await client.query(`SELECT byte_size FROM navigation.knowledge_documents
          WHERE user_id=$1 AND id=$2 AND status='importing' FOR UPDATE`, [job.user_id, job.document_id]);
        if (!document) return false;
        if (hashes.bytes > Number(document.byte_size)) throw new Error('下载视频超过已预留空间');
        const claim = await client.query(`UPDATE navigation.knowledge_imports SET state='done',lease=NULL,media_json=$4
          WHERE user_id=$1 AND document_id=$2 AND lease=$3 AND state='downloading' AND heartbeat>=$5`,
        [job.user_id, job.document_id, job.lease, JSON.stringify(media), Date.now() - 120000]);
        if (!claim.rowCount) return false;
        if (publish) await publish();
        await client.query(`UPDATE navigation.knowledge_documents SET byte_size=$3,status='queued',stage=CASE WHEN backend='gemini' THEN '等待 Gemini' ELSE '等待GPU工作器' END,
          source_sha256=$4,progress=0,error='',updated_at=$5 WHERE user_id=$1 AND id=$2`,
        [job.user_id, job.document_id, hashes.bytes, hashes.sha256, new Date().toISOString()]);
        await client.query(`UPDATE navigation.knowledge_sources SET state='pending'
          WHERE user_id=$1 AND document_id=$2 AND state='waiting'`, [job.user_id, job.document_id]);
        return true;
      });
    },
    fail(job, message) {
      return db.transaction(async client => {
        const doc = await client.query(`SELECT id FROM navigation.knowledge_documents
          WHERE user_id=$1 AND id=$2 AND status='importing' FOR UPDATE`, [job.user_id, job.document_id]);
        if (!doc.rowCount) return false;
        const claim = await client.query(`UPDATE navigation.knowledge_imports SET state='failed',lease=NULL
          WHERE user_id=$1 AND document_id=$2 AND lease=$3 AND state='downloading' AND heartbeat>=$4`,
        [job.user_id, job.document_id, job.lease, Date.now() - 120000]);
        if (!claim.rowCount) return false;
        await client.query(`UPDATE navigation.knowledge_documents SET status='failed',stage='链接导入失败',error=$3,updated_at=$4
          WHERE user_id=$1 AND id=$2`, [job.user_id, job.document_id, String(message).slice(0, 400), new Date().toISOString()]);
        return true;
      });
    },
  };
}
