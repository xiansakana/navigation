import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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
      if (!objectPath.startsWith(this.config.rootPath + '/') || !/^navigation-[\d-]+\/(?:backup\.tar\.gz\.enc|part-\d{6}\.enc|manifest\.json)$/.test(objectPath.slice(this.config.rootPath.length + 1))) throw new Error('Invalid backup object path');
    }
    async download(objectPath, range) { return super.download(objectPath, range, AbortSignal.timeout(300000)); }
    async exists(objectPath) {
      this.validatePath(objectPath);
      const listing = await this.api('/fs/list', { path: path.posix.dirname(objectPath), password: '', page: 1, per_page: 0, refresh: true });
      return (listing.content || []).find(file => file.name === path.posix.basename(objectPath));
    }
  }
  if (!/^\/115\/[\w-]+$/.test(settings.rootPath) || settings.rootPath === config.rootPath) throw new Error('Use a dedicated backup directory');
  return new BackupStorage({ ...config, rootPath: settings.rootPath });
}

async function* splitEncrypted(source, limit) {
  let chunks = [], bytes = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(limit - bytes, chunk.length - offset);
      chunks.push(chunk.subarray(offset, offset + count)); bytes += count; offset += count;
      if (bytes === limit) { yield Buffer.concat(chunks, bytes); chunks = []; bytes = 0; }
    }
  }
  if (bytes) yield Buffer.concat(chunks, bytes);
}

async function saveReceipt(file, receipt) {
  const temporary = file + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  await fsp.rename(temporary, file);
}

export async function archiveBackup(file, { storage: suppliedStorage, chunkBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 16 * 1024 * 1024) throw new Error('Invalid backup part size');
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
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of encryptedChunks(file, key, iv)) { digest.update(chunk); bytes += chunk.length; }
  const sha256 = digest.digest('hex');
  const objectPath = `${storage.config.rootPath}/${path.basename(file, '.tar.gz')}/backup.tar.gz.enc`;
  if (receipt && (receipt.sha256 !== sha256 || receipt.objectPath !== objectPath)) throw new Error('Backup or key changed since upload; preserving local files');
  receipt ||= { objectPath, iv: iv.toString('hex'), sha256, bytes, state: 'pending', createdAt: new Date().toISOString() };
  if (receipt.chunkBytes && receipt.chunkBytes !== chunkBytes) throw new Error('Cannot change backup part size during resume');
  Object.assign(receipt, { version: 2, chunkBytes, parts: receipt.parts || [] });
  await saveReceipt(receiptFile, receipt);
  await storage.mkdir(objectPath);
  let index = 0, pending = [], saving = Promise.resolve();
  const persist = () => { saving = saving.then(() => saveReceipt(receiptFile, receipt)); return saving; };
  const finishBatch = async () => {
    const results = await Promise.allSettled(pending); pending = [];
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  };
  const putPart = async (body, index) => {
    const partPath = path.posix.join(path.posix.dirname(objectPath), `part-${String(index + 1).padStart(6, '0')}.enc`);
    const partHash = crypto.createHash('sha256').update(body).digest('hex');
    let part = receipt.parts[index];
    if (part && (part.sha256 !== partHash || part.bytes !== body.length || part.objectPath !== partPath)) throw new Error('Backup part changed; preserving local archive');
    part ||= { objectPath: partPath, sha256: partHash, bytes: body.length, verified: false };
    receipt.parts[index] = part;
    await persist();
    const existing = await storage.exists(partPath);
    if (!(part.verified && existing && existing.size === part.bytes)) {
      if (!existing) {
        await storage.api('/fs/put', null, { method: 'PUT', body, timeoutMs: 300000, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'File-Path': encodeURIComponent(partPath),
          'X-File-Sha1': crypto.createHash('sha1').update(body).digest('hex'), Overwrite: 'false'
        } });
      }
      await storage.verify(partPath, body.length, partHash);
      part.verified = true;
      await persist();
    }
    console.log(JSON.stringify({ event: 'backup_part_verified', part: index + 1, total: Math.ceil(bytes / chunkBytes) }));
  };
  for await (const body of splitEncrypted(encryptedChunks(file, key, iv), chunkBytes)) {
    const operation = putPart(body, index++); operation.catch(() => {}); pending.push(operation);
    if (pending.length === 2) await finishBatch();
  }
  await finishBatch();
  const manifestPath = path.posix.join(path.posix.dirname(objectPath), 'manifest.json');
  const manifest = Buffer.from(JSON.stringify({ version: 2, objectPath, iv: receipt.iv, sha256, bytes,
    parts: receipt.parts.map(({ objectPath, sha256, bytes }) => ({ objectPath, sha256, bytes })) }));
  if (!(await storage.exists(manifestPath))) {
    await storage.api('/fs/put', null, { method: 'PUT', body: manifest, headers: {
      'Content-Type': 'application/json', 'Content-Length': String(manifest.length), 'File-Path': encodeURIComponent(manifestPath),
      'X-File-Sha1': crypto.createHash('sha1').update(manifest).digest('hex'), Overwrite: 'false'
    } });
  }
  await storage.verify(manifestPath, manifest.length, crypto.createHash('sha256').update(manifest).digest('hex'));
  receipt.state = 'verified'; receipt.verifiedAt = new Date().toISOString();
  await saveReceipt(receiptFile, receipt);
  await fsp.unlink(file);
  console.log(JSON.stringify({ ok: true, state: 'verified', receipt: receiptFile, localArchiveRemoved: true }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, input, output, keyFile] = process.argv.slice(2);
  if (command === 'upload') await archiveBackup(input);
  else if (command === 'decrypt') await decryptBackup(input, output, await fsp.readFile(keyFile));
  else if (command === 'download') {
    const receipt = JSON.parse(await fsp.readFile(input, 'utf8'));
    const storage = backupStorage(), parts = receipt.version === 2 ? receipt.parts : [{ objectPath: receipt.objectPath, bytes: receipt.bytes, sha256: receipt.sha256 }];
    const complete = crypto.createHash('sha256'); let total = 0;
    for (const part of parts) {
      const response = await storage.download(part.objectPath);
      if (response.status !== 200) throw new Error('Backup download failed');
      const hash = crypto.createHash('sha256'); let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; total += chunk.length; hash.update(chunk); complete.update(chunk);
        if (size > part.bytes) throw new Error('Backup part length mismatch');
        if (!process.stdout.write(chunk)) await new Promise(resolve => process.stdout.once('drain', resolve));
      }
      if (size !== part.bytes || hash.digest('hex') !== part.sha256) throw new Error('Backup part checksum mismatch');
    }
    if (total !== receipt.bytes || complete.digest('hex') !== receipt.sha256) throw new Error('Backup checksum mismatch');
  } else throw new Error('Usage: backup-115.mjs upload ARCHIVE | download RECEIPT | decrypt ENCRYPTED OUTPUT KEY');
}
