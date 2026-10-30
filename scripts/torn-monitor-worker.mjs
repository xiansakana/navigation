import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { getDatabase, closeDatabase } from '../shared/db/index.js';
import { loadConfig } from '../portal/src/config.js';
import { resolveSessionUser } from '../portal/src/auth.js';
import { moduleApiHandler } from '../portal/src/module-api.js';
import { verifyWorkerMessage, tornWorkerPort } from '../portal/src/torn-worker-transport.js';
import { createTornRunStore } from '../portal/src/torn-worker-runs.js';
import { createTornWorkerRuntime, tickTornWorker } from '../portal/src/torn-worker-runtime.js';
import { userJobs } from '../portal/src/torn-users.js';
import { shoppingJobs } from '../portal/src/torn-shopping.js';
import { destructionJobs } from '../portal/src/torn-chain.js';
import { factionJobs } from '../portal/src/torn-factions.js';
import { portalTornRequest } from '../portal/src/torn-chain-monitor.js';
import { bazaarListings } from '../portal/src/torn-shopping-monitor.js';
import { installWorkerApi } from '../torn-toolbox-desktop/src/torn-api.js';

process.env.NAVIGATION_PROCESS_ROLE = 'torn-monitor-worker';
const config = loadConfig(), db = getDatabase(), controller = new AbortController();
const startedAt = Date.now(), seen = new Map();
let stopping = false, ready = false;
installWorkerApi(portalTornRequest, bazaarListings, controller.signal);
const runtime = createTornWorkerRuntime({ runs: createTornRunStore(db), config,
  jobs: () => ({ 'torn-shopping': shoppingJobs(), 'torn-chain': destructionJobs(), 'torn-factions': factionJobs(), 'torn-users': userJobs() }),
  sessionFor: uid => { const current = resolveSessionUser({ userId: uid }, config); return current && { userId: current.user.id, permissions: current.permissions, isGuest: current.user.username === (config.auth?.guestUsername || 'guest') }; },
  dispatch: (req, res, url, session, deps) => moduleApiHandler(url.pathname)(req, res, url, session, deps)
});
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return json(res, ready && !stopping ? 200 : 503, { ok: ready && !stopping, startedAt, pid: process.pid });
  if (req.method !== 'POST' || req.url !== '/dispatch') return json(res, 404, { ok: false });
  if (stopping || !ready) return json(res, 503, { ok: false, error: '监控进程正在启动或停止' });
  let message;
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 262144) { json(res, 413, { ok: false }); req.resume(); return; } chunks.push(chunk); }
    message = verifyWorkerMessage(Buffer.concat(chunks).toString('utf8'), req.headers['x-torn-signature'], config, seen);
  } catch { return json(res, 403, { ok: false, error: 'Unauthorized' }); }
  try { const result = await runtime.dispatch(message); json(res, result.status, result.body); }
  catch { json(res, 500, { ok: false, error: '监控请求处理失败' }); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(tornWorkerPort(config), '127.0.0.1', resolve); });
const company = await import('../torn-toolbox-desktop/src/server-company.js');
const undercut = await import('../torn-toolbox-desktop/src/server-undercut.js');
await runtime.resume();
ready = true;
const timer = setInterval(() => tickTornWorker(runtime, db), 5000);
console.log('Torn monitor worker ready (six monitors; control on loopback :' + tornWorkerPort(config) + ')');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 30000); deadline.unref();
  server.close(); company.server.close(); undercut.server.close();
  company.monitor.stop(); undercut.monitor.stop(); controller.abort();
  await runtime.close();
  while (company.monitor.checking || undercut.monitor.checking) await delay(50);
  closeDatabase(); process.exit(0);
});
