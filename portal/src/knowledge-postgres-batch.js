import { randomBytes } from 'node:crypto';
import { bilibiliUrl } from './knowledge-bilibili.js';
import { batchImportInput, uploadQueueSettings } from './knowledge-upload-queue.js';
import { findPostgresKnowledgeDuplicate, lockKnowledgeUploadAdmission, reservePostgresKnowledgeUpload } from './knowledge-postgres-uploads.js';

const active = "status IN ('uploading','importing','queued','processing')";
const pending = "state IN ('pending','resolving','failed')";

async function settle(client, job, state, message = '', documentId = '', title = '') {
  const result = await client.query(`UPDATE navigation.knowledge_upload_queue
    SET state=$4,error=$5,document_id=$6,title=$7,lease=NULL,expires=0,updated_at=$8
    WHERE user_id=$1 AND id=$2 AND lease=$3 AND state='resolving'`,
  [job.user_id, job.id, job.lease, state, String(message).slice(0, 400), documentId, title, Date.now()]);
  return result.rowCount === 1;
}

export function createPostgresKnowledgeBatch(db) {
  return {
    async get(uid, id) {
      const { rows: [row] } = await db.query('SELECT * FROM navigation.knowledge_upload_queue WHERE user_id=$1 AND id=$2', [uid, id]);
      return row;
    },
    add(uid, raw, defaults) {
      const settings = uploadQueueSettings(raw, defaults);
      return db.transaction(async client => {
        await lockKnowledgeUploadAdmission(client);
        const { rows: [existing] } = await client.query('SELECT count(*) AS n FROM navigation.knowledge_upload_queue WHERE user_id=$1 AND ' + pending, [uid]);
        let accepted = 0;
        const results = [], time = Date.now();
        for (const [index, input] of raw.urls.entries()) {
          let url;
          try { url = bilibiliUrl(input.trim().replace(/[，。；、）)\]}]+$/, '')); }
          catch (error) { results.push({ index, status: 'invalid', error: error.message }); continue; }
          const duplicate = await findPostgresKnowledgeDuplicate(client, uid, url);
          if (duplicate) {
            results.push({ index, status: 'duplicate', url, documentId: duplicate.document_id || '', title: duplicate.title || '' });
            continue;
          }
          if (Number(existing.n) + accepted >= 500) throw new Error('等待和失败队列最多500条，请先处理或取消部分任务');
          const id = randomBytes(16).toString('hex');
          await client.query(`INSERT INTO navigation.knowledge_upload_queue(id,user_id,url,settings_json,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$5)`, [id, uid, url, JSON.stringify(settings), time]);
          accepted++;
          results.push({ index, status: 'accepted', id, url });
        }
        return { accepted, results };
      });
    },
    list(uid, offset = 0) {
      return db.transaction(async client => {
        const { rows: counts } = await client.query('SELECT state,count(*) AS count FROM navigation.knowledge_upload_queue WHERE user_id=$1 GROUP BY state', [uid]);
        const { rows: entries } = await client.query(`SELECT q.id,q.url,q.state,q.title,q.error,q.document_id AS "documentId",q.created_at AS "createdAt",
            d.status AS "documentStatus",d.stage AS "documentStage",d.title AS "documentTitle"
          FROM navigation.knowledge_upload_queue q LEFT JOIN navigation.knowledge_documents d ON d.id=q.document_id AND d.user_id=q.user_id
          WHERE q.user_id=$1 ORDER BY CASE q.state WHEN 'resolving' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
            CASE WHEN q.state IN ('pending','resolving','failed') THEN q.seq ELSE -q.seq END LIMIT 50 OFFSET $2`, [uid, offset]);
        const { rows: [jobs] } = await client.query('SELECT count(*) AS n FROM navigation.knowledge_documents WHERE user_id=$1 AND ' + active, [uid]);
        return { entries: entries.map(item => ({ ...item, createdAt: Number(item.createdAt) })),
          counts: Object.fromEntries(counts.map(item => [item.state, Number(item.count)])),
          total: counts.reduce((sum, item) => sum + Number(item.count), 0), active: Number(jobs.n), capacity: 5, offset };
      }, { readOnly: true });
    },
    async change(uid, id, action) {
      const retry = action === 'retry';
      const result = await db.query(`UPDATE navigation.knowledge_upload_queue SET state=$3,error='',lease=NULL,expires=0,updated_at=$4
        WHERE user_id=$1 AND id=$2 AND state=ANY($5::text[])`,
      [uid, id, retry ? 'pending' : 'cancelled', Date.now(), retry ? ['failed'] : ['pending', 'resolving', 'failed']]);
      return result.rowCount === 1;
    },
    claim() {
      return db.transaction(async client => {
        await lockKnowledgeUploadAdmission(client);
        const time = Date.now(), lease = randomBytes(24).toString('hex');
        const { rows: [job] } = await client.query(`WITH next AS (
          SELECT q.id FROM navigation.knowledge_upload_queue q
          WHERE (q.state='pending' OR q.state='resolving' AND q.expires<$1)
            AND (SELECT count(*) FROM navigation.knowledge_documents d WHERE d.user_id=q.user_id AND d.${active})
              + (SELECT count(*) FROM navigation.knowledge_upload_queue r WHERE r.user_id=q.user_id AND r.state='resolving' AND r.expires>=$1) < 5
          ORDER BY q.seq LIMIT 1 FOR UPDATE OF q
        )
        UPDATE navigation.knowledge_upload_queue q SET state='resolving',lease=$2,expires=$3,updated_at=$1
        FROM next WHERE q.id=next.id RETURNING q.*`, [time, lease, time + 120000]);
        return job || null;
      });
    },
    fail(job, error) { return settle(db, job, 'failed', error); },
    submit(job, info, selection, config, availableBytes) {
      return db.transaction(async client => {
        await lockKnowledgeUploadAdmission(client);
        const live = await client.query(`SELECT id FROM navigation.knowledge_upload_queue
          WHERE user_id=$1 AND id=$2 AND lease=$3 AND state='resolving' AND expires>=$4 FOR UPDATE`, [job.user_id, job.id, job.lease, Date.now()]);
        if (!live.rowCount) return null;
        // Reservation failures abort the transaction; isolate them so the queue
        // job can still be settled instead of leaving it stuck in resolving.
        await client.query('SAVEPOINT knowledge_submit');
        try {
          const item = await reservePostgresKnowledgeUpload(client, job.user_id, batchImportInput(info, selection), config,
            availableBytes, { url: info.sourceUrl, selection }, job.id);
          await client.query('RELEASE SAVEPOINT knowledge_submit');
          await settle(client, job, 'submitted', '', item.id, info.title);
          return item;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT knowledge_submit');
          await client.query('RELEASE SAVEPOINT knowledge_submit');
          if (error.code === 'KNOWLEDGE_DUPLICATE_SOURCE') {
            await settle(client, job, 'duplicate', '', error.duplicate.documentId, error.duplicate.title || info.title);
            return null;
          }
          if (error.code === 'KNOWLEDGE_CAPACITY') { await settle(client, job, 'pending'); return null; }
          throw error;
        }
      });
    },
  };
}
