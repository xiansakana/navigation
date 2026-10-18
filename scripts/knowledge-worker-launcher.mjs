import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
