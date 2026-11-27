import { withTestDatabase, assert, assertEqual } from './postgres-test-harness.mjs';
import { createPostgresPool } from '../shared/db/postgres/pool.js';
import { createPostgresCodexStore } from '../shared/codex/codex-postgres-store.js';

await withTestDatabase(async ({ url, pg }) => {
  const pool = createPostgresPool(pg.Pool, url, 'navigation-test-codex');
  try {
    const store = createPostgresCodexStore(pool);
    const uid = 'codex-test', qq = '12345678';
    await store.saveSettings(uid, { groups: ['33333333'], groupReply: 'group' });
    assertEqual(await store.settings(uid), { groups: ['33333333'], groupReply: 'group' }, 'Codex 设置');
    await store.saveRuntime(uid, '', { model: 'fixture-model', effort: 'high' });
    assertEqual(await store.runtime(uid), { model: 'fixture-model', effort: 'high' }, 'Codex 运行时偏好');
    await store.saveSession(uid, 'navigation', '', 'private-thread');
    assertEqual(await store.session(uid, 'navigation'), 'private-thread', 'Codex 会话');
    assertEqual(await store.event('codex-event-1'), true, '事件首次写入');
    assertEqual(await store.event('codex-event-1'), false, '事件去重');

    const jobId = await store.enqueue(uid, qq, 'codex-event-2', 'navigation', 'fixture task');
    assertEqual(await store.hasActiveJobs(), true, '队列活跃');
    const job = await store.claim();
    assertEqual(job.id, jobId, '队列领取');
    assertEqual(await store.touch(job.id), true, '心跳');
    await store.finish(job, { state: 'succeeded', result: 'done', sessionId: 'private-thread-2' });
    assertEqual(await store.latestResult(uid), 'done', '队列完成');
    assertEqual(await store.session(uid, 'navigation'), 'private-thread-2', '完成写入会话');

    const conversation = await store.conversations.create(uid, 'navigation');
    const input = { prompt: 'web task', runtime: {}, requestId: 'codex-request-1' };
    const webId = await store.conversations.enqueue(uid, qq, conversation.id, input);
    assertEqual(await store.conversations.enqueue(uid, qq, conversation.id, input), webId, 'Web 请求幂等');
    const web = await store.claim();
    assertEqual(web.id, webId, 'Web 队列领取');
    await store.finish(web, { state: 'succeeded', result: 'web done', sessionId: 'web-thread' });
    assertEqual((await store.conversations.jobs(uid, conversation.id))[0].state, 'succeeded', 'Web 会话状态');

    const todoInput = { title: 'todo', project: 'navigation', prompt: 'todo task', runtime: {}, autoRun: true, requestId: 'codex-todo-1' };
    const todo = await store.todos.create(uid, qq, todoInput);
    assertEqual(todo.state, 'pending', '待办创建');
    assertEqual((await store.todos.create(uid, qq, todoInput)).id, todo.id, '待办请求幂等');
    assertEqual((await store.todos.list(uid)).some(row => row.id === todo.id), true, '待办列表');
    console.log('codex postgres ok');
  } finally {
    await pool.close();
  }
});
