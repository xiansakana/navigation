import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCodexStore } from './codex-store.js';
import { createPostgresCodexStore } from './codex-postgres-store.js';

const Database = createRequire(new URL('../../portal/package.json', import.meta.url))('better-sqlite3');

// A recording fixture for the SQL the Codex PostgreSQL store issues. It keeps
// the store's public contract and parameter handling covered without a live
// database; real SQL is exercised by scripts/test-mingli-postgres.mjs.
function fakeCodexDatabase() {
  const state = {
    settings: new Map(), runtime: new Map(), sessions: new Map(), groups: new Map(),
    receptions: new Map(), files: new Map(), events: new Set(), outbox: [], jobs: [],
  };
  let activeClient = null, outboxId = 1, transactions = 0;
  const value = (...parts) => parts.map(part => String(part)).join('\u0000');
  const reply = rows => ({ rows, rowCount: rows.length });

  function execute(sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.includes('FROM navigation.qq_codex_settings')) {
      const row = state.settings.get(params[0]);
      return reply(row ? [{ groups_json: row.groups, group_reply: row.reply }] : []);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_settings')) {
      state.settings.set(params[0], { groups: params[1], reply: params[2] });
      return reply([]);
    }
    if (q.includes('FROM navigation.qq_codex_runtime_preferences')) {
      const row = state.runtime.get(value(params[0], params[1]));
      return reply(row ? [{ model: row.model, effort: row.effort }] : []);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_runtime_preferences')) {
      state.runtime.set(value(params[0], params[1]), { model: params[2], effort: params[3] });
      return reply([]);
    }
    if (q.startsWith('SELECT session_id FROM navigation.qq_codex_group_sessions')) {
      const session = state.groups.get(value(params[0], params[1], params[2]));
      return reply(session === undefined ? [] : [{ session_id: session }]);
    }
    if (q.startsWith('SELECT session_id FROM navigation.qq_codex_sessions')) {
      const session = state.sessions.get(value(params[0], params[1]));
      return reply(session === undefined ? [] : [{ session_id: session }]);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_group_sessions')) {
      state.groups.set(value(params[0], params[1], params[2]), params[3]);
      return reply([]);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_sessions')) {
      state.sessions.set(value(params[0], params[1]), params[2]);
      return reply([]);
    }
    if (q.startsWith('DELETE FROM navigation.qq_codex_group_sessions')) {
      state.groups.delete(value(params[0], params[1], params[2]));
      return reply([]);
    }
    if (q.startsWith('DELETE FROM navigation.qq_codex_sessions')) {
      state.sessions.delete(value(params[0], params[1]));
      return reply([]);
    }
    if (q.startsWith('DELETE FROM navigation.qq_codex_attachment_receptions WHERE expires_at<=')) {
      for (const [key, row] of state.receptions) if (row.expires_at <= params[0]) state.receptions.delete(key);
      return reply([]);
    }
    if (q.startsWith('SELECT 1 FROM navigation.qq_codex_attachment_receptions')) {
      const row = state.receptions.get(value(params[0], params[1]));
      if (!row) return reply([]);
      const readable = row.expires_at > params[2] && (Number(params[3]) === 0 || row.armed_at <= Number(params[3]) + 1000);
      return reply(readable ? [{ '?column?': 1 }] : []);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_attachment_receptions')) {
      state.receptions.set(value(params[0], params[1]), { armed_at: params[2], expires_at: params[3] });
      return reply([]);
    }
    if (q.startsWith('DELETE FROM navigation.qq_codex_attachment_receptions')) {
      state.receptions.delete(value(params[0], params[1]));
      return reply([]);
    }
    if (q.startsWith('SELECT attachments_json FROM navigation.qq_codex_pending_files')) {
      const row = state.files.get(value(params[0], params[1]));
      return reply(row && row.created_at > params[2] ? [{ attachments_json: row.attachments }] : []);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_pending_files')) {
      state.files.set(value(params[0], params[1]), { attachments: params[2], created_at: params[3] });
      return reply([]);
    }
    if (q.startsWith('DELETE FROM navigation.qq_codex_pending_files')) {
      state.files.delete(value(params[0], params[1]));
      return reply([]);
    }
    if (q.includes('FROM navigation.qq_codex_jobs WHERE event_key=$1')) {
      return reply(state.jobs.some(job => job.event_key === params[0]) ? [{ '?column?': 1 }] : []);
    }
    if (q.startsWith('DELETE FROM navigation.qq_codex_events')) {
      return reply([]);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_events')) {
      if (state.events.has(params[0])) return reply([]);
      state.events.add(params[0]);
      return reply([{ event_key: params[0] }]);
    }
    if (q.includes("WHERE state='running' OR")) {
      const includeQQ = q.includes('TRUE');
      const busy = state.jobs.some(job => job.state === 'running'
        || (job.state === 'queued' && (includeQQ || job.origin === 'web')));
      return reply(busy ? [{ '?column?': 1 }] : []);
    }
    if (q.startsWith('UPDATE navigation.qq_codex_jobs SET heartbeat')) {
      const job = state.jobs.find(entry => entry.id === params[0] && entry.state === 'running');
      if (job) job.heartbeat = params[1];
      return reply(job ? [job] : []);
    }
    if (q.startsWith('SELECT cancel FROM navigation.qq_codex_jobs')) {
      const job = state.jobs.find(entry => entry.id === params[0]);
      return reply(job ? [{ cancel: job.cancel }] : []);
    }
    if (q.startsWith('SELECT id,project,state,created_at,commit_sha,runtime_json FROM navigation.qq_codex_jobs')) {
      return reply(state.jobs.filter(job => job.user_id === params[0] && job.group_id === params[1] && job.origin === 'qq'));
    }
    if (q.startsWith('SELECT result FROM navigation.qq_codex_jobs')) {
      const job = state.jobs.filter(entry => entry.user_id === params[0] && entry.group_id === params[1] && entry.origin === 'qq' && entry.result)
        .sort((a, b) => b.created_at - a.created_at)[0];
      return reply(job ? [{ result: job.result }] : []);
    }
    if (q.startsWith('SELECT artifacts_json FROM navigation.qq_codex_jobs')) {
      const job = state.jobs.filter(entry => entry.user_id === params[0] && entry.group_id === params[1] && entry.origin === 'qq' && entry.result)
        .sort((a, b) => b.created_at - a.created_at)[0];
      return reply(job ? [{ artifacts_json: job.artifacts_json }] : []);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_outbox') && q.includes('artifact_json')) {
      state.outbox.push({ id: outboxId++, user_id: params[0], qq_id: params[1], message: '', created_at: params[2],
        group_id: params[3], full_result: 1, artifact_json: params[4], source_group_id: params[5], next_attempt: 0 });
      return reply([]);
    }
    if (q.startsWith('INSERT INTO navigation.qq_codex_outbox')) {
      state.outbox.push({ id: outboxId++, user_id: params[0], qq_id: params[1], message: params[2], created_at: params[3],
        group_id: params[4], full_result: params[5], artifact_json: '', source_group_id: '', next_attempt: 0 });
      return reply([]);
    }
    if (q.startsWith('SELECT * FROM navigation.qq_codex_outbox')) {
      const row = state.outbox.find(entry => entry.next_attempt <= params[0]);
      return reply(row ? [{ ...row }] : []);
    }
    if (q.startsWith('DELETE FROM navigation.qq_codex_outbox')) {
      state.outbox = state.outbox.filter(entry => String(entry.id) !== String(params[0]));
      return reply([]);
    }
    if (q.startsWith('UPDATE navigation.qq_codex_outbox')) {
      const row = state.outbox.find(entry => String(entry.id) === String(params[0]));
      if (row) row.next_attempt = params[1];
      return reply([]);
    }
    throw new Error('Unexpected scenario SQL: ' + q);
  }

  const client = { query: async (sql, params) => execute(sql, params) };
  return {
    state,
    get transactions() { return transactions; },
    query: async (sql, params) => {
      if (activeClient) throw new Error('pool query outside the ambient transaction');
      return execute(sql, params);
    },
    async transaction(run) {
      transactions++;
      activeClient = client;
      try { return await run(client); } finally { activeClient = null; }
    },
  };
}

