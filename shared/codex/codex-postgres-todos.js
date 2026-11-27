import crypto from 'node:crypto';
import { lockPostgresCodexQueue } from './codex-postgres-queue.js';
import { postgresCodexScope } from './codex-postgres-scope.js';

const ACTIVE_JOB = "state IN ('queued','running')";

function todoRow(row) {
  if (!row) return undefined;
  return { ...row, sort_order: Number(row.sort_order), attempts: Number(row.attempts),
    next_check_at: Number(row.next_check_at), reset_at: Number(row.reset_at),
    created_at: Number(row.created_at), updated_at: Number(row.updated_at), scheduled_at: Number(row.scheduled_at) };
}

export function createPostgresCodexTodos(db, { conversations }) {
  const scope = postgresCodexScope(db);

  async function get(client, uid, id) {
    const { rows: [row] } = await client.query(`SELECT t.*,j.state AS job_state FROM navigation.codex_todos t
      LEFT JOIN navigation.qq_codex_jobs j ON j.id=t.job_id AND j.user_id=t.user_id
      WHERE t.user_id=$1 AND t.id=$2`, [uid, id]);
    return todoRow(row);
  }

  const store = {
    async get(uid, id) { return get(scope.client(), uid, id); },

    reconcile(now = Date.now()) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const { rows } = await client.query(`SELECT t.id,t.user_id,t.state,j.state AS job_state,j.failure_kind
          FROM navigation.codex_todos t JOIN navigation.qq_codex_jobs j ON j.id=t.job_id AND j.user_id=t.user_id
          WHERE t.state IN ('queued','running','paused')`);
        for (const row of rows) {
          if (row.state === 'paused' && row.job_state !== 'succeeded') continue;
          let state = row.job_state, note = '', next = 0;
          if (state === 'failed' && row.failure_kind === 'quota') { state = 'waiting_quota'; note = '执行中额度耗尽，等待恢复后继续'; next = now + 60000; }
          else if (state === 'failed' && row.failure_kind === 'authorization') { state = 'paused'; note = '执行授权已撤销，自动执行已暂停'; }
          else if (state === 'failed') note = '任务失败，请查看会话后决定是否重试';
          else if (state === 'cancelled') { state = 'paused'; note = '已停止，已有修改保留'; }
          if (state !== row.state) {
            await client.query('UPDATE navigation.codex_todos SET state=$3,note=$4,next_check_at=$5,updated_at=$6 WHERE id=$1 AND user_id=$2',
              [row.id, row.user_id, state, note, next, now]);
          }
        }
      });
    },

    async list(uid) {
      await store.reconcile();
      const { rows } = await scope.client().query(`SELECT t.*,j.state AS job_state FROM navigation.codex_todos t
        LEFT JOIN navigation.qq_codex_jobs j ON j.id=t.job_id AND j.user_id=t.user_id
        WHERE t.user_id=$1 ORDER BY t.sort_order,t.created_at`, [uid]);
      return rows.map(todoRow);
    },

    create(uid, qq, values) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const requestId = values.requestId || crypto.randomUUID();
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([values.project, values.title, values.prompt, values.runtime, values.conversationId || '', values.autoRun, ...(values.scheduledAt ? [values.scheduledAt] : [])])).digest('hex');
        const { rows: [previous] } = await client.query('SELECT id,payload_hash FROM navigation.codex_todos WHERE user_id=$1 AND request_id=$2', [uid, requestId]);
        if (previous) {
          if (previous.payload_hash !== fingerprint) throw new Error('此请求已保存其他内容，请刷新列表后再新增');
          return get(client, uid, previous.id);
        }
        const { rows: [size] } = await client.query('SELECT count(*) AS n FROM navigation.codex_todos WHERE user_id=$1', [uid]);
        if (Number(size.n) >= 200) throw new Error('最多保留200条待办，请先删除不再需要的记录');
        const id = crypto.randomUUID(), now = Date.now();
        const { rows: [order] } = await client.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM navigation.codex_todos WHERE user_id=$1', [uid]);
        await client.query(`INSERT INTO navigation.codex_todos(id,user_id,qq_id,project,title,prompt,request_id,payload_hash,runtime_json,
          conversation_id,state,sort_order,created_at,updated_at,scheduled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14)`,
        [id, uid, qq, values.project, values.title, values.prompt, requestId, fingerprint, JSON.stringify(values.runtime),
          values.conversationId || '', values.autoRun ? 'pending' : 'paused', Number(order.n), now, values.scheduledAt || 0]);
        return get(client, uid, id);
      });
    },

    edit(uid, id, values) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const row = await get(client, uid, id);
        if (!row || row.job_id || !['pending', 'waiting_quota', 'paused'].includes(row.state)) throw new Error('仅尚未开始执行的待办可以编辑指令');
        await client.query(`UPDATE navigation.codex_todos SET project=$3,title=$4,prompt=$5,runtime_json=$6,conversation_id=$7,state=$8,
          scheduled_at=$9,next_check_at=0,reset_at=0,note='',updated_at=$10 WHERE user_id=$1 AND id=$2`,
        [uid, id, values.project, values.title, values.prompt, JSON.stringify(values.runtime), values.conversationId || '',
          values.autoRun ? 'pending' : 'paused', values.scheduledAt || 0, Date.now()]);
        return get(client, uid, id);
      });
    },

    pause(uid, id) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const row = await get(client, uid, id);
        if (!row || ['succeeded', 'cancelled'].includes(row.state)) throw new Error('此待办已经结束');
        await client.query(`UPDATE navigation.qq_codex_jobs SET cancel=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,
          result=CASE WHEN state='queued' THEN '已暂停待办' ELSE result END,
          finished_at=CASE WHEN state='queued' THEN $3 ELSE finished_at END
          WHERE id=$1 AND user_id=$2 AND ${ACTIVE_JOB}`, [row.job_id, uid, Date.now()]);
        await client.query("UPDATE navigation.codex_todos SET state='paused',note='已暂停自动执行',updated_at=$3 WHERE user_id=$1 AND id=$2",
          [uid, id, Date.now()]);
        return get(client, uid, id);
      });
    },

    resume(uid, id) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const row = await get(client, uid, id);
        if (!row || !['paused', 'failed'].includes(row.state) || ['queued', 'running', 'succeeded'].includes(row.job_state)) throw new Error('请等待任务停止后再恢复，已完成的待办不能重做');
        await client.query("UPDATE navigation.codex_todos SET state='pending',next_check_at=0,reset_at=0,note='',updated_at=$3 WHERE user_id=$1 AND id=$2",
          [uid, id, Date.now()]);
        return get(client, uid, id);
      });
    },

    remove(uid, id) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const row = await get(client, uid, id);
        if (!row || ['queued', 'running'].includes(row.state) || ['queued', 'running'].includes(row.job_state)) throw new Error('请先暂停并等待执行结束');
        await client.query('DELETE FROM navigation.codex_todos WHERE user_id=$1 AND id=$2', [uid, id]);
      });
    },

    move(uid, id, direction) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const row = await get(client, uid, id);
        if (!row || !['pending', 'waiting_quota', 'paused'].includes(row.state)) throw new Error('此待办不能调整顺序');
        const comparison = direction === 'up' ? '<' : '>';
        const order = direction === 'up' ? 'DESC' : 'ASC';
        const { rows: [other] } = await client.query(`SELECT id,sort_order FROM navigation.codex_todos
          WHERE user_id=$1 AND state IN ('pending','waiting_quota','paused') AND sort_order ${comparison} $2
          ORDER BY sort_order ${order} LIMIT 1`, [uid, row.sort_order]);
        if (other) {
          await client.query('UPDATE navigation.codex_todos SET sort_order=$3 WHERE user_id=$1 AND id=$2', [uid, id, Number(other.sort_order)]);
          await client.query('UPDATE navigation.codex_todos SET sort_order=$3 WHERE user_id=$1 AND id=$2', [uid, other.id, row.sort_order]);
        }
        return get(client, uid, id);
      });
    },

    async due(now) {
      await store.reconcile(now);
      const { rows } = await scope.client().query(`SELECT t.* FROM navigation.codex_todos t
        WHERE t.state IN ('pending','waiting_quota') AND t.next_check_at<=$1 AND t.scheduled_at<=$1
        AND NOT EXISTS(SELECT 1 FROM navigation.codex_todos p WHERE p.user_id=t.user_id AND p.sort_order<t.sort_order
          AND p.state IN ('pending','waiting_quota','queued','running','failed')
          AND (p.state NOT IN ('pending','waiting_quota') OR p.scheduled_at<=$1))
        ORDER BY t.sort_order,t.created_at LIMIT 20`, [now]);
      return rows.map(todoRow);
    },

    async defer(reason, next, reset = 0, now = Date.now()) {
      await scope.client().query(`UPDATE navigation.codex_todos SET state='waiting_quota',note=$1,next_check_at=$2,reset_at=$3,updated_at=$4
        WHERE state IN ('pending','waiting_quota') AND next_check_at<=$4 AND scheduled_at<=$4`, [reason, next, reset, now]);
    },

    async fail(row, note, state = 'failed') {
      await scope.client().query(`UPDATE navigation.codex_todos SET state=$3,note=$4,updated_at=$5
        WHERE id=$1 AND user_id=$2 AND state IN ('pending','waiting_quota')`, [row.id, row.user_id, state, note, Date.now()]);
    },

    promote(row, runtime, now, includeQQ = true) {
      return scope.run(async client => {
        await lockPostgresCodexQueue(client);
        const fresh = await get(client, row.user_id, row.id);
        if (!fresh || !['pending', 'waiting_quota'].includes(fresh.state) || fresh.next_check_at > now || fresh.scheduled_at > now) return null;
        if (['project', 'title', 'prompt', 'runtime_json', 'conversation_id', 'sort_order', 'scheduled_at', 'updated_at'].some(key => fresh[key] !== row[key])) return null;
        const blocked = await client.query(`SELECT 1 FROM navigation.codex_todos WHERE user_id=$1 AND sort_order<$2
          AND state IN ('pending','waiting_quota','queued','running','failed')
          AND (state NOT IN ('pending','waiting_quota') OR scheduled_at<=$3) LIMIT 1`, [row.user_id, fresh.sort_order, now]);
        if (blocked.rowCount) return null;
        const busy = await client.query('SELECT 1 FROM navigation.qq_codex_jobs WHERE state=$1 OR (state=$2 AND ($3::boolean OR origin=$4)) LIMIT 1',
          ['running', 'queued', includeQQ, 'web']);
        if (busy.rowCount) return null;
        let conversation = fresh.conversation_id && await conversations.get(row.user_id, fresh.conversation_id);
        if (!conversation) conversation = await conversations.create(row.user_id, row.project, ('Todo · ' + row.title).slice(0, 80));
        const { rows: [previous] } = await client.query('SELECT session_id FROM navigation.qq_codex_jobs WHERE id=$1 AND user_id=$2', [fresh.job_id, row.user_id]);
        const prompt = previous?.session_id ? '继续本待办上次中断的任务。先核对已完成的修改、提交与外部操作，从中断处继续，避免重复已经完成的操作。\n\n原始指令：\n' + fresh.prompt : fresh.prompt;
        const job = await conversations.enqueue(row.user_id, row.qq_id, conversation.id, { prompt, runtime, requestId: 'todo-' + row.id + '-' + fresh.attempts });
        await client.query('UPDATE navigation.qq_codex_jobs SET todo_id=$3 WHERE id=$1 AND user_id=$2', [job, row.user_id, row.id]);
        await client.query(`UPDATE navigation.codex_todos SET state='queued',conversation_id=$3,job_id=$4,attempts=attempts+1,
          next_check_at=0,reset_at=0,note='',updated_at=$5 WHERE id=$1 AND user_id=$2`,
        [row.id, row.user_id, conversation.id, job, Date.now()]);
        return job;
      });
    },
  };
  return store;
}
