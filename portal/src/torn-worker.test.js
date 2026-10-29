import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { workerSignature, verifyWorkerMessage, forwardTornWorker } from './torn-worker-transport.js';
import { createTornRunStore } from './torn-worker-runs.js';
import { createTornWorkerRuntime, tickTornWorker } from './torn-worker-runtime.js';
import { Readable } from 'node:stream';
import { createChainApiClient } from './torn-chain-monitor.js';

const config = { auth: { sessionSecret: 'unique-test-secret-for-torn-worker-12345' } };
test('a busy SQLite heartbeat cannot crash the worker and succeeds on the following tick', () => {
  let busy = true, ticks = 0, writes = 0;
  const runtime = { reconcile() { ticks++; } }, db = { prepare() { return { run() { if (busy) throw Object.assign(Error('locked'), { code: 'SQLITE_BUSY' }); writes++; } }; } };
  assert.equal(tickTornWorker(runtime, db), false);
  busy = false; assert.equal(tickTornWorker(runtime, db), true);
  assert.equal(ticks, 2); assert.equal(writes, 1);
  assert.equal(tickTornWorker({ reconcile() { throw Object.assign(Error('locked'), { code: 'SQLITE_LOCKED' }); } }, db), false);
});
test('worker envelopes reject tampering, expiration, replay and wrong secrets', () => {
  const text = JSON.stringify({ at: 100000, nonce: 'a'.repeat(32), path: '/api/torn-shopping/state' });
  const signature = workerSignature(text, config), seen = new Map();
  assert.equal(verifyWorkerMessage(text, signature, config, seen, 100000).path, '/api/torn-shopping/state');
  assert.throws(() => verifyWorkerMessage(text, signature, config, seen, 100000), /Replayed/);
  assert.throws(() => verifyWorkerMessage(text + ' ', signature, config, new Map(), 100000), /Unauthorized/);
  assert.throws(() => verifyWorkerMessage(text, signature, config, new Map(), 131000), /Expired/);
  assert.throws(() => verifyWorkerMessage(text, workerSignature(text, { auth: { sessionSecret: 'different-secret-for-tests-1234567890' } }), config, new Map(), 100000), /Unauthorized/);
});

test('Portal forwards scoped permissions, preserves query and rejects cross-site writes without a local fallback', async () => {
  let calls = 0, result;
  const deps = { config, json: (_res, status, body) => { result = { status, body }; }, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'http://127.0.0.1:8792/dispatch');
    const message = verifyWorkerMessage(options.body, options.headers['X-Torn-Signature'], config, new Map());
    assert.equal(message.session.userId, 'owner'); assert.deepEqual(message.session.dataAccess.permissions, ['torn-shopping:view']);
    assert.equal(message.path, '/api/torn-shopping/state?offset=50');
    assert.equal(message.headers.authorization, undefined); assert.equal(message.headers.cookie, undefined);
    return { status: 403, json: async () => ({ ok: false, error: 'Denied' }) };
  } };
  const req = Readable.from([]); req.method = 'GET'; req.headers = { host: 'test', cookie: 'secret', authorization: 'secret' };
  const session = { userId: 'owner', permissions: ['*'], dataAccess: { permissions: ['torn-shopping:view'] } };
  await forwardTornWorker(req, { setHeader() {} }, new URL('http://test/api/torn-shopping/state?offset=50'), session, deps);
  assert.equal(result.status, 403); assert.equal(calls, 1);
  req.method = 'POST'; req.headers.origin = 'https://evil.test';
  await forwardTornWorker(req, {}, new URL('http://test/api/torn-shopping/start'), session, deps);
  assert.equal(result.status, 403); assert.equal(calls, 1);
  req.method = 'GET';
  await forwardTornWorker(req, {}, new URL('http://test/api/torn-shopping/state'), session, { ...deps, fetchImpl: async () => { throw Error('private internal failure'); } });
  assert.equal(result.status, 503); assert.ok(!JSON.stringify(result).includes('private internal failure'));
});

test('worker restart resumes only desired permitted tasks; shutdown preserves intent, explicit stop and fatal errors clear it', async () => {
  const db = new Database(':memory:'), runs = createTornRunStore(db);
  let instances, stopped = 0;
  function create() {
    instances = new Map();
    return createTornWorkerRuntime({ runs, config, jobs: () => ({ 'torn-shopping': instances }),
      sessionFor: uid => uid === 'disabled' ? null : { userId: uid, permissions: uid === 'denied' ? [] : ['*'] },
      dispatch: async (req, res, url, session, deps) => {
        if (!session.permissions.includes('*')) return deps.json(res, 403, { ok: false, error: 'Denied' });
        const action = url.pathname.split('/').at(-1);
        let job = instances.get(session.userId);
        if (!job) { job = { running: false, busy: false, error: '', status() { return this; }, stop() { this.running = false; stopped++; } }; instances.set(session.userId, job); }
        if (action === 'start') job.running = true;
        if (['stop', 'config', 'reset'].includes(action)) job.stop();
        return deps.json(res, 200, { ok: true, ...(action === 'state' ? { state: { running: job.running, error: job.error } } : {}) });
      }
    });
  }
  const message = (uid, action) => ({ method: 'POST', path: '/api/torn-shopping/' + action, session: { userId: uid, permissions: ['*'] }, headers: {}, body: {} });
  try {
    for (const uid of ['active', 'disabled', 'denied']) runs.set('torn-shopping', uid, true);
    runs.set('torn-shopping', 'stopped', false);
    let runtime = create(); await runtime.resume();
    assert.ok(instances.get('active').running); assert.ok(!instances.has('stopped'));
    assert.equal(runs.list().find(row => row.user_id === 'denied').desired, 0);
    await runtime.close(); assert.equal(runs.list().find(row => row.user_id === 'active').desired, 1);
    runtime = create(); await runtime.resume(); assert.ok(instances.get('active').running);
    await runtime.dispatch(message('active', 'stop')); assert.equal(runs.list().find(row => row.user_id === 'active').desired, 0);
    await runtime.dispatch(message('active', 'start')); await runtime.dispatch(message('active', 'config'));
    assert.equal(runs.list().find(row => row.user_id === 'active').desired, 0);
    await runtime.dispatch(message('active', 'start')); instances.get('active').running = false; instances.get('active').error = 'All keys invalid'; runtime.reconcile();
    assert.equal(runs.list().find(row => row.user_id === 'active').desired, 0);
    assert.equal(runs.list().find(row => row.user_id === 'active').error, 'All keys invalid');
    assert.ok(stopped > 0); await runtime.close();
  } finally { db.close(); }
});

test('shared worker client allows only required legacy API endpoints and keeps keys on the official host', async () => {
  const paths = [];
  const request = createChainApiClient({ spacingMs: 0, fetchImpl: async url => { paths.push(new URL(url).pathname); return { ok: true, json: async () => ({}) }; } });
  for (const path of ['user/basic', 'user/bazaar', 'user/itemmarket', 'https://api.torn.com/company/?selections=applications']) await request(path, 'test');
  assert.equal(paths.length, 4);
  await assert.rejects(request('https://evil.test/v2/user/basic', 'secret'), /无效/);
  await assert.rejects(request('https://api.torn.com/company/?selections=employees', 'secret'), /无效/);
  assert.equal(paths.length, 4);
});
