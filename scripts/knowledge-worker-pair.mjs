import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const configPath = path.resolve(process.argv[2]), bundle = path.resolve(process.argv[3]);
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const portal = new URL(config.portalUrl);
if (portal.protocol !== 'https:' && !(portal.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(portal.hostname))) throw new Error('HTTPS required');
if (config.deviceId && config.token) {
  const check = await fetch(new URL('/api/knowledge/worker/release', portal), { redirect: 'error', headers: { Authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(30000) });
  if (check.ok) { console.log('Existing device connection is valid.'); process.exit(0); }
}
const request = async (route, data) => {
  const r = await fetch(new URL('/api/knowledge/worker/pair/' + route, portal), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('Pairing server HTTP ' + r.status);
  return r.json();
};
let secret, deadline;
try {
  const binding = JSON.parse(await fs.readFile(path.join(bundle, 'worker-pairing.json'), 'utf8'));
  if (new URL(binding.portalUrl).origin === portal.origin && binding.expiresAt > Date.now()) { secret = binding.deviceCode; deadline = binding.expiresAt; }
} catch { /* Expired/absent one-use installer authorization falls back to browser pairing. */ }
const browserPair = async () => {
  const pair = await request('start', { label: os.hostname() }); secret = pair.deviceCode; deadline = Date.now() + pair.expiresIn * 1000;
  const url = new URL('/knowledge/', portal); url.searchParams.set('pair', pair.userCode);
  console.log('Confirm this device in your browser. Pairing code: ' + pair.userCode);
  spawn('explorer.exe', [url.href], { windowsHide: true, stdio: 'ignore' }).unref();
};
if (!secret) await browserPair();
while (Date.now() < deadline) {
  const result = await request('poll', { deviceCode: secret, label: os.hostname() });
  if (result.status === 'approved') {
    if (!/^nkw_[a-f0-9]{64}$/.test(result.token) || !/^[a-f0-9]{32}$/.test(result.deviceId)) throw new Error('Invalid pairing response');
    config.token = result.token; config.deviceId = result.deviceId;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await fs.rm(path.join(bundle, 'worker-pairing.json'), { force: true });
    console.log('Device connected. No credential needs to be copied.'); process.exit(0);
  }
  if (result.status === 'expired') { await browserPair(); continue; }
  if (!['pending', 'slow_down'].includes(result.status)) throw new Error('Pairing refused: ' + result.status);
  await new Promise(resolve => setTimeout(resolve, 5000));
}
throw new Error('Pairing expired. Run setup again.');
