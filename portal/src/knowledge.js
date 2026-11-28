import { sameOriginWrite } from '../../shared/http.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { geminiAccounts, defaultGeminiModel } from './knowledge-gemini.js';
import { getKnowledgeDatabase } from './knowledge-runtime.js';
import { createPostgresKnowledgeStore } from './knowledge-postgres-store.js';
import { storageConfig } from './knowledge-storage.js';
import { hasPermission } from './rbac.js';
import { createKnowledgeStore, CHUNK_BYTES, MAX_VIDEO_BYTES, MODEL_FIELDS } from './knowledge-store.js';
import { sendWorkerPackage } from './knowledge-worker-package.js';
import { sendWorkerExe } from './knowledge-worker-exe.js';
import { inspectBilibili, inspectBilibiliQuality, qualityLabel } from './knowledge-bilibili.js';
import { bilibiliAccount, qualitySettings } from './knowledge-bilibili-account.js';
import { handlePublicKnowledge, handleKnowledgeVisibility, handleKnowledgeBatchVisibility } from './knowledge-public.js';
import { createUploadQueue } from './knowledge-upload-queue.js';
import { duplicateSourceError } from './knowledge-source-dedupe.js';
import { retryKnowledgeDocument } from './knowledge-retry.js';
import { reanalysisTargets, scheduleReanalysis } from './knowledge-reanalysis.js';
import { createKnowledgeCaseStore } from './mingli-knowledge-store.js';
import { ASR_FIELDS } from './knowledge-asr.js';

import { body, bytes, lock, stream, serveSource, knowledgeRoot, knowledgeDirectory, knowledgeFailure } from './knowledge-http.js';

export function canKnowledge(session, action = 'view') {
  return !!session?.userId && (!session.isGuest || ['view', 'notes:view'].includes(action))
    && hasPermission(session.permissions || [], 'knowledge:' + action);
}

const importRequests = new Map();
async function inspectImport(uid, url) {
  const time = Date.now();
  for (const [key, value] of importRequests) if (time - value.since > 60000 && !value.busy) importRequests.delete(key);
  const rate = importRequests.get(uid) || { since: time, count: 0, busy: false };
  if (rate.busy || rate.count >= 20 || importRequests.size > 10000) throw Object.assign(new Error('视频信息读取过于频繁，请稍后重试'), { status: 429 });
  rate.count++; rate.busy = true; importRequests.set(uid, rate);
  try { const cookie = await bilibiliAccount(getKnowledgeDatabase()).credentials(uid); return await inspectBilibili(url, { cookie }); } finally { rate.busy = false; }
}

