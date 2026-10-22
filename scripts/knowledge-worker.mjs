import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVideo, originDownloadRequest } from '../portal/src/knowledge-download.js';
import { startLocalInputServer, localDocuments, verifyLocalInput, pruneLocalInputs } from '../portal/src/knowledge-local-input.js';
import { runProcess, summarizeVideo, modelConfiguration, resolveCodexBinary, createStageGate, workerPortalRequest } from '../portal/src/knowledge-model.js';
import { restartWithWorkerProxy } from './knowledge-worker-launcher.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.resolve(process.argv[2] || path.join(repo, 'portal/knowledge-worker.config.json'));
let config;
try { config = JSON.parse(await fsp.readFile(configPath, 'utf8')); }
catch { console.error('请先复制 portal/knowledge-worker.config.example.json 为私有配置，并填写网页生成的工作器凭据。'); process.exit(1); }
const portal = new URL(config.portalUrl || 'http://127.0.0.1:8080');
if (portal.username || portal.password || portal.search || portal.hash || portal.pathname !== '/' || !['http:', 'https:'].includes(portal.protocol) || portal.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(portal.hostname)) throw new Error('Portal 必须是 HTTPS 站点根地址（本机回环地址可用 HTTP）');
if (await restartWithWorkerProxy({ portalUrl: portal.href })) process.exit(process.exitCode || 0);
const token = process.env.KNOWLEDGE_WORKER_TOKEN || config.token;
if (!/^nkw_[a-f0-9]{64}$/.test(token || '')) throw new Error('工作器凭据无效，请在知识库设置中生成');
const originDownload = originDownloadRequest(portal.href, config.downloadOrigin);
const workRoot = path.resolve(config.workDir || path.join(repo, 'portal/data/knowledge-worker'));
await fsp.mkdir(workRoot, { recursive: true, mode: 0o700 });
const python = config.python || (process.platform === 'win32' ? 'python.exe' : 'python3');
const workerId = crypto.createHash('sha256').update(os.hostname() + ':' + configPath).digest('hex').slice(0, 32);
let stopped = false, mediaActive = 0;
let limits = { mediaConcurrency: 1, summaryConcurrency: 2 };
const activeControllers = new Set(), tasks = new Set(), summaryGate = createStageGate(2);
function configurePipeline(value) {
  if (Number.isSafeInteger(value?.mediaConcurrency) && value.mediaConcurrency >= 1 && value.mediaConcurrency <= 2
    && Number.isSafeInteger(value?.summaryConcurrency) && value.summaryConcurrency >= 1 && value.summaryConcurrency <= 4) {
    limits = value; summaryGate.setLimit(value.summaryConcurrency);
  }
}
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { stopped = true; for (const controller of activeControllers) controller.abort(); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, { data, method, lease, signal, raw = false, headers = {} } = {}) {
  const response = await workerPortalRequest(new URL('/api/knowledge/worker' + route, portal), { method: method || (data === undefined ? 'GET' : 'POST'), redirect: 'error',
    headers: { ...headers, Authorization: 'Bearer ' + token, ...(lease ? { 'X-Knowledge-Lease': lease } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.any([AbortSignal.timeout(raw ? 900000 : 120000), ...(signal ? [signal] : [])]) }, { fetch: raw && originDownload ? originDownload : globalThis.fetch });
  return raw ? response : response.json();
}
async function capabilities() {
  const result = { pipeline: { version: 1 }, reanalysis: { version: 1 } };
  try {
    const device = (await runProcess(python, [path.join(repo, 'portal/workers/video_runtime.py'), 'cuda'], { timeout: 20000 })).trim();
    await runProcess(config.ffmpeg || 'ffmpeg', ['-version'], { timeout: 10000 });
    result.media = { ready: true, model: config.asr?.model || 'turbo', detail: device, asrSettingsVersion: 1 };
  } catch { result.media = { ready: false, detail: '请检查 Python 转写依赖和 FFmpeg 路径' }; }
  try {
    const binary = resolveCodexBinary(config.codex?.binary);
    await runProcess(binary, ['login', 'status'], { timeout: 15000 });
    const help = await runProcess(binary, ['exec', '--help'], { timeout: 10000 });
    if (!help.includes('--ignore-user-config') || !help.includes('--ignore-rules')) throw new Error('Codex CLI 版本过旧');
    result.codex = { ready: true, model: config.codex?.model || 'CLI 默认模型' };
  } catch { result.codex = { ready: false, detail: '请安装新版 Codex CLI，并在运行工作器的账号下登录' }; }
  try {
    const api = config.openai || {}, url = new URL(api.baseUrl || 'https://api.openai.com/v1');
    const configured = !!(api.apiKey || process.env[api.apiKeyEnv || 'KNOWLEDGE_API_KEY']) || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const probe = !api.model && configured ? { ...config, openai: { ...api, model: '由任务设置指定' } } : config;
    const m = modelConfiguration(probe, 'openai'); result.openai = { ready: true, model: m.model, detail: m.vision ? '支持关键画面核对' : '仅文字总结' };
  }
  catch { result.openai = { ready: false, detail: '兼容 API 尚未配置模型' }; }
  return result;
}
async function download(job, directory, signal, update) {
  let last = 0;
  return downloadVideo(job, path.join(directory, 'source'), (range, transferSignal) => request('/jobs/' + job.id + '/source', { lease: job.lease, raw: true, signal: transferSignal, headers: range ? { Range: range } : {} }), signal, {
    progress(loaded, total) {
      if (Date.now() - last < 4000 && loaded < total) return;
      last = Date.now();
      update(`下载视频 · ${(loaded / 1024 ** 2).toFixed(1)}/${(total / 1024 ** 2).toFixed(1)} MB · ${Math.floor(loaded / total * 100)}%${originDownload ? ' · 源站通道' : ''}`, 2 + Math.min(2, Math.floor(loaded / total * 2))).catch(() => {});
    }
  });
}
async function processJob(job) {
  if (!/^[a-f0-9]{32}$/.test(job.id) || !Number.isSafeInteger(job.bytes) || job.bytes > 1024 ** 3) { mediaActive--; throw new Error('服务器任务格式无效'); }
  const directory = path.join(workRoot, job.id);
  try { await fsp.mkdir(directory, { recursive: true, mode: 0o700 }); } catch (e) { mediaActive--; throw e; }
  const controller = new AbortController(); activeControllers.add(controller);
  const { signal } = controller;
  let mediaHeld = true, releaseSummary;
  const releaseMedia = () => { if (mediaHeld) { mediaHeld = false; mediaActive--; } };
  let state = { stage: '下载视频', progress: 2 }, lastProgress = 0;
  const update = async (stage, progress) => {
    state = { stage, progress };
    await request('/jobs/' + job.id + '/progress', { data: state, lease: job.lease, signal });
    lastProgress = Date.now();
  };
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      await request('/jobs/' + job.id + '/progress', { data: state, lease: job.lease, signal });
      await request('/heartbeat', { data: { workerId, label: config.label || os.hostname(), capabilities: cachedCapabilities }, signal });
    } catch (e) { if ([401, 403, 409].includes(e.status)) controller.abort(); }
    finally { heartbeatBusy = false; }
  }, 20000);
  try {
    console.log(new Date().toISOString(), '领取任务', job.id, job.backend);
    const evidenceFile = path.join(directory, 'evidence.json');
    if (job.reanalysis?.state === 'pending') {
      const stamp = path.join(directory, 'reanalysis-run.txt');
      const previous = await fsp.readFile(stamp, 'utf8').catch(() => '');
      if (previous !== job.reanalysis.runId) {
        await fsp.rm(evidenceFile, { force: true }); await fsp.rm(path.join(directory, 'result.json'), { force: true });
        await fsp.writeFile(stamp, job.reanalysis.runId);
      }
      if (job.reanalysis.mode === 'reuse' && !fs.existsSync(evidenceFile)) {
        await update('复用已有转写与关键画面 · 无需下载原视频', 60);
        const { evidence } = await request('/jobs/' + job.id + '/evidence', { lease: job.lease, signal });
        for (const f of evidence.frames) {
          if (!/^[a-z0-9.-]+\.jpg$/.test(f.name)) throw new Error('画面文件名无效');
          await fsp.writeFile(path.join(directory, f.name), Buffer.from(f.data, 'base64'));
        }
        evidence.frames = evidence.frames.map(({ data, ...f }) => f);
        await fsp.writeFile(evidenceFile, JSON.stringify(evidence));
      }
    }
    const speech = job.modelSettings || {};
    const profile = speech.asrProfile === 'bazi' || (speech.asrProfile || 'auto') === 'auto' && /八字|命理|盲派|四柱|乾造|坤造/.test([job.title, job.topic, ...(job.tags || [])].join(' ')) ? 'bazi' : 'general';
    const language = speech.asrLanguage === 'auto' ? '' : speech.asrLanguage || config.asr?.language || 'zh';
    const asrSelection = JSON.stringify({ version: 2, model: speech.asrModel || config.asr?.model || 'turbo', language, profile, hotwords: speech.asrHotwords || '' });
    if (job.reanalysis?.mode !== 'reuse' && fs.existsSync(evidenceFile)) {
      const cached = JSON.parse(await fsp.readFile(evidenceFile, 'utf8'));
      if (cached.asrSelection !== asrSelection) {
        await fsp.rm(evidenceFile, { force: true }); await fsp.rm(path.join(directory, 'result.json'), { force: true });
      }
    }
    if (!fs.existsSync(evidenceFile)) {
      let input;
      if (job.localInput) {
        await update('校验本机原视频 · 无需下载', 2);
        if (!await verifyLocalInput(workRoot, job)) {
          await request('/local-input', { data: { action: 'forget', documentId: job.id, workerId: config.deviceId || workerId } });
          throw new Error('本机原视频缓存失效，归档完成后可重试');
        }
        input = path.join(directory, 'source');
        console.log(new Date().toISOString(), '直接使用本机原视频', job.id);
      } else input = await download(job, directory, signal, update);
      const args = [path.join(repo, 'portal/workers/video_evidence.py'), '--input', input, '--output', directory,
        '--ffmpeg', config.ffmpeg || 'ffmpeg', '--model', speech.asrModel || config.asr?.model || 'turbo', '--device', 'cuda',
        '--profile', profile, '--hotwords', speech.asrHotwords || '',
        '--threads', String(config.asr?.threads || 2)];
      if (language) args.push('--language', language);
      if (config.asr?.modelCache) args.push('--model-cache', path.resolve(config.asr.modelCache));
      await runProcess(python, args, { cwd: directory, signal, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        timeout: 8 * 3600000, onLine(line) {
          try {
            const data = JSON.parse(line); state = { stage: data.stage, progress: data.progress };
            if (data.metrics) console.log(new Date().toISOString(), job.id, '素材耗时', JSON.stringify(data.metrics));
            if (Date.now() - lastProgress > 5000) update(state.stage, state.progress).catch(() => {});
          } catch { /* Library diagnostics are not protocol messages. */ }
        } });
    }
    if (job.storage?.provider === '115' && job.storage.state === 'ready') await fsp.rm(path.join(directory, 'source'), { force: true });
    const evidence = JSON.parse(await fsp.readFile(evidenceFile, 'utf8'));
    if (job.reanalysis?.mode !== 'reuse') { evidence.asrSelection = asrSelection; await fsp.writeFile(evidenceFile, JSON.stringify(evidence)); }
    // Persist the handoff before freeing the GPU slot. The same lease and local
    // evidence stay with this worker; no video upload/download is added here.
    await request('/jobs/' + job.id + '/phase', { data: { phase: 'summary_wait' }, lease: job.lease, signal });
    state = { stage: '等待总结', progress: Math.max(state.progress, 60) };
    releaseMedia();
    releaseSummary = await summaryGate.acquire(signal);
    while (true) {
      const transition = await request('/jobs/' + job.id + '/phase', { data: { phase: 'summary' }, lease: job.lease, signal });
      if (transition.accepted) break;
      await sleep(1000); signal.throwIfAborted();
    }
    await update('正在总结', 65);
    const defaults = config[job.backend === 'codex' ? 'codex' : 'openai'] || {};
    const selection = JSON.stringify({ id: job.id, runId: job.reanalysis?.runId || '', title: job.title, topic: job.topic, tags: job.tags, sourceUrl: job.sourceUrl, backend: job.backend, modelSettings: job.modelSettings,
      workerModel: { model: defaults.model || '', reasoningEffort: defaults.reasoningEffort || '', vision: defaults.vision } });
    let result;
    try {
      const cached = JSON.parse(await fsp.readFile(path.join(directory, 'result.json'), 'utf8'));
      if (cached.workerSelection === selection) { result = cached; console.log('复用已完成笔记，仅重新提交入库', job.id); }
    } catch { /* A missing or incomplete result must be generated normally. */ }
    if (!result) {
      const summary = await summarizeVideo({...config,onCodexCall:input=>request('/jobs/'+job.id+'/codex',{data:input,lease:job.lease,signal})}, job, evidence, directory, update, signal);
      const frames = [];
      for (const f of evidence.frames) frames.push({ name: f.name, time: f.time, data: (await fsp.readFile(path.join(directory, f.name))).toString('base64') });
      result = { ...evidence, ...summary, frames, workerSelection: selection };
    }
    await fsp.writeFile(path.join(directory, 'result.json'), JSON.stringify(result), { mode: 0o600 });
    await update('保存知识库', 98);
    let saved = false;
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      try { await request('/jobs/' + job.id + '/complete', { data: result, lease: job.lease, signal }); saved = true; }
      catch (e) { if ([401, 409, 400, 413].includes(e.status) || attempt === 3) throw e; await sleep(5000); }
    }
    // directory is always the validated 32-hex job under the configured work root.
    await fsp.rm(directory, { recursive: true, force: true });
    console.log(new Date().toISOString(), '笔记已入库', job.id);
  } catch (e) {
    console.error(new Date().toISOString(), '任务失败', job.id, e.message);
    try { await request('/jobs/' + job.id + '/fail', { data: { error: e.message, stage: state.stage }, lease: job.lease }); } catch { /* Expired jobs are recovered by the server. */ }
  } finally { clearInterval(heartbeat); releaseMedia(); releaseSummary?.(); activeControllers.delete(controller); }
}
let cachedCapabilities = {}, checkedAt = 0;
let localServer;
if (process.platform === 'win32' && config.localUpload !== false) {
  try {
    localServer = await startLocalInputServer({ portalOrigin: portal.origin, workRoot, workerId: config.deviceId || workerId,
      ready: () => cachedCapabilities.media?.ready && cachedCapabilities.media.detail === 'cuda',
      authorize: data => request('/local-input', { data: { ...data, workerId: config.deviceId || workerId } }) });
  } catch { console.error('本机直送端口不可用，将继续使用服务器下载流程'); }
}
let updateCheckedAt = Date.now();
let cacheCheckedAt = 0;
console.log('知识库工作器已启动：', portal.origin, '配置：', configPath);
while (!stopped) {
  try {
    if (Date.now() - checkedAt > 60000) { cachedCapabilities = await capabilities(); checkedAt = Date.now(); }
    const heartbeat = await request('/heartbeat', { data: { workerId, label: config.label || os.hostname(), capabilities: cachedCapabilities } });
    configurePipeline(heartbeat.pipeline);
    const backends = cachedCapabilities.media?.ready ? ['codex', 'openai'].filter(b => cachedCapabilities[b]?.ready) : [];
    const hasCapacity = mediaActive < limits.mediaConcurrency && tasks.size < limits.mediaConcurrency + limits.summaryConcurrency;
    const { job } = hasCapacity ? await request('/claim', { data: { backends, workerId, localDocuments: localServer ? await localDocuments(workRoot) : [] } }) : { job: null };
    if (stopped && job) {
      await request('/jobs/' + job.id + '/fail', { data: { error: '工作器正在退出，请重试' }, lease: job.lease });
      break;
    }
    if (job) {
      mediaActive++;
      const task = processJob(job).catch(e => console.error('任务启动失败', job.id, e.message));
      tasks.add(task); task.finally(() => tasks.delete(task));
    }
    else {
      if (!tasks.size && localServer && !localServer.isReceiving() && Date.now() - cacheCheckedAt > 3600000) { await pruneLocalInputs(workRoot); cacheCheckedAt = Date.now(); }
      if (!tasks.size && config.autoUpdate && !localServer?.isReceiving() && Date.now() - updateCheckedAt > 15 * 60000) {
        updateCheckedAt = Date.now();
        try {
          const release = await request('/release');
          const current = JSON.parse(await fsp.readFile(path.join(repo, 'worker-version.json'), 'utf8'));
          if (release.version !== current.version) { process.exitCode = 75; break; }
        } catch { /* Keep processing when update checks are unavailable. */ }
      }
      await sleep(tasks.size ? 1000 : 5000);
    }
  } catch (e) {
    console.error(new Date().toISOString(), e.message, e.cause?.code ? '网络错误：' + e.cause.code + '。请检查服务器直连与代理连接；不代表GPU故障。' : '');
    if ([401, 403].includes(e.status)) {
      console.error('设备已停用或凭据失效，请重新运行安装程序连接。');
      for (const controller of activeControllers) controller.abort();
      process.exitCode = 78; break;
    }
    await sleep(10000);
  }
}
await Promise.allSettled([...tasks]);
localServer?.close();
