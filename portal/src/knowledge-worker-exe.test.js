import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { knowledgeWorkerExe } from './knowledge-worker-exe.js';

test('EXE contains a valid PE bootstrap, verified public ZIP and isolated one-use binding', () => {
  const binding = { portalUrl: 'https://example.test', deviceCode: 'f'.repeat(64), expiresAt: Date.now() + 600000 };
  const exe = knowledgeWorkerExe(binding), footer = exe.subarray(-16);
  assert.equal(exe.toString('ascii', 0, 2), 'MZ');
  assert.equal(exe.toString('ascii', exe.readUInt32LE(0x3c), exe.readUInt32LE(0x3c) + 4), 'PE\0\0');
  assert.equal(footer.toString('ascii', 8), 'NKWEXE01');
  const zipLength = footer.readUInt32LE(0), metaLength = footer.readUInt32LE(4);
  const meta = JSON.parse(exe.subarray(-16 - metaLength, -16).toString('utf8'));
  const zip = exe.subarray(exe.length - 16 - metaLength - zipLength, exe.length - 16 - metaLength);
  assert.equal(crypto.createHash('sha256').update(zip).digest('hex'), meta.sha256);
  assert.deepEqual(meta.binding, binding);
  assert.equal(JSON.parse(knowledgeWorkerExe().subarray(-16 - Buffer.byteLength(JSON.stringify({ sha256: meta.sha256, binding: null })), -16)).binding, null);
});

test('Windows executes the actual EXE and extracts the complete installer without starting a worker', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-exe-test-')), file = path.join(root, 'setup.exe'), result = path.join(root, 'result.txt');
  let stage;
  try {
    await fs.writeFile(file, knowledgeWorkerExe({ portalUrl: 'https://example.test', deviceCode: 'f'.repeat(64), expiresAt: Date.now() + 600000 }));
    await promisify(execFile)(file, ['--verify-only', result], { timeout: 20000, windowsHide: true });
    const lines = (await fs.readFile(result, 'utf8')).split('\n'); assert.equal(lines[0], 'EXE_BOOTSTRAP_OK'); stage = lines[1];
    assert.equal(path.dirname(stage), path.join(os.tmpdir(), 'NavigationKnowledgeInstall')); assert.match(path.basename(stage), /^[a-f0-9]{32}$/);
    assert.ok((await fs.stat(path.join(stage, 'scripts/setup-knowledge-worker.ps1'))).size > 1000);
    const grant = JSON.parse(await fs.readFile(path.join(stage, 'worker-pairing.json'), 'utf8')); assert.equal(grant.deviceCode, 'f'.repeat(64));
    const damaged = knowledgeWorkerExe(); damaged[damaged.length - 8] = 0; await fs.writeFile(file, damaged);
    await assert.rejects(promisify(execFile)(file, ['--verify-only', result], { timeout: 20000, windowsHide: true }));
  } finally {
    if (stage && path.dirname(stage) === path.join(os.tmpdir(), 'NavigationKnowledgeInstall') && /^[a-f0-9]{32}$/.test(path.basename(stage))) await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
