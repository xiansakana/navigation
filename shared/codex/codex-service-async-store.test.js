import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCodexService } from './codex-service.js';
import { createCodexStore } from './codex-store.js';

const Database = createRequire(new URL('../../portal/package.json', import.meta.url))('better-sqlite3');
const event = text => ({ post_type: 'message', message_type: 'private', user_id: 12345678, self_id: 22222222, message_id: 42, message: [{ type: 'text', data: { text } }] });

// Mirrors the asynchronous PostgreSQL store surface: every member resolves to
// a promise and transaction callbacks may await nested store calls.
function asyncify(target) {
  return new Proxy(target, {
    get(source, property) {
      const member = source[property];
      if (typeof member === 'function') return (...args) => Promise.resolve().then(() => member.apply(source, args));
      if (property === 'conversations' || property === 'todos') return asyncify(member);
      return member;
    },
  });
}

function fixture(execute, extra = {}) {
  const db = new Database(':memory:'), store = createCodexStore(db), sent = [];
  const config = { codex: { enabled: true, defaultProject: 'navigation', projects: { navigation: { directory: path.resolve(os.tmpdir(), 'codex-async-test'), remote: 'git@example.com:repo.git' } } },
    channels: { qq: { enabled: true } } };
  const user = { userId: 'u1', qqId: '12345678', projects: ['navigation'] };
  const service = createCodexService({ getConfig: () => config, store: asyncify(store), authorize: qq => qq === user.qqId ? user : null,
    prepareMedia: async () => undefined, send: async (c, target, text) => { sent.push({ target, text }); }, execute, ...extra });
  return { store, service, sent, config, close: () => { service.stop(); db.close(); } };
}

test('Codex service drives an asynchronous store through receive, execute and delivery', async () => {
  const sessions = [];
  const f = fixture(async (config, job, session) => { sessions.push({ id: job.id, session }); return { result: '异步完成', sessionId: 'async-thread' }; });
  try {
    f.store.saveSession('u1', 'navigation', '', 'previous-thread');
    await f.service.receive(event('codex navigation 检查代码'));
    await f.service.receive(event('codex navigation 检查代码'));
    assert.equal(f.store.active('u1').length, 1);
    f.service.start();
    await f.service.tick();
    assert.deepEqual(sessions, [{ id: f.store.active('u1')[0].id, session: 'previous-thread' }]);
    assert.equal(f.store.latestResult('u1'), '异步完成');
    assert.equal(f.store.session('u1', 'navigation'), 'async-thread');
    while (f.store.pendingReply()) await f.service.deliver();
    assert.equal(f.store.pendingReply(), undefined);
    assert.ok(f.sent.some(row => /异步完成/.test(row.text)));
  } finally { f.close(); }
});

test('Codex todo scheduler dispatches through an asynchronous store', async () => {
  const f = fixture(async () => ({ result: '待办完成', sessionId: 'todo-thread' }), {
    authorizeWeb: () => true,
    authorizeTodo: () => true,
    readCatalog: async () => ({ models: [{ id: 'test', efforts: ['low'], defaultEffort: 'low' }], defaults: { model: 'test', effort: 'low' } }),
    readUsage: async () => ({ rateLimits: { primary: { usedPercent: 0 } } }),
  });
  try {
    f.config.channels.qq.enabled = false;
    const todo = f.store.todos.create('u1', '12345678', { title: 'todo', project: 'navigation', prompt: 'do it', runtime: { model: 'test', effort: 'low' }, autoRun: true });
    f.service.start();
    await f.service.tick();
    f.store.todos.reconcile();
    assert.equal(f.store.todos.get('u1', todo.id).state, 'succeeded');
    assert.equal(f.store.pendingReply(), undefined);
    assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});
