import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createInternalNotificationSettingsHandler } from './notification-settings.js';
import { portfolioIdentityMiddleware } from '../../shared/portfolio-user.js';

test('internal notification snapshot requires service auth and leaves portfolio identity checks intact', async t => {
  const handler = createInternalNotificationSettingsHandler({
    getToken: () => 'service-secret',
    getNotify: () => ({ qq: { enabled: true, token: 'private-token', url: 'http://127.0.0.1/notify' }, targets: [{ type: 'private', userId: '123' }] }),
    getStatus: () => ({ running: true, checks: 7, cashUsd: 99999 })
  });
  const app = express();
  app.get('/api/internal/notification-settings', handler);
  app.use(portfolioIdentityMiddleware);
  app.get('/api/state', (_req, res) => res.json({ portfolio: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const path = base + '/api/internal/notification-settings';
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const headers = { Authorization: 'Bearer service-secret' };
  const response = await fetch(path, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(data.monitor, { running: true, checks: 7 });
  assert.deepEqual(data.notify.qq, { enabled: true });
  assert.equal(data.notify.targets[0].userId, '123');
  assert.ok(!JSON.stringify(data).includes('private-token'));
  assert.equal((await fetch(base + '/api/state', { headers })).status, 401);
  let status;
  handler({ socket: { remoteAddress: '192.0.2.1' }, headers }, {
    setHeader() {}, status(value) { status = value; return this; }, json() {}
  });
  assert.equal(status, 403);
});
