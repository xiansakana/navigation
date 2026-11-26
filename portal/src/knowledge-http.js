import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxySource } from './knowledge-storage.js';

export const knowledgeRoot = () => path.resolve(process.env.KNOWLEDGE_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/knowledge'));
export function knowledgeDirectory(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('文档编号无效');
  return path.join(knowledgeRoot(), id);
}
export async function bytes(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) { const e = new Error('请求超过大小限制'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function body(req, max = 1024 * 1024) {
  try { return JSON.parse((await bytes(req, max)).toString('utf8')); }
  catch (e) { if (e.status) throw e; throw new Error('请求体不是合法 JSON'); }
}
const locks = new Map();
export async function lock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(fn);
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}
export function stream(req, res, file, type, attachment = '') {
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
  if (attachment) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(attachment);
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    start = match ? Number(match[1]) : -1; end = match && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (start < 0 || start > end || start >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`; status = 206;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  const input = fs.createReadStream(file, { start, end });
  input.on('error', () => res.destroy()); res.on('close', () => input.destroy()); input.pipe(res);
}
export async function serveSource(req, res, store, uid, id) {
  const source = store.sources.get(uid, id), item = store.get(uid, id);
  // Link imports may be processed while 115 archives in parallel. If its cache
  // was cleaned between claim and GET, verified/ready storage below is available.
  const local = path.join(knowledgeDirectory(id), 'source');
  if (item.importState === 'done' && fs.existsSync(local)) return stream(req, res, local, item.mimeType);
  if (source && ['ready', 'verified'].includes(source.state)) return proxySource(req, res, uid, source, item.mimeType);
  return stream(req, res, path.join(knowledgeDirectory(id), 'source'), item.mimeType);
}
export function knowledgeFailure(res, json, error, showDuplicate = false) {
  if (error.code === 'KNOWLEDGE_CAPACITY') return json(res, 409, { ok: false, code: error.code, error: error.message });
  if (/^SQLITE_(BUSY|LOCKED)/.test(error.code || '')) {
    res.setHeader('Retry-After', '1');
    return json(res, 503, { ok: false, code: 'KNOWLEDGE_BUSY', retryable: true, error: '知识库正在写入，请稍后重试' });
  }
  return json(res, error.status || 400, { ok: false, ...(error.code === 'KNOWLEDGE_DUPLICATE_SOURCE' ? { code: error.code, ...(showDuplicate ? { duplicate: error.duplicate } : {}) } : {}), error: error.code?.startsWith('SQLITE_') ? '知识库存储失败' : error.message });
}