test('PostgreSQL Codex store covers the SQLite store public methods', () => {
  const sqliteDatabase = new Database(':memory:'), sqlite = createCodexStore(sqliteDatabase);
  try {
    const store = createPostgresCodexStore(fakeCodexDatabase());
    for (const [name, member] of Object.entries(sqlite)) {
      assert.equal(typeof store[name], typeof member, name);
    }
    for (const name of Object.keys(sqlite.conversations)) {
      assert.equal(typeof store.conversations[name], 'function', 'conversations.' + name);
    }
    for (const name of Object.keys(sqlite.todos)) {
      assert.equal(typeof store.todos[name], 'function', 'todos.' + name);
    }
  } finally { sqliteDatabase.close(); }
});

test('PostgreSQL Codex settings, runtime, sessions and attachments keep SQLite semantics', async () => {
  const db = fakeCodexDatabase(), store = createPostgresCodexStore(db);
  assert.deepEqual(await store.settings('u'), { groups: [], groupReply: 'private' });
  await assert.rejects(() => store.saveSettings('u', { groups: ['123'], groupReply: 'private' }), /最多20个群号/);
  await assert.rejects(() => store.saveSettings('u', { groups: [], groupReply: 'other' }), /有效的结果发送方式/);
  assert.deepEqual(await store.saveSettings('u', { groups: ['12345678', '12345678'], groupReply: 'group' }),
    { groups: ['12345678'], groupReply: 'group' });
  assert.deepEqual(await store.settings('u'), { groups: ['12345678'], groupReply: 'group' });
  await assert.rejects(() => store.saveRuntime('u', '', { model: 1, effort: '' }), /模型设置格式无效/);
  assert.deepEqual(await store.saveRuntime('u', '', { model: 'model-b', effort: 'high' }), { model: 'model-b', effort: 'high' });
  assert.deepEqual(await store.runtime('u', '12345678'), { model: '', effort: '' });

  await store.saveSession('u', 'navigation', '', 'private-thread');
  await store.saveSession('u', 'navigation', '12345678', 'group-thread');
  assert.equal(await store.session('u', 'navigation'), 'private-thread');
  assert.equal(await store.session('u', 'navigation', '12345678'), 'group-thread');
  assert.equal(await store.session('u', 'navigation', '87654321'), undefined);
  await store.reset('u', 'navigation', '12345678');
  assert.equal(await store.session('u', 'navigation', '12345678'), undefined);
  assert.equal(await store.session('u', 'navigation'), 'private-thread');

  const image = { kind: 'image', id: 'image-1', size: 10 }, file = { kind: 'file', id: 'file-1', size: 20 };
  assert.deepEqual(await store.stageAttachments('u', '12345678', [image]), [image]);
  assert.deepEqual(await store.stageAttachments('u', '12345678', [image, file]), [image, file]);
  assert.deepEqual(await store.attachments('u', '12345678'), [image, file]);

  await store.armAttachments('u', '12345678');
  assert.equal(await store.attachmentReception('u', '12345678'), true);
  assert.equal(await store.attachmentReception('u', '12345678', Date.now() - 10000), false);
  await store.clearAttachments('u', '12345678');
  assert.deepEqual(await store.attachments('u', '12345678'), []);
  assert.equal(await store.attachmentReception('u', '12345678'), false);
});

