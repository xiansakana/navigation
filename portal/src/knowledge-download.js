import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function valid(file, job) {
  if (!fs.existsSync(file) || fs.statSync(file).size !== job.bytes) return false;
  if (!job.sourceSha256) return true;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === job.sourceSha256;
}
export async function downloadVideo(job, target, request, signal) {
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
  let count = offset;
  const limiter = new Transform({ transform(chunk, _, cb) { count += chunk.length; cb(count > job.bytes ? new Error('视频超过声明大小') : null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(temp, { flags: offset ? 'a' : 'w', mode: 0o600 }), { signal });
  if (count !== job.bytes) throw new Error('视频下载不完整，可重试续传');
  if (!await valid(temp, job)) { await fsp.rm(temp, { force: true }); throw new Error('视频完整性校验失败'); }
  await fsp.rename(temp, target);
  return target;
}
