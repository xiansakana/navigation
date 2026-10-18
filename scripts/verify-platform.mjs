import fs from 'node:fs';
import { loadConfig } from '../portal/src/config.js';
import { getDatabase, loadRbacBlob } from '../shared/db/index.js';
import { createSessionCookie } from '../portal/src/auth.js';
import { sessionSecret } from '../portal/src/login-security.js';

const config = loadConfig(), db = getDatabase();
const admin = loadRbacBlob(db)?.users?.find(user => user.enabled && user.roleIds?.includes('role_admin'));
if (!admin) throw new Error('No active administrator');
const base = `http://127.0.0.1:${config.server?.port || 8080}`;
for (const route of ['/healthz', '/readyz']) {
  const response = await fetch(base + route);
  if (!response.ok || !(await response.json()).ok) throw new Error('Portal readiness check failed');
}
const cookie = createSessionCookie(admin.id, sessionSecret(config)).split(';')[0];
const response = await fetch(base + '/api/resources/metrics', { headers: { Cookie: cookie } });
const result = await response.json();
if (!response.ok || !result.ok || result.snapshot.modules.length < 7) throw new Error('Module inventory check failed');
const anonymous = await fetch(base + '/api/resources/metrics');
if (anonymous.status !== 403) throw new Error('Anonymous resource access must be denied');
console.log(JSON.stringify({ ok: true, modules: result.snapshot.modules.length, services: result.snapshot.processes.length, anonymousDenied: true }));
