import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { handleMingliApi } from '../portal/src/mingli.js';
import { createMingliPostgresStore } from '../portal/src/mingli-postgres.js';
import { createPostgresDatabase } from '../portal/src/postgres.js';
import { createPortalPostgresRbac } from '../portal/src/postgres-rbac.js';
import { createPasswordRecord } from '../portal/src/rbac.js';
import { createSessionCookie, resolveRequestUser, verifyLogin } from '../portal/src/auth.js';
import { handleAdminApi } from '../portal/src/admin-api.js';
import { requestDataAccess } from '../portal/src/data-access.js';
import { createPostgresRbacStore } from '../shared/db/postgres/rbac-store.js';
import { createCodexService } from '../shared/codex/codex-service.js';
import { verifyPostgresSchema } from '../shared/db/postgres/readiness.js';
import { startAccessPortal } from '../portal/src/test-fixtures/access-portal.js';
import { moduleInventoryPostgres } from '../portal/src/modules.js';
import { createPostgresBlogRepository } from '../portal/src/blog-postgres.js';
import { createPostgresUsersStore } from '../portal/src/torn-users-postgres.js';
import { UsersMonitor } from '../portal/src/torn-users-monitor.js';
import { createTornRunStore } from '../portal/src/torn-worker-runs.js';
import { createTornWorkerRuntime, tickTornWorker } from '../portal/src/torn-worker-runtime.js';
import { workerSignature } from '../portal/src/torn-worker-transport.js';
import { createCodexAuthMonitor } from '../qq-bot/src/codex-auth-monitor.js';
import { createWatchdogStore, startLoginWatchdog } from '../qq-bot/src/watchdog.js';
import { createPostgresShoppingStore } from '../portal/src/torn-shopping-postgres.js';
import { ShoppingMonitor } from '../portal/src/torn-shopping-monitor.js';
import { createPostgresDestructionStore } from '../portal/src/torn-destruction-postgres.js';
import { createPostgresCompanyAlertsStore } from '../portal/src/torn-company-alerts-postgres.js';
import { createPostgresFactionStore } from '../portal/src/torn-faction-postgres.js';
import { FactionScanner } from '../portal/src/torn-faction-scan.js';
import { createPostgresUndercutStore } from '../torn-toolbox-desktop/src/undercut-store.js';
import { createPostgresQuantStore } from '../stock-manage/src/quant-store.js';
import { createPostgresQuantBacktestStore } from '../stock-manage/src/quant-backtest-store.js';
import { createPostgresKnowledgeLeases } from '../portal/src/knowledge-postgres-leases.js';
import { createPostgresKnowledgeDeviceStore } from '../portal/src/knowledge-devices.js';
import { createPostgresKnowledgeSourceStore } from '../portal/src/knowledge-source-store.js';

async function verifyQqMonitoring(db) {
  let restarts = 0, now = 1000000, usageReads = 0, sent = 0;
  const settings = {
    napcat: { watchdog: { enabled: true, failBeforeRestart: 1, cooldownMs: 600000, settleMs: 1 } },
    codex: { enabled: true }, channels: { email: { enabled: true, smtp: { host: 'fixture' }, to: 'fixture@example.invalid' } },
  };
  const store = createWatchdogStore(db);
  const hooks = { store, schedule: false, now: () => now,
    getStatus: async () => ({ online: false }), restart: async () => { restarts++; } };
  const first = startLoginWatchdog(settings, hooks);
  await first.tick(); first.stop();
  assert.equal(restarts, 1);
  now += 1000;
  const next = startLoginWatchdog(settings, hooks);
  await next.tick(); next.stop();
  assert.equal(restarts, 1);
  assert.ok((await store.read()).incident.id);
  const auth = () => createCodexAuthMonitor({ db, now: () => now, getConfig: () => settings,
    readUsage: async () => { usageReads++; throw Object.assign(new Error('fixture'), { code: 'CODEX_AUTH_REQUIRED' }); },
    send: async () => { sent++; } });
  await Promise.all([auth().tick(), auth().tick()]);
  assert.equal(usageReads, 1);
  assert.equal(sent, 1);
  now += 300000;
  await auth().tick();
  assert.equal(usageReads, 2);
  assert.equal(sent, 1);
}

