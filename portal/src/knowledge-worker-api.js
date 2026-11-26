import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDatabase } from '../../shared/db/index.js';
import { createKnowledgeStore } from './knowledge-store.js';
import { knowledgeWorkerPackage, sendWorkerPackage } from './knowledge-worker-package.js';
import { failureMessage } from '../public/knowledge/failure.js';
import { body, lock, serveSource, knowledgeDirectory, knowledgeFailure } from './knowledge-http.js';

const pairingRates = new Map();

export function validateKnowledgeResult(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 14400) throw new Error('视频时长无效或超过4小时');
  if (typeof raw.notes !== 'string' || raw.notes.trim().length < 40 || raw.notes.length > 500000) throw new Error('总结为空或过长');
  if (!Array.isArray(raw.transcript) || raw.transcript.length > 30000) throw new Error('转写数据无效');
  let previous = -1;
  const transcript = raw.transcript.map(s => {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.start < previous || s.end < s.start || s.end > raw.duration + 2 || typeof s.text !== 'string' || s.text.length > 12000) throw new Error('转写时间戳或文本无效');
    previous = s.start;
    if (s.rawText !== undefined && (typeof s.rawText !== 'string' || s.rawText.length > 12000)) throw new Error('原始转写文字无效');
    return { start: s.start, end: s.end, text: s.rawText ?? s.text };
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

export async function handleKnowledgeWorkerApi(req, res, url, json, authorize = () => false, store) {
  try { return await workerApi(req, res, url, json, authorize, store); }
  catch (e) { return knowledgeFailure(res, json, e); }
}
async function workerApi(req, res, url, json, authorize, store = createKnowledgeStore(getDatabase())) {
  res.setHeader('Cache-Control', 'no-store');
  const route = url.pathname.slice('/api/knowledge/worker'.length), method = req.method;
  if (['/pair/start', '/pair/poll'].includes(route) && method === 'POST') {
    try {
      const raw = await body(req, 1024);
      if (route === '/pair/start') {
        const key = req.socket.remoteAddress || 'unknown', time = Date.now();
        for (const [ip, r] of pairingRates) if (r.until < time) pairingRates.delete(ip);
        const rate = pairingRates.get(key) || { count: 0, until: time + 60000 };
        if (++rate.count > 30 || pairingRates.size > 10000) return json(res, 429, { ok: false, error: '配对请求过多，请稍后重试' });
        pairingRates.set(key, rate);
        return json(res, 200, { ok: true, ...await store.devices.start(raw.label) });
      }
      if (!/^[a-f0-9]{64}$/.test(raw.deviceCode || '')) return json(res, 400, { ok: false, error: '配对请求无效' });
      return json(res, 200, { ok: true, ...await store.devices.poll(raw.deviceCode, authorize, raw.label) });
    } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  }
  const token = /^Bearer (nkw_[a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
  if (!token) return json(res, 401, { ok: false, error: '工作器凭据无效' });
  const device = await store.devices.authenticate(token), uid = device?.user_id || await store.workerUser(token);
  if (!uid) return json(res, 401, { ok: false, error: '工作器凭据已撤销' });
  if (!await authorize(uid)) return json(res, 403, { ok: false, error: '账号已停用或知识库处理权限已撤销' });
  try {
    if (route === '/package' && method === 'GET') return sendWorkerPackage(res);
    if (route === '/release' && method === 'GET') { const { version, sha256, bytes } = knowledgeWorkerPackage(); return json(res, 200, { ok: true, version, sha256, bytes }); }
    if (route === '/heartbeat' && method === 'POST') {
      const raw = await body(req, 4096);
      const accepted = await store.heartbeatWorker(uid, device ? { ...raw, workerId: device.id, label: device.label } : raw, token, device);
      if (accepted === false) return json(res, 401, { ok: false, error: '工作器凭据已撤销' });
      const { mediaConcurrency, summaryConcurrency } = await store.settings(uid);
      return json(res, 200, { ok: true, pipeline: { mediaConcurrency, summaryConcurrency } });
    }
    if (route === '/local-input' && method === 'POST') {
      const raw = await body(req, 4096), workerId = device?.id || raw.workerId;
      if (raw.action === 'forget') { await store.localInputs.forget(uid, raw.documentId, workerId); return json(res, 200, { ok: true }); }
      return json(res, 200, { ok: true, ...await store.localInputs.verify(uid, raw.documentId, workerId, raw.ticket, raw.sha256) });
    }
    if (route === '/claim' && method === 'POST') {
      const raw = await body(req, 4096);
      const backends = Array.isArray(raw.backends) ? raw.backends.filter(b => ['codex', 'openai'].includes(b)) : [];
      return json(res, 200, { ok: true, job: await store.claim(uid, backends, device?.id || (typeof raw.workerId === 'string' ? raw.workerId : ''), Array.isArray(raw.localDocuments) ? raw.localDocuments.slice(0, 200).filter(id => /^[a-f0-9]{32}$/.test(id)) : []) });
    }
    const match = /^\/jobs\/([a-f0-9]{32})\/(source|evidence|progress|phase|complete|fail|codex)$/.exec(route);
    if (!match) return json(res, 404, { ok: false, error: '工作器接口不存在' });
    const [, id, action] = match, lease = req.headers['x-knowledge-lease'];
    return await lock(id, async () => {
      if (!await store.leased(uid, id, lease)) return json(res, 409, { ok: false, error: '任务已删除、过期或由其他工作器领取' });
      if(action==='codex'&&method==='POST'){
        const input=await body(req,3*1024*1024);
        if(!await store.leased(uid,id,lease))return json(res,409,{ok:false,error:'任务已过期'});
        const doc=await store.getRow(uid,id);if(doc?.backend!=='codex')return json(res,400,{ok:false,error:'此任务未使用Codex'});
        if(await store.codexCalls.record(uid,doc,input,lease)===false)return json(res,409,{ok:false,error:'任务已过期'});
        return json(res,200,{ok:true});
      }
      if (action === 'source' && method === 'GET') return serveSource(req, res, store, uid, id);
      if (action === 'evidence' && method === 'GET') {
        const d = await store.get(uid, id), run = await store.reanalysis.get(uid, id);
        if (run?.state !== 'pending' || run.mode !== 'reuse') return json(res, 409, { ok: false, error: '此任务未请求复用素材' });
        const frames = [];
        for (const f of d.frames) {
          if (!/^[a-z0-9.-]+\.jpg$/.test(f.name)) throw new Error('画面文件名无效');
          frames.push({ ...f, data: (await fsp.readFile(path.join(knowledgeDirectory(id), f.name))).toString('base64') });
        }
        return json(res, 200, { ok: true, evidence: { duration: d.duration, language: d.language, transcript: d.transcript, frames, asrModel: d.provenance.asrModel || '', warnings: ['本次复用已有转写与抽样画面，未重新提取原视频。'] } });
      }
      if (action === 'phase' && method === 'POST') {
        const input = await body(req, 1024);
        return json(res, 200, { ok: true, accepted: await store.phase(uid, id, lease, input.phase) });
      }
      if (action === 'progress' && method === 'POST') {
        const input = await body(req, 4096); await store.progress(uid, id, lease, input.stage, input.progress); return json(res, 200, { ok: true });
      }
      if (action === 'fail' && method === 'POST') {
        const input = await body(req, 4096);
        const stage = String(input.stage || (await store.getRow(uid, id))?.stage || '').slice(0, 120);
        await store.fail(uid, id, lease, failureMessage(String(input.error || '工作器处理失败'), stage));
        return json(res, 200, { ok: true });
      }
      if (action === 'complete' && method === 'POST') {
        const raw = await body(req, 18 * 1024 * 1024), result = validateKnowledgeResult(raw);
        const directory = knowledgeDirectory(id);
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        const batch = randomBytes(16).toString('hex');
        const names = new Map();
        for (let i = 0; i < result.frames.length; i++) {
          const frame = result.frames[i], name = `frame-${batch}-${i + 1}.jpg`;
          const previous = raw.frames[i].name || frame.name;
          if (typeof previous === 'string' && /^[a-z0-9.-]+\.jpg$/.test(previous)) names.set(previous, name);
          frame.name = name;
        }
        result.notes = result.notes.replace(/\/frames\/([a-z0-9.-]+\.jpg)\b/g, (link, name) => names.has(name) ? '/frames/' + names.get(name) : link);
        for (const f of result.frames) await fsp.writeFile(path.join(directory, f.name), f.data);
        result.frames = result.frames.map(({ data, ...f }) => f);
        if (!await store.finish(uid, id, lease, result)) {
          await Promise.allSettled(result.frames.map(frame => fsp.rm(path.join(directory, frame.name), { force: true })));
          return json(res, 409, { ok: false, error: '任务已过期' });
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { ok: false, error: '不支持此请求方法' });
    });
  } catch (e) { return knowledgeFailure(res, json, e); }
}
