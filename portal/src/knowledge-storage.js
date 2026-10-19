import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const agent = 'NavigationKnowledge/1.0';
export function storageConfig(uid) {
  const file = process.env.KNOWLEDGE_STORAGE_CONFIG || fileURLToPath(new URL('../data/knowledge-storage.json', import.meta.url));
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')).users?.[uid]; }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('视频存储配置无法读取'); }
  if (!config) return null;
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !config.token || !/^\/115\/[\w-]+$/.test(config.rootPath)) throw new Error('115存储配置无效');
  return config;
}
export function sourcePath(config, uid, doc) {
  const owner = crypto.createHash('sha256').update(uid).digest('hex').slice(0, 24);
  const extension = ({ 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' })[doc.mimeType] || '.mp4';
  return `${config.rootPath}/${owner}/${doc.id}/source${extension}`;
}
export class OpenListStorage {
  constructor(config) { if (!config) throw new Error('115存储尚未配置'); this.config = config; }
  async api(route, data, options = {}) {
    try {
      const response = await fetch(new URL('/api' + route, this.config.baseUrl), {
        method: options.method || 'POST', redirect: 'error',
        headers: { Authorization: this.config.token, 'User-Agent': agent, 'Content-Type': 'application/json', ...options.headers },
        body: options.body || JSON.stringify(data), duplex: options.body ? 'half' : undefined,
        signal: AbortSignal.timeout(options.timeoutMs || (options.body ? 3600000 : 60000))
      });
      const result = await response.json();
      if (!response.ok || result.code !== 200) throw Object.assign(new Error('115操作失败'), { missing: result.code === 404 });
      return result.data;
    } catch (e) { throw Object.assign(new Error('115暂时不可用，请稍后重试'), { missing: e.missing === true }); }
  }
  validatePath(objectPath) {
    if (!objectPath.startsWith(this.config.rootPath + '/') || !/^[a-f0-9]{24}\/[a-f0-9]{32}\/source\.(mp4|webm|mov)$/.test(objectPath.slice(this.config.rootPath.length + 1))) throw new Error('115视频路径无效');
  }
  async exists(objectPath) {
    this.validatePath(objectPath);
    const listing = await this.api('/fs/list', { path: path.posix.dirname(objectPath), password: '', page: 1, per_page: 100, refresh: true });
    return (listing.content || []).find(f => f.name === path.posix.basename(objectPath));
  }
  async mkdir(objectPath) {
    this.validatePath(objectPath);
    let current = '/115';
    for (const part of path.posix.dirname(objectPath).split('/').slice(2)) {
      current += '/' + part;
      const parent = path.posix.dirname(current), name = path.posix.basename(current);
      const listing = await this.api('/fs/list', { path: parent, password: '', page: 1, per_page: 0, refresh: true });
      if (!(listing.content || []).some(f => f.name === name && f.is_dir)) await this.api('/fs/mkdir', { path: current });
    }
  }
  async upload(objectPath, file, bytes, sha1) {
    this.validatePath(objectPath);
    await this.api('/fs/put', null, { method: 'PUT', body: fs.createReadStream(file), headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes), 'File-Path': encodeURIComponent(objectPath),
      'X-File-Sha1': sha1, Overwrite: 'false'
    } });
  }
  async download(objectPath, range, signal) {
    this.validatePath(objectPath);
    const meta = await this.api('/fs/get', { path: objectPath, password: '' });
    const url = new URL(meta.raw_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('115下载地址无效');
    try {
      return await fetch(url, { headers: { 'User-Agent': agent, ...(range ? { Range: range } : {}) },
        signal: AbortSignal.any([AbortSignal.timeout(3600000), ...(signal ? [signal] : [])]) });
    } catch { throw new Error('115视频读取失败'); }
  }
  async verify(objectPath, bytes, sha256) {
    const response = await this.download(objectPath);
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('115视频校验读取失败'); }
    const hash = crypto.createHash('sha256'); let count = 0;
    for await (const chunk of response.body) { count += chunk.length; if (count > bytes) throw new Error('115视频大小校验失败'); hash.update(chunk); }
    if (count !== bytes || hash.digest('hex') !== sha256) throw new Error('115视频完整性校验失败，保留本地原片');
  }
  async remove(objectPath) {
    this.validatePath(objectPath);
    const folder = path.posix.dirname(objectPath);
    const listing = await this.api('/fs/list', { path: path.posix.dirname(folder), password: '', refresh: true, page: 1, per_page: 0 });
    if ((listing.content || []).some(f => f.name === path.posix.basename(folder))) {
      await this.api('/fs/remove', { dir: path.posix.dirname(folder), names: [path.posix.basename(folder)] });
    }
  }
}
export async function hashFile(file) {
  const sha1 = crypto.createHash('sha1'), sha256 = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { sha1.update(chunk); sha256.update(chunk); bytes += chunk.length; }
  return { sha1: sha1.digest('hex'), sha256: sha256.digest('hex'), bytes };
}
export async function archiveSource(storage, sources, s, file) {
  let hashes = s;
  if (!s.sha256) {
    hashes = await hashFile(file);
    if (hashes.bytes !== s.byte_size) throw new Error('临时原视频大小不符');
    if (!sources.update(s, { sha1: hashes.sha1, sha256: hashes.sha256 })) throw new Error('归档任务已过期');
  }
  await storage.mkdir(s.object_path);
  const existing = await storage.exists(s.object_path);
  if (!existing) {
    const started = Date.now();
    sources.update(s, { state: 'uploading', error: '', upload_started_at: started, upload_ms: 0 });
    await storage.upload(s.object_path, file, s.byte_size, hashes.sha1);
    sources.update(s, { upload_ms: Date.now() - started });
  }
  const verificationStarted = Date.now();
  sources.update(s, { state: 'verifying', verification_started_at: verificationStarted, verification_ms: 0 });
  await storage.verify(s.object_path, s.byte_size, hashes.sha256);
  if (!sources.update(s, { state: 'verified', verified_at: new Date().toISOString(), error: '', verification_ms: Date.now() - verificationStarted })) throw new Error('归档任务已过期');
  await fsp.rm(file, { force: true });
  sources.update(s, { state: 'ready' });
}
export async function proxySource(req, res, uid, source, mimeType) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const response = await new OpenListStorage(storageConfig(uid)).download(source.object_path, req.headers.range, controller.signal);
    if (![200, 206, 416].includes(response.status)) { await response.body?.cancel(); throw new Error('视频读取失败'); }
    const headers = { 'Content-Type': mimeType, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
    for (const key of ['content-length', 'content-range']) if (response.headers.has(key)) headers[key] = response.headers.get(key);
    res.writeHead(response.status, headers);
    pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal }).catch(() => res.destroy());
  } catch {
    if (res.headersSent) res.destroy();
    else { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('115视频暂时不可用，请稍后重试'); }
  }
}
