import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function workerProxyEnvironment({ env = process.env, platform = process.platform, readProxy = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p=Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings'; @{enabled=$p.ProxyEnable;server=$p.ProxyServer}|ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, timeout: 5000 })) } = {}) {
  if (platform !== 'win32' || env.NAVIGATION_WORKER_PROXY_READY === '1') return null;
  const next = { ...env };
  if (!next.HTTPS_PROXY && !next.https_proxy && !next.HTTP_PROXY && !next.http_proxy) {
    let proxy;
    try { proxy = readProxy(); } catch { return null; }
    if (!proxy.enabled || !proxy.server) return null;
    const entries = String(proxy.server).split(';').map(s => s.trim()).filter(Boolean);
    for (const protocol of ['http', 'https']) {
      const entry = entries.find(s => s.startsWith(protocol + '='))?.slice(protocol.length + 1) || entries.find(s => !s.includes('='));
      if (!entry) continue;
      try {
        const url = new URL(entry.includes('://') ? entry : 'http://' + entry);
        if (['http:', 'https:'].includes(url.protocol) && url.hostname) next[protocol.toUpperCase() + '_PROXY'] = url.href;
      } catch { /* Ignore unsupported system proxy entries. */ }
    }
  }
  if (!next.HTTPS_PROXY && !next.https_proxy && !next.HTTP_PROXY && !next.http_proxy) return null;
  next.NO_PROXY = [next.NO_PROXY || next.no_proxy, 'localhost', '127.0.0.1', '[::1]', '::1'].filter(Boolean).join(',');
  next.no_proxy = next.NO_PROXY;
  next.NODE_USE_ENV_PROXY = '1';
  next.NAVIGATION_WORKER_PROXY_READY = '1';
  return next;
}

// Fetch reads proxy configuration at Node startup. Re-execute once so pairing,
// updates, heartbeats and video downloads all use the same Windows proxy.
export async function restartWithWorkerProxy() {
  const env = workerProxyEnvironment();
  if (!env) return false;
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) throw new Error('Node does not support system proxy networking. Run the latest worker installer.');
  console.log('Worker networking uses the configured system proxy; loopback stays direct.');
  process.exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--use-env-proxy', ...process.argv.slice(1)], { env, windowsHide: true, stdio: 'inherit' });
    const stop = () => child.kill();
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, stop);
    const finish = code => { for (const event of ['SIGINT', 'SIGTERM']) process.removeListener(event, stop); resolve(code ?? 1); };
    child.once('error', () => finish(1)); child.once('exit', finish);
  });
  return true;
}

const allowed = new Set(['package.json', 'README.txt', 'worker-version.json',
  'scripts/knowledge-worker.mjs', 'scripts/start-knowledge-worker.ps1', 'scripts/install-knowledge-worker.ps1',
  'scripts/setup-knowledge-worker.ps1', 'scripts/knowledge-worker-launcher.mjs', 'scripts/knowledge-worker-pair.mjs', 'scripts/knowledge-worker-setup.cmd',
  'portal/src/knowledge-model.js', 'portal/src/knowledge-visual-evidence.js', 'portal/src/knowledge-download.js', 'portal/src/knowledge-local-input.js', 'portal/workers/video_evidence.py', 'portal/workers/video_runtime.py', 'portal/workers/requirements.txt']);
export async function extractWorkerPackage(data, destination) {
  let offset = 0; const names = new Set();
  while (offset + 30 <= data.length && data.readUInt32LE(offset) === 0x04034b50) {
    const method = data.readUInt16LE(offset + 8), size = data.readUInt32LE(offset + 18), length = data.readUInt16LE(offset + 26), extra = data.readUInt16LE(offset + 28);
    const name = data.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const start = offset + 30 + length + extra;
    if (method !== 0 || !allowed.has(name) || names.has(name) || start + size > data.length) throw new Error('Invalid worker package');
    names.add(name);
    const target = path.resolve(destination, name);
    if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error('Invalid worker path');
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data.subarray(start, start + size)); offset = start + size;
  }
  if (!names.has('scripts/knowledge-worker.mjs') || !names.has('worker-version.json')) throw new Error('Incomplete worker package');
}
export async function updateWorker(config, configPath) {
  const portal = new URL(config.portalUrl);
  if (portal.protocol !== 'https:' && !(portal.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(portal.hostname))) throw new Error('HTTPS required');
  const request = async route => {
    const r = await fetch(new URL('/api/knowledge/worker/' + route, portal), { redirect: 'error', headers: { Authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw Object.assign(new Error('Update server HTTP ' + r.status), { status: r.status });
    return r;
  };
  const release = await (await request('release')).json();
  if (!/^[a-f0-9]{64}$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.sha256) || release.bytes > 2000000) throw new Error('Invalid release manifest');
  const root = config.releaseRoot;
  try { if (JSON.parse(await fs.readFile(path.join(root, 'worker-version.json'), 'utf8')).version === release.version) return root; } catch { /* Install the first release. */ }
  const data = Buffer.from(await (await request('package')).arrayBuffer());
  if (data.length !== release.bytes || crypto.createHash('sha256').update(data).digest('hex') !== release.sha256) throw new Error('Worker update checksum mismatch');
  const destination = path.join(path.dirname(configPath), 'releases', release.version);
  await extractWorkerPackage(data, destination);
  config.releaseRoot = destination;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log('Worker updated: ' + release.version.slice(0, 12));
  return destination;
}
async function main() {
  if (await restartWithWorkerProxy()) return;
  const configPath = path.resolve(process.argv[2]);
  while (true) {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    let root = config.releaseRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (config.autoUpdate) {
      try { root = await updateWorker(config, configPath); }
      catch (e) { if ([401, 403].includes(e.status)) { console.error('Device disabled or unbound. Run setup to reconnect.'); process.exitCode = 78; return; } console.error('Update unavailable; keeping current release.'); }
    }
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(root, 'scripts/knowledge-worker.mjs'), configPath], { windowsHide: true, stdio: 'inherit' });
      const stop = () => child.kill();
      for (const event of ['SIGINT', 'SIGTERM']) process.once(event, stop);
      const finish = code => { for (const event of ['SIGINT', 'SIGTERM']) process.removeListener(event, stop); resolve(code); };
      child.once('error', () => finish(1)); child.once('exit', code => finish(code));
    });
    if (code === 78) { process.exitCode = 78; return; }
    await new Promise(resolve => setTimeout(resolve, code === 75 ? 1000 : 15000));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('Worker launcher failed; check configuration.'); process.exitCode = 1; });
