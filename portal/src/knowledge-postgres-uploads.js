import { randomBytes } from 'node:crypto';
import { assertUploadDiskSpace, CHUNK_BYTES, MAX_VIDEO_BYTES, projectKnowledgeDocument, uploadInput } from './knowledge-store.js';
import { sourcePath } from './knowledge-storage.js';
import { duplicateSourceError, sourceKey } from './knowledge-source-dedupe.js';

const capacityError = () => Object.assign(new Error('已有5个待处理任务，请等待空闲位置'), { code: 'KNOWLEDGE_CAPACITY', status: 409 });

// Booking both disks and worker slots happens in the same transaction. A batch
// importer must take this same lock before reserving a slot for a resolving link.
export async function lockKnowledgeUploadAdmission(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('knowledge:upload-admission', 0))");
}

export async function findPostgresKnowledgeDuplicate(client, uid, link, { exceptDocument = '', exceptQueue = '', includeQueue = true } = {}) {
  const key = sourceKey(link);
  if (!key) return null;
  const documents = await client.query(`SELECT d.id AS document_id,d.title,d.status,d.source_url,i.url AS import_url
    FROM navigation.knowledge_documents d LEFT JOIN navigation.knowledge_imports i ON i.document_id=d.id AND i.user_id=d.user_id
    WHERE d.user_id=$1 AND d.id<>$2 AND d.status<>'deleting'
    ORDER BY CASE d.status WHEN 'ready' THEN 0 ELSE 1 END,d.created_at,d.id`, [uid, exceptDocument]);
  const document = documents.rows.find(row => sourceKey(row.source_url) === key || sourceKey(row.import_url) === key);
  if (document || !includeQueue) return document || null;
  const queue = await client.query(`SELECT q.id AS queue_id,q.document_id,q.title,q.url,q.state AS status
    FROM navigation.knowledge_upload_queue q LEFT JOIN navigation.knowledge_documents d ON d.id=q.document_id AND d.user_id=q.user_id
    WHERE q.user_id=$1 AND q.id<>$2 AND ($3='' OR q.document_id<>$3)
      AND (q.state IN ('pending','resolving') OR q.state='submitted' AND d.id IS NOT NULL AND d.status<>'deleting')
    ORDER BY q.seq`, [uid, exceptQueue, exceptDocument]);
  return queue.rows.find(row => sourceKey(row.url) === key) || null;
}

async function readParts(client, id) {
  const { rows } = await client.query('SELECT part,bytes FROM navigation.knowledge_parts WHERE document_id=$1 ORDER BY part', [id]);
  return rows.map(row => ({ part: Number(row.part), bytes: Number(row.bytes) }));
}

export async function reservePostgresKnowledgeUpload(client, uid, input, config, availableBytes, linkImport, queueId = '') {
  if (!Number.isFinite(availableBytes) || availableBytes < 0) throw new Error('服务器可用空间无法确定');
  await lockKnowledgeUploadAdmission(client);
  const { rows: [settings] } = await client.query('SELECT backend,model_settings_json FROM navigation.knowledge_settings WHERE user_id=$1', [uid]);
  const document = uploadInput(input, { backend: settings?.backend || 'codex', ...JSON.parse(settings?.model_settings_json || '{}') });
  for (const url of new Set([document.sourceUrl, linkImport?.url].filter(Boolean))) {
    const duplicate = await findPostgresKnowledgeDuplicate(client, uid, url, { exceptQueue: queueId });
    if (duplicate) throw duplicateSourceError(duplicate);
  }
  const { rows: [quotas] } = await client.query(`SELECT
      count(*) FILTER (WHERE user_id=$1) AS notes,
      coalesce(sum(byte_size) FILTER (WHERE user_id=$1),0) AS owner_bytes,
      coalesce(sum(byte_size) FILTER (WHERE status IN ('uploading','importing')),0) AS reserved,
      count(*) FILTER (WHERE user_id=$1 AND status IN ('uploading','importing','queued','processing'))
        + (SELECT count(*) FROM navigation.knowledge_upload_queue
          WHERE user_id=$1 AND state='resolving' AND expires>=$2 AND id<>$3) AS pending
    FROM navigation.knowledge_documents`, [uid, Date.now(), queueId]);
  assertUploadDiskSpace(document.bytes, Number(quotas.reserved), availableBytes);
  if (Number(quotas.pending) >= 5) throw capacityError();
  if (Number(quotas.notes) >= 2000) throw new Error('最多2000篇笔记，请先清理已有内容');
  if (!config && Number(quotas.owner_bytes) + document.bytes > 20 * MAX_VIDEO_BYTES) throw new Error('服务器存储最多20GB视频，请先清理已有内容');
  const id = randomBytes(16).toString('hex'), time = new Date().toISOString();
  const { rows: [saved] } = await client.query(`INSERT INTO navigation.knowledge_documents
    (id,user_id,title,topic,tags_json,source_url,original_name,byte_size,mime_type,fingerprint,backend,model_settings_json,status,stage,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`, [
    id, uid, document.title, document.topic, JSON.stringify(document.tags), document.sourceUrl, document.originalName,
    document.bytes, document.mimeType, document.fingerprint, document.backend, JSON.stringify(linkImport?.selection?.modelSettings || document.modelSettings),
    linkImport ? 'importing' : 'uploading', linkImport ? '等待下载B站视频' : '等待上传', time,
  ]);
  if (config) await client.query('INSERT INTO navigation.knowledge_sources(document_id,user_id,object_path) VALUES($1,$2,$3)',
    [id, uid, sourcePath(config, uid, { id, mimeType: document.mimeType })]);
  if (linkImport) await client.query(`INSERT INTO navigation.knowledge_imports(document_id,user_id,url,created_at,settings_json)
    VALUES($1,$2,$3,$4,$5)`, [id, uid, linkImport.url, Date.now(), JSON.stringify(linkImport.selection)]);
  return projectKnowledgeDocument(saved, {
    sourceImport: linkImport ? { state: 'pending' } : null,
    storage: config ? { provider: '115', state: 'waiting', error: '', verifiedAt: null, timings: { uploadMs: 0, verificationMs: 0 } }
      : { provider: 'local', state: 'local' },
  });
}

