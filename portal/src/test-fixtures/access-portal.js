import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { getDatabase, closeDatabase } from '../../../shared/db/index.js';
import { loadRbac, saveRbac, upsertUser } from '../rbac.js';
import { modulePolicy } from '../access-policy.js';
import { createSessionCookie } from '../auth.js';
import { createBookkeepingStore } from '../bookkeeping-store.js';

export async function startAccessPortal() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'navigation-access-'));
  const previousDb = process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH = path.join(root, 'fixture.db');
  const db = getDatabase({ rbacJsonPath: path.join(root, 'absent-rbac.json'), portfolioJsonPath: path.join(root, 'absent-portfolio.json') });
  const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: req.url, owner: req.headers['x-portal-user-id'] || null, permissions: req.headers['x-portal-permissions'] || null })); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const endpoint = 'http://127.0.0.1:' + upstream.address().port;
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const config = { server: { host: '127.0.0.1', port }, auth: { username: 'fixture-admin', password: 'local-fixture-password', sessionSecret: 'local-fixture-session-secret-1234567890' }, runtime: { externalWorkers: true },
    services: [{ id: 'stock-manage', type: 'proxy', title: '股票管理', path: '/stock-manage', internalUrl: endpoint }, { id: 'torn-company', type: 'proxy', title: '公司监听', path: '/torn-toolbox/company', internalUrl: endpoint }, { id: 'company-team', type: 'proxy', title: '团队独立公司实例', path: '/team-company', internalUrl: endpoint, upstreamPathPrefix: '/team' }] };
  const configFile = path.join(root, 'config.json'); await fs.writeFile(configFile, JSON.stringify(config));
  let rbac = loadRbac(config);
  rbac.roles.push({ id: 'fixture_member', name: '测试成员', permissions: ['service:stock-manage:view', 'service:stock-manage:edit', 'service:torn-company:view', 'service:torn-company:edit'] });
  const a = upsertUser(rbac, { username: 'fixture-a', password: 'local-fixture-password', roleIds: ['fixture_member'] });
  const b = upsertUser(rbac, { username: 'fixture-b', password: 'local-fixture-password', roleIds: ['fixture_member'] });
  const p = modulePolicy(rbac, 'bookkeeping');
  p.grants = [{ kind: 'user', id: a.id, scope: 'user:' + b.id, read: true, write: false }, { kind: 'user', id: a.id, scope: 'team:research', read: true, write: true }];
  rbac.accessPolicy.modules.bookkeeping = p;
  rbac.accessPolicy.teams.push({ id: 'research', name: '研究团队', ownerId: b.id });
  rbac.accessPolicy.modules['stock-manage'] = { ...modulePolicy(rbac, 'stock-manage'), grants: [{ kind: 'user', id: a.id, scope: 'user:' + b.id, read: true, write: false }] };
  rbac.accessPolicy.modules['torn-company'] = { ...modulePolicy(rbac, 'torn-company', config.services), instances: ['company-team'], grants: [{ kind: 'user', id: a.id, scope: 'instance:company-team', read: true, write: false }] };
  saveRbac(rbac);
  const store = createBookkeepingStore(db), account = store.saveAccount(b.id, { name: 'B 的账户', balance: 123 });
  store.saveEntry(b.id, { date: '2026-10-24T12:00:00', type: '支出', amount: 3, accountId: account });
  let output = '';
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { windowsHide: true,
    env: { ...process.env, PORTAL_CONFIG_PATH: configFile, NAVIGATION_EXTERNAL_WORKERS: '1', KNOWLEDGE_DATA_DIR: path.join(root, 'knowledge'), NODE_TEST_CONTEXT: 'fixture' } });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const baseUrl = 'http://127.0.0.1:' + port;
  const cleanup = async () => {
    if (child.exitCode == null && child.signalCode == null) { const exit = once(child, 'exit'), force = setTimeout(() => child.kill('SIGKILL'), 1500); child.kill(); try { await exit; } finally { clearTimeout(force); } }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    closeDatabase(); if (previousDb === undefined) delete process.env.NAVIGATION_DB_PATH; else process.env.NAVIGATION_DB_PATH = previousDb;
    if (path.dirname(root) !== os.tmpdir()) throw new Error('Unexpected fixture directory');
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    const until = Date.now() + 10000;
    while (true) {
      if (child.exitCode != null || Date.now() > until) throw new Error('Portal fixture did not start: ' + output.slice(-2000));
      try { const r = await fetch(baseUrl + '/healthz', { signal: AbortSignal.timeout(500) }); if (r.ok) break; } catch { /* Wait for the listening socket. */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } catch (error) { await cleanup(); throw error; }
  const cookie = uid => createSessionCookie(uid, config.auth.sessionSecret).split(';')[0];
  const request = async (pathname, { uid = a.id, scope, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(baseUrl + pathname, { method, redirect: 'manual', headers: { Cookie: cookie(uid), ...(scope ? { 'X-Navigation-Data-Scope': scope } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  return { root, baseUrl, config, a, b, db, cookie, request, cleanup, update: change => { rbac = loadRbac(config); change(rbac); saveRbac(rbac); } };
}
