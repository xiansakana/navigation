import { loadConfig, saveConfig } from '../portal/src/config.js';
import { getDatabase, loadRbacBlob } from '../shared/db/index.js';
import { createSessionCookie } from '../portal/src/auth.js';
import { sessionSecret } from '../portal/src/login-security.js';
import { createTornRunStore } from '../portal/src/torn-worker-runs.js';
import { loadServiceConfig, saveServiceConfig } from '../torn-toolbox-desktop/src/config.js';
import { normalizeUndercutWatchers } from '../torn-toolbox-desktop/src/watchers.js';
import { createUndercutStore } from '../torn-toolbox-desktop/src/undercut-store.js';

const config = loadConfig();
if (config.runtime?.tornMonitorWorker) { console.log('Torn worker migration already applied'); process.exit(0); }
const db = getDatabase(), base = new URL('http://127.0.0.1:' + config.server.port).origin;
const rows = [];
for (const user of loadRbacBlob(db).users.filter(user => user.enabled !== false && user.username !== (config.auth?.guestUsername || 'guest'))) {
  const headers = { Cookie: createSessionCookie(user.id, sessionSecret(config)).split(';')[0], Origin: base, 'X-Navigation-Data-Scope': 'self' };
  for (const module of ['torn-shopping', 'torn-chain', 'torn-factions']) {
    const response = await fetch(base + '/api/' + module + '/state', { headers, signal: AbortSignal.timeout(15000) });
    if (response.status === 403) continue;
    if (!response.ok) throw new Error('Cannot snapshot ' + module);
    const state = (await response.json()).state;
    rows.push({ module, uid: user.id, running: state.running, headers });
  }
}
const legacy = {};
for (const service of ['company', 'undercut']) {
  const cfg = loadServiceConfig(service);
  const response = await fetch('http://127.0.0.1:' + cfg.server.port + '/api/state', {
    headers: { Authorization: 'Bearer ' + (cfg.server.adminToken || '') }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Cannot snapshot ' + service);
  const data = await response.json(); legacy[service] = { cfg, state: data[service] };
}
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ ok: true, mode: 'check', nativeRunning: rows.filter(row => row.running).length, company: legacy.company.state.running, undercut: legacy.undercut.state.running }));
  process.exit(0);
}
// Persist intent before stopping anything, preserving stopped tasks too.
const runs = createTornRunStore(db);
const prepared = db.prepare("SELECT value FROM meta WHERE key='torn_worker_prepared_v1'").get();
if (!prepared) db.transaction(() => {
  for (const row of rows) runs.set(row.module, row.uid, row.running);
  db.prepare("INSERT INTO meta(key,value) VALUES('torn_worker_prepared_v1',?)").run(JSON.stringify({ company: legacy.company.state.running, undercut: legacy.undercut.state.running }));
})();
const legacyIntent = prepared ? JSON.parse(prepared.value) : { company: legacy.company.state.running, undercut: legacy.undercut.state.running };
for (const row of rows.filter(row => row.running)) {
  const response = await fetch(base + '/api/' + row.module + '/stop', { method: 'POST', headers: row.headers });
  if (!response.ok) throw new Error('Cannot stop old ' + row.module);
}
for (const service of ['company', 'undercut']) {
  const { cfg, state } = legacy[service];
  cfg[service] = { ...cfg[service], autoStart: legacyIntent[service] };
  saveServiceConfig(service, cfg);
}
// Preserve current undercut alerts so migration does not re-notify existing undercuts.
const undercutStore = createUndercutStore(db);
for (const watcher of normalizeUndercutWatchers(legacy.undercut.cfg)) {
  const alerts = (legacy.undercut.state.alertsList || []).filter(row => row.watcherId === watcher.id);
  undercutStore.save(watcher, { activeKeys: new Set(alerts.map(row => row.key)), alertMap: new Map(alerts.map(row => [row.key, row])) });
}
config.runtime = { ...config.runtime, tornMonitorWorker: true };
saveConfig(config);
console.log(JSON.stringify({ ok: true, migrated: true, nativeRunning: rows.filter(row => row.running).length, company: legacy.company.state.running, undercut: legacy.undercut.state.running }));
