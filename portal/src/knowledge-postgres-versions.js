import { randomBytes } from 'node:crypto';
import { activeKnowledgeStates, knowledgeSnapshot, knowledgeVersion } from './knowledge-reanalysis-store.js';
import { lockKnowledgeUploadAdmission } from './knowledge-postgres-uploads.js';
import { syncPostgresKnowledgeCases } from './mingli-knowledge-postgres-index.js';

const error = (status, message) => Object.assign(new Error(message), { status });
const newId = () => randomBytes(16).toString('hex');
const now = () => new Date().toISOString();

async function lockedDocument(client, uid, id) {
  const { rows: [row] } = await client.query('SELECT * FROM navigation.knowledge_documents WHERE user_id=$1 AND id=$2 FOR UPDATE', [uid, id]);
  return row;
}

async function snapshot(client, row) {
  await client.query(`INSERT INTO navigation.knowledge_note_versions(id,user_id,document_id,snapshot_json,created_at)
    VALUES($1,$2,$3,$4,$5)`, [newId(), row.user_id, row.id, JSON.stringify(knowledgeSnapshot(row)), now()]);
  await client.query(`DELETE FROM navigation.knowledge_note_versions WHERE user_id=$1 AND document_id=$2
    AND id IN (SELECT id FROM navigation.knowledge_note_versions WHERE user_id=$1 AND document_id=$2
      ORDER BY created_at DESC,_sqlite_rowid DESC OFFSET 10)`, [row.user_id, row.id]);
}

export function createPostgresKnowledgeVersions(db) {
  return {
    async get(uid, id) {
      const { rows: [row] } = await db.query(`SELECT run_id AS "runId",mode,state FROM navigation.knowledge_reanalyses
        WHERE user_id=$1 AND document_id=$2`, [uid, id]);
      return row;
    },
    async list(uid, id) {
      const { rows } = await db.query(`SELECT id,snapshot_json,created_at FROM navigation.knowledge_note_versions
        WHERE user_id=$1 AND document_id=$2 ORDER BY created_at DESC,_sqlite_rowid DESC`, [uid, id]);
      return rows.map(knowledgeVersion);
    },
    schedule(uid, id, revision, mode, settings) {
      return db.transaction(async client => {
        await lockKnowledgeUploadAdmission(client);
        const row = await lockedDocument(client, uid, id);
        if (!row || !['ready', 'failed'].includes(row.status) || !row.notes || Number(row.revision) !== revision) {
          throw error(409, '笔记不存在、已更新或正在处理中，请刷新后重试');
        }
        if (!['reuse', 'full'].includes(mode)) throw new Error('重新分析方式无效');
        if (mode === 'reuse' && (!row.duration || !JSON.parse(row.transcript_json).length && !JSON.parse(row.frames_json).length)) {
          throw new Error('没有可复用的转写或关键画面，请选择重新提取原视频');
        }
        await snapshot(client, row);
        const runId = newId();
        await client.query(`INSERT INTO navigation.knowledge_reanalyses(document_id,user_id,run_id,mode,state) VALUES($2,$1,$3,$4,'pending')
          ON CONFLICT(document_id) DO UPDATE SET run_id=excluded.run_id,mode=excluded.mode,state=excluded.state`, [uid, id, runId, mode]);
        await client.query(`UPDATE navigation.knowledge_documents SET status='queued',stage=$3,backend=$4,
          model_settings_json=$5,error='',lease=NULL,worker_id='',processing_phase='',progress=0,revision=revision+1,updated_at=$6
          WHERE user_id=$1 AND id=$2`, [
          uid, id, mode === 'reuse' ? '等待GPU工作器重新分析 · 复用转写与画面' : '等待GPU工作器重新提取原视频',
          settings.backend, JSON.stringify(settings), now(),
        ]);
        return runId;
      });
    },
    restore(uid, id, versionId, revision) {
      return db.transaction(async client => {
        const current = await lockedDocument(client, uid, id);
        const { rows: [version] } = await client.query(`SELECT snapshot_json FROM navigation.knowledge_note_versions
          WHERE user_id=$1 AND document_id=$2 AND id=$3`, [uid, id, versionId]);
        if (!current || !version) throw error(404, '笔记或历史版本不存在');
        if (activeKnowledgeStates.includes(current.status) || Number(current.revision) !== revision) {
          throw error(409, '笔记正在处理或已更新，请刷新后再恢复');
        }
        const saved = JSON.parse(version.snapshot_json);
        await snapshot(client, current);
        const { rows: [row] } = await client.query(`UPDATE navigation.knowledge_documents
          SET notes=$3,transcript_json=$4,frames_json=$5,provenance_json=$6,duration=$7,language=$8,status='ready',
            stage='已恢复历史版本',error='',progress=100,lease=NULL,worker_id='',processing_phase='',revision=revision+1,updated_at=$9
          WHERE user_id=$1 AND id=$2 RETURNING *`, [
          uid, id, saved.notes, saved.transcript_json, saved.frames_json, saved.provenance_json, saved.duration, saved.language, now(),
        ]);
        await client.query("UPDATE navigation.knowledge_reanalyses SET state='restored' WHERE user_id=$1 AND document_id=$2", [uid, id]);
        await syncPostgresKnowledgeCases(client, row);
      });
    },
  };
}
