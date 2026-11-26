import { randomBytes } from 'node:crypto';
import { pipelineSettings } from './knowledge-pipeline.js';
import { syncPostgresKnowledgeCases } from './mingli-knowledge-postgres-index.js';

const expired = () => new Date(Date.now() - 15 * 60000).toISOString();
const now = () => new Date().toISOString();
const conflict = message => Object.assign(new Error(message), { status: 409 });

export async function lockKnowledgeWorkerOwner(client, uid) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('knowledge:worker:' || $1, 0))", [uid]);
}

export async function expireKnowledgeLeases(client, uid) {
  await client.query(`UPDATE navigation.knowledge_documents
    SET status='queued',stage='等待GPU工作器恢复',error='',lease=NULL,worker_id='',processing_phase='',progress=0,updated_at=$2
    WHERE user_id=$1 AND status='processing' AND heartbeat<$3`, [uid, now(), expired()]);
}

async function readLimits(client, uid) {
  const { rows: [row] } = await client.query('SELECT pipeline_json FROM navigation.knowledge_settings WHERE user_id=$1', [uid]);
  return pipelineSettings({}, JSON.parse(row?.pipeline_json || '{}'));
}

export function createPostgresKnowledgeLeases(db) {
  return {
    claim(uid, backends, workerId, localDocuments = []) {
      return db.transaction(async client => {
        await lockKnowledgeWorkerOwner(client, uid);
        await expireKnowledgeLeases(client, uid);
        const { rows: [worker] } = await client.query(`SELECT capabilities_json FROM navigation.knowledge_worker_instances
          WHERE user_id=$1 AND worker_id=$2 AND last_seen>$3`, [uid, workerId, new Date(Date.now() - 90000).toISOString()]);
        const capabilities = JSON.parse(worker?.capabilities_json || '{}');
        if (!capabilities.media?.ready || capabilities.media.detail !== 'cuda') return null;
        const supported = backends.filter(backend => ['openai', 'codex'].includes(backend) && capabilities[backend]?.ready);
        if (!supported.length) return null;
        const { rows: [active] } = await client.query(`SELECT count(*) AS total,
            count(*) FILTER (WHERE processing_phase NOT IN ('summary_wait','summary')) AS media
          FROM navigation.knowledge_documents WHERE user_id=$1 AND worker_id=$2 AND status='processing'`, [uid, workerId]);
        const pipeline = capabilities.pipeline?.version === 1;
        const limits = await readLimits(client, uid);
        if (pipeline ? Number(active.total) >= limits.mediaConcurrency + limits.summaryConcurrency || Number(active.media) >= limits.mediaConcurrency
          : Number(active.total) > 0) return null;
        const { rows: [candidate] } = await client.query(`SELECT d.id,
            coalesce(l.worker_id=$2 AND d.id=ANY($4::text[]) AND d.source_sha256<>'' AND l.sha256=d.source_sha256, false) AS local_input,
            coalesce(nullif(d.source_sha256,''),s.sha256,'') AS source_hash
          FROM navigation.knowledge_documents d
          LEFT JOIN navigation.knowledge_local_inputs l ON l.user_id=d.user_id AND l.document_id=d.id
          LEFT JOIN navigation.knowledge_sources s ON s.user_id=d.user_id AND s.document_id=d.id
          LEFT JOIN navigation.knowledge_imports i ON i.user_id=d.user_id AND i.document_id=d.id
          LEFT JOIN navigation.knowledge_reanalyses r ON r.user_id=d.user_id AND r.document_id=d.id
          WHERE d.user_id=$1 AND d.status='queued' AND d.backend=ANY($3::text[])
            AND NOT coalesce(l.worker_id=$2 AND l.sha256='' AND l.expires>$5,false)
            AND ($6 OR r.state IS DISTINCT FROM 'pending')
            AND (s.document_id IS NULL OR s.state='ready' OR i.state='done' OR (r.state='pending' AND r.mode='reuse')
              OR (l.worker_id=$2 AND d.id=ANY($4::text[]) AND d.source_sha256<>'' AND l.sha256=d.source_sha256))
          ORDER BY d.created_at,d.id LIMIT 1 FOR UPDATE OF d`,
        [uid, workerId, supported, localDocuments, Date.now(), capabilities.reanalysis?.version === 1]);
        if (!candidate) return null;
        const lease = randomBytes(24).toString('hex');
        const { rows: [row] } = await client.query(`UPDATE navigation.knowledge_documents SET
          status='processing',processing_phase=$3,stage='正在转写 · 准备视频素材',progress=1,
          lease=$4,heartbeat=$5,updated_at=$5,worker_id=$6,attempt=attempt+1
          WHERE user_id=$1 AND id=$2 AND status='queued' RETURNING *`,
        [uid, candidate.id, pipeline ? 'media' : '', lease, now(), workerId]);
        return row ? { row, localInput: candidate.local_input, sourceSha256: candidate.source_hash, lease } : null;
      });
    },
    phase(uid, id, lease, phase) {
      if (!['summary_wait', 'summary'].includes(phase)) throw new Error('处理阶段无效');
      return db.transaction(async client => {
        await lockKnowledgeWorkerOwner(client, uid);
        const { rows: [row] } = await client.query(`SELECT worker_id,processing_phase FROM navigation.knowledge_documents
          WHERE user_id=$1 AND id=$2 AND status='processing' AND lease=$3 AND heartbeat>=$4 FOR UPDATE`, [uid, id, lease, expired()]);
        if (!row) throw conflict('任务已过期');
        if (row.processing_phase === phase) return true;
        if (row.processing_phase !== (phase === 'summary_wait' ? 'media' : 'summary_wait')) throw conflict('处理阶段顺序无效');
        if (phase === 'summary') {
          const { rows: [active] } = await client.query(`SELECT count(*) AS total FROM navigation.knowledge_documents
            WHERE user_id=$1 AND worker_id=$2 AND status='processing' AND processing_phase='summary' AND heartbeat>=$3`,
          [uid, row.worker_id, expired()]);
          if (Number(active.total) >= (await readLimits(client, uid)).summaryConcurrency) return false;
        }
        await client.query(`UPDATE navigation.knowledge_documents SET processing_phase=$4,stage=$5,heartbeat=$6,updated_at=$6
          WHERE user_id=$1 AND id=$2 AND lease=$3`, [uid, id, lease, phase, phase === 'summary_wait' ? '等待总结' : '正在总结', now()]);
        return true;
      });
    },
    async progress(uid, id, lease, stage, progress) {
      const result = await db.query(`UPDATE navigation.knowledge_documents SET stage=$4,progress=$5,heartbeat=$6,updated_at=$6
        WHERE user_id=$1 AND id=$2 AND status='processing' AND lease=$3 AND heartbeat>=$7`,
      [uid, id, lease, String(stage || '处理中').slice(0, 100), Math.max(1, Math.min(99, Math.floor(Number(progress) || 1))), now(), expired()]);
      return result.rowCount === 1;
    },
    async leased(uid, id, lease) {
      if (!lease) return false;
      const result = await db.query(`SELECT 1 FROM navigation.knowledge_documents
        WHERE user_id=$1 AND id=$2 AND lease=$3 AND status='processing' AND heartbeat>=$4`, [uid, id, lease, expired()]);
      return result.rowCount === 1;
    },
    finish(uid, id, lease, result) {
      return db.transaction(async client => {
        const { rows: [imported] } = await client.query('SELECT media_json FROM navigation.knowledge_imports WHERE user_id=$1 AND document_id=$2', [uid, id]);
        const provenance = { ...result.provenance, ...(imported ? { sourceMedia: JSON.parse(imported.media_json) } : {}) };
        const { rows: [row] } = await client.query(`UPDATE navigation.knowledge_documents SET
          status='ready',stage='笔记已生成',progress=100,error='',duration=$4,language=$5,notes=$6,transcript_json=$7,
          frames_json=$8,provenance_json=$9,revision=revision+1,lease=NULL,updated_at=$10
          WHERE user_id=$1 AND id=$2 AND lease=$3 AND status='processing' AND heartbeat>=$11 RETURNING *`,
        [uid, id, lease, result.duration, result.language, result.notes, JSON.stringify(result.transcript),
          JSON.stringify(result.frames), JSON.stringify(provenance), now(), expired()]);
        if (!row) return false;
        await syncPostgresKnowledgeCases(client, row);
        await client.query("UPDATE navigation.knowledge_reanalyses SET state='done' WHERE user_id=$1 AND document_id=$2 AND state='pending'", [uid, id]);
        return true;
      });
    },
    async fail(uid, id, lease, error) {
      const result = await db.query(`UPDATE navigation.knowledge_documents SET status='failed',stage='处理失败',
        error=$4,lease=NULL,updated_at=$5 WHERE user_id=$1 AND id=$2 AND lease=$3 AND status='processing' AND heartbeat>=$6`,
      [uid, id, lease, String(error).slice(0, 500), now(), expired()]);
      return result.rowCount === 1;
    },
  };
}
