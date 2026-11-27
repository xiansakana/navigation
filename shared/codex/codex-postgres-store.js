import crypto from 'node:crypto';
import { createPostgresCodexQueue } from './codex-postgres-queue.js';
import { createPostgresCodexConversations } from './codex-postgres-conversations.js';
import { createPostgresCodexTodos } from './codex-postgres-todos.js';
import { postgresCodexScope } from './codex-postgres-scope.js';
import { validateAttachments, mergeAttachments } from './codex-media.js';

const PENDING_ATTACHMENT_WINDOW = 30 * 60000;

function outboxRow(row) {
  if (!row) return undefined;
  return { ...row, id: Number(row.id), full_result: Number(row.full_result), created_at: Number(row.created_at), next_attempt: Number(row.next_attempt) };
}

export function createPostgresCodexStore(db, { formatReply = message => [String(message)] } = {}) {
  const scope = postgresCodexScope(db);
  const queue = createPostgresCodexQueue(db, { formatReply });
  const conversations = createPostgresCodexConversations(db, { queue });
  const todos = createPostgresCodexTodos(db, { conversations });

  async function settingsFor(uid) {
    const { rows: [row] } = await scope.client().query('SELECT groups_json,group_reply FROM navigation.qq_codex_settings WHERE user_id=$1', [uid]);
    return row ? { groups: JSON.parse(row.groups_json), groupReply: row.group_reply } : { groups: [], groupReply: 'private' };
  }

  async function runtimeFor(uid, group = '') {
    const { rows: [row] } = await scope.client().query('SELECT model,effort FROM navigation.qq_codex_runtime_preferences WHERE user_id=$1 AND group_id=$2', [uid, group]);
    return row ? { model: row.model, effort: row.effort } : { model: '', effort: '' };
  }

  async function attachmentsFor(uid, group = '') {
    const { rows: [row] } = await scope.client().query('SELECT attachments_json FROM navigation.qq_codex_pending_files WHERE user_id=$1 AND group_id=$2 AND created_at>$3',
      [uid, group, Date.now() - PENDING_ATTACHMENT_WINDOW]);
    return row ? JSON.parse(row.attachments_json) : [];
  }

  async function clearAttachmentReception(uid, group) {
    await scope.client().query('DELETE FROM navigation.qq_codex_attachment_receptions WHERE user_id=$1 AND group_id=$2', [uid, group]);
  }

  async function clearAttachmentsFor(uid, group = '') {
    await clearAttachmentReception(uid, group);
    await scope.client().query('DELETE FROM navigation.qq_codex_pending_files WHERE user_id=$1 AND group_id=$2', [uid, group]);
  }

  async function saveSession(uid, project, group, value) {
    if (group) {
      await scope.client().query(`INSERT INTO navigation.qq_codex_group_sessions(user_id,project,group_id,session_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,project,group_id) DO UPDATE SET session_id=excluded.session_id`, [uid, project, group, value]);
    } else {
      await scope.client().query(`INSERT INTO navigation.qq_codex_sessions(user_id,project,session_id) VALUES($1,$2,$3)
        ON CONFLICT(user_id,project) DO UPDATE SET session_id=excluded.session_id`, [uid, project, value]);
    }
  }

  return {
    conversations,
    todos,

    async hasActiveJobs(includeQQ = true) {
      const { rowCount } = await scope.client().query(`SELECT 1 FROM navigation.qq_codex_jobs
        WHERE state='running' OR (state='queued' AND ${includeQQ ? 'TRUE' : "origin='web'"}) LIMIT 1`);
      return rowCount > 0;
    },

    runtime: runtimeFor,
    async saveRuntime(uid, group, values) {
      if (!values || typeof values.model !== 'string' || typeof values.effort !== 'string' || values.model.length > 120 || values.effort.length > 24) throw new Error('模型设置格式无效');
      await scope.client().query(`INSERT INTO navigation.qq_codex_runtime_preferences(user_id,group_id,model,effort,updated_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id,group_id) DO UPDATE SET model=excluded.model,effort=excluded.effort,updated_at=excluded.updated_at`,
      [uid, group, values.model, values.effort, Date.now()]);
      return runtimeFor(uid, group);
    },
    async recordRuntime(job, values) {
      const result = await scope.client().query("UPDATE navigation.qq_codex_jobs SET runtime_json=$3 WHERE id=$1 AND user_id=$2 AND state='running'",
        [job.id, job.user_id, JSON.stringify(values)]);
      return result.rowCount === 1;
    },

    settings: settingsFor,
    async saveSettings(uid, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式无效');
      if (!Array.isArray(input.groups) || input.groups.length > 20 || input.groups.some(g => typeof g !== 'string' || !/^\d{5,20}$/.test(g))) throw new Error('最多20个群号，每个群号需为5—20位数字');
      if (!['private', 'group'].includes(input.groupReply)) throw new Error('请选择有效的结果发送方式');
      await scope.client().query(`INSERT INTO navigation.qq_codex_settings(user_id,groups_json,group_reply) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET groups_json=excluded.groups_json,group_reply=excluded.group_reply`,
      [uid, JSON.stringify([...new Set(input.groups)]), input.groupReply]);
      return settingsFor(uid);
    },

    transaction(run) { return scope.run(run); },

    async armAttachments(uid, group) {
      const now = Date.now(), client = scope.client();
      await client.query('DELETE FROM navigation.qq_codex_attachment_receptions WHERE expires_at<=$1', [now]);
      await client.query(`INSERT INTO navigation.qq_codex_attachment_receptions(user_id,group_id,armed_at,expires_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,group_id) DO UPDATE SET armed_at=excluded.armed_at,expires_at=excluded.expires_at`, [uid, group, now, now + 120000]);
    },
    async attachmentReception(uid, group, sentAt = 0) {
      const { rowCount } = await scope.client().query(`SELECT 1 FROM navigation.qq_codex_attachment_receptions
        WHERE user_id=$1 AND group_id=$2 AND expires_at>$3 AND ($4::bigint=0 OR armed_at<=$4::bigint+1000)`, [uid, group, Date.now(), sentAt]);
      return rowCount > 0;
    },
    clearAttachmentReception,

    attachments: attachmentsFor,
    stageAttachments(uid, group, items) {
      return scope.run(async client => {
        const all = mergeAttachments(await attachmentsFor(uid, group), items);
        await client.query(`INSERT INTO navigation.qq_codex_pending_files(user_id,group_id,attachments_json,created_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(user_id,group_id) DO UPDATE SET attachments_json=excluded.attachments_json,created_at=excluded.created_at`,
        [uid, group, JSON.stringify(all), Date.now()]);
        return all;
      });
    },
    async clearAttachments(uid, group = '') {
      await clearAttachmentsFor(uid, group);
    },

    event(key) {
      return scope.run(async client => {
        const existing = await client.query('SELECT 1 FROM navigation.qq_codex_jobs WHERE event_key=$1 LIMIT 1', [key]);
        if (existing.rowCount) return false;
        await client.query('DELETE FROM navigation.qq_codex_events WHERE created_at<$1', [Date.now() - 7 * 86400000]);
        const inserted = await client.query('INSERT INTO navigation.qq_codex_events(event_key,created_at) VALUES($1,$2) ON CONFLICT(event_key) DO NOTHING', [key, Date.now()]);
        return inserted.rowCount > 0;
      });
    },

    enqueue: queue.enqueueQQ,
    claim: queue.claim,
    finish: queue.finish,
    cancel: queue.cancelQQ,

    async active(uid, group = '') {
      const { rows } = await scope.client().query(`SELECT id,project,state,created_at,commit_sha,runtime_json FROM navigation.qq_codex_jobs
        WHERE user_id=$1 AND group_id=$2 AND origin='qq' ORDER BY state IN ('queued','running') DESC,created_at DESC,_sqlite_rowid DESC LIMIT 5`, [uid, group]);
      return rows.map(row => ({ ...row, created_at: Number(row.created_at) }));
    },
    async latestResult(uid, group = '') {
      const { rows: [row] } = await scope.client().query(`SELECT result FROM navigation.qq_codex_jobs
        WHERE user_id=$1 AND group_id=$2 AND origin='qq' AND result<>'' ORDER BY created_at DESC,_sqlite_rowid DESC LIMIT 1`, [uid, group]);
      return row?.result;
    },
    async latestArtifacts(uid, group = '') {
      const { rows: [row] } = await scope.client().query(`SELECT artifacts_json FROM navigation.qq_codex_jobs
        WHERE user_id=$1 AND group_id=$2 AND origin='qq' AND result<>'' ORDER BY created_at DESC,_sqlite_rowid DESC LIMIT 1`, [uid, group]);
      return row ? JSON.parse(row.artifacts_json) : [];
    },

    async touch(id) {
      const { rowCount } = await scope.client().query("UPDATE navigation.qq_codex_jobs SET heartbeat=$2 WHERE id=$1 AND state='running'", [id, Date.now()]);
      return rowCount > 0;
    },
    async cancelled(id) {
      const { rows: [row] } = await scope.client().query('SELECT cancel FROM navigation.qq_codex_jobs WHERE id=$1', [id]);
      return Number(row?.cancel || 0) !== 0;
    },

    async session(uid, project, group = '') {
      const { rows: [row] } = group
        ? await scope.client().query('SELECT session_id FROM navigation.qq_codex_group_sessions WHERE user_id=$1 AND project=$2 AND group_id=$3', [uid, project, group])
        : await scope.client().query('SELECT session_id FROM navigation.qq_codex_sessions WHERE user_id=$1 AND project=$2', [uid, project]);
      return row?.session_id;
    },
    saveSession,

    captureSession(job, value) {
      return scope.run(async client => {
        const updated = await client.query("UPDATE navigation.qq_codex_jobs SET session_id=$3 WHERE id=$1 AND user_id=$2 AND state='running'",
          [job.id, job.user_id, value]);
        if (!updated.rowCount) return;
        if (job.origin !== 'web') await saveSession(job.user_id, job.project, job.group_id || '', value);
        await conversations.capture(job, value);
      });
    },

    async reset(uid, project, group = '') {
      await clearAttachmentsFor(uid, group);
      if (group) await scope.client().query('DELETE FROM navigation.qq_codex_group_sessions WHERE user_id=$1 AND project=$2 AND group_id=$3', [uid, project, group]);
      else await scope.client().query('DELETE FROM navigation.qq_codex_sessions WHERE user_id=$1 AND project=$2', [uid, project]);
    },

    async reply(uid, qq, message, group = '', fullResult = false) {
      for (const text of formatReply(message)) {
        await scope.client().query(`INSERT INTO navigation.qq_codex_outbox(user_id,qq_id,message,created_at,group_id,full_result)
          VALUES($1,$2,$3,$4,$5,$6)`, [uid, qq, text, Date.now(), group, fullResult ? 1 : 0]);
      }
    },
    async replyArtifact(uid, qq, artifact, group = '', sourceGroup = '') {
      await scope.client().query(`INSERT INTO navigation.qq_codex_outbox(user_id,qq_id,message,created_at,group_id,full_result,artifact_json,source_group_id)
        VALUES($1,$2,'',$3,$4,1,$5,$6)`, [uid, qq, Date.now(), group, JSON.stringify(artifact), sourceGroup]);
    },
    async pendingReply() {
      const { rows: [row] } = await scope.client().query('SELECT * FROM navigation.qq_codex_outbox WHERE next_attempt<=$1 ORDER BY id LIMIT 1', [Date.now()]);
      return outboxRow(row);
    },
    async delivered(id) {
      await scope.client().query('DELETE FROM navigation.qq_codex_outbox WHERE id=$1', [id]);
    },
    async retryReply(id) {
      await scope.client().query('UPDATE navigation.qq_codex_outbox SET next_attempt=$2 WHERE id=$1', [id, Date.now() + 30000]);
    },
  };
}
