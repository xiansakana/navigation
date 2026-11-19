import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';

test('the portfolio owner still needs feature permissions for QQQ endpoints and snapshots', { timeout: 15000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'navigation-dip-access-'));
  const dbPath = path.join(dir, 'navigation.db');
  const db = getDatabase({ dbPath, rbacJsonPath: path.join(dir, 'absent-rbac.json'), portfolioJsonPath: path.join(dir, 'absent-portfolio.json') });
  db.prepare("INSERT INTO meta(key,value) VALUES('portfolio_legacy_owner',?)").run('fixture_owner');
  closeDatabase();
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ server: { host: '127.0.0.1', port }, dbPath: path.join(dir, 'dip.db') }));
  // Fresh FX fixture keeps snapshot requests independent of external quote providers.
  await fs.writeFile(path.join(dir, 'dip.json'), JSON.stringify({ cash: { usdCnyRate: 7.2, fxUpdatedAt: new Date().toISOString() } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    env: { ...process.env, QQQ_DIP_CONFIG_PATH: configPath, NAVIGATION_DB_PATH: dbPath }, stdio: 'ignore', windowsHide: true
  });
  const base = `http://127.0.0.1:${port}/api`;
  const request = (route, permissions, method = 'GET', body, userId = 'fixture_owner') =>
    fetch(base + route, { method, signal: AbortSignal.timeout(3000), headers: {
      'x-portal-user-id': userId, 'x-portal-permissions': Buffer.from(JSON.stringify(permissions)).toString('base64url'),
      'Content-Type': 'application/json'
    }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const until = Date.now() + 5000;
    while (true) {
      try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Await listening. */ }
      assert.ok(child.exitCode === null && Date.now() < until, 'QQQ fixture failed to start');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const view = ['service:qqq-dip:tab-monitor:view'];
    const state = await request('/state', view);
    assert.equal(state.status, 200);
    const privateFields = ['cash', 'lots', 'evaluation', 'notify', 'actions'];
    const snapshot = await state.json();
    for (const field of privateFields) assert.ok(!(field in snapshot));
    const stream = await request('/events', view);
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const event = JSON.parse(frame.split('data: ')[1]);
    for (const field of privateFields) assert.ok(!(field in event));
    for (const [route, method] of [['/cash', 'PUT'], ['/settings', 'PUT'], ['/monitor/start', 'POST'],
      ['/quotes/refresh', 'POST'], ['/lots', 'GET'], ['/lots', 'POST'], ['/actions', 'GET'], ['/round/reset', 'POST']]) {
      assert.equal((await request(route, view, method, method === 'GET' ? undefined : {})).status, 403, route);
    }
    const note = [...view, 'service:qqq-dip:actions-note:edit'];
    assert.equal((await request('/actions', note, 'POST', { type: 'sell' })).status, 403);
    assert.equal((await request('/actions', note, 'POST', { legs: [{ side: 'sell' }] })).status, 403);
    assert.equal((await request('/actions', note, 'POST', { message: 'fixture note' })).status, 200);
    assert.equal((await request('/state', ['service:qqq-dip:view'])).status, 403);
    assert.equal((await request('/state', ['*'], 'GET', undefined, 'other')).status, 403);
    const admin = await (await request('/state', ['*'])).json();
    for (const field of privateFields) assert.ok(field in admin);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
