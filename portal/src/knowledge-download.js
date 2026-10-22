import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function valid(file, job) {
  if (!fs.existsSync(file) || fs.statSync(file).size !== job.bytes) return false;
  if (!job.sourceSha256) return true;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === job.sourceSha256;
}
// Optional private origin route: keep TLS hostname/chain verification and the
// existing Portal token/lease checks, while avoiding a slow CDN body transfer.
export function originDownloadRequest(portalUrl, origin) {
  if (!origin?.address) return null;
  const portal = new URL(portalUrl), port = origin.port ?? 443;
  if (portal.protocol !== 'https:' || !net.isIP(origin.address) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('源站下载配置无效');
  let ca;
  if (origin.caFile) {
    if (fs.statSync(origin.caFile).size > 65536) throw new Error('源站CA文件过大');
    ca = fs.readFileSync(origin.caFile);
  }
  return (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== portal.origin || !/^\/api\/knowledge\/worker\/jobs\/[a-f0-9]{32}\/source$/.test(url.pathname) || options.method && options.method !== 'GET' || options.body) throw new Error('源站仅允许读取当前Portal的视频');
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: origin.address, port, servername: portal.hostname, ca, rejectUnauthorized: true,
        path: url.pathname + url.search, method: 'GET', headers: { ...options.headers, Host: portal.host }, signal: options.signal, agent: false }, response => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
      });
      request.on('error', reject); request.end();
    });
  };
}
export async function downloadVideo(job, target, request, signal, { progress = () => {}, idleMs = 30000, retryDelayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const stalled = new AbortController(); let timer;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(Object.assign(new Error('视频下载连续30秒未收到数据'), { code: 'DOWNLOAD_STALLED' })), idleMs); };
    const attemptSignal = AbortSignal.any([stalled.signal, ...(signal ? [signal] : [])]);
    try { touch(); return await downloadAttempt(job, target, range => request(range, attemptSignal), attemptSignal, loaded => { touch(); progress(loaded, job.bytes); }); }
    catch (cause) {
      const error = stalled.signal.aborted && !signal?.aborted ? stalled.signal.reason : cause;
      const interrupted = /^(terminated|fetch failed)$/i.test(error.message || '') || ['DOWNLOAD_STALLED', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code || error.code);
      if (signal?.aborted || !interrupted) throw error;
      if (attempt >= 2) throw new Error('下载视频时网络连接中断或长时间无数据，已自动续传重试2次；请检查网络后点击一键重试。');
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
}
async function downloadAttempt(job, target, request, signal, progress) {
  if (await valid(target, job)) return target;
  const temp = target + '.tmp';
  if (await valid(temp, job)) { await fsp.rename(temp, target); return target; }
  let offset = fs.existsSync(temp) ? fs.statSync(temp).size : 0;
  if (offset >= job.bytes) { await fsp.rm(temp, { force: true }); offset = 0; }
  const response = await request(offset ? 'bytes=' + offset + '-' : undefined);
  if (response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!match || Number(match[1]) !== offset || Number(match[2]) !== job.bytes - 1 || Number(match[3]) !== job.bytes) {
      await response.body.cancel(); throw new Error('视频续传范围无效');
    }
  } else if (response.status === 200) offset = 0;
  else { await response.body?.cancel(); throw new Error('视频下载失败'); }
  let count = offset; progress(count);
  const limiter = new Transform({ transform(chunk, _, cb) { count += chunk.length; if (count <= job.bytes) progress(count); cb(count > job.bytes ? new Error('视频超过声明大小') : null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(temp, { flags: offset ? 'a' : 'w', mode: 0o600 }), { signal });
  if (count !== job.bytes) throw new Error('视频下载不完整，可重试续传');
  if (!await valid(temp, job)) { await fsp.rm(temp, { force: true }); throw new Error('视频完整性校验失败'); }
  await fsp.rename(temp, target);
  return target;
}