async function verifyTornUsers(db) {
  const uid = 'torn-owner', store = createPostgresUsersStore(db);
  const event = { id: 1, hospitalUntil: 1030 };
  await store.save(uid, { apiKey: 'a'.repeat(16), targets: [1] });
  const first = await Promise.all([store.record(uid, event), store.record(uid, event)]);
  assert.deepEqual(first.sort(), [false, true]);
  assert.equal((await store.get('torn-other')).history.length, 0);
  const observers = new Map();
  let allowed = true, dispatched = 0, notifications = 0;
  const instance = new UsersMonitor({
    uid, store, initialObservations: [], authorize: async () => allowed,
    request: async () => ({ profile: { id: 1, name: 'Fixture', status: { state: 'Hospital', until: 1030 } } }),
    now: () => 1000, schedule: () => null, cancel: () => {},
    notify: async () => { notifications++; },
  });
  const runs = createTornRunStore(db);
  await runs.set('torn-users', uid, true);
  const stale = (await runs.list())[0];
  await runs.set('torn-users', uid, true);
  await runs.clearIfUnchanged(stale, 'stale reconciliation');
  assert.equal((await runs.list())[0].desired, 1);
  const runtime = createTornWorkerRuntime({ runs, config: {},
    sessionFor: async userId => ({ userId, permissions: ['*'] }),
    jobs: () => ({ 'torn-users': observers }),
    dispatch: async (req, res, url, session, { json }) => {
      assert.equal(session.userId, uid);
      if (url.pathname.endsWith('/start')) {
        dispatched++;
        observers.set(uid, instance);
        await instance.start();
      } else if (url.pathname.endsWith('/stop')) instance.stop();
      return json(res, 200, { ok: true });
    },
  });
  try {
    await runtime.resume();
    await instance.promise;
    assert.equal(dispatched, 1);
    assert.equal(notifications, 0);
    assert.equal((await store.get(uid)).observations[0].id, 1);
    assert.equal(await tickTornWorker(runtime, db), true);
    const resource = (await moduleInventoryPostgres(db)).find(module => module.id === 'torn-users');
    assert.equal(resource.worker.online, 1);
    await runtime.dispatch({ method: 'POST', path: '/api/torn-users/stop', session: { userId: uid }, body: {} });
    assert.equal((await runs.list())[0].desired, 0);
    await runtime.resume();
    assert.equal(dispatched, 1);
    allowed = false;
    await assert.rejects(() => instance.start(), /无权启动/);
  } finally { await runtime.close(); }
}

async function verifyTornShopping(db) {
  const uid = 'shopping-owner', store = createPostgresShoppingStore(db);
  await store.save(uid, { apiKey: 'b'.repeat(16), items: [{ id: 7, name: 'test item', market: 100 }] });
  let sent = 0;
  const job = new ShoppingMonitor({ uid, store, authorize: async () => true, schedule: () => null, cancel: () => {},
    request: async () => ({ itemmarket: { listings: [{ price: 50, amount: 1 }] } }),
    notify: async () => { sent++; } });
  try {
    await job.start(); await job.promise;
    await job.scan();
    assert.equal(sent, 1);
    const saved = await store.get(uid);
    assert.equal(saved.history[0].price, 50);
    assert.equal((await store.get('another-shopper')).history.length, 0);
    await store.clear(uid);
    await job.scan();
    assert.equal(sent, 1);
    assert.equal((await store.get(uid)).history.length, 0);
  } finally { job.stop(); }
}