export async function handleKnowledgeApi(req, res, url, session, json) {
  try { return await knowledgeApi(req, res, url, session, json); }
  catch (e) { return knowledgeFailure(res, json, e, canKnowledge(session, 'notes:view')); }
}
async function knowledgeApi(req, res, url, session, json) {
  res.setHeader('Cache-Control', 'no-store');
  if (!canKnowledge(session)) return json(res, 403, { ok: false, error: '请登录并获取知识库权限' });
  if (req.headers['x-knowledge-owner'] && req.headers['x-knowledge-owner'] !== session.userId)
    return json(res, 409, { ok: false, code: 'KNOWLEDGE_ACCOUNT_CHANGED', error: '登录账号已变化，请回到原账号继续或刷新页面' });
  if (url.pathname.startsWith('/api/knowledge/public/')) {
    if (!canKnowledge(session, 'notes:view')) return json(res, 403, { ok: false, error: '无权查看公开笔记' });
    try { return await handlePublicKnowledge(req, res, url, json, getKnowledgeDatabase()); }
    catch { return json(res, 503, { ok: false, error: '公开笔记暂不可用，请稍后重试' }); }
  }
  // Never route a guest through personal settings, worker, import, media or document APIs.
  if (session.isGuest) return json(res, 403, { ok: false, error: '游客仅可浏览公开笔记' });
  if (url.pathname === '/api/knowledge/documents/visibility') {
    if (!canKnowledge(session, 'publish:batch:edit') || !canKnowledge(session, 'publish:edit') || !canKnowledge(session, 'notes:view'))
      return json(res, 403, { ok: false, error: '无权批量修改笔记可见范围' });
    return handleKnowledgeBatchVisibility(req, res, session, json, getKnowledgeDatabase());
  }
  const visibility = /^\/api\/knowledge\/documents\/([a-f0-9]{32})\/visibility$/.exec(url.pathname);
  if (visibility) {
    if (!canKnowledge(session, 'publish:edit') || !canKnowledge(session, 'notes:view')) return json(res, 403, { ok: false, error: '无权修改笔记可见范围' });
    try { return await handleKnowledgeVisibility(req, res, url, session, json, getKnowledgeDatabase(), visibility[1]); }
    catch { return json(res, 503, { ok: false, error: '可见范围暂不可用，请稍后重试' }); }
  }
  const route = url.pathname.slice('/api/knowledge'.length), method = req.method;
  const document = /^\/documents\/([a-f0-9]{32})(?:\/(parts|complete|local-input|retry|storage-retry|reanalyze|versions|restore|source|export|frames)(?:\/([a-z0-9.-]+))?)?$/.exec(route);
  const action = route === '/settings' ? method === 'GET' ? 'view' : 'settings:edit'
    : route === '/documents/retry-failed' && method === 'POST' ? 'process:batch:edit'
    : route === '/reanalysis' && method === 'POST' ? 'reanalysis:batch:edit'
    : route === '/upload-queue' ? method === 'GET' ? 'queue:view' : method === 'POST' ? 'queue:edit' : null
    : /^\/upload-queue\/[a-f0-9]{32}\/(retry|cancel)$/.test(route) && method === 'POST' ? 'queue:manage'
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
        : document ? method === 'GET' ? document[2] === 'versions' ? 'history:view' : document[2] === 'export' ? 'export:view' : 'view'
          : document[2] === 'reanalyze' ? 'reanalysis:edit' : document[2] === 'restore' ? 'history:restore'
          : method === 'DELETE' ? 'delete:edit' : document[2] === 'local-input' ? 'local-input:edit' : document[2] === 'storage-retry' ? 'storage:edit' : document[2] === 'retry' ? 'process:edit'
            : document[2] ? 'upload:edit' : 'notes:edit' : null;
  if (!action) return json(res, 404, { ok: false, error: '知识库接口不存在' });
  if (!canKnowledge(session, action)) return json(res, 403, { ok: false, error: '无权执行此知识库操作' });
  if (method === 'GET' && (route === '/documents' || document && !['parts', 'source', 'frames'].includes(document[2])) && !canKnowledge(session, 'notes:view')) return json(res, 403, { ok: false, error: '无权查看学习笔记' });
  if (document && ['source', 'frames'].includes(document[2]) && !canKnowledge(session, document[2] + ':view')) return json(res, 403, { ok: false, error: '无权查看此原始材料' });
  if (!['GET', 'HEAD'].includes(method) && (!sameOriginWrite(req))) return json(res, 403, { ok: false, error: '不允许跨站写入' });
  const db = getKnowledgeDatabase(), store = db.query ? createPostgresKnowledgeStore(db) : createKnowledgeStore(db), uid = session.userId;
  const retry = (id, input = {}) => db.query ? store.retry(uid, id, action => canKnowledge(session, action), input)
    : retryKnowledgeDocument(db, store, uid, id, action => canKnowledge(session, action), input);
  const visible = d => d && ({ ...d, transcript: canKnowledge(session, 'transcript:view') ? d.transcript.map(({ rawText, ...s }) => ({ ...s, ...(canKnowledge(session, 'transcript:script:view') ? { rawText } : {}) })) : [], frames: canKnowledge(session, 'frames:view') ? d.frames : [] });
  try {
    if (route.startsWith('/upload-queue')) {
      const queue = store.queue || createUploadQueue(db);
      if (route === '/upload-queue' && method === 'GET') return json(res, 200, { ok: true, ...await queue.list(uid, Math.min(100000, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0)))) });
      if (!route.endsWith('/cancel') && !['import:edit', 'upload:edit', 'process:edit'].every(a => canKnowledge(session, a))) return json(res, 403, { ok: false, error: '需要链接导入、上传和生成笔记权限' });
      if (route === '/upload-queue' && method === 'POST') {
        const input = await body(req, 180000), defaults = await store.settings(uid);
        const result = await queue.add(uid, input, { ...defaults, quality: await bilibiliAccount(db).public(uid), modelSettings: Object.fromEntries([...MODEL_FIELDS, ...ASR_FIELDS].map(key => [key, defaults[key]])) });
        if (!canKnowledge(session, 'notes:view')) result.results = result.results.map(({ documentId, title, ...rest }) => rest);
        return json(res, 202, { ok: true, ...result });
      }
      const match = /^\/upload-queue\/([a-f0-9]{32})\/(retry|cancel)$/.exec(route);
      if (!await queue.get(uid, match[1])) return json(res, 404, { ok: false, error: '队列任务不存在' });
      if (!await queue.change(uid, match[1], match[2])) return json(res, 409, { ok: false, error: '任务已进入下载处理，请在对应笔记中管理' });
      return json(res, 200, { ok: true });
    }
    if (route.startsWith('/bilibili')) {
      const account = bilibiliAccount(db);
      if (route === '/bilibili' && method === 'GET') return json(res, 200, { ok: true, account: await account.public(uid) });
      if (route === '/bilibili/check') return json(res, 200, { ok: true, account: await account.check(uid) });
      if (route === '/bilibili/settings') return json(res, 200, { ok: true, settings: qualitySettings({}, await account.saveSettings(uid, await body(req, 1024))) });
      if (route === '/bilibili/login/start') return json(res, 200, { ok: true, ...await account.start(uid) });
      if (route === '/bilibili/login/poll') return json(res, 200, { ok: true, ...await account.poll(uid) });
      if (route === '/bilibili' && method === 'DELETE') return json(res, 200, { ok: true, account: await account.unlink(uid) });
    }
    if (['/imports/preview', '/imports'].includes(route)) {
      if (!canKnowledge(session, 'upload:edit') || !canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '需要上传视频和生成笔记权限' });
      const input = await body(req, 8192);
      const known = await store.duplicateSource(uid, input.url);
      if (known) throw duplicateSourceError(known);
      const info = await inspectImport(uid, input.url);
      const resolved = await store.duplicateSource(uid, info.sourceUrl);
      if (resolved) throw duplicateSourceError(resolved);
      const account = bilibiliAccount(db), selection = qualitySettings(input, await account.public(uid));
      const cookie = await account.credentials(uid);
      const playback = await inspectBilibiliQuality(info, selection, { cookie });
      if (route === '/imports/preview') return json(res, 200, { ok: true, metadata: { ...info, playback } });
      if (!playback.canImport) throw new Error(playback.reason);
      await fsp.mkdir(knowledgeRoot(), { recursive: true, mode: 0o700 });
      const disk = await fsp.statfs(knowledgeRoot());
      const item = await store.createLinkImport(uid, {
        title: input.title === undefined ? info.title : input.title,
        topic: input.topic === undefined ? info.topic : input.topic,
        tags: input.tags === undefined ? info.tags : input.tags,
        sourceUrl: input.sourceUrl === undefined ? info.sourceUrl : input.sourceUrl,
        bytes: MAX_VIDEO_BYTES,
        mimeType: 'video/mp4',
        originalName: info.title.replace(/[\\/:*?"<>|]/g, '-') + '.mp4',
        backend: input.backend || (await store.settings(uid)).backend
      }, info.sourceUrl, selection, storageConfig(uid), disk.bavail * disk.bsize);
      return json(res, 202, { ok: true, document: item });
    }
    if (route === '/worker-install') {
      if (!canKnowledge(session, 'devices:edit') || !canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '需要设备绑定和视频处理权限' });
      const input = await body(req, 1024), format = input.format || 'exe';
      if (!['exe', 'zip'].includes(format)) throw new Error('安装包格式无效');
      if (format === 'zip' && !canKnowledge(session, 'devices:install-zip')) return json(res, 403, { ok: false, error: '需要ZIP脚本安装包下载权限' });
      const pairing = await store.devices.start('Windows 视频工作器');
      if (!await store.devices.approve(uid, pairing.userCode)) throw new Error('设备配对码已失效');
      const binding = { portalUrl: process.env.KNOWLEDGE_PUBLIC_URL || 'https://saoyu.fun', deviceCode: pairing.deviceCode, expiresAt: Date.now() + 600000 };
      return format === 'zip' ? sendWorkerPackage(res, binding) : sendWorkerExe(res, binding);
    }
    if (route === '/worker-package') return sendWorkerPackage(res);
    if (route === '/devices' && method === 'GET') return json(res, 200, { ok: true, devices: await store.devices.list(uid) });
    if (/^\/devices\/[a-f0-9]{32}$/.test(route) && method === 'DELETE') { const revoked = await store.devices.revoke(uid, route.split('/').pop()); return json(res, revoked ? 200 : 404, { ok: revoked }); }
    if (route === '/device-pair') {
      const code = method === 'GET' ? url.searchParams.get('code') : (await body(req, 1024)).code;
      if (!/^[A-Fa-f0-9]{8}$/.test(code || '')) throw new Error('请输入安装程序显示的8位配对码');
      if (method === 'GET') { const pair = await store.devices.inspect(code); return json(res, pair ? 200 : 404, pair ? { ok: true, ...pair } : { ok: false, error: '配对码已失效或已使用' }); }
      if (!canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '需要知识库处理权限' });
      const approved = await store.devices.approve(uid, code); return json(res, approved ? 200 : 409, { ok: approved, ...(approved ? {} : { error: '配对码已失效或已使用' }) });
    }
    if (route === '/settings' && method === 'GET') {
      const account = geminiAccounts().get(uid);
      return json(res, 200, { ok: true, ...await store.settings(uid), linkDefaults: qualitySettings({}, await bilibiliAccount(db).public(uid)), storage: { provider: storageConfig(uid) ? '115' : 'local' }, worker: await store.worker(uid), chunkBytes: CHUNK_BYTES, maxBytes: MAX_VIDEO_BYTES, gemini: { configured: !!account, model: account?.model || defaultGeminiModel } });
    }
    if (route === '/settings' && method === 'PUT') {
      const input = await body(req, 4096);
      if (MODEL_FIELDS.some(key => Object.hasOwn(input, key)) && !canKnowledge(session, 'model:edit')) return json(res, 403, { ok: false, error: '没有模型和强度设置权限' });
      if (ASR_FIELDS.some(key => Object.hasOwn(input, key)) && !canKnowledge(session, 'asr:edit')) return json(res, 403, { ok: false, error: '没有语音转写设置权限' });
      if (['mediaConcurrency', 'summaryConcurrency'].some(key => Object.hasOwn(input, key)) && !canKnowledge(session, 'concurrency:edit')) return json(res, 403, { ok: false, error: '没有并发设置权限' });
      return json(res, 200, { ok: true, ...await store.saveSettings(uid, input) });
    }
    if (route === '/worker-token' && method === 'POST') return json(res, 200, { ok: true, token: await store.rotateToken(uid) });
    if (route === '/reanalysis' && method === 'POST') {
      if (!canKnowledge(session, 'reanalysis:edit') || !canKnowledge(session, 'process:edit') || !canKnowledge(session, 'notes:view')) return json(res, 403, { ok: false, error: '需要重新分析、生成笔记和查看笔记权限' });
      const input = await body(req, 256000), items = await reanalysisTargets(store, uid, input, canKnowledge(session, 'transcript:view'));
      return json(res, 202, { ok: true, ...await scheduleReanalysis(store, uid, items, input.mode || 'reuse', knowledgeDirectory, input.preview === true) });
    }
    if (route === '/documents/retry-failed' && method === 'POST') {
      if (!canKnowledge(session, 'process:edit') || !canKnowledge(session, 'notes:view')) return json(res, 403, { ok: false, error: '需要查看笔记和生成笔记权限' });
      await body(req, 4096);
      const failed = await store.failedDocuments(uid);
      const results = [];
      for (const { id } of failed) {
        try { results.push({ id, accepted: await retry(id) }); }
        catch (e) { results.push({ id, accepted: false, error: /^SQLITE_/.test(e.code || '') ? '知识库忙，请稍后重试' : e.message }); }
      }
      const accepted = results.filter(r => r.accepted).length;
      return json(res, 202, { ok: true, accepted, skipped: results.length - accepted, results });
    }
    if (route === '/documents' && method === 'GET') return json(res, 200, { ok: true, ...await store.list(uid, {
      search: url.searchParams.get('search') || '', topic: url.searchParams.get('topic') || '', status: url.searchParams.get('status') || '',
      offset: Math.floor(Math.min(100000, Math.max(0, Number(url.searchParams.get('offset')) || 0))), limit: 30,
      includeTranscript: canKnowledge(session, 'transcript:view')
    }) });
    if (route === '/documents' && method === 'POST') {
      const input = await body(req, 8192);
      if (!canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '上传视频还需生成笔记权限' });
      const duplicate = await store.duplicateSource(uid, input.sourceUrl);
      if (duplicate) throw duplicateSourceError(duplicate);
      await fsp.mkdir(knowledgeRoot(), { recursive: true, mode: 0o700 });
      const disk = await fsp.statfs(knowledgeRoot());
      const item = await store.createUpload(uid, input, storageConfig(uid), disk.bavail * disk.bsize);
      try { await fsp.mkdir(knowledgeDirectory(item.id), { recursive: true, mode: 0o700 }); }
      catch (e) { await store.remove(uid, item.id); throw e; }
      return json(res, 201, { ok: true, document: item, chunkBytes: CHUNK_BYTES });
    }
    if (!document) return json(res, 405, { ok: false, error: '不支持此请求方法' });
    const [, id, operation, part] = document;
    // Receive concurrent chunk bodies before the document mutation lock. File commits,
    // completion and deletion remain serialized so no upload can recreate deleted data.
    const partData = operation === 'parts' && method === 'PUT' ? await bytes(req, CHUNK_BYTES) : null;
    return await lock(id, async () => {
      await store.expire(uid);
      const item = await store.get(uid, id);
      if (!item) return json(res, 404, { ok: false, error: '笔记不存在' });
      if (operation === 'versions' && method === 'GET') return json(res, 200, { ok: true, versions: await store.reanalysis.list(uid, id) });
      if (['reanalyze', 'restore'].includes(operation) && method === 'POST') {
        if (!canKnowledge(session, 'process:edit') || !canKnowledge(session, 'notes:view')) return json(res, 403, { ok: false, error: '需要生成笔记和查看笔记权限' });
        const input = await body(req, 4096);
        if (operation === 'reanalyze') return json(res, 202, { ok: true, ...await scheduleReanalysis(store, uid, [{ id, revision: input.revision }], input.mode || 'reuse', knowledgeDirectory, input.preview === true) });
        if (!/^[a-f0-9]{32}$/.test(input.versionId || '')) throw new Error('历史版本无效');
        await store.reanalysis.restore(uid, id, input.versionId, input.revision);
        if (!db.query) createKnowledgeCaseStore(db).syncDocument(store.getRow(uid, id));
        return json(res, 200, { ok: true, document: visible(await store.get(uid, id)) });
      }
      const directory = knowledgeDirectory(id);
      if (operation === 'local-input' && method === 'POST') {
        if (!canKnowledge(session, 'upload:edit') || !canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '需要上传和生成笔记权限' });
        const input = await body(req, 1024);
        if (input.cancel) { await store.localInputs.remove(uid, id); return json(res, 200, { ok: true }); }
        if (item.backend === 'gemini') throw new Error('Gemini 使用服务器原视频');
        return json(res, 200, { ok: true, ...await store.localInputs.offer(uid, id, input.workerId) });
      }
      if (!operation && method === 'GET') return json(res, 200, { ok: true, document: visible(item) });
      if (!operation && method === 'PUT') {
        if (item.status === 'processing' || item.status === 'queued' && item.reanalysis?.state === 'pending') return json(res, 409, { ok: false, error: '请等待当前任务完成后编辑' });
        return json(res, 200, { ok: true, document: visible(await store.edit(uid, id, await body(req))) });
      }
      if (!operation && method === 'DELETE') {
        const downloading = await store.imports.get(uid, id);
        if (downloading?.state === 'downloading' && downloading.heartbeat > Date.now() - 120000) return json(res, 409, { ok: false, error: '视频正在下载，请等待下载完成或失败后删除' });
        if (await store.sources.deleting(uid, id)) return json(res, 200, { ok: true });
        if (!await store.remove(uid, id)) return json(res, 409, { ok: false, error: '笔记状态已变化，请刷新后重试' });
        await fsp.rm(directory, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      if (operation === 'parts' && method === 'GET') return json(res, 200, { ok: true, parts: await store.parts(uid, id), chunkBytes: CHUNK_BYTES });
      if (operation === 'parts' && method === 'PUT') {
        const number = Number(part), count = Math.ceil(item.bytes / CHUNK_BYTES);
        if (item.status !== 'uploading' || !Number.isInteger(number) || number < 1 || number > count) throw new Error('分片编号或上传状态无效');
        const data = partData;
        if (data.length !== (number === count ? item.bytes - (number - 1) * CHUNK_BYTES : CHUNK_BYTES)) throw new Error('分片大小不符');
        if (number === 1 && !(item.mimeType === 'video/webm' ? data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) : data.toString('ascii', 4, 8) === 'ftyp')) throw new Error('视频内容与格式不符');
        const temp = path.join(directory, 'part-' + number + '.' + crypto.randomBytes(6).toString('hex'));
        await fsp.writeFile(temp, data);
        try { await fsp.rename(temp, path.join(directory, 'part-' + number)); } finally { await fsp.rm(temp, { force: true }); }
        await store.part(uid, id, number, data.length); return json(res, 200, { ok: true });
      }
      if (operation === 'complete' && method === 'POST') {
        if (!canKnowledge(session, 'process:edit')) return json(res, 403, { ok: false, error: '无权生成笔记' });
        if (item.status !== 'uploading') return json(res, 409, { ok: false, error: '视频已提交处理' });
        const parts = await store.parts(uid, id), count = Math.ceil(item.bytes / CHUNK_BYTES);
        if (parts.length !== count || parts.some((p, i) => p.part !== i + 1) || parts.reduce((n, p) => n + p.bytes, 0) !== item.bytes) throw new Error('视频尚未上传完整');
        const target = await fsp.open(path.join(directory, 'source.tmp'), 'w');
        const digest = crypto.createHash('sha256');
        try { for (const p of parts) for await (const chunk of fs.createReadStream(path.join(directory, 'part-' + p.part))) { digest.update(chunk); await target.writeFile(chunk); } }
        finally { await target.close(); }
        await fsp.rename(path.join(directory, 'source.tmp'), path.join(directory, 'source'));
        if (!await store.enqueue(uid, id, digest.digest('hex'))) return json(res, 409, { ok: false, error: '视频已提交处理' });
        for (const p of parts) await fsp.rm(path.join(directory, 'part-' + p.part), { force: true });
        return json(res, 202, { ok: true, document: await store.get(uid, id) });
      }
      if (operation === 'retry' && method === 'POST') {
        const input = await body(req, 4096);
        if (!await retry(id, input)) return json(res, 409, { ok: false, error: '仅失败任务可以重试' });
        return json(res, 202, { ok: true, document: await store.get(uid, id) });
      }
      if (operation === 'storage-retry' && method === 'POST') {
        if (!await store.sources.retry(uid, id)) return json(res, 409, { ok: false, error: '仅保存失败的视频可以重试' });
        return json(res, 202, { ok: true, document: visible(await store.get(uid, id)) });
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
  } catch (e) { return knowledgeFailure(res, json, e, canKnowledge(session, 'notes:view')); }
}
