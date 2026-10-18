import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '../../shared/db/index.js';
import { storageConfig, sourcePath, proxySource } from './knowledge-storage.js';
import { hasPermission } from './rbac.js';
import { createKnowledgeStore, CHUNK_BYTES, MAX_VIDEO_BYTES, MODEL_FIELDS } from './knowledge-store.js';
import { knowledgeWorkerPackage, sendWorkerPackage } from './knowledge-worker-package.js';
import { sendWorkerExe } from './knowledge-worker-exe.js';
import { inspectBilibili, inspectBilibiliQuality, qualityLabel } from './knowledge-bilibili.js';
import { bilibiliAccount, qualitySettings } from './knowledge-bilibili-account.js';

const root = () => path.resolve(process.env.KNOWLEDGE_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/knowledge'));
export function knowledgeDirectory(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('文档编号无效');
  return path.join(root(), id);
}
export function canKnowledge(session, action = 'view') {
  return !!session?.userId && !session.isGuest && hasPermission(session.permissions || [], 'knowledge:' + action);
}
async function bytes(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) { const e = new Error('请求超过大小限制'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req, max = 1024 * 1024) {
  try { return JSON.parse((await bytes(req, max)).toString('utf8')); }
  catch (e) { if (e.status) throw e; throw new Error('请求体不是合法 JSON'); }
}
const locks = new Map();
const pairingRates = new Map();
const importRequests = new Map();
async function inspectImport(uid, url) {
  const time = Date.now();
  for (const [key, value] of importRequests) if (time - value.since > 60000 && !value.busy) importRequests.delete(key);
  const rate = importRequests.get(uid) || { since: time, count: 0, busy: false };
  if (rate.busy || rate.count >= 20 || importRequests.size > 10000) throw Object.assign(new Error('视频信息读取过于频繁，请稍后重试'), { status: 429 });
  rate.count++; rate.busy = true; importRequests.set(uid, rate);
  try { return await inspectBilibili(url); } finally { rate.busy = false; }
}
async function lock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(fn);
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}
function stream(req, res, file, type, attachment = '') {
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
async function serveSource(req, res, store, uid, id) {
  const source = store.sources.get(uid, id), item = store.get(uid, id);
  // Link imports may be processed while 115 archives in parallel. If its cache
  // was cleaned between claim and GET, verified/ready storage below is available.
  const local = path.join(knowledgeDirectory(id), 'source');
  if (item.importState === 'done' && fs.existsSync(local)) return stream(req, res, local, item.mimeType);
  if (source && ['ready', 'verified'].includes(source.state)) return proxySource(req, res, uid, source, item.mimeType);
  return stream(req, res, path.join(knowledgeDirectory(id), 'source'), item.mimeType);
}
export function validateKnowledgeResult(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 14400) throw new Error('视频时长无效或超过4小时');
  if (typeof raw.notes !== 'string' || raw.notes.trim().length < 40 || raw.notes.length > 500000) throw new Error('总结为空或过长');
  if (!Array.isArray(raw.transcript) || raw.transcript.length > 30000) throw new Error('转写数据无效');
  let previous = -1;
  const transcript = raw.transcript.map(s => {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.start < previous || s.end < s.start || s.end > raw.duration + 2 || typeof s.text !== 'string' || s.text.length > 12000) throw new Error('转写时间戳或文本无效');
    previous = s.start;
    return { start: s.start, end: s.end, text: s.text };
  });
  if (!Array.isArray(raw.frames) || raw.frames.length > 36) throw new Error('画面数量超过限制');
  const frames = raw.frames.map((f, i) => {
    if (!Number.isFinite(f.time) || f.time < 0 || f.time > raw.duration || typeof f.data !== 'string' || f.data.length > 600000) throw new Error('画面数据无效');
    const data = Buffer.from(f.data, 'base64');
    if (data.length < 20 || data.length > 450000 || data[0] !== 255 || data[1] !== 216 || data[2] !== 255) throw new Error('画面不是有效 JPEG');
    return { time: f.time, name: `frame-${i + 1}.jpg`, data };
  });
  const provenance = { backend: String(raw.provenance?.backend || '').slice(0, 30), model: String(raw.provenance?.model || '').slice(0, 120),
    reasoningEffort: String(raw.provenance?.reasoningEffort || '').slice(0, 20),
    asrModel: String(raw.provenance?.asrModel || '').slice(0, 120), vision: raw.provenance?.vision === true, generatedAt: new Date().toISOString(),
    warnings: Array.isArray(raw.provenance?.warnings) ? raw.provenance.warnings.slice(0, 10).map(s => String(s).slice(0, 300)) : [] };
  return { duration: raw.duration, language: String(raw.language || '').slice(0, 30), notes: raw.notes.trim(), transcript, frames, provenance };
}

