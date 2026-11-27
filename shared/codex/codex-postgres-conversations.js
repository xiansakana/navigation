import { randomUUID } from 'node:crypto';
import { createPostgresCodexQueue, lockPostgresCodexQueue } from './codex-postgres-queue.js';
import { postgresCodexScope } from './codex-postgres-scope.js';
import { codexProgress } from './codex-conversations.js';

function conversation(row) {
  return row && { ...row, archived: Number(row.archived), created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}

export function createPostgresCodexConversations(db, { formatReply, queue } = {}) {
  const scope = postgresCodexScope(db);
  const jobs = queue || createPostgresCodexQueue(db, { formatReply });

  async function importUnlinked(client, uid) {
    const { rows: unlinked } = await client.query(`SELECT id,project,prompt,group_id,session_id,created_at,finished_at
      FROM navigation.qq_codex_jobs WHERE user_id=$1 AND origin='qq' AND conversation_id=''
      ORDER BY created_at,_sqlite_rowid LIMIT 1000 FOR UPDATE`, [uid]);
    for (const job of unlinked) {
      let existing;
      if (job.session_id) {
        ({ rows: [existing] } = await client.query(`SELECT id FROM navigation.codex_conversations
          WHERE user_id=$1 AND project=$2 AND group_id=$3 AND session_id=$4 ORDER BY created_at,_sqlite_rowid LIMIT 1`,
        [uid, job.project, job.group_id, job.session_id]));
      }
      const id = existing?.id || 'qq-' + job.id, activity = job.finished_at ?? job.created_at;
      if (!existing) await client.query(`INSERT INTO navigation.codex_conversations
        (id,user_id,project,title,source,group_id,session_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,'qq',$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
      [id, uid, job.project, job.prompt.replace(/^__(usage|sync)__$/, '状态查询').slice(0, 80), job.group_id, job.session_id, job.created_at, activity]);
      await client.query(`UPDATE navigation.qq_codex_jobs SET conversation_id=$3 WHERE user_id=$1 AND id=$2
        AND EXISTS (SELECT 1 FROM navigation.codex_conversations WHERE user_id=$1 AND id=$3)`, [uid, job.id, id]);
      await client.query('UPDATE navigation.codex_conversations SET updated_at=greatest(updated_at,$3) WHERE user_id=$1 AND id=$2', [uid, id, activity]);
    }
  }

  return {
    async get(uid, id) {
      const { rows: [row] } = await scope.client().query('SELECT * FROM navigation.codex_conversations WHERE user_id=$1 AND id=$2', [uid, id]);
      return conversation(row);
    },
    async create(uid, project, title = '新会话') {
      const id = randomUUID(), now = Date.now();
      const { rows: [row] } = await scope.client().query(`INSERT INTO navigation.codex_conversations(id,user_id,project,title,source,created_at,updated_at)
        VALUES($1,$2,$3,$4,'web',$5,$5) RETURNING *`, [id, uid, project, title, now]);
      return conversation(row);
    },
    update(uid, id, { title, archived }) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        if (archived) {
          const result = await client.query(`SELECT 1 FROM navigation.qq_codex_jobs
            WHERE user_id=$1 AND conversation_id=$2 AND state IN ('queued','running') LIMIT 1`, [uid, id]);
          if (result.rowCount) throw new Error('请先等待或停止执行中的任务');
        }
        const { rows: [row] } = await client.query(`UPDATE navigation.codex_conversations SET title=coalesce($3,title),
          archived=coalesce($4,archived),updated_at=$5 WHERE user_id=$1 AND id=$2 RETURNING *`,
        [uid, id, title ?? null, archived === undefined ? null : Number(archived), Date.now()]);
        return conversation(row);
      });
    },
    list(uid) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        await importUnlinked(client, uid);
        const { rows } = await client.query(`SELECT c.*, (SELECT state FROM navigation.qq_codex_jobs j
          WHERE j.conversation_id=c.id AND j.user_id=c.user_id ORDER BY j.created_at DESC,j._sqlite_rowid DESC LIMIT 1) AS state
          FROM navigation.codex_conversations c WHERE c.user_id=$1 ORDER BY c.updated_at DESC,c.id LIMIT 500`, [uid]);
        return rows.map(conversation);
      });
    },
    importQQ(uid) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        await importUnlinked(client, uid);
      });
    },
    jobs(uid, id) {
      return scope.run(async client => {
        const { rows } = await client.query(`SELECT id,prompt,state,result,session_id,commit_sha,runtime_json,origin,cancel,created_at,finished_at
          FROM (SELECT * FROM navigation.qq_codex_jobs WHERE user_id=$1 AND conversation_id=$2
            ORDER BY created_at DESC,_sqlite_rowid DESC LIMIT 500) AS recent ORDER BY created_at,_sqlite_rowid`, [uid, id]);
        if (!rows.length) return [];
        const { rows: events } = await client.query(`SELECT id,job_id,kind,text,created_at FROM navigation.codex_job_progress
          WHERE job_id=ANY($1::text[]) ORDER BY id`, [rows.map(job => job.id)]);
        const progress = new Map(rows.map(job => [job.id, []]));
        for (const { job_id, id: eventId, created_at, ...event } of events) {
          progress.get(job_id).push({ ...event, id: Number(eventId), created_at: Number(created_at) });
        }
        return rows.map(row => ({ ...row, cancel: Number(row.cancel), created_at: Number(row.created_at),
          finished_at: row.finished_at === null ? null : Number(row.finished_at),
          runtime: JSON.parse(row.runtime_json), progress: progress.get(row.id) }));
      });
    },
    capture(job, sessionId) {
      return scope.run(async client => {
        const { rows: [linked] } = await client.query('SELECT conversation_id FROM navigation.qq_codex_jobs WHERE id=$1 AND user_id=$2', [job.id, job.user_id]);
        let id = linked?.conversation_id || job.conversation_id || '';
        if (job.origin !== 'web' && id) {
          const { rows: [existing] } = await client.query(`SELECT id FROM navigation.codex_conversations
            WHERE user_id=$1 AND project=$2 AND group_id=$3 AND session_id=$4 AND source='qq' AND id<>$5
            ORDER BY created_at,_sqlite_rowid LIMIT 1`, [job.user_id, job.project, job.group_id || '', sessionId, id]);
          if (existing) {
            await client.query('UPDATE navigation.qq_codex_jobs SET conversation_id=$3 WHERE id=$1 AND user_id=$2', [job.id, job.user_id, existing.id]);
            await client.query(`DELETE FROM navigation.codex_conversations c WHERE c.user_id=$1 AND c.id=$2
              AND NOT EXISTS (SELECT 1 FROM navigation.qq_codex_jobs j WHERE j.user_id=c.user_id AND j.conversation_id=c.id)`, [job.user_id, id]);
            id = existing.id;
          }
        }
        await client.query('UPDATE navigation.codex_conversations SET session_id=$3,updated_at=$4 WHERE user_id=$1 AND id=$2',
          [job.user_id, sessionId, Date.now(), id]);
      });
    },
    async progress(job, event) {
      const progress = codexProgress(event);
      if (!progress) return false;
      return scope.run(async client => {
        const live = await client.query(`SELECT id FROM navigation.qq_codex_jobs
          WHERE id=$1 AND user_id=$2 AND state='running' FOR UPDATE`, [job.id, job.user_id]);
        if (!live.rowCount) return false;
        const result = await client.query(`INSERT INTO navigation.codex_job_progress(job_id,kind,text,created_at)
          SELECT $1,$2,$3,$4 WHERE (SELECT count(*) FROM navigation.codex_job_progress WHERE job_id=$1) < 150`,
        [job.id, progress.kind, progress.text, Date.now()]);
        return result.rowCount === 1;
      });
    },
    enqueue: jobs.enqueueWeb,
    stop: jobs.stopConversation,
  };
}