async function verifyBlog(db, app, member, outsider) {
  const uid = member.id, foreign = outsider.id;
  const post = await app.request('/api/blog/posts', {
    uid, method: 'POST', body: {
      content: '**原生博客** <script>不执行</script>', contentFormat: 'markdown', tags: ['迁移验证'],
      visibility: { audience: 'self' },
    },
  });
  assert.equal(post.status, 201, JSON.stringify(post.data));
  const id = post.data.id;
  const inventory = await moduleInventoryPostgres(db);
  assert.equal(inventory.find(module => module.id === 'blog').records, 1);
  assert.doesNotMatch(JSON.stringify(inventory), /原生博客|不执行/);
  const feed = '/api/blog/posts?q=' + encodeURIComponent('原生博客');
  const visible = await app.request(feed, { uid });
  assert.equal(visible.status, 200, JSON.stringify(visible.data));
  assert.equal(visible.data.posts[0].id, id);
  assert.match(visible.data.posts[0].contentHtml, /<strong>原生博客<\/strong>/);
  assert.doesNotMatch(visible.data.posts[0].contentHtml, /<script>/);
  assert.equal((await app.request(feed, { uid: foreign })).data.posts.length, 0);
  const legacy = 'a'.repeat(32);
  await db.query(`INSERT INTO navigation.blog_images (id,post_id,author_id,mime_type,image_data,position,created_at)
    VALUES ($1,$2,$3,'image/png',$4,0,$5)`, [legacy, id, uid, Buffer.from([1, 2, 3]), new Date().toISOString()]);
  assert.equal((await app.request('/api/blog/images/' + legacy, { uid: foreign })).status, 404);
  assert.equal((await app.request('/api/blog/images/' + legacy, { uid })).status, 200);
  const comments = '/api/blog/posts/' + id + '/comments';
  assert.equal((await app.request(comments, { uid: foreign, method: 'POST', body: { content: '私密文章' } })).status, 404);
  assert.equal((await app.request('/api/blog/posts/' + id, {
    uid, method: 'PUT', body: { content: '已公开', tags: ['公开'], visibility: { audience: 'public' } },
  })).status, 200);
  const replies = await Promise.all([
    app.request(comments, { uid: foreign, method: 'POST', body: { content: '评论一' } }),
    app.request(comments, { uid: foreign, method: 'POST', body: { content: '评论二' } }),
  ]);
  assert.deepEqual(replies.map(result => result.status).sort(), [201, 429]);
  const stored = await app.request(comments, { uid });
  assert.equal(stored.data.comments.length, 1);
  assert.equal(stored.data.comments[0].canDelete, true);

  const video = await app.request('/api/blog/posts/' + id + '/video-uploads', { uid, method: 'POST', body: { size: 12, mimeType: 'video/mp4' } });
  assert.equal(video.status, 201, JSON.stringify(video.data));
  const upload = '/api/blog/video-uploads/' + video.data.id;
  assert.equal((await app.request(upload, { uid: foreign })).status, 404);
  const part = await fetch(app.baseUrl + upload + '/parts/1', {
    method: 'PUT', headers: { Cookie: app.cookie(uid), 'Content-Type': 'application/octet-stream' },
    body: Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0]),
  });
  assert.equal(part.status, 200, await part.text());
  const child = await db.query('SELECT byte_size FROM navigation.blog_video_parts WHERE upload_id=$1', [video.data.id]);
  assert.equal(child.rows[0].byte_size, '12');
  assert.equal((await app.request(upload, { uid, method: 'DELETE' })).status, 200);
  assert.equal((await db.query('SELECT 1 FROM navigation.blog_video_parts WHERE upload_id=$1', [video.data.id])).rowCount, 0);
  const queued = await app.request('/api/blog/posts/' + id + '/video-uploads', { uid, method: 'POST', body: { size: 12, mimeType: 'video/mp4' } });
  assert.equal(queued.status, 201);
  const { rows: [uploadRow] } = await db.query("UPDATE navigation.blog_video_uploads SET state='storing' WHERE id=$1 RETURNING *", [queued.data.id]);
  const repository = createPostgresBlogRepository(db);
  const file = { kind: 'video', mimeType: 'video/mp4', url: 'https://example.invalid/video.mp4', storageKey: uploadRow.storage_key, thumbnailData: Buffer.from([0xff, 0xd8]) };
  const result = await Promise.all([1, 2].map(() => repository.completeVideo(uploadRow, {
    userId: uid, permissions: ['blog:post:edit'],
  }, file)));
  assert.deepEqual(result.map(row => row.status).sort(), [201, 404]);
  const mediaId = result.find(row => row.status === 201).id;
  assert.equal((await app.request('/api/blog/media/' + mediaId + '?thumbnail=1', { uid })).status, 200);
  assert.equal((await app.request('/api/blog/posts/' + id, { uid, method: 'DELETE' })).status, 200);
  assert.equal((await app.request(comments, { uid: foreign })).status, 404);
  assert.equal((await db.query("SELECT count(*) FROM navigation.blog_media_cleanup WHERE storage_key=$1 AND kind='object'", [file.storageKey])).rows[0].count, '1');
}

async function verifyTornDestruction(db) {
  const first = createPostgresDestructionStore(db);
  const second = createPostgresDestructionStore(db);
  const uid = 'torn-destruction-fixture';
  await db.query('INSERT INTO navigation.torn_chain_monitors(user_id,config_json) VALUES($1,$2)', [
    uid, JSON.stringify({ apiKey: 'fixtureskey12345', apiIntervalSeconds: 3 }),
  ]);
  assert.equal((await first.get(uid)).config.apiIntervalSeconds, 3);
  const alive = { id: 2468, respect: 10, name: 'fixture', leaderId: 12, leaderName: 'fixture-leader', isDestroyed: false, checkedAt: 100 };
  assert.equal(await first.observe(uid, alive), null);
  const zero = { ...alive, respect: 0, checkedAt: 101 };
  const events = await Promise.all([first.observe(uid, zero), second.observe(uid, zero)]);
  assert.deepEqual(events.filter(Boolean).map(event => event.kind), ['respect-zero']);
  await second.observe(uid, { ...zero, isDestroyed: true, checkedAt: 102 });
  assert.equal(await first.observe(uid, { ...alive, checkedAt: 103 }), null);
  assert.equal((await first.get(uid)).history[0].destroyedConfirmedAt, 102);
  assert.equal((await second.observations(uid))[0].isDestroyed, true);
  assert.deepEqual(await second.observations('other-torn-destruction-fixture'), []);
  await first.clear(uid);
  assert.deepEqual((await second.get(uid)).history, []);
}

