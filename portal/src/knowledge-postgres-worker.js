import { createPostgresKnowledgeCodexCalls } from './knowledge-codex-calls.js';
import { createPostgresKnowledgeDeviceStore } from './knowledge-devices.js';
import { createPostgresKnowledgeLocalInputs } from './knowledge-local-store.js';
import { createPostgresKnowledgeDocuments } from './knowledge-postgres-documents.js';
import { createPostgresKnowledgeLeases, lockKnowledgeWorkerOwner } from './knowledge-postgres-leases.js';
import { createPostgresKnowledgeSourceStore } from './knowledge-source-store.js';
import { createPostgresKnowledgeVersions } from './knowledge-postgres-versions.js';
import { hashToken, knowledgeWorkerHeartbeat } from './knowledge-store.js';

export function createPostgresKnowledgeWorker(db) {
  const devices = createPostgresKnowledgeDeviceStore(db);
  const documents = createPostgresKnowledgeDocuments(db);
  const leases = createPostgresKnowledgeLeases(db);
  return {
    ...leases,
    get: documents.get,
    settings: documents.settings,
    devices,
    sources: createPostgresKnowledgeSourceStore(db),
    localInputs: createPostgresKnowledgeLocalInputs(db),
    reanalysis: createPostgresKnowledgeVersions(db),
    codexCalls: createPostgresKnowledgeCodexCalls(db),
    async getRow(uid, id) {
      const { rows: [row] } = await db.query('SELECT * FROM navigation.knowledge_documents WHERE user_id=$1 AND id=$2', [uid, id]);
      return row;
    },
    async workerUser(token) {
      const { rows: [row] } = await db.query('SELECT user_id FROM navigation.knowledge_workers WHERE token_hash=$1', [hashToken(token)]);
      return row?.user_id || null;
    },
    heartbeatWorker(uid, input, token, device) {
      const { workerId, capabilities, label, time } = knowledgeWorkerHeartbeat(input);
      return db.transaction(async client => {
        await lockKnowledgeWorkerOwner(client, uid);
        const hash = hashToken(token);
        const active = device ? await client.query(`SELECT 1 FROM navigation.knowledge_worker_devices
          WHERE user_id=$1 AND id=$2 AND token_hash=$3 AND revoked_at IS NULL`, [uid, workerId, hash])
          : await client.query('SELECT 1 FROM navigation.knowledge_workers WHERE user_id=$1 AND token_hash=$2', [uid, hash]);
        if (!active.rowCount) return false;
        await client.query('UPDATE navigation.knowledge_workers SET last_seen=$2,label=$3,capabilities_json=$4 WHERE user_id=$1',
          [uid, time, label, capabilities]);
        await client.query(`INSERT INTO navigation.knowledge_worker_instances(user_id,worker_id,last_seen,label,capabilities_json)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,worker_id) DO UPDATE SET last_seen=excluded.last_seen,label=excluded.label,
          capabilities_json=excluded.capabilities_json`, [uid, workerId, time, label, capabilities]);
        await client.query('DELETE FROM navigation.knowledge_worker_instances WHERE user_id=$1 AND last_seen<$2',
          [uid, new Date(Date.now() - 7 * 86400000).toISOString()]);
        return true;
      });
    },
    async claim(uid, backends, workerId, localDocuments) {
      const claim = await leases.claim(uid, backends, workerId, localDocuments);
      if (!claim) return null;
      const document = await documents.get(uid, claim.row.id);
      return document && { ...document, localInput: claim.localInput, sourceSha256: claim.sourceSha256, lease: claim.lease };
    },
  };
}