test('PostgreSQL Codex events, outbox and active job helpers stay consistent', async () => {
  const db = fakeCodexDatabase(), store = createPostgresCodexStore(db, { formatReply: text => ['chunk-a:' + text, 'chunk-b'] });
  assert.equal(await store.event('event-1'), true);
  assert.equal(await store.event('event-1'), false);
  db.state.jobs.push({ id: 'job-1', user_id: 'u', group_id: '', origin: 'qq', state: 'succeeded', event_key: 'event-2', created_at: 1, result: '', artifacts_json: '[]' });
  assert.equal(await store.event('event-2'), false);

  assert.equal(await store.hasActiveJobs(), false);
  db.state.jobs.push({ id: 'job-2', user_id: 'u', group_id: '', origin: 'web', state: 'queued', created_at: 2, result: '' });
  assert.equal(await store.hasActiveJobs(false), true);
  assert.equal(await store.hasActiveJobs(true), true);
  db.state.jobs.push({ id: 'job-3', user_id: 'u', group_id: '', origin: 'qq', state: 'queued', created_at: 3, result: '' });
  db.state.jobs.find(job => job.id === 'job-2').state = 'succeeded';
  assert.equal(await store.hasActiveJobs(false), false);
  assert.equal(await store.hasActiveJobs(true), true);
  db.state.jobs.find(job => job.id === 'job-3').state = 'running';
  assert.equal(await store.touch('job-3'), true);
  assert.equal(await store.touch('job-1'), false);
  assert.equal(await store.cancelled('job-3'), false);
  db.state.jobs.find(job => job.id === 'job-3').cancel = 1;
  assert.equal(await store.cancelled('job-3'), true);

  await store.reply('u', '12345678', 'hello');
  assert.deepEqual(db.state.outbox.map(row => row.message), ['chunk-a:hello', 'chunk-b']);
  await store.replyArtifact('u', '12345678', { path: 'image.png' }, '', '12345678');
  const pending = await store.pendingReply();
  assert.equal(typeof pending.id, 'number');
  assert.equal(pending.message, 'chunk-a:hello');
  assert.equal(pending.full_result, 0);
  await store.delivered(pending.id);
  assert.equal((await store.pendingReply()).message, 'chunk-b');
  await store.delivered(2);
  const artifact = await store.pendingReply();
  assert.equal(JSON.parse(artifact.artifact_json).path, 'image.png');
  await store.retryReply(artifact.id);
  assert.equal(await store.pendingReply(), undefined);
  assert.equal(db.state.outbox.find(row => row.id === artifact.id).next_attempt > Date.now(), true);
});

test('PostgreSQL Codex transactions reuse one client for nested store calls', async () => {
  const db = fakeCodexDatabase(), store = createPostgresCodexStore(db);
  const snapshot = await store.transaction(async () => {
    await store.saveSettings('u', { groups: ['12345678'], groupReply: 'group' });
    await store.saveRuntime('u', '12345678', { model: 'model-a', effort: 'low' });
    return { settings: await store.settings('u'), runtime: await store.runtime('u', '12345678') };
  });
  assert.equal(db.transactions, 1);
  assert.deepEqual(snapshot, { settings: { groups: ['12345678'], groupReply: 'group' }, runtime: { model: 'model-a', effort: 'low' } });
  await assert.rejects(() => store.transaction(async () => {
    await store.saveSettings('u', { groups: [], groupReply: 'private' });
    throw new Error('rollback fixture');
  }), /rollback fixture/);
});