async function verifyTornCompanyAlerts(db) {
  const first = createPostgresCompanyAlertsStore(db);
  const second = createPostgresCompanyAlertsStore(db);
  const uid = 'torn-company-alerts-fixture';
  const watcher = { id: 'fixture', label: 'Company fixture' };
  const signals = [{ key: 'training:fixture', message: 'Fixture event' }];
  const commit = store => store.commit(uid, 'fixture:training', signals, 'training', watcher, 100);
  const results = await Promise.all([commit(first), commit(second)]);
  assert.equal(results.flat().length, 1);
  assert.equal((await second.get(uid)).history[0].watcherId, watcher.id);
  assert.deepEqual(await commit(second), []);
  assert.deepEqual((await first.get('other-company-alerts-fixture')).history, []);
}

async function verifyTornFactionScan(db) {
  const first = createPostgresFactionStore(db);
  const restarted = createPostgresFactionStore(db);
  const uid = 'torn-faction-scan-fixture', today = 21000;
  await first.save(uid, { apiKey: 'fixturekey123456' });
  await first.savePoints(uid, 101, [
    { day: today - 1, timestamp: (today - 1) * 86400, value: 50 },
    { day: today - 2, timestamp: (today - 2) * 86400, value: 40 },
  ]);
  const rows = [{ id: 3, respect: 8, status: 'excluded' }];
  const checkpoint = { rows, cursor: 1, today, listComplete: true, currentFaction: 3 };
  await first.saveRun(uid, checkpoint);
  const saved = await restarted.get(uid);
  assert.deepEqual(saved.run, checkpoint);
  const scanner = new FactionScanner({
    uid, store: restarted, initialRun: saved.run, now: () => today * 86400,
    authorize: async () => true,
    request: () => { throw new Error('A completed checkpoint made an unexpected external request'); },
  });
  await scanner.start();
  await scanner.promise;
  assert.equal(scanner.status().stage, '本次列表扫描完成');
  assert.equal((await restarted.points(uid, 101, today - 2, today - 1)).size, 2);
  assert.equal((await restarted.get('other-faction-fixture')).run.rows.length, 0);
  await restarted.saveRun(uid, {});
  assert.equal((await first.get(uid)).run.rows.length, 0);
}

async function verifyTornUndercut(db) {
  const watcher = { id: 'undercut-fixture', apiKey: 'fixturekey123456' };
  const first = createPostgresUndercutStore(db);
  await first.save(watcher, {
    activeKeys: new Set(['market:1']), alertMap: new Map(), pendingMarket: new Map([['im-2', { firstSeenAt: 1000 }]]),
  });
  const restarted = createPostgresUndercutStore(db);
  assert.deepEqual((await restarted.restore(watcher)).activeKeys, ['market:1']);
  assert.deepEqual((await restarted.restore(watcher)).pendingMarket, [['im-2', { firstSeenAt: 1000 }]]);
  assert.equal(await restarted.restore({ ...watcher, apiKey: 'fixturekey000000' }), null);
}