export function createPostgresKnowledgeUploads(db) {
  function create(uid, input, config, availableBytes, linkImport) {
    return db.transaction(client => reservePostgresKnowledgeUpload(client, uid, input, config, availableBytes, linkImport));
  }

  return {
    duplicateSource(uid, input, options) { return findPostgresKnowledgeDuplicate(db, uid, input, options); },
    createUpload(uid, input, config, availableBytes) { return create(uid, input, config, availableBytes); },
    createLinkImport(uid, input, url, selection, config, availableBytes) {
      return create(uid, input, config, availableBytes, { url, selection });
    },
    parts(uid, id) {
      return db.transaction(async client => {
        const owned = await client.query('SELECT 1 FROM navigation.knowledge_documents WHERE user_id=$1 AND id=$2', [uid, id]);
        return owned.rowCount ? readParts(client, id) : null;
      }, { readOnly: true });
    },
    part(uid, id, number, bytes) {
      return db.transaction(async client => {
        const { rows: [row] } = await client.query(`SELECT byte_size FROM navigation.knowledge_documents
          WHERE user_id=$1 AND id=$2 AND status='uploading' FOR UPDATE`, [uid, id]);
        if (!row) throw new Error('上传任务已结束');
        const size = Number(row.byte_size), count = Math.ceil(size / CHUNK_BYTES);
        if (!Number.isSafeInteger(number) || number < 1 || number > count) throw new Error('分片编号或上传状态无效');
        if (bytes !== Math.min(CHUNK_BYTES, size - (number - 1) * CHUNK_BYTES)) throw new Error('分片大小不符');
        await client.query(`INSERT INTO navigation.knowledge_parts(document_id,part,bytes) VALUES($1,$2,$3)
          ON CONFLICT(document_id,part) DO UPDATE SET bytes=excluded.bytes`, [id, number, bytes]);
        await client.query(`UPDATE navigation.knowledge_documents SET progress=(
          SELECT floor(sum(bytes)::numeric*100/byte_size) FROM navigation.knowledge_parts WHERE document_id=$2
        ),updated_at=$3 WHERE user_id=$1 AND id=$2`, [uid, id, new Date().toISOString()]);
      });
    },
    enqueue(uid, id, sha256) {
      if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('视频校验值无效');
      return db.transaction(async client => {
        const { rows: [doc] } = await client.query(`SELECT byte_size FROM navigation.knowledge_documents
          WHERE user_id=$1 AND id=$2 AND status='uploading' FOR UPDATE`, [uid, id]);
        if (!doc) return false;
        const parts = await readParts(client, id), size = Number(doc.byte_size);
        if (parts.length !== Math.ceil(size / CHUNK_BYTES) ||
            parts.some(({ part, bytes }, i) => part !== i + 1 || bytes !== Math.min(CHUNK_BYTES, size - i * CHUNK_BYTES))) {
          throw new Error('视频尚未上传完整');
        }
        await client.query(`UPDATE navigation.knowledge_documents SET status='queued',stage=CASE WHEN backend='gemini' THEN '等待 Gemini' ELSE '等待GPU工作器' END,progress=0,
          source_sha256=$3,updated_at=$4 WHERE user_id=$1 AND id=$2`, [uid, id, sha256, new Date().toISOString()]);
        await client.query(`UPDATE navigation.knowledge_sources SET state='pending'
          WHERE user_id=$1 AND document_id=$2 AND state='waiting'`, [uid, id]);
        return true;
      });
    },
  };
}
