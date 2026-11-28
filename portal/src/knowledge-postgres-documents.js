import { backendName, metadata, modelSettings, projectKnowledgeDocument } from './knowledge-store.js';
import { pipelineSettings } from './knowledge-pipeline.js';
import { expireKnowledgeLeases } from './knowledge-postgres-leases.js';
import { duplicateSourceError, sourceKey } from './knowledge-source-dedupe.js';
import { findPostgresKnowledgeDuplicate, lockKnowledgeUploadAdmission } from './knowledge-postgres-uploads.js';
import { syncPostgresKnowledgeCases } from './mingli-knowledge-postgres-index.js';

const related = `
  LEFT JOIN navigation.knowledge_imports i ON i.user_id=d.user_id AND i.document_id=d.id
  LEFT JOIN navigation.knowledge_sources s ON s.user_id=d.user_id AND s.document_id=d.id
  LEFT JOIN navigation.knowledge_reanalyses r ON r.user_id=d.user_id AND r.document_id=d.id`;
const relatedFields = `i.state AS import_state,i.media_json,r.run_id,r.mode AS run_mode,r.state AS run_state,
  s.state AS storage_state,s.error AS storage_error,s.verified_at,s.upload_started_at,s.upload_ms,s.verification_started_at,s.verification_ms`;

function read(row) {
  const { storage_state: state, upload_started_at: uploadStarted, verification_started_at: verificationStarted } = row;
  return projectKnowledgeDocument(row, {
    sourceImport: row.import_state ? { state: row.import_state, media_json: row.media_json } : null,
    reanalysis: row.run_id ? { runId: row.run_id, mode: row.run_mode, state: row.run_state } : undefined,
    storage: state ? { provider: '115', state, error: row.storage_error, verifiedAt: row.verified_at,
      timings: {
        uploadMs: state === 'uploading' && Number(uploadStarted) ? Date.now() - Number(uploadStarted) : Number(row.upload_ms),
        verificationMs: state === 'verifying' && Number(verificationStarted) ? Date.now() - Number(verificationStarted) : Number(row.verification_ms),
      },
    } : { provider: 'local', state: 'local' },
  });
}

async function readSettings(client, uid, lock = false) {
  const { rows: [row] } = await client.query('SELECT backend,model_settings_json,pipeline_json FROM navigation.knowledge_settings WHERE user_id=$1' + (lock ? ' FOR UPDATE' : ''), [uid]);
  return { backend: row?.backend || 'codex', ...modelSettings({}, JSON.parse(row?.model_settings_json || '{}')),
    ...pipelineSettings({}, JSON.parse(row?.pipeline_json || '{}')) };
}

