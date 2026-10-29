import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../shared/db/schema.js';
import { saveRbacBlob } from '../../shared/db/rbac-store.js';
import { createShoppingStore } from './torn-shopping-monitor.js';
import { createTornRunStore } from './torn-worker-runs.js';
import { workerSignature } from './torn-worker-transport.js';
import { randomBytes } from 'node:crypto';

test('one worker owns all five services and restores running intent after process restart without real requests or notifications', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'navigation-torn-worker-'));
  const reservations = await Promise.all([0, 1, 2].map(() => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => resolve(server)); })));
  const [port, companyPort, undercutPort] = reservations.map(server => server.address().port);
  const config = { auth: { username: 'admin', sessionSecret: 'isolated-process-test-secret-1234567890' }, services: [], runtime: { tornMonitorWorker: true, tornMonitorWorkerPort: port } };
  const dbPath = path.join(dir, 'test.db'), db = new Database(dbPath); initSchema(db);
  // Prevent host legacy JSON imports; every fixture is isolated from real configuration.
  db.prepare('INSERT INTO trades(id,data) VALUES(?,?)').run('fixture', '{}');
  saveRbacBlob(db, { users: [{ id: 'usr_admin', username: 'admin', enabled: true, roleIds: ['role_admin'] }], roles: [{ id: 'role_admin', permissions: ['*'] }], permissions: [], menus: [], userPrefs: {} });
  createShoppingStore(db).save('usr_admin', { apiKey: '1234567890abcdef', intervalSeconds: 1, items: [{ id: 1, market: 1 }] });
  const runs = createTornRunStore(db); runs.set('torn-shopping', 'usr_admin', true); runs.set('torn-chain', 'usr_admin', false); runs.set('torn-factions', 'usr_admin', false);
  db.close();
  const portalFile = path.join(dir, 'portal.json'), companyFile = path.join(dir, 'company.json'), undercutFile = path.join(dir, 'undercut.json'), preload = path.join(dir, 'mock.mjs');
  await writeFile(portalFile, JSON.stringify(config));
  for (const [file, service, servicePort] of [[companyFile, 'company', companyPort], [undercutFile, 'undercut', undercutPort]]) await writeFile(file, JSON.stringify({ server: { host: '127.0.0.1', port: servicePort }, [service]: { autoStart: true, intervalSeconds: 30, watchers: [{ id: 'fixture', apiKey: '1234567890abcdef', watchBazaar: false, watchItemMarket: true }] } }));
  await writeFile(preload, `const real=globalThis.fetch;globalThis.fetch=async(input,options)=>{const u=new URL(input);if(u.hostname==='api.torn.com')return Response.json({info:{user:{id:123}},applications:{},itemmarket:u.pathname.includes('/market/')?{listings:[]}:[],bazaar:[],player_id:123});if(u.hostname==='127.0.0.1')return real(input,options);throw Error('Unexpected external request blocked in test');};`);
  await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  let child, output = '';
  const env = { ...process.env, NAVIGATION_DB_PATH: dbPath, PORTAL_CONFIG_PATH: portalFile, TORN_COMPANY_CONFIG_PATH: companyFile, TORN_UNDERCUT_CONFIG_PATH: undercutFile, TORN_COMPANY_STATE_FILE: path.join(dir, 'company-state.json') };
  const start = async () => {
    child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/torn-monitor-worker.mjs'], { cwd: path.resolve(import.meta.dirname, '../..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error('Worker exited: ' + output);
      try { const r = await fetch('http://127.0.0.1:' + port + '/healthz'); if (r.ok) return await r.json(); } catch {}
      await delay(50);
    }
    throw Error('Worker startup timed out: ' + output);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const api = async (action, permissions = ['*']) => {
    const text = JSON.stringify({ at: Date.now(), nonce: randomBytes(16).toString('hex'), method: action === 'state' ? 'GET' : 'POST', path: '/api/torn-shopping/' + action, session: { userId: 'usr_admin', permissions }, headers: { host: '127.0.0.1' }, body: action === 'state' ? null : {} });
    const response = await fetch('http://127.0.0.1:' + port + '/dispatch', { method: 'POST', headers: { 'X-Torn-Signature': workerSignature(text, config) }, body: text });
    return { status: response.status, data: await response.json() };
  };
  try {
    const first = await start(); assert.equal((await api('state')).data.state.running, true);
    const lock = new Database(dbPath);
    lock.exec('BEGIN IMMEDIATE');
    try { await delay(11000); } finally { lock.exec('ROLLBACK'); lock.close(); }
    const alive = await (await fetch('http://127.0.0.1:' + port + '/healthz')).json();
    assert.equal(alive.pid, first.pid, 'SQLite write contention must not restart the worker');
    for (const [servicePort, service] of [[companyPort, 'company'], [undercutPort, 'undercut']]) assert.equal((await (await fetch('http://127.0.0.1:' + servicePort + '/api/state')).json())[service].running, true);
    assert.equal((await api('stop', ['torn-shopping:view'])).status, 403); assert.equal((await api('state')).data.state.running, true);
    const untrusted = await fetch('http://127.0.0.1:' + port + '/dispatch', { method: 'POST', body: '{}' }); assert.equal(untrusted.status, 403);
    await stop(); const second = await start(); assert.notEqual(first.pid, second.pid); assert.equal((await api('state')).data.state.running, true);
    assert.equal((await api('stop')).status, 200); await stop(); await start(); assert.equal((await api('state')).data.state.running, false);
    assert.ok(!JSON.stringify((await api('state')).data.config).includes('1234567890abcdef'));
  } finally {
    await stop();
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(dir, { recursive: true, force: true });
  }
});
