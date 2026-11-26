import { bilibiliAccount, qualitySettings } from './knowledge-bilibili-account.js';
import { createPostgresKnowledgeBatch } from './knowledge-postgres-batch.js';
import { createPostgresKnowledgeDocuments } from './knowledge-postgres-documents.js';
import { createPostgresKnowledgeImports } from './knowledge-postgres-imports.js';
import { expireKnowledgeLeases } from './knowledge-postgres-leases.js';
import { createPostgresKnowledgeUploads, lockKnowledgeUploadAdmission } from './knowledge-postgres-uploads.js';
import { createPostgresKnowledgeWorker } from './knowledge-postgres-worker.js';
import { backendName, modelSettings } from './knowledge-store.js';

const stores = new WeakMap();
const dependents = ['mingli_knowledge_cases', 'mingli_knowledge_index', 'knowledge_sources', 'knowledge_reanalyses',
  'knowledge_note_versions', 'knowledge_local_inputs', 'knowledge_imports', 'knowledge_codex_calls'];

export function createPostgresKnowledgeStore(db) {
  if (stores.has(db)) return stores.get(db);
  const store = {
    ...createPostgresKnowledgeWorker(db),
    ...createPostgresKnowledgeDocuments(db),
    ...createPostgresKnowledgeUploads(db),
    queue: createPostgresKnowledgeBatch(db),
    imports: createPostgresKnowledgeImports(db),
    expire: uid => expireKnowledgeLeases(db, uid),
    async failedDocuments(uid) {
      const { rows } = await db.query("SELECT id FROM navigation.knowledge_documents WHERE user_id=$1 AND status='failed' ORDER BY created_at,id", [uid]);
      return rows;
    },
    async retry(uid, id, can, input) {
      const linkDefaults = await bilibiliAccount(db).public(uid);
      return db.transaction(async client => {
        await lockKnowledgeUploadAdmission(client);
        const { rows: [doc] } = await client.query(`SELECT id FROM navigation.knowledge_documents
          WHERE user_id=$1 AND id=$2 AND status='failed' FOR UPDATE`, [uid, id]);
        if (!doc) return false;
        const { rows: [imported] } = await client.query('SELECT state FROM navigation.knowledge_imports WHERE user_id=$1 AND document_id=$2 FOR UPDATE', [uid, id]);
        const link = imported?.state === 'failed';
        if (link && (!can('import:edit') || !can('upload:edit'))) throw Object.assign(new Error('重新下载视频需要链接导入和上传权限'), { status: 403 });
        if (link) {
          const { rows: [capacity] } = await client.query(`SELECT (SELECT count(*) FROM navigation.knowledge_documents
            WHERE user_id=$1 AND status IN ('importing','uploading','queued','processing'))
            + (SELECT count(*) FROM navigation.knowledge_upload_queue WHERE user_id=$1 AND state='resolving' AND expires>=$2) AS n`, [uid, Date.now()]);
          if (Number(capacity.n) >= 5) throw new Error('最多5个待处理任务，请等待已有任务完成');
          await client.query(`UPDATE navigation.knowledge_imports SET state='pending',lease=NULL,settings_json=$3
            WHERE user_id=$1 AND document_id=$2`, [uid, id, JSON.stringify(qualitySettings(input, linkDefaults))]);
        }
        const { rows: [settings] } = await client.query('SELECT backend,model_settings_json FROM navigation.knowledge_settings WHERE user_id=$1', [uid]);
        const backend = backendName(input.backend || settings?.backend || 'codex');
        await client.query(`UPDATE navigation.knowledge_documents SET status=$3,stage=$4,backend=$5,
          model_settings_json=$6,progress=0,error='',lease=NULL,updated_at=$7 WHERE user_id=$1 AND id=$2`,
        [uid, id, link ? 'importing' : 'queued', link ? '等待下载B站视频' : '等待GPU工作器', backend,
          JSON.stringify(modelSettings({}, JSON.parse(settings?.model_settings_json || '{}'))), new Date().toISOString()]);
        return true;
      });
    },
    remove(uid, id, archiveLease) {
      return db.transaction(async client => {
        const { rows: [doc] } = await client.query('SELECT status FROM navigation.knowledge_documents WHERE user_id=$1 AND id=$2 FOR UPDATE', [uid, id]);
        if (!doc) return false;
        const { rows: [source] } = await client.query('SELECT lease,state FROM navigation.knowledge_sources WHERE user_id=$1 AND document_id=$2 FOR UPDATE', [uid, id]);
        const unstarted = doc.status === 'uploading' && source?.state === 'waiting' && !source.lease;
        if (source && !unstarted && (!archiveLease || source.state !== 'deleting' || source.lease !== archiveLease)) return false;
        const { rows: [imported] } = await client.query('SELECT state,heartbeat FROM navigation.knowledge_imports WHERE user_id=$1 AND document_id=$2 FOR UPDATE', [uid, id]);
        if (imported?.state === 'downloading' && Number(imported.heartbeat) > Date.now() - 120000) {
          throw Object.assign(new Error('视频正在下载，请等待下载完成或失败后删除'), { status: 409 });
        }
        for (const table of dependents) await client.query('DELETE FROM navigation.' + table + ' WHERE user_id=$1 AND document_id=$2', [uid, id]);
        await client.query('DELETE FROM navigation.knowledge_parts WHERE document_id=$1', [id]);
        await client.query('DELETE FROM navigation.knowledge_documents WHERE user_id=$1 AND id=$2', [uid, id]);
        return true;
      });
    },
  };
  stores.set(db, store);
  return store;
}