export function createPostgresKnowledgeDocuments(db) {
  async function get(uid, id, client = db) {
    const { rows: [row] } = await client.query(`SELECT d.*,${relatedFields} FROM navigation.knowledge_documents d ${related}
      WHERE d.user_id=$1 AND d.id=$2 AND d.status<>'deleting'`, [uid, id]);
    return row ? read(row) : null;
  }

  return {
    settings: uid => readSettings(db, uid),
    saveSettings(uid, raw) {
      const input = typeof raw === 'string' ? { backend: raw } : raw;
      return db.transaction(async client => {
        await client.query('INSERT INTO navigation.knowledge_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING', [uid]);
        const previous = await readSettings(client, uid, true), backend = backendName(input.backend || previous.backend);
        const { rows: [stored] } = await client.query('SELECT model_settings_json FROM navigation.knowledge_settings WHERE user_id=$1', [uid]);
        const models = modelSettings(input, previous), pipeline = pipelineSettings(input, previous);
        await client.query('UPDATE navigation.knowledge_settings SET backend=$2,model_settings_json=$3,pipeline_json=$4 WHERE user_id=$1',
          [uid, backend, JSON.stringify({ ...JSON.parse(stored.model_settings_json || '{}'), ...models }), JSON.stringify(pipeline)]);
        return { backend, ...models, ...pipeline };
      });
    },
    get,
    edit(uid, id, raw) {
      const fields = metadata(raw);
      return db.transaction(async client => {
        await lockKnowledgeUploadAdmission(client);
        const { rows: [previous] } = await client.query(`SELECT d.source_url,d.notes,d.revision,d.status,r.state AS reanalysis_state
          FROM navigation.knowledge_documents d LEFT JOIN navigation.knowledge_reanalyses r ON r.user_id=d.user_id AND r.document_id=d.id
          WHERE d.user_id=$1 AND d.id=$2 AND d.status<>'deleting' FOR UPDATE OF d`, [uid, id]);
        if (!previous) return null;
        if (previous.status === 'processing' || previous.status === 'queued' && previous.reanalysis_state === 'pending') {
          throw Object.assign(new Error('请等待当前任务完成后编辑'), { status: 409 });
        }
        if (Number(previous.revision) !== Number(raw.revision)) throw Object.assign(new Error('笔记已更新，请重新打开后再保存'), { status: 409 });
        const notes = String(raw.notes ?? previous.notes);
        if (notes.length > 500000) throw new Error('笔记不超过50万字');
        if (sourceKey(fields.sourceUrl) !== sourceKey(previous.source_url)) {
          const duplicate = await findPostgresKnowledgeDuplicate(client, uid, fields.sourceUrl, { exceptDocument: id });
          if (duplicate) throw duplicateSourceError(duplicate);
        }
        const { rows: [row] } = await client.query(`UPDATE navigation.knowledge_documents SET title=$3,topic=$4,tags_json=$5,
          source_url=$6,notes=$7,revision=revision+1,updated_at=$8 WHERE user_id=$1 AND id=$2 RETURNING *`,
        [uid, id, fields.title, fields.topic, JSON.stringify(fields.tags), fields.sourceUrl, notes, new Date().toISOString()]);
        await syncPostgresKnowledgeCases(client, row);
        return get(uid, id, client);
      });
    },
    async list(uid, { search = '', topic = '', status = '', offset = 0, limit = 30, includeTranscript = true } = {}) {
      await expireKnowledgeLeases(db, uid);
      return db.transaction(async client => {
        const pattern = '%' + String(search).slice(0, 120).replace(/[A-Z]/g, letter => letter.toLowerCase()).replace(/[!%_]/g, '!$&') + '%';
        const searchFields = ['title', 'notes', 'tags_json', ...(includeTranscript ? ['transcript_json'] : [])];
        const where = `d.user_id=$1 AND d.status<>'deleting' AND ($3='' OR d.topic=$3)
          AND (${searchFields.map(field => `translate(d.${field},'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') LIKE $2 ESCAPE '!'`).join(' OR ')})`;
        const params = [uid, pattern, String(topic).slice(0, 60)];
        const counts = await client.query(`SELECT d.status,count(*) AS count FROM navigation.knowledge_documents d
          WHERE ${where} GROUP BY d.status`, params);
        const statusCounts = Object.fromEntries(counts.rows.map(row => [row.status, Number(row.count)]));
        const total = status ? statusCounts[status] || 0 : Object.values(statusCounts).reduce((sum, n) => sum + n, 0);
        const { rows } = await client.query(`SELECT d.id,d.title,d.topic,d.tags_json,d.source_url,d.visibility,d.original_name,d.byte_size,
          d.mime_type,d.fingerprint,d.backend,d.model_settings_json,d.status,d.stage,d.processing_phase,d.progress,d.error,d.duration,d.language,
          substr(d.notes,1,240) AS notes,'[]' AS transcript_json,'[]' AS frames_json,d.provenance_json,d.revision,d.attempt,d.created_at,d.updated_at,
          jsonb_array_length(d.frames_json::jsonb) AS frame_count,jsonb_array_length(d.transcript_json::jsonb) AS segment_count,${relatedFields}
          FROM navigation.knowledge_documents d ${related} WHERE ${where} AND ($4='' OR d.status=$4)
          ORDER BY d.updated_at DESC,d.id LIMIT $5 OFFSET $6`, [...params, status, limit, offset]);
        const documents = rows.map(row => {
          const { notes, transcript, frames, ...document } = read(row);
          return { ...document, preview: notes.replace(/[#*`>]/g, '').slice(0, 180), frameCount: row.frame_count, segmentCount: row.segment_count };
        });
        const topics = await client.query(`SELECT topic,count(*) AS count FROM navigation.knowledge_documents
          WHERE user_id=$1 AND topic<>'' GROUP BY topic ORDER BY topic COLLATE "C"`, [uid]);
        return { documents, total, offset, limit, topics: topics.rows.map(row => ({ ...row, count: Number(row.count) })), statusCounts };
      }, { readOnly: true });
    },
  };
}