export async function handleKnowledgeWorkerApi(req, res, url, json, authorize = () => false) {
  res.setHeader('Cache-Control', 'no-store');
  const route = url.pathname.slice('/api/knowledge/worker'.length), method = req.method;
  const store = createKnowledgeStore(getDatabase());
  if (['/pair/start', '/pair/poll'].includes(route) && method === 'POST') {
    try {
      const raw = await body(req, 1024);
      if (route === '/pair/start') {
        const key = req.socket.remoteAddress || 'unknown', time = Date.now();
        for (const [ip, r] of pairingRates) if (r.until < time) pairingRates.delete(ip);
        const rate = pairingRates.get(key) || { count: 0, until: time + 60000 };
        if (++rate.count > 30 || pairingRates.size > 10000) return json(res, 429, { ok: false, error: '配对请求过多，请稍后重试' });
        pairingRates.set(key, rate);
        return json(res, 200, { ok: true, ...store.devices.start(raw.label) });
      }
      if (!/^[a-f0-9]{64}$/.test(raw.deviceCode || '')) return json(res, 400, { ok: false, error: '配对请求无效' });
      return json(res, 200, { ok: true, ...store.devices.poll(raw.deviceCode, authorize, raw.label) });
    } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  }
  const token = /^Bearer (nkw_[a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
  if (!token) return json(res, 401, { ok: false, error: '工作器凭据无效' });
  const uid = store.workerUser(token), device = store.devices.authenticate(token);
  if (!uid) return json(res, 401, { ok: false, error: '工作器凭据已撤销' });
  if (!authorize(uid)) return json(res, 403, { ok: false, error: '账号已停用或知识库处理权限已撤销' });
  try {
    if (route === '/package' && method === 'GET') return sendWorkerPackage(res);
    if (route === '/release' && method === 'GET') { const { version, sha256, bytes } = knowledgeWorkerPackage(); return json(res, 200, { ok: true, version, sha256, bytes }); }
    if (route === '/heartbeat' && method === 'POST') { const raw = await body(req, 4096); store.heartbeatWorker(uid, device ? { ...raw, workerId: device.id, label: device.label } : raw); return json(res, 200, { ok: true }); }
    if (route === '/local-input' && method === 'POST') {
      const raw = await body(req, 4096), workerId = device?.id || raw.workerId;
      if (raw.action === 'forget') { store.localInputs.forget(uid, raw.documentId, workerId); return json(res, 200, { ok: true }); }
      return json(res, 200, { ok: true, ...store.localInputs.verify(uid, raw.documentId, workerId, raw.ticket, raw.sha256) });
    }
    if (route === '/claim' && method === 'POST') {
      const raw = await body(req, 4096);
      const backends = Array.isArray(raw.backends) ? raw.backends.filter(b => ['codex', 'openai'].includes(b)) : [];
      return json(res, 200, { ok: true, job: store.claim(uid, backends, device?.id || (typeof raw.workerId === 'string' ? raw.workerId : ''), Array.isArray(raw.localDocuments) ? raw.localDocuments.slice(0, 200).filter(id => /^[a-f0-9]{32}$/.test(id)) : []) });
    }
    const match = /^\/jobs\/([a-f0-9]{32})\/(source|progress|complete|fail|codex)$/.exec(route);
    if (!match) return json(res, 404, { ok: false, error: '工作器接口不存在' });
    const [, id, action] = match, lease = req.headers['x-knowledge-lease'];
    return await lock(id, async () => {
      if (!store.leased(uid, id, lease)) return json(res, 409, { ok: false, error: '任务已删除、过期或由其他工作器领取' });
      if(action==='codex'&&method==='POST'){
        const input=await body(req,3*1024*1024);
        if(!store.leased(uid,id,lease))return json(res,409,{ok:false,error:'任务已过期'});
        const doc=store.getRow(uid,id);if(doc.backend!=='codex')return json(res,400,{ok:false,error:'此任务未使用Codex'});
        store.codexCalls.record(uid,doc,input);return json(res,200,{ok:true});
      }
      if (action === 'source' && method === 'GET') return serveSource(req, res, store, uid, id);
      if (action === 'progress' && method === 'POST') {
        const input = await body(req, 4096); store.progress(uid, id, lease, input.stage, input.progress); return json(res, 200, { ok: true });
      }
      if (action === 'fail' && method === 'POST') {
        const input = await body(req, 4096); store.fail(uid, id, lease, String(input.error || '工作器处理失败')); return json(res, 200, { ok: true });
      }
      if (action === 'complete' && method === 'POST') {
        const result = validateKnowledgeResult(await body(req, 18 * 1024 * 1024));
        const directory = knowledgeDirectory(id);
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        for (const f of result.frames) await fsp.writeFile(path.join(directory, f.name), f.data);
        result.frames = result.frames.map(({ data, ...f }) => f);
        if (!store.finish(uid, id, lease, result)) return json(res, 409, { ok: false, error: '任务已过期' });
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { ok: false, error: '不支持此请求方法' });
    });
  } catch (e) { return json(res, e.status || 400, { ok: false, error: e.code?.startsWith('SQLITE_') ? '知识库存储失败' : e.message }); }
}

export async function handleKnowledgeApi(req, res, url, session, json) {
  res.setHeader('Cache-Control', 'no-store');
  if (!canKnowledge(session)) return json(res, 403, { ok: false, error: '请登录并获取知识库权限' });
  const route = url.pathname.slice('/api/knowledge'.length), method = req.method;
  const document = /^\/documents\/([a-f0-9]{32})(?:\/(parts|complete|local-input|retry|storage-retry|source|export|frames)(?:\/([a-z0-9.-]+))?)?$/.exec(route);
  const action = route === '/settings' ? method === 'GET' ? 'view' : 'settings:edit'
    : (route === '/bilibili' && method === 'GET' || route === '/bilibili/check' && method === 'POST') ? 'bilibili:view'
    : (route === '/bilibili' && method === 'DELETE' || ['/bilibili/login/start', '/bilibili/login/poll'].includes(route) && method === 'POST') ? 'bilibili:edit'
    : route === '/bilibili/settings' && method === 'PUT' ? 'quality:edit'
    : ['/imports/preview', '/imports'].includes(route) && method === 'POST' ? 'import:edit'
    : route === '/worker-package' && method === 'GET' ? 'devices:install'
    : route === '/worker-install' && method === 'POST' ? 'devices:install'
    : route === '/devices' && method === 'GET' ? 'devices:view'
    : /^\/devices\/[a-f0-9]{32}$/.test(route) && method === 'DELETE' ? 'devices:edit'
    : route === '/device-pair' ? method === 'GET' ? 'devices:view' : method === 'POST' ? 'devices:edit' : null
    : route === '/worker-token' && method === 'POST' ? 'worker:edit'
      : route === '/documents' ? method === 'GET' ? 'view' : 'upload:edit'
        : document ? method === 'GET' ? document[2] === 'export' ? 'export:view' : 'view'
          : method === 'DELETE' ? 'delete:edit' : document[2] === 'local-input' ? 'local-input:edit' : document[2] === 'storage-retry' ? 'storage:edit' : document[2] === 'retry' ? 'process:edit'
            : document[2] ? 'upload:edit' : 'notes:edit' : null;
  if (!action) return json(res, 404, { ok: false, error: '知识库接口不存在' });
  if (!canKnowledge(session, action)) return json(res, 403, { ok: false, error: '无权执行此知识库操作' });
  if (method === 'GET' && (route === '/documents' || document && !['parts', 'source', 'frames'].includes(document[2])) && !canKnowledge(session, 'notes:view')) return json(res, 403, { ok: false, error: '无权查看学习笔记' });
  if (document && ['source', 'frames'].includes(document[2]) && !canKnowledge(session, document[2] + ':view')) return json(res, 403, { ok: false, error: '无权查看此原始材料' });
  if (!['GET', 'HEAD'].includes(method) && (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && !['http://' + req.headers.host, 'https://' + req.headers.host].includes(req.headers.origin))) return json(res, 403, { ok: false, error: '不允许跨站写入' });
  const store = createKnowledgeStore(getDatabase()), uid = session.userId;
  const visible = d => d && ({ ...d, transcript: canKnowledge(session, 'transcript:view') ? d.transcript : [], frames: canKnowledge(session, 'frames:view') ? d.frames : [] });
  try {
    if (route.startsWith('/bilibili')) {
      const account = bilibiliAccount(getDatabase());
      if (route === '/bilibili' && method === 'GET') return json(res, 200, { ok: true, account: account.public(uid) });
      if (route === '/bilibili/check') return json(res, 200, { ok: true, account: await account.check(uid) });
      if (route === '/bilibili/settings') return json(res, 200, { ok: true, settings: qualitySettings({}, account.saveSettings(uid, await body(req, 1024))) });
      if (route === '/bilibili/login/start') return json(res, 200, { ok: true, ...await account.start(uid) });
      if (route === '/bilibili/login/poll') return json(res, 200, { ok: true, ...await account.poll(uid) });
      if (route === '/bilibili' && method === 'DELETE') return json(res, 200, { ok: true, account: account.unlink(uid) });
    }
    if (['/imports/preview', '/imports'].includes(route)) {
      if (!canKnowledge(session, 'upload:edit') || !canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '需要上传视频和生成笔记权限' });
      const input = await body(req, 8192);
      const info = await inspectImport(uid, input.url);
      const account = bilibiliAccount(getDatabase()), selection = qualitySettings(input, account.public(uid));
      const cookie = await account.credentials(uid);
      const playback = await inspectBilibiliQuality(info, selection, { cookie });
      if (route === '/imports/preview') return json(res, 200, { ok: true, metadata: { ...info, playback } });
      if (!playback.canImport) throw new Error(playback.reason);
      await fsp.mkdir(root(), { recursive: true, mode: 0o700 });
      const disk = await fsp.statfs(root());
      const reserved = getDatabase().prepare("SELECT coalesce(sum(byte_size),0) AS bytes FROM knowledge_documents WHERE status IN ('uploading','importing')").get().bytes;
      if (MAX_VIDEO_BYTES * 3 + reserved * 2 + 5 * 1024 ** 3 > disk.bavail * disk.bsize) throw new Error('服务器可用空间不足');
      const config = storageConfig(uid);
      const item = getDatabase().transaction(() => {
        const created = store.create(uid, { title: input.title === undefined ? info.title : input.title, topic: input.topic === undefined ? info.topic : input.topic,
          tags: input.tags === undefined ? info.tags : input.tags, sourceUrl: input.sourceUrl === undefined ? info.sourceUrl : input.sourceUrl,
          bytes: MAX_VIDEO_BYTES, mimeType: 'video/mp4', originalName: info.title.replace(/[\\/:*?"<>|]/g, '-') + '.mp4', backend: input.backend || store.settings(uid).backend });
        store.imports.add(uid, created.id, info.sourceUrl, selection);
        if (config) store.sources.add(uid, created.id, sourcePath(config, uid, created));
        getDatabase().prepare("UPDATE knowledge_documents SET status='importing',stage='等待下载B站视频' WHERE user_id=? AND id=?").run(uid, created.id);
        return store.get(uid, created.id);
      })();
      return json(res, 202, { ok: true, document: item });
    }
    if (route === '/worker-install') {
      if (!canKnowledge(session, 'devices:edit') || !canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '需要设备绑定和视频处理权限' });
      const pairing = store.devices.start('Windows 视频工作器'); store.devices.approve(uid, pairing.userCode);
      return sendWorkerExe(res, { portalUrl: process.env.KNOWLEDGE_PUBLIC_URL || 'https://saoyu.fun', deviceCode: pairing.deviceCode, expiresAt: Date.now() + 600000 });
    }
    if (route === '/worker-package') return sendWorkerPackage(res);
    if (route === '/devices' && method === 'GET') return json(res, 200, { ok: true, devices: store.devices.list(uid) });
    if (/^\/devices\/[a-f0-9]{32}$/.test(route) && method === 'DELETE') { const revoked = store.devices.revoke(uid, route.split('/').pop()); return json(res, revoked ? 200 : 404, { ok: revoked }); }
    if (route === '/device-pair') {
      const code = method === 'GET' ? url.searchParams.get('code') : (await body(req, 1024)).code;
      if (!/^[A-Fa-f0-9]{8}$/.test(code || '')) throw new Error('请输入安装程序显示的8位配对码');
      if (method === 'GET') { const pair = store.devices.inspect(code); return json(res, pair ? 200 : 404, pair ? { ok: true, ...pair } : { ok: false, error: '配对码已失效或已使用' }); }
      if (!canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '需要知识库处理权限' });
      const approved = store.devices.approve(uid, code); return json(res, approved ? 200 : 409, { ok: approved, ...(approved ? {} : { error: '配对码已失效或已使用' }) });
    }
    if (route === '/settings' && method === 'GET') return json(res, 200, { ok: true, ...store.settings(uid), linkDefaults: qualitySettings({}, bilibiliAccount(getDatabase()).public(uid)), storage: { provider: storageConfig(uid) ? '115' : 'local' }, worker: store.worker(uid), chunkBytes: CHUNK_BYTES, maxBytes: MAX_VIDEO_BYTES });
    if (route === '/settings' && method === 'PUT') {
      const input = await body(req, 4096);
      if (MODEL_FIELDS.some(key => Object.hasOwn(input, key)) && !canKnowledge(session, 'model:edit')) return json(res, 403, { ok: false, error: '没有模型和强度设置权限' });
      return json(res, 200, { ok: true, ...store.saveSettings(uid, input) });
    }
    if (route === '/worker-token' && method === 'POST') return json(res, 200, { ok: true, token: store.rotateToken(uid) });
    if (route === '/documents' && method === 'GET') return json(res, 200, { ok: true, ...store.list(uid, {
      search: url.searchParams.get('search') || '', topic: url.searchParams.get('topic') || '', status: url.searchParams.get('status') || '',
      offset: Math.floor(Math.min(100000, Math.max(0, Number(url.searchParams.get('offset')) || 0))), limit: 30,
      includeTranscript: canKnowledge(session, 'transcript:view')
    }) });
    if (route === '/documents' && method === 'POST') {
      const input = await body(req, 8192);
      if (!canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '上传视频还需生成笔记权限' });
      await fsp.mkdir(root(), { recursive: true, mode: 0o700 });
      const disk = await fsp.statfs(root());
      if (Number(input.bytes) * 3 + 5 * 1024 ** 3 + getDatabase().prepare("SELECT coalesce(sum(byte_size),0) AS bytes FROM knowledge_documents WHERE status IN ('uploading','importing')").get().bytes * 2 > disk.bavail * disk.bsize) throw new Error('服务器可用空间不足');
      const config = storageConfig(uid);
      const item = getDatabase().transaction(() => {
        const created = store.create(uid, input);
        if (config) { store.sources.add(uid, created.id, sourcePath(config, uid, created)); created.storage = store.sources.public(uid, created.id); }
        return created;
      })();
      try { await fsp.mkdir(knowledgeDirectory(item.id), { recursive: true, mode: 0o700 }); }
      catch (e) { store.remove(uid, item.id); throw e; }
      return json(res, 201, { ok: true, document: item, chunkBytes: CHUNK_BYTES });
    }
    if (!document) return json(res, 405, { ok: false, error: '不支持此请求方法' });
    const [, id, operation, part] = document;
    // Receive concurrent chunk bodies before the document mutation lock. File commits,
    // completion and deletion remain serialized so no upload can recreate deleted data.
    const partData = operation === 'parts' && method === 'PUT' ? await bytes(req, CHUNK_BYTES) : null;
    return await lock(id, async () => {
      store.expire(uid);
      const item = store.get(uid, id);
      if (!item) return json(res, 404, { ok: false, error: '笔记不存在' });
      const directory = knowledgeDirectory(id);
      if (operation === 'local-input' && method === 'POST') {
        if (!canKnowledge(session, 'upload:edit') || !canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '需要上传和生成笔记权限' });
        const input = await body(req, 1024);
        if (input.cancel) { store.localInputs.remove(uid, id); return json(res, 200, { ok: true }); }
        return json(res, 200, { ok: true, ...store.localInputs.offer(uid, id, input.workerId) });
      }
      if (!operation && method === 'GET') return json(res, 200, { ok: true, document: visible(item) });
      if (!operation && method === 'PUT') {
        if (item.status === 'processing') return json(res, 409, { ok: false, error: '请等待当前任务完成后编辑' });
        return json(res, 200, { ok: true, document: visible(store.edit(uid, id, await body(req))) });
      }
      if (!operation && method === 'DELETE') {
        const downloading = store.imports.get(uid, id);
        if (downloading?.state === 'downloading' && downloading.heartbeat > Date.now() - 120000) return json(res, 409, { ok: false, error: '视频正在下载，请等待下载完成或失败后删除' });
        if (store.sources.deleting(uid, id)) return json(res, 200, { ok: true });
        store.remove(uid, id);
        await fsp.rm(directory, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      if (operation === 'parts' && method === 'GET') return json(res, 200, { ok: true, parts: store.parts(uid, id), chunkBytes: CHUNK_BYTES });
      if (operation === 'parts' && method === 'PUT') {
        const number = Number(part), count = Math.ceil(item.bytes / CHUNK_BYTES);
        if (item.status !== 'uploading' || !Number.isInteger(number) || number < 1 || number > count) throw new Error('分片编号或上传状态无效');
        const data = partData;
        if (data.length !== (number === count ? item.bytes - (number - 1) * CHUNK_BYTES : CHUNK_BYTES)) throw new Error('分片大小不符');
        if (number === 1 && !(item.mimeType === 'video/webm' ? data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) : data.toString('ascii', 4, 8) === 'ftyp')) throw new Error('视频内容与格式不符');
        const temp = path.join(directory, 'part-' + number + '.' + crypto.randomBytes(6).toString('hex'));
        await fsp.writeFile(temp, data);
        try { await fsp.rename(temp, path.join(directory, 'part-' + number)); } finally { await fsp.rm(temp, { force: true }); }
        store.part(uid, id, number, data.length); return json(res, 200, { ok: true });
      }
      if (operation === 'complete' && method === 'POST') {
        if (!canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '无权生成笔记' });
        if (item.status !== 'uploading') return json(res, 409, { ok: false, error: '视频已提交处理' });
        const parts = store.parts(uid, id), count = Math.ceil(item.bytes / CHUNK_BYTES);
        if (parts.length !== count || parts.some((p, i) => p.part !== i + 1) || parts.reduce((n, p) => n + p.bytes, 0) !== item.bytes) throw new Error('视频尚未上传完整');
        const target = await fsp.open(path.join(directory, 'source.tmp'), 'w');
        const digest = crypto.createHash('sha256');
        try { for (const p of parts) for await (const chunk of fs.createReadStream(path.join(directory, 'part-' + p.part))) { digest.update(chunk); await target.writeFile(chunk); } }
        finally { await target.close(); }
        await fsp.rename(path.join(directory, 'source.tmp'), path.join(directory, 'source'));
        store.enqueue(uid, id, digest.digest('hex'));
        for (const p of parts) await fsp.rm(path.join(directory, 'part-' + p.part), { force: true });
        return json(res, 202, { ok: true, document: store.get(uid, id) });
      }
      if (operation === 'retry' && method === 'POST') {
        if (store.imports.get(uid, id)?.state === 'failed' && !canKnowledge(session, 'import:edit')) return json(res, 403, { ok: false, error: '需要链接导入权限' });
        const input = await body(req, 4096);
        if (store.imports.get(uid, id)?.state === 'failed') {
          if (!canKnowledge(session, 'upload:edit')) return json(res, 403, { ok: false, error: '需要上传视频权限' });
          const selected = qualitySettings(input, bilibiliAccount(getDatabase()).public(uid));
          getDatabase().prepare('UPDATE knowledge_imports SET settings_json=? WHERE user_id=? AND document_id=?').run(JSON.stringify(selected), uid, id);
        }
        if (!store.retry(uid, id, input.backend || store.settings(uid).backend)) return json(res, 409, { ok: false, error: '仅失败任务可以重试' });
        return json(res, 202, { ok: true, document: store.get(uid, id) });
      }
      if (operation === 'storage-retry' && method === 'POST') {
        if (!store.sources.retry(uid, id)) return json(res, 409, { ok: false, error: '仅保存失败的视频可以重试' });
        return json(res, 202, { ok: true, document: visible(store.get(uid, id)) });
      }
      if (operation === 'source' && method === 'GET') return serveSource(req, res, store, uid, id);
      if (operation === 'frames' && method === 'GET' && item.frames.some(f => f.name === part)) return stream(req, res, path.join(directory, part), 'image/jpeg');
      if (operation === 'export' && method === 'GET') {
        const m = item.sourceMedia, media = m.width ? `\n原片清晰度：${qualityLabel(m.quality)} · ${m.width}×${m.height}${m.downgraded ? '（已降级，目标' + qualityLabel(m.requestedQuality) + '）' : ''}` : '';
        const text = `# ${item.title}\n\n来源：${item.sourceUrl || item.originalName}${media}\n生成后端：${item.provenance.backend || item.backend} / ${item.provenance.model || '未生成'}\n\n${item.notes}\n`;
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(item.title.replace(/[\\/:*?"<>|]/g, '-') + '.md') });
        return res.end(text);
      }
      return json(res, 404, { ok: false, error: '接口或资源不存在' });
    });
  } catch (e) { return json(res, e.status || 400, { ok: false, error: e.code?.startsWith('SQLITE_') ? '知识库存储失败' : e.message }); }
}
