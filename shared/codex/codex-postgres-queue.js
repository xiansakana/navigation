import { randomBytes } from 'node:crypto';
import { validateAttachments } from './codex-media.js';
import { postgresCodexScope } from './codex-postgres-scope.js';

const IN_FLIGHT = "state IN ('queued','running')";
const STOPPED = '执行进程已中断，未自动重做。修改和提交保留在开发目录，请先查看状态。';

export async function lockPostgresCodexQueue(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('navigation:codex:queue', 0))");
}

function jobRow(row) {
  if (!row) return null;
  const { _sqlite_rowid, cancel, heartbeat, created_at, finished_at, ...job } = row;
  return { ...job, cancel: Number(cancel), heartbeat: Number(heartbeat), created_at: Number(created_at),
    finished_at: finished_at === null ? null : Number(finished_at) };
}

export function createPostgresCodexQueue(db, { formatReply = message => [String(message)] } = {}) {
  const scope = postgresCodexScope(db);

  async function settings(client, uid) {
    const { rows: [row] } = await client.query('SELECT groups_json,group_reply FROM navigation.qq_codex_settings WHERE user_id=$1', [uid]);
    return row ? { groups: JSON.parse(row.groups_json), reply: row.group_reply } : { groups: [], reply: 'private' };
  }

  async function assertCapacity(client) {
    const { rows: [size] } = await client.query('SELECT count(*) AS n FROM navigation.qq_codex_jobs WHERE ' + IN_FLIGHT);
    if (Number(size.n) >= 5) throw new Error('队列已满，请稍后再试');
  }

  async function reply(client, job, text, group, full = false, artifacts = []) {
    for (const part of formatReply(text)) {
      await client.query(`INSERT INTO navigation.qq_codex_outbox(user_id,qq_id,message,created_at,group_id,full_result)
        VALUES ($1,$2,$3,$4,$5,$6)`, [job.user_id, job.qq_id, part, Date.now(), group, Number(full)]);
    }
    for (const artifact of artifacts) {
      await client.query(`INSERT INTO navigation.qq_codex_outbox(user_id,qq_id,message,created_at,group_id,full_result,artifact_json,source_group_id)
        VALUES ($1,$2,'',$3,$4,1,$5,$6)`, [job.user_id, job.qq_id, Date.now(), group, JSON.stringify(artifact), job.group_id]);
    }
  }

  async function persistCompletion(client, job, result, requiredState) {
    const { state, result: message, sessionId = job.session_id || '', commit = '', artifacts = [], runtime, failureKind = '' } = result;
    const { rows: [saved] } = await client.query(`UPDATE navigation.qq_codex_jobs SET state=$3,result=$4,session_id=$5,commit_sha=$6,
      finished_at=$7,artifacts_json=$8,failure_kind=$9 WHERE id=$1 AND user_id=$2 AND state=$10 RETURNING *`,
    [job.id, job.user_id, state, message.slice(0, 24000), sessionId, commit, Date.now(), JSON.stringify(artifacts), failureKind, requiredState]);
    if (!saved) return false;
    if (sessionId) {
      if (saved.origin !== 'web') {
        if (saved.group_id) {
          await client.query(`INSERT INTO navigation.qq_codex_group_sessions(user_id,project,group_id,session_id) VALUES($1,$2,$3,$4)
            ON CONFLICT(user_id,project,group_id) DO UPDATE SET session_id=excluded.session_id`, [saved.user_id, saved.project, saved.group_id, sessionId]);
        } else {
          await client.query(`INSERT INTO navigation.qq_codex_sessions(user_id,project,session_id) VALUES($1,$2,$3)
            ON CONFLICT(user_id,project) DO UPDATE SET session_id=excluded.session_id`, [saved.user_id, saved.project, sessionId]);
        }
      }
      let conversationId = saved.conversation_id;
      if (conversationId && saved.origin !== 'web') {
        const { rows: [prior] } = await client.query(`SELECT id FROM navigation.codex_conversations
          WHERE user_id=$1 AND project=$2 AND group_id=$3 AND session_id=$4 AND source='qq' AND id<>$5
          ORDER BY created_at,_sqlite_rowid LIMIT 1`, [saved.user_id, saved.project, saved.group_id, sessionId, conversationId]);
        if (prior) {
          await client.query('UPDATE navigation.qq_codex_jobs SET conversation_id=$3 WHERE user_id=$1 AND id=$2', [saved.user_id, saved.id, prior.id]);
          await client.query(`DELETE FROM navigation.codex_conversations WHERE user_id=$1 AND id=$2
            AND NOT EXISTS (SELECT 1 FROM navigation.qq_codex_jobs WHERE user_id=$1 AND conversation_id=$2)`, [saved.user_id, conversationId]);
          conversationId = prior.id;
        }
      }
      await client.query('UPDATE navigation.codex_conversations SET session_id=$3,updated_at=$4 WHERE user_id=$1 AND id=$2',
        [saved.user_id, conversationId, sessionId, Date.now()]);
    }
    if (saved.origin !== 'web') {
      const preferences = await settings(client, saved.user_id);
      const allowed = saved.group_id && preferences.groups.includes(saved.group_id);
      const toGroup = allowed && saved.reply_mode === 'group' && preferences.reply === 'group';
      const summary = `Codex ${saved.id.slice(0, 8)} · ${saved.project} · ${{ succeeded: '完成', failed: '失败', cancelled: '已停止' }[state]}`;
      const model = runtime?.model ? '模型：' + runtime.model + ' · 强度：' + (runtime.effort || '模型默认') + '\n' : '';
      await reply(client, saved, summary + '\n' + model + (commit ? 'Git: ' + commit.slice(0, 12) + '\n' : '') + message, toGroup ? saved.group_id : '', true, artifacts);
      if (allowed && !toGroup) await reply(client, saved, summary + '\n完整结果将通过私聊发送给发起人。', saved.group_id);
    }
    return true;
  }

  return {
    enqueueQQ(uid, qq, eventKey, project, prompt, groupId = '', attachments = []) {
      const payload = JSON.stringify(validateAttachments(attachments));
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const { rows: [existing] } = await client.query('SELECT id,user_id FROM navigation.qq_codex_jobs WHERE event_key=$1', [eventKey]);
        if (existing) {
          if (existing.user_id !== uid) throw new Error('任务标识已使用');
          return existing.id;
        }
        await assertCapacity(client);
        const { rows: [runtime] } = await client.query('SELECT model,effort FROM navigation.qq_codex_runtime_preferences WHERE user_id=$1 AND group_id=$2', [uid, groupId]);
        const preferences = await settings(client, uid);
        const id = randomBytes(8).toString('hex');
        await client.query(`INSERT INTO navigation.qq_codex_jobs
          (id,user_id,qq_id,event_key,project,prompt,created_at,group_id,reply_mode,attachments_json,runtime_json)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, uid, qq, eventKey, project, prompt, Date.now(), groupId, preferences.reply, payload, JSON.stringify(runtime || { model: '', effort: '' })]);
        return id;
      });
    },
    enqueueWeb(uid, qq, conversationId, { prompt, runtime = {}, requestId }) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const event = 'web:' + uid + ':' + requestId;
        const { rows: [previous] } = await client.query('SELECT id,conversation_id FROM navigation.qq_codex_jobs WHERE user_id=$1 AND event_key=$2', [uid, event]);
        if (previous) {
          if (previous.conversation_id !== conversationId) throw new Error('请求标识已用于其他会话');
          return previous.id;
        }
        const { rows: [conversation] } = await client.query('SELECT project,archived FROM navigation.codex_conversations WHERE user_id=$1 AND id=$2 FOR UPDATE', [uid, conversationId]);
        if (!conversation || Number(conversation.archived)) throw new Error('会话不存在或已归档');
        const active = await client.query('SELECT 1 FROM navigation.qq_codex_jobs WHERE user_id=$1 AND conversation_id=$2 AND ' + IN_FLIGHT + ' LIMIT 1', [uid, conversationId]);
        if (active.rowCount) throw new Error('请等待本轮完成，或先停止任务');
        await assertCapacity(client);
        const id = randomBytes(8).toString('hex'), time = Date.now();
        await client.query(`INSERT INTO navigation.qq_codex_jobs
          (id,user_id,qq_id,event_key,project,prompt,created_at,runtime_json,origin,conversation_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'web',$9)`, [id, uid, qq, event, conversation.project, prompt, time, JSON.stringify(runtime), conversationId]);
        await client.query(`UPDATE navigation.codex_conversations SET updated_at=$3,title=CASE WHEN title='新会话' THEN $4 ELSE title END
          WHERE user_id=$1 AND id=$2`, [uid, conversationId, time, prompt.replace(/\s+/g, ' ').slice(0, 60)]);
        return id;
      });
    },
    claim({ includeQQ = true } = {}) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const now = Date.now();
        const { rows: stale } = await client.query(`SELECT * FROM navigation.qq_codex_jobs
          WHERE state='running' AND heartbeat<$1 ORDER BY created_at,_sqlite_rowid FOR UPDATE`, [now - 120000]);
        for (const job of stale) await persistCompletion(client, job, { state: 'failed', result: STOPPED }, 'running');
        if ((await client.query("SELECT 1 FROM navigation.qq_codex_jobs WHERE state='running' LIMIT 1")).rowCount) return null;
        const { rows: [job] } = await client.query(`SELECT * FROM navigation.qq_codex_jobs
          WHERE state='queued' AND ($1 OR origin='web') ORDER BY created_at,_sqlite_rowid LIMIT 1 FOR UPDATE`, [includeQQ]);
        if (!job) return null;
        await client.query("UPDATE navigation.qq_codex_jobs SET state='running',heartbeat=$2 WHERE id=$1", [job.id, now]);
        return jobRow(job);
      });
    },
    async touch(job) {
      const write = await scope.client().query("UPDATE navigation.qq_codex_jobs SET heartbeat=$3 WHERE id=$1 AND user_id=$2 AND state='running'",
        [job.id, job.user_id, Date.now()]);
      return write.rowCount === 1;
    },
    finish(job, result) { return scope.run(client => persistCompletion(client, job, result, 'running')); },
    cancelQQ(uid, groupId = '') {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const { rows } = await client.query(`SELECT * FROM navigation.qq_codex_jobs
          WHERE user_id=$1 AND group_id=$2 AND origin='qq' AND ${IN_FLIGHT} ORDER BY created_at,_sqlite_rowid FOR UPDATE`, [uid, groupId]);
        for (const job of rows) {
          if (job.state === 'queued') await persistCompletion(client, job, { state: 'cancelled', result: '已取消排队任务' }, 'queued');
          else await client.query('UPDATE navigation.qq_codex_jobs SET cancel=1 WHERE id=$1 AND user_id=$2', [job.id, uid]);
        }
        return rows.length;
      });
    },
    async stopConversation(uid, conversationId) {
      const result = await scope.client().query(`UPDATE navigation.qq_codex_jobs
        SET cancel=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,
          result=CASE WHEN state='queued' THEN '已取消排队任务' ELSE result END,
          finished_at=CASE WHEN state='queued' THEN $3 ELSE finished_at END
        WHERE user_id=$1 AND conversation_id=$2 AND ${IN_FLIGHT}`, [uid, conversationId, Date.now()]);
      return result.rowCount;
    },
    async cancelled(job) {
      const { rows: [row] } = await scope.client().query('SELECT cancel FROM navigation.qq_codex_jobs WHERE id=$1 AND user_id=$2', [job.id, job.user_id]);
      return Number(row?.cancel || 0) !== 0;
    },
    async recordRuntime(job, runtime) {
      const result = await scope.client().query(`UPDATE navigation.qq_codex_jobs SET runtime_json=$3
        WHERE id=$1 AND user_id=$2 AND state='running'`, [job.id, job.user_id, JSON.stringify(runtime)]);
      return result.rowCount === 1;
    },
  };
}
