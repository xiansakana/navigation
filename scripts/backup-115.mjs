import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { storageConfig, OpenListStorage } from '../portal/src/knowledge-storage.js';

const magic = Buffer.from('NAVBK001');
const root = fileURLToPath(new URL('../', import.meta.url));

export async function* encryptedChunks(file, key, iv) {
  yield Buffer.concat([magic, iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  for await (const chunk of fs.createReadStream(file)) yield cipher.update(chunk);
  yield cipher.final();
  yield cipher.getAuthTag();
}

export async function decryptBackup(input, output, key) {
  const size = (await fsp.stat(input)).size;
  if (size < 36) throw new Error('Invalid encrypted backup');
  const handle = await fsp.open(input, 'r');
  const header = Buffer.alloc(20), tag = Buffer.alloc(16);
  try { await handle.read(header, 0, 20, 0); await handle.read(tag, 0, 16, size - 16); }
  finally { await handle.close(); }
  if (!header.subarray(0, 8).equals(magic)) throw new Error('Unknown backup format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(8));
  decipher.setAuthTag(tag);
  const temporary = output + '.partial';
  try {
    await pipeline(fs.createReadStream(input, { start: 20, end: size - 17 }), decipher, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await fsp.rename(temporary, output);
  } catch (error) { await fsp.rm(temporary, { force: true }); throw error; }
}

function backupStorage() {
  const settingsFile = process.env.NAVIGATION_BACKUP_CONFIG || path.join(root, 'data/backup115.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const config = storageConfig(settings.userId);
  if (!config) throw new Error('Backup 115 account is not configured');
  // Backup objects cannot address or remove the knowledge-video tree.
  class BackupStorage extends OpenListStorage {
    validatePath(objectPath) {
      if (!objectPath.startsWith(this.config.rootPath + '/') || !/^navigation-[\d-]+\/backup\.tar\.gz\.enc$/.test(objectPath.slice(this.config.rootPath.length + 1))) throw new Error('Invalid backup object path');
    }
  }
  if (!/^\/115\/[\w-]+$/.test(settings.rootPath) || settings.rootPath === config.rootPath) throw new Error('Use a dedicated backup directory');
  return new BackupStorage({ ...config, rootPath: settings.rootPath });
}

export async function archiveBackup(file, { storage: suppliedStorage } = {}) {
  file = path.resolve(file);
  if (!/^navigation-[\d-]+\.tar\.gz$/.test(path.basename(file))) throw new Error('Invalid backup archive name');
  const directory = path.dirname(file), keyPath = path.join(directory, '.encryption-key');
  try { await fsp.writeFile(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = await fsp.readFile(keyPath);
  if (key.length !== 32) throw new Error('Invalid backup key');
  const receiptFile = file + '.115.json';
  let receipt;
  try { receipt = JSON.parse(await fsp.readFile(receiptFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const storage = suppliedStorage || backupStorage();
  const iv = receipt ? Buffer.from(receipt.iv, 'hex') : crypto.randomBytes(12);
  const digest = crypto.createHash('sha256'), sha1 = crypto.createHash('sha1');
  let bytes = 0;
  for await (const chunk of encryptedChunks(file, key, iv)) { digest.update(chunk); sha1.update(chunk); bytes += chunk.length; }
  const sha256 = digest.digest('hex');
  const objectPath = `${storage.config.rootPath}/${path.basename(file, '.tar.gz')}/backup.tar.gz.enc`;
  if (receipt && (receipt.sha256 !== sha256 || receipt.objectPath !== objectPath)) throw new Error('Backup or key changed since upload; preserving local files');
  receipt ||= { version: 1, objectPath, iv: iv.toString('hex'), sha256, bytes, state: 'pending', createdAt: new Date().toISOString() };
  await fsp.writeFile(receiptFile, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  await storage.mkdir(objectPath);
  if (!(await storage.exists(objectPath))) {
    await storage.api('/fs/put', null, { method: 'PUT', body: Readable.from(encryptedChunks(file, key, iv)), headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes), 'File-Path': encodeURIComponent(objectPath),
      'X-File-Sha1': sha1.digest('hex'), Overwrite: 'false'
    } });
  }
  await storage.verify(objectPath, bytes, sha256);
  receipt.state = 'verified'; receipt.verifiedAt = new Date().toISOString();
  await fsp.writeFile(receiptFile, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  await fsp.unlink(file);
  console.log(JSON.stringify({ ok: true, state: 'verified', receipt: receiptFile, localArchiveRemoved: true }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, input, output, keyFile] = process.argv.slice(2);
  if (command === 'upload') await archiveBackup(input);
  else if (command === 'decrypt') await decryptBackup(input, output, await fsp.readFile(keyFile));
  else if (command === 'download') {
    const receipt = JSON.parse(await fsp.readFile(input, 'utf8'));
    const response = await backupStorage().download(receipt.objectPath);
    if (!response.ok) throw new Error('Backup download failed');
    await pipeline(Readable.fromWeb(response.body), process.stdout);
  } else throw new Error('Usage: backup-115.mjs upload ARCHIVE | download RECEIPT | decrypt ENCRYPTED OUTPUT KEY');
}
