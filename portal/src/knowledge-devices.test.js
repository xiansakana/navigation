import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import http from 'node:http';
import { once } from 'node:events';
import { createKnowledgeStore } from './knowledge-store.js';
import { knowledgeWorkerPackage, zipFiles, workerPackageFiles } from './knowledge-worker-package.js';
import { extractWorkerPackage, updateWorker } from '../../scripts/knowledge-worker-launcher.mjs';

const upload = { title: '设备测试', bytes: 24, mimeType: 'video/mp4', originalName: 'test.mp4' };
function fixture(fn) { const db = new Database(':memory:'); try { return fn(createKnowledgeStore(db), db); } finally { db.close(); } }
test('pairings expire, require approval, mint credentials once and never expose them in device listings', () => fixture((store, db) => {
  const pair = store.devices.start('Laptop');
  assert.equal(store.devices.poll(pair.deviceCode, () => true).status, 'pending');
  assert.equal(store.devices.approve('a', pair.userCode), true);
  assert.equal(store.devices.approve('b', pair.userCode), false);
  db.prepare('UPDATE knowledge_worker_pairings SET last_poll=0').run();
  const device = store.devices.poll(pair.deviceCode, uid => uid === 'a');
  assert.equal(device.status, 'approved'); assert.equal(store.workerUser(device.token), 'a');
  assert.equal(store.devices.poll(pair.deviceCode, () => true).status, 'expired');
  assert.equal(store.devices.list('b').length, 0);
  assert.ok(!JSON.stringify(store.devices.list('a')).includes(device.token));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM knowledge_worker_devices').all()).includes(device.token));
  const expired = store.devices.start('Expired'); db.prepare('UPDATE knowledge_worker_pairings SET expires=0 WHERE user_code=?').run(expired.userCode);
  assert.equal(store.devices.inspect(expired.userCode), null); assert.equal(store.devices.approve('a', expired.userCode), false);
  assert.equal(store.devices.poll(expired.deviceCode, () => true).status, 'expired');
  const denied = store.devices.start('Denied'); store.devices.approve('a', denied.userCode);
  assert.equal(store.devices.poll(denied.deviceCode, () => false).status, 'denied');
}));

test('revoking one device stops its lease, preserves other devices and survives shared-token rotation', () => fixture((store) => {
  const mint = name => { const p = store.devices.start(name); store.devices.approve('a', p.userCode); return store.devices.poll(p.deviceCode, () => true); };
  const gpu = mint('GPU'), backup = mint('Backup');
  store.heartbeatWorker('a', { workerId: gpu.deviceId, capabilities: { media: { ready: true, detail: 'cuda' }, codex: { ready: true } } });
  const d = store.create('a', upload); store.enqueue('a', d.id); const job = store.claim('a', ['codex'], gpu.deviceId);
  store.rotateToken('a'); assert.ok(store.leased('a', d.id, job.lease)); assert.ok(store.worker('a').online);
  assert.equal(store.devices.revoke('b', gpu.deviceId), false); assert.equal(store.workerUser(gpu.token), 'a');
  assert.equal(store.devices.revoke('a', gpu.deviceId), true); assert.equal(store.workerUser(gpu.token), null);
  assert.equal(store.leased('a', d.id, job.lease), false); assert.equal(store.get('a', d.id).status, 'failed');
  assert.equal(store.workerUser(backup.token), 'a');
}));

test('installer package is deterministic, contains only public runtime files and rejects path traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-package-'));
  try {
    const pkg = knowledgeWorkerPackage();
    assert.equal(pkg.sha256, knowledgeWorkerPackage().sha256);
    assert.ok(workerPackageFiles.every(f => !/config\.json|auth\.json|data\//.test(f)));
    await extractWorkerPackage(pkg.buffer, root);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'worker-version.json'), 'utf8')).version, pkg.version);
    assert.ok((await fs.readFile(path.join(root, 'scripts/setup-knowledge-worker.ps1'), 'utf8')).includes('Assert-NativeExit'));
    assert.throws(() => zipFiles([['../escape', 'bad']]));
    const invalid = Buffer.from(pkg.buffer); invalid.writeUInt16LE(8, 8);
    await assert.rejects(extractWorkerPackage(invalid, root), /Invalid worker package/);
    const binding = knowledgeWorkerPackage({ deviceCode: 'secret-for-installer', portalUrl: 'https://example.test' });
    assert.notEqual(binding.sha256, pkg.sha256);
    assert.equal(knowledgeWorkerPackage().sha256, pkg.sha256, 'private one-use installer grants are never cached');
    assert.ok(!pkg.buffer.includes(Buffer.from('secret-for-installer')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('updates reject non-HTTPS endpoints before sending worker credentials', async () => {
  await assert.rejects(updateWorker({ portalUrl: 'http://example.test', token: 'secret' }, '/tmp/config.json'), /HTTPS required/);
});

test('automatic updates verify package checksums and preserve private configuration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-update-')), pkg = knowledgeWorkerPackage();
  let corrupt = true;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-device-secret');
    if (req.url.endsWith('/release')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ version: pkg.version, sha256: pkg.sha256, bytes: pkg.bytes })); }
    const data = Buffer.from(pkg.buffer); if (corrupt) data[31] ^= 1; res.end(data);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const file = path.join(root, 'config.json'), config = { portalUrl: 'http://127.0.0.1:' + server.address().port, token: 'test-device-secret', releaseRoot: path.join(root, 'old'), workDir: 'existing-cache' };
  await fs.writeFile(file, JSON.stringify(config));
  try {
    await assert.rejects(updateWorker(config, file), /checksum mismatch/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).releaseRoot, config.releaseRoot);
    corrupt = false; await updateWorker(config, file);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.token, 'test-device-secret'); assert.equal(saved.workDir, 'existing-cache');
    assert.equal(JSON.parse(await fs.readFile(path.join(saved.releaseRoot, 'worker-version.json'), 'utf8')).version, pkg.version);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});
