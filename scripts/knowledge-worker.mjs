import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runProcess, summarizeVideo, modelConfiguration } from '../portal/src/knowledge-model.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.resolve(process.argv[2] || path.join(repo, 'portal/knowledge-worker.config.json'));
let config;
try { config = JSON.parse(await fsp.readFile(configPath, 'utf8')); }
catch { console.error('请先复制 portal/knowledge-worker.config.example.json 为私有配置，并填写网页生成的工作器凭据。'); process.exit(1); }
const portal = new URL(config.portalUrl || 'http://127.0.0.1:8080');
if (portal.username || portal.password || portal.search || portal.hash || portal.pathname !== '/' || !['http:', 'https:'].includes(portal.protocol) || portal.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(portal.hostname)) throw new Error('Portal 必须是 HTTPS 站点根地址（本机回环地址可用 HTTP）');
const token = process.env.KNOWLEDGE_WORKER_TOKEN || config.token;
if (!/^nkw_[a-f0-9]{64}$/.test(token || '')) throw new Error('工作器凭据无效，请在知识库设置中生成');
const workRoot = path.resolve(config.workDir || path.join(repo, 'portal/data/knowledge-worker'));
await fsp.mkdir(workRoot, { recursive: true });
const python = config.python || (process.platform === 'win32' ? 'python.exe' : 'python3');
let stopped = false, activeController = null;
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { stopped = true; activeController?.abort(); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, { data, method, lease, signal, raw = false } = {}) {
  const response = await fetch(new URL('/api/knowledge/worker' + route, portal), { method: method || (data === undefined ? 'GET' : 'POST'), redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, ...(lease ? { 'X-Knowledge-Lease': lease } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.any([AbortSignal.timeout(raw ? 900000 : 60000), ...(signal ? [signal] : [])]) });
  if (!response.ok) {
    const error = new Error('Portal 返回 HTTP ' + response.status);
    error.status = response.status; throw error;
  }
  return raw ? response : response.json();
}
async function capabilities() {
  const result = {};
  try {
    await runProcess(python, ['-c', 'import faster_whisper, av; from PIL import Image'], { timeout: 20000 });
    await runProcess(config.ffmpeg || 'ffmpeg', ['-version'], { timeout: 10000 });
    result.media = { ready: true, model: config.asr?.model || 'small', detail: config.asr?.device || 'cpu' };
  } catch { result.media = { ready: false, detail: '请检查 Python 转写依赖和 FFmpeg 路径' }; }
  try {
    const binary = config.codex?.binary || (process.platform === 'win32' ? 'codex.exe' : 'codex');
    await runProcess(binary, ['login', 'status'], { timeout: 15000 });
    const help = await runProcess(binary, ['exec', '--help'], { timeout: 10000 });
    if (!help.includes('--ignore-user-config') || !help.includes('--ignore-rules')) throw new Error('Codex CLI 版本过旧');
    result.codex = { ready: true, model: config.codex?.model || 'CLI 默认模型' };
  } catch { result.codex = { ready: false, detail: '请安装新版 Codex CLI，并在运行工作器的账号下登录' }; }
  try { const m = modelConfiguration(config, 'openai'); result.openai = { ready: true, model: m.model, detail: m.vision ? '支持关键画面核对' : '仅文字总结' }; }
  catch { result.openai = { ready: false, detail: '兼容 API 尚未配置模型' }; }
  return result;
}
async function download(job, directory, signal) {
  const target = path.join(directory, 'source');
  if (fs.existsSync(target) && fs.statSync(target).size === job.bytes) return target;
  const response = await request('/jobs/' + job.id + '/source', { lease: job.lease, raw: true, signal });
  let count = 0;
  const limiter = new Transform({ transform(chunk, _, callback) { count += chunk.length; callback(count > job.bytes ? new Error('视频超过声明大小') : null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(target + '.tmp'), { signal });
  if (count !== job.bytes) throw new Error('视频下载不完整');
  await fsp.rename(target + '.tmp', target);
  return target;
}
async function processJob(job) {
  if (!/^[a-f0-9]{32}$/.test(job.id) || !Number.isSafeInteger(job.bytes) || job.bytes > 1024 ** 3) throw new Error('服务器任务格式无效');
  const directory = path.join(workRoot, job.id);
  await fsp.mkdir(directory, { recursive: true });
  activeController = new AbortController();
  const { signal } = activeController;
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
      await request('/heartbeat', { data: { label: config.label || os.hostname(), capabilities: cachedCapabilities }, signal });
    } catch (e) { if ([401, 409].includes(e.status)) activeController?.abort(); }
    finally { heartbeatBusy = false; }
  }, 20000);
  try {
    console.log(new Date().toISOString(), '领取任务', job.id, job.backend);
    const input = await download(job, directory, signal), evidenceFile = path.join(directory, 'evidence.json');
    if (!fs.existsSync(evidenceFile)) {
      const args = [path.join(repo, 'portal/workers/video_evidence.py'), '--input', input, '--output', directory,
        '--ffmpeg', config.ffmpeg || 'ffmpeg', '--model', config.asr?.model || 'small', '--device', config.asr?.device || 'cpu',
        '--threads', String(config.asr?.threads || 2)];
      if (config.asr?.language) args.push('--language', config.asr.language);
      if (config.asr?.modelCache) args.push('--model-cache', path.resolve(config.asr.modelCache));
      await runProcess(python, args, { cwd: directory, signal, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        timeout: 8 * 3600000, onLine(line) {
          try {
            const data = JSON.parse(line); state = { stage: data.stage, progress: data.progress };
            if (Date.now() - lastProgress > 5000) update(state.stage, state.progress).catch(() => {});
          } catch { /* Library diagnostics are not protocol messages. */ }
        } });
    }
    const evidence = JSON.parse(await fsp.readFile(evidenceFile, 'utf8'));
    const summary = await summarizeVideo(config, job, evidence, directory, update, signal);
    const frames = [];
    for (const f of evidence.frames) frames.push({ time: f.time, data: (await fsp.readFile(path.join(directory, f.name))).toString('base64') });
    const result = { ...evidence, ...summary, frames };
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
    try { await request('/jobs/' + job.id + '/fail', { data: { error: e.message }, lease: job.lease }); } catch { /* Expired jobs are recovered by the server. */ }
  } finally { clearInterval(heartbeat); activeController = null; }
}
let cachedCapabilities = {}, checkedAt = 0;
console.log('知识库工作器已启动：', portal.origin, '配置：', configPath);
while (!stopped) {
  try {
    if (Date.now() - checkedAt > 60000) { cachedCapabilities = await capabilities(); checkedAt = Date.now(); }
    await request('/heartbeat', { data: { label: config.label || os.hostname(), capabilities: cachedCapabilities } });
    const backends = cachedCapabilities.media?.ready ? ['codex', 'openai'].filter(b => cachedCapabilities[b]?.ready) : [];
    const { job } = await request('/claim', { data: { backends } });
    if (job) await processJob(job);
    else await sleep(5000);
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
    if (e.status === 401) { console.error('请更新私有配置中的工作器凭据后重启。'); break; }
    await sleep(10000);
  }
}
