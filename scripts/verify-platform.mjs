import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../portal/src/config.js';
import { getDatabase, loadRbacBlob } from '../shared/db/index.js';
import { postgresUrlFor } from '../shared/db/postgres/config.js';
import { createSessionCookie } from '../portal/src/auth.js';
import { sessionSecret } from '../portal/src/login-security.js';

const config = loadConfig();
if (config.runtime?.tornMonitorWorker) {
  const { tornWorkerPort } = await import('../portal/src/torn-worker-transport.js');
  const worker = await fetch('http://127.0.0.1:' + tornWorkerPort(config) + '/readyz', { signal: AbortSignal.timeout(5000) });
  if (!worker.ok || !(await worker.json()).ok) throw new Error('Torn monitor worker readiness check failed');
}
let admin;
if (postgresUrlFor('identity')) {
  const { portalIdentity } = await import('../portal/src/postgres-rbac.js');
  const rbac = await portalIdentity.load(config);
  admin = rbac?.users?.find(user => user.enabled && user.roleIds?.includes('role_admin'));
} else {
  admin = loadRbacBlob(getDatabase())?.users?.find(user => user.enabled && user.roleIds?.includes('role_admin'));
}
if (!admin) throw new Error('No active administrator');
const base = `http://127.0.0.1:${config.server?.port || 8080}`;
const deadline = Date.now() + 15_000;
while (true) {
  try {
    for (const route of ['/healthz', '/readyz']) {
      const timeLeft = Math.max(1, deadline - Date.now());
      const response = await fetch(base + route, { signal: AbortSignal.timeout(Math.min(timeLeft, 2000)) });
      if (!response.ok || !(await response.json()).ok) throw new Error(`Unexpected response from ${route}`);
    }
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw new Error('Portal readiness check failed', { cause: error });
    await delay(Math.min(250, deadline - Date.now()));
  }
}
const cookie = createSessionCookie(admin.id, sessionSecret(config)).split(';')[0];
const response = await fetch(base + '/api/resources/metrics', { headers: { Cookie: cookie } });
const result = await response.json();
if (!response.ok || !result.ok || result.snapshot.modules.length < 7) throw new Error('Module inventory check failed');
const anonymous = await fetch(base + '/api/resources/metrics', { redirect: 'manual' });
if (![401, 403, 302, 303].includes(anonymous.status)) throw new Error('Anonymous resource access must be denied');
const chain = await fetch(base + '/api/torn-chain/notifications', { headers: { Cookie: cookie } });
const chainData = await chain.json();
if (!chain.ok || !chainData.ok || !Array.isArray(chainData.settings?.targets) || !chainData.permissions?.save) throw new Error('Chain notification settings check failed');
const notifyPage = await fetch(base + '/notifications/', { headers: { Cookie: cookie } });
if (!notifyPage.ok || !(await notifyPage.text()).includes('chain-notifications.js')) throw new Error('Chain notification management page check failed');
console.log(JSON.stringify({ ok: true, modules: result.snapshot.modules.length, services: result.snapshot.processes.length, anonymousDenied: true, chainNotifications: true }));