async function verifyTornWorkerProcess(db, dsn, uid) {
  const reservations = await Promise.all(Array.from({ length: 3 }, async () => {
    const server = net.createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
  }));
  const [workerPort, companyPort, undercutPort] = reservations.map(server => server.address().port);
  await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'navigation-torn-postgres-'));
  const paths = Object.fromEntries(['portal', 'company', 'undercut', 'state', 'sqlite'].map(name => [name, path.join(dir, name + '.json')]));
  const config = { auth: { sessionSecret: randomUUID() }, services: [], runtime: { tornMonitorWorkerPort: workerPort } };
  let child, exited, output = '';
  const stop = async () => {
    if (!child) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; }
    finally { clearTimeout(force); child = undefined; }
  };
  try {
    await writeFile(paths.portal, JSON.stringify(config));
    for (const [service, port] of [['company', companyPort], ['undercut', undercutPort]]) {
      await writeFile(paths[service], JSON.stringify({ server: { host: '127.0.0.1', port }, [service]: { autoStart: false } }));
    }
    const mock = path.join(dir, 'mock.mjs');
    await writeFile(mock, `const real = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        if (url.hostname === '127.0.0.1') return real(input, options);
        if (url.hostname === 'api.torn.com') return Response.json({ search: [], info: { user: { id: 123 } } });
        throw new Error('External request blocked in test');
      };`);
    const env = {
      ...process.env, NAVIGATION_DATABASE_ENGINE: 'postgres', NAVIGATION_DB_PATH: paths.sqlite,
      NAVIGATION_TORN_POSTGRES_URL: dsn, NAVIGATION_RBAC_POSTGRES_URL: dsn,
      PORTAL_CONFIG_PATH: paths.portal, TORN_COMPANY_CONFIG_PATH: paths.company,
      TORN_UNDERCUT_CONFIG_PATH: paths.undercut, TORN_COMPANY_STATE_FILE: paths.state,
    };
    const run = async () => {
      child = spawn(process.execPath, ['--import', pathToFileURL(mock).href, 'scripts/torn-monitor-worker.mjs'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      exited = once(child, 'exit');
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
      const deadline = Date.now() + 10000;
      while (child.exitCode === null && Date.now() < deadline) {
        const status = await fetch('http://127.0.0.1:' + workerPort + '/readyz', { signal: AbortSignal.timeout(500) }).catch(() => null);
        if (status?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('PostgreSQL Torn worker readiness failed: ' + output);
    };
    await createPostgresDestructionStore(db).save(uid, { apiKey: 'fixturekey123456' });
    const runs = createTornRunStore(db);
    await runs.set('torn-chain', uid, true);
    const checkRunning = async () => {
      const body = JSON.stringify({ at: Date.now(), nonce: randomUUID().replaceAll('-', ''), method: 'GET',
        path: '/api/torn-chain/state', session: { userId: uid, permissions: ['*'] }, headers: { host: '127.0.0.1' }, body: null });
      const response = await fetch('http://127.0.0.1:' + workerPort + '/dispatch', {
        method: 'POST', headers: { 'X-Torn-Signature': workerSignature(body, config) }, body,
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.state.running, true, JSON.stringify({ state: data.state, output }));
    };
    await run();
    await checkRunning();
    await stop();
    await run();
    await checkRunning();
    assert.equal((await fetch('http://127.0.0.1:' + undercutPort + '/api/state')).status, 200);
    await assert.rejects(() => readFile(paths.sqlite), { code: 'ENOENT' });
    await runs.set('torn-chain', uid, false);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function verifyKnowledgeLeases(db) {
  const uid = 'knowledge-lease-fixture', stamp = new Date().toISOString();
  const devices = createPostgresKnowledgeDeviceStore(db);
  const pairing = await devices.start('Worker fixture');
  assert.equal((await devices.inspect(pairing.userCode)).label, 'Worker fixture');
  assert.equal(await devices.approve(uid, pairing.userCode), true);
  const polls = await Promise.all([devices.poll(pairing.deviceCode, async owner => owner === uid), devices.poll(pairing.deviceCode, async owner => owner === uid)]);
  assert.deepEqual(polls.map(result => result.status).sort(), ['approved', 'expired']);
  const { token, deviceId: workerId } = polls.find(result => result.status === 'approved');
  assert.equal((await devices.authenticate(token)).user_id, uid);
  const capabilities = { media: { ready: true, detail: 'cuda' }, codex: { ready: true }, pipeline: { version: 1 } };
  await db.query(`INSERT INTO navigation.knowledge_worker_instances(user_id,worker_id,last_seen,label,capabilities_json)
    VALUES($1,$2,$3,'Fixture',$4)`, [uid, workerId, stamp, JSON.stringify(capabilities)]);
  await db.query(`INSERT INTO navigation.knowledge_settings(user_id,pipeline_json) VALUES($1,'{"mediaConcurrency":1,"summaryConcurrency":1}')`, [uid]);
  for (const id of ['knowledge-a', 'knowledge-b']) {
    await db.query(`INSERT INTO navigation.knowledge_documents(id,user_id,title,original_name,byte_size,mime_type,backend,status,created_at,updated_at)
      VALUES($1,$2,$1,'fixture.mp4',100,'video/mp4','codex','queued',$3,$3)`, [id, uid, stamp]);
  }
  const sources = createPostgresKnowledgeSourceStore(db);
  await sources.add(uid, 'knowledge-a', 'fixtures/a.mp4');
  await sources.enqueue(uid, 'knowledge-a');
  const archivalJobs = (await Promise.all([sources.claim(), createPostgresKnowledgeSourceStore(db).claim()])).filter(Boolean);
  assert.equal(archivalJobs.length, 1);
  const [archive] = archivalJobs;
  assert.equal(archive.document_id, 'knowledge-a');
  assert.equal(archive.attempts, 0);
  assert.equal(await sources.update({ ...archive, user_id: 'other' }, { state: 'ready' }), false);
  assert.equal(await sources.update({ ...archive, lease: 'other' }, { state: 'ready' }), false);
  await assert.rejects(() => sources.deleting(uid, archive.document_id), { status: 409 });
  assert.equal(await sources.update(archive, { state: 'ready', upload_ms: 42 }), true);
  await sources.release(archive);
  assert.equal((await sources.public(uid, archive.document_id)).timings.uploadMs, 42);
  const first = createPostgresKnowledgeLeases(db), second = createPostgresKnowledgeLeases(db);
  const claim = store => store.claim(uid, ['codex'], workerId);
  const acquisitions = (await Promise.all([claim(first), claim(second)])).filter(Boolean);
  assert.equal(acquisitions.length, 1);
  const [job] = acquisitions;
  assert.equal(job.row.id, 'knowledge-a');
  assert.equal(await first.progress('other-knowledge-owner', job.row.id, job.lease, 'spurious', 10), false);
  await assert.rejects(() => first.phase(uid, job.row.id, job.lease, 'summary'), { status: 409 });
  assert.equal(await first.phase(uid, job.row.id, job.lease, 'summary_wait'), true);
  assert.equal(await first.phase(uid, job.row.id, job.lease, 'summary'), true);
  const next = await claim(second);
  assert.equal(next.row.id, 'knowledge-b');
  assert.equal(await second.phase(uid, next.row.id, next.lease, 'summary_wait'), true);
  assert.equal(await second.phase(uid, next.row.id, next.lease, 'summary'), false);
  await db.query("UPDATE navigation.knowledge_documents SET heartbeat='2000-01-01T00:00:00.000Z' WHERE id=$1", [job.row.id]);
  assert.equal(await first.progress(uid, job.row.id, job.lease, 'expired', 90), false);
  const recovered = await claim(createPostgresKnowledgeLeases(db));
  assert.equal(recovered.row.id, job.row.id);
  assert.notEqual(recovered.lease, job.lease);
  assert.equal(Number(recovered.row.attempt), 2);
  assert.equal((await devices.list(uid))[0].online, true);
  assert.equal(await devices.revoke('other-knowledge-owner', workerId), false);
  assert.equal(await devices.revoke(uid, workerId), true);
  assert.equal(await devices.authenticate(token), undefined);
  assert.equal(await first.progress(uid, recovered.row.id, recovered.lease, 'revoked', 90), false);
  assert.equal(await claim(second), null);
}

async function verifyQuant(db) {
  const uid = 'quant-fixture', outsider = 'quant-fixture-other';
  const first = createPostgresQuantStore({}, db), second = createPostgresQuantStore({}, db);
  await Promise.all([
    first.update(uid, state => { state.settings.symbols = ['GOOG']; }),
    second.update(uid, state => { state.paper.cash -= 500; }),
    second.update(uid, state => { state.paper.cash -= 500; }),
  ]);
  const saved = await first.read(uid);
  assert.deepEqual(saved.settings.symbols, ['GOOG']);
  assert.equal(saved.paper.cash, 99000);
  assert.equal((await second.read(outsider)).paper.cash, 100000);
  await assert.rejects(() => first.update(uid, state => {
    state.paper.cash = 1;
    throw new Error('rollback fixture');
  }), /rollback fixture/);
  assert.equal((await second.read(uid)).paper.cash, 99000);

  const backtests = createPostgresQuantBacktestStore(db);
  const result = await backtests.save(uid, { period: '1y', results: [{ symbol: 'GOOG' }] });
  assert.equal((await backtests.list(uid))[0].id, result.id);
  assert.equal(await backtests.get(outsider, result.id), null);
  assert.equal(await backtests.remove(outsider, result.id), false);
  assert.deepEqual(await backtests.get(uid, result.id), result);
  assert.equal(await backtests.remove(uid, result.id), true);
}

async function verifyRbac(db) {
  const lowLevel = createPostgresRbacStore(db);
  const writer = createPortalPostgresRbac(db);
  const reader = createPortalPostgresRbac(db);
  const config = { auth: { anonymousGuest: false, sessionSecret: 'isolated-postgres-test-only' }, services: [] };
  await assert.rejects(() => reader.load(config), { status: 503 });
  const member = { id: 'member', username: 'member', roleIds: ['codex'], enabled: true, ...createPasswordRecord('fixture-passphrase') };
  const outsider = { id: 'member-b', username: 'member-b', roleIds: [], enabled: true };
  const admin = { id: 'admin', username: 'admin', roleIds: ['role_admin'], enabled: true };
  await lowLevel.save({
    roles: [{ id: 'role_admin', name: '管理员', permissions: ['*'] }, { id: 'codex', name: 'Codex', permissions: ['qq-codex:execute'] }],
    users: [member, admin, outsider],
  });
  const replies = [];
  const codex = createCodexService({
    getConfig: () => ({
      channels: { qq: { enabled: true } },
      codex: { enabled: true, allowedUsers: [{ qqId: '123456', userId: member.id }] },
    }),
    readRbac: () => lowLevel.load(),
    store: { transaction: callback => callback(), event: () => true, reply: (...args) => replies.push(args) },
  });
  const receiveCodexHelp = messageId => codex.receive({
    post_type: 'message', message_type: 'private', message_id: messageId, user_id: 123456, self_id: 999999,
    message: [{ type: 'text', data: { text: 'codex 帮助' } }],
  });
  assert.equal(await receiveCodexHelp(1), true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], member.id);
  const identity = await reader.load(config);
  assert.equal(verifyLogin('member', 'fixture-passphrase', config, identity).id, member.id);
  const cookie = createSessionCookie(member.id, config.auth.sessionSecret).split(';')[0];
  const req = { method: 'GET', url: '/api/mingli/cases', headers: { cookie } };
  const session = resolveRequestUser(req, config, identity);
  assert.equal(requestDataAccess(req, session, 'mingli', config, 'read', identity).ownerId, member.id);
  assert.throws(() => requestDataAccess({ ...req, headers: { ...req.headers, 'x-navigation-data-scope': 'user:admin' } },
    session, 'mingli', config, 'read', identity), { status: 403 });
  const a = await writer.load(config), b = await reader.load(config);
  a.userPrefs = { member: { fromA: true } };
  b.userPrefs = { member: { fromB: true } };
  const results = await Promise.allSettled([writer.save(a), reader.save(b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await assert.rejects(() => lowLevel.save({ users: [] }), { status: 409 });
  const before = await lowLevel.revision();
  const adminResponse = await handleAdminApi({ method: 'POST' }, {}, new URL('http://localhost/api/admin/users'),
    { userId: admin.id }, config, (_, status, body) => ({ status, body }),
    async () => ({ id: member.id, username: member.username, roleIds: [], enabled: false }), writer);
  assert.equal(adminResponse.status, 200);
  assert.equal(await lowLevel.revision(), before + 1n);
  const fresh = await reader.load(config);
  assert.equal(resolveRequestUser(req, config, fresh), null);
  assert.equal(verifyLogin('member', 'fixture-passphrase', config, fresh), null);
  assert.equal(await receiveCodexHelp(2), true);
  assert.equal(replies.length, 1);
  await db.query("UPDATE navigation.rbac_snapshot SET payload = payload WHERE id = 1");
  assert.equal(await lowLevel.revision(), before + 2n);
  const enabled = await writer.load(config);
  enabled.users.find(user => user.id === member.id).enabled = true;
  await writer.save(enabled);
  const dsn = new URL('postgresql://127.0.0.1/');
  dsn.username = process.env.PGUSER || 'rehearsal';
  dsn.password = process.env.PGPASSWORD || '';
  dsn.hostname = process.env.PGHOST || '127.0.0.1';
  dsn.port = process.env.PGPORT || '5432';
  dsn.pathname = '/' + process.env.PGDATABASE;
  await verifyTornWorkerProcess(db, dsn.toString(), admin.id);
  const running = await startAccessPortal({ extraEnv: {
    NAVIGATION_RBAC_POSTGRES_URL: dsn.toString(), NAVIGATION_MINGLI_POSTGRES_URL: dsn.toString(),
    NAVIGATION_BLOG_POSTGRES_URL: dsn.toString(), NAVIGATION_RESOURCES_POSTGRES_URL: dsn.toString(),
  } });
  try {
    assert.equal((await fetch(running.baseUrl + '/readyz')).status, 200);
    const login = () => fetch(running.baseUrl + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: member.username, password: 'fixture-passphrase' }),
    });
    const response = await login();
    assert.equal(response.status, 200, await response.text());
    const authenticated = await running.request('/api/me', { uid: member.id });
    assert.equal(authenticated.data.userId, member.id);
    assert.equal((await running.request('/api/me/data-scopes?module=mingli', { uid: member.id })).status, 200);
    const written = await running.request('/api/mingli/cases', { uid: member.id, method: 'POST', body: {
      name: 'PostgreSQL end-to-end case', birth: { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1 },
      tags: [], notes: '',
    } });
    assert.equal(written.status, 201, JSON.stringify(written.data));
    const deadline = Date.now() + 3000;
    let audit;
    while (!(audit = (await db.query("SELECT actor_id,owner_id,status FROM navigation.data_access_audit WHERE module_id='mingli'")).rows[0])) {
      if (Date.now() >= deadline) throw new Error('No audit row in PostgreSQL');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(audit, { actor_id: member.id, owner_id: member.id, status: '201' });
    await verifyBlog(db, running, member, outsider);
    const adminWrite = await running.request('/api/admin/users', {
      uid: admin.id, method: 'POST', body: { id: member.id, username: member.username, enabled: false, roleIds: [] },
    });
    assert.equal(adminWrite.status, 200, JSON.stringify(adminWrite.data));
    assert.equal((await login()).status, 401);
    assert.equal((await running.request('/api/mingli/cases', { uid: member.id })).status, 403);
  } finally { await running.cleanup(); }
}

test('Mingli HTTP entry point uses PostgreSQL for owner-scoped cases, categories, filters and import', async () => {
  const db = createPostgresDatabase();
  let schemaCreated = false;
  try {
    const { rows: [database] } = await db.query('SELECT current_database() AS name');
    assert.match(database.name, /^navigation_rehearsal_[a-z0-9_]+$/);
    await assert.rejects(() => verifyPostgresSchema(db), { code: 'POSTGRES_NOT_READY' });
    const ddl = await readFile(new URL('../shared/db/postgres/001-initial.sql', import.meta.url), 'utf8');
    await db.transaction(async client => {
      await client.query('CREATE SCHEMA navigation');
      await client.query('SET LOCAL search_path = navigation, pg_catalog');
      await client.query(ddl);
    });
    schemaCreated = true;
    assert.deepEqual(await verifyPostgresSchema(db), { database: database.name, version: '001-initial' });
    await verifyTornUsers(db);
    await verifyTornShopping(db);
    await verifyTornDestruction(db);
    await verifyTornCompanyAlerts(db);
    await verifyTornFactionScan(db);
    await verifyTornUndercut(db);
    await verifyQuant(db);
    await verifyKnowledgeLeases(db);
    await verifyQqMonitoring(db);
    await verifyRbac(db);
    const store = createMingliPostgresStore(db);
    const session = (userId, isGuest = false) => ({ userId, isGuest, permissions: ['*'] });
    async function call(route, method = 'GET', data, user = session('a')) {
      const req = {
        method, headers: { host: 'localhost' },
        async *[Symbol.asyncIterator]() { if (data !== undefined) yield Buffer.from(JSON.stringify(data)); },
      };
      return handleMingliApi(req, { setHeader() {} }, new URL('http://localhost/api/mingli' + route), user,
        (_, status, body) => ({ status, body }), () => store);
    }

    assert.equal((await call('/cases', 'GET', undefined, session('guest', true))).status, 403);
    const [first, second] = await Promise.all([
      call('/categories', 'POST', { name: 'Stocks' }),
      call('/categories', 'POST', { name: 'stocks' }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 400]);
    const categoryId = (first.body.category || second.body.category).id;
    const { body: { category: foreign } } = await call('/categories', 'POST', { name: 'STOCKS' }, session('b'));
    const input = {
      name: '案例 A %_', birth: { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1, location: 'City' },
      notes: '核对出生记录', tags: ['学习'], categoryId, userId: 'b',
    };
    const created = await call('/cases', 'POST', input);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.case.id;
    assert.equal(created.body.case.categoryId, categoryId);
    assert.equal((await call('/cases', 'POST', { ...input, categoryId: foreign.id })).status, 400);
    assert.equal((await call('/cases/' + id, 'GET', undefined, session('b'))).status, 404);
    const filters = encodeURIComponent(JSON.stringify({ gender: 1, location: 'CITY', notes: 'yes', solarFrom: '2005-12-01', pillars: [{ gan: '乙' }, {}, {}, {}], characters: ['酉'] }));
    const list = await call('/cases?search=%25_&filters=' + filters);
    assert.equal(list.body.total, 1, JSON.stringify(list.body));
    const updated = await call('/cases/' + id, 'PUT', { ...input, name: '已更新' });
    assert.equal(updated.body.case.name, '已更新');
    const notAssigned = await call('/cases/category', 'POST', { ids: [id, 'a'.repeat(32)], categoryId: null });
    assert.equal(notAssigned.status, 404);
    assert.equal((await call('/cases/' + id)).body.case.categoryId, categoryId);
    assert.equal((await call('/categories/' + categoryId, 'DELETE')).body.moved, 1);
    assert.equal((await call('/cases/' + id)).body.case.categoryId, null);
    const bundle = { format: 'navigation-wenzhen-v1', settings: { midnight: false }, groups: [{ id: 'group', name: '家人' }], cases: [{
      guid: '11111111-1111-4111-8111-111111111111', name: '测试命例', sex: 2, solarTime: '2005-12-23 09:00:00',
      sunTime: '2005-12-23 08:37:00', bz: '乙 酉 戊 子 辛 巳 壬 辰', groupGuid: 'group', type: 1,
    }] };
    assert.equal((await call('/import/preview', 'POST', bundle)).body.matched, 1);
    const imports = await Promise.all([call('/import/confirm', 'POST', bundle), call('/import/confirm', 'POST', bundle)]);
    assert.deepEqual(imports.map(result => result.body.imported).sort(), [0, 1]);
    assert.equal((await call('/cases', 'GET', undefined, session('b'))).body.total, 0);
    assert.equal((await call('/cases/' + id, 'DELETE')).status, 200);
  } finally {
    if (schemaCreated) await db.query('DROP SCHEMA navigation CASCADE');
    await db.close();
  }
});
