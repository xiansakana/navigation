import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveBackup, decryptBackup } from '../../scripts/backup-115.mjs';

test('115 backup preserves failed uploads, authenticates ciphertext, and deletes only verified local archives', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'navigation-backup-crypto-'));
  try {
    const file = path.join(directory, 'navigation-20261018-000001.tar.gz');
    const original = crypto.randomBytes(1024 * 1024);
    await fs.writeFile(file, original);
    let ciphertext;
    let fail = true;
    const storage = {
      config: { rootPath: '/115/Navigation-Backups' },
      async mkdir() {}, async exists() { return !!ciphertext; },
      async api(route, data, options) {
        const parts = []; for await (const part of options.body) parts.push(part);
        ciphertext = Buffer.concat(parts);
      },
      async verify(object, bytes, sha256) {
        if (fail) throw new Error('Cloud unavailable');
        assert.equal(bytes, ciphertext.length);
        assert.equal(crypto.createHash('sha256').update(ciphertext).digest('hex'), sha256);
      }
    };
    await assert.rejects(archiveBackup(file, { storage }), /Cloud unavailable/);
    await fs.access(file);
    fail = false;
    await archiveBackup(file, { storage });
    await assert.rejects(fs.access(file));
    const encrypted = path.join(directory, 'backup.enc'), restored = path.join(directory, 'restored.tar.gz');
    await fs.writeFile(encrypted, ciphertext);
    const key = await fs.readFile(path.join(directory, '.encryption-key'));
    await decryptBackup(encrypted, restored, key);
    assert.deepEqual(await fs.readFile(restored), original);
    ciphertext[30] ^= 1;
    await fs.writeFile(encrypted, ciphertext);
    await assert.rejects(decryptBackup(encrypted, path.join(directory, 'tampered'), key));
    await assert.rejects(fs.access(path.join(directory, 'tampered')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
