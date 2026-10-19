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
    const objects = new Map(), uploads = new Map();
    let fail = true;
    const storage = {
      config: { rootPath: '/115/Navigation-Backups' },
      async mkdir() {}, async exists(object) { return objects.has(object) ? { size: objects.get(object).length } : null; },
      async api(route, data, options) {
        const object = decodeURIComponent(options.headers['File-Path']);
        assert.ok(options.body.length <= 128 * 1024);
        objects.set(object, Buffer.from(options.body));
        uploads.set(object, (uploads.get(object) || 0) + 1);
      },
      async verify(object, bytes, sha256) {
        if (fail) throw new Error('Cloud unavailable');
        assert.equal(bytes, objects.get(object).length);
        assert.equal(crypto.createHash('sha256').update(objects.get(object)).digest('hex'), sha256);
      }
    };
    await assert.rejects(archiveBackup(file, { storage, chunkBytes: 128 * 1024 }), /Cloud unavailable/);
    await fs.access(file);
    fail = false;
    await archiveBackup(file, { storage, chunkBytes: 128 * 1024 });
    await assert.rejects(fs.access(file));
    const encrypted = path.join(directory, 'backup.enc'), restored = path.join(directory, 'restored.tar.gz');
    const receipt = JSON.parse(await fs.readFile(file + '.115.json', 'utf8'));
    assert.equal(receipt.version, 2);
    assert.ok(receipt.parts.length > 1);
    assert.equal(uploads.get(receipt.parts[0].objectPath), 1);
    const ciphertext = Buffer.concat(receipt.parts.map(part => objects.get(part.objectPath)));
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
