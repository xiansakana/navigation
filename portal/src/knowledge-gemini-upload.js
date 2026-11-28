import fsp from 'node:fs/promises';

const origin = 'https://generativelanguage.googleapis.com';
const chunkTarget = 8 * 1024 ** 2;
const transient = error => error?.code === 'GEMINI_TRANSPORT' || [408, 500, 502, 503, 504].includes(error?.status);
const unsigned = value => /^\d+$/.test(value || '') ? Number(value) : NaN;

export async function uploadGeminiFile({ apiKey, file, size, mimeType, signal, send, progress, wait, chunkBytes = chunkTarget }) {
  const request = (url, stage, options) => send(url, stage, {
    ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)])
  });
  let start;
  for (let attempt = 0; ; attempt++) {
    try {
      start = await request(origin + '/upload/v1beta/files', '创建上传', {
        method: 'POST', headers: {
          'x-goog-api-key': apiKey, 'Content-Type': 'application/json',
          'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': mimeType
        },
        body: JSON.stringify({ file: { displayName: 'knowledge-video' } })
      });
      break;
    } catch (error) {
      signal.throwIfAborted();
      if (!transient(error) || attempt >= 2) throw error;
      await wait(1000 * 2 ** attempt, undefined, { signal });
    }
  }
  let uploadUrl;
  try { uploadUrl = new URL(start.headers.get('x-goog-upload-url') || '/', origin); }
  catch { throw new Error('Gemini 返回的上传地址无效'); }
  finally { await start.body?.cancel(); }
  if (uploadUrl.origin !== origin || uploadUrl.username || uploadUrl.password || uploadUrl.pathname !== '/upload/v1beta/files') {
    throw new Error('Gemini 返回的上传地址无效');
  }
  const unit = unsigned(start.headers.get('x-goog-upload-chunk-granularity') || '262144');
  if (!Number.isSafeInteger(unit) || unit < 1 || unit > chunkTarget) throw new Error('Gemini 返回的上传分块大小无效');
  const length = Math.max(unit, Math.floor(chunkBytes / unit) * unit);
  const source = await fsp.open(file, 'r');
  let offset = 0, upper = 0, retries = 0, query = false;
  const stage = bytes => '上传至 Gemini · ' + (bytes / 1024 ** 2).toFixed(1) + '/' + (size / 1024 ** 2).toFixed(1) + ' MiB';
  const percent = bytes => 15 + Math.floor(29 * bytes / size);
  try {
    while (true) {
      signal.throwIfAborted();
      try {
        if (query) {
          const response = await request(uploadUrl, '查询上传断点', {
            method: 'POST', headers: { 'X-Goog-Upload-Command': 'query', 'Content-Length': '0' }
          });
          const confirmed = unsigned(response.headers.get('x-goog-upload-size-received'));
          const status = response.headers.get('x-goog-upload-status');
          if (status === 'final') {
            const result = await response.json().catch(() => null);
            if (result?.file) return result.file;
            throw new Error('Gemini 已结束上传，但未返回文件编号，请重试此任务');
          }
          await response.body?.cancel();
          if (status !== 'active' || !Number.isSafeInteger(confirmed) || confirmed < offset
            || confirmed > upper || (confirmed < size && confirmed % unit !== 0)) {
            throw new Error('Gemini 返回了无效的上传断点');
          }
          if (confirmed > offset) retries = 0;
          offset = confirmed;
          query = false;
          continue;
        }

        const bytes = Math.min(length, size - offset), final = offset + bytes === size;
        const buffer = Buffer.allocUnsafe(bytes);
        if (bytes && (await source.read(buffer, 0, bytes, offset)).bytesRead !== bytes) throw new Error('本地原视频长度已变化');
        upper = offset + bytes;
        await progress(stage(offset), percent(offset));
        const response = await request(uploadUrl, '上传视频', {
          method: 'POST', body: buffer, headers: {
            'Content-Type': mimeType, 'Content-Length': String(bytes), 'X-Goog-Upload-Offset': String(offset),
            'X-Goog-Upload-Command': final ? (bytes ? 'upload, finalize' : 'finalize') : 'upload'
          }
        });
        if (final) {
          try { return (await response.json()).file; }
          catch (error) {
            if (error instanceof SyntaxError) throw new Error('Gemini 未返回有效的上传回执');
            throw Object.assign(new Error('Gemini 上传回执连接中断'), { code: 'GEMINI_TRANSPORT' });
          }
        }
        const state = response.headers.get('x-goog-upload-status');
        await response.body?.cancel();
        if (state !== 'active') throw new Error('Gemini 未确认当前上传分块');
        offset = upper;
        retries = 0;
      } catch (error) {
        signal.throwIfAborted();
        if (!transient(error)) throw error;
        if (++retries > 3) throw new Error('Gemini 视频上传中断，已尝试断点续传（' + stage(offset) + '）。请稍后重试。');
        await progress('Gemini 上传中断，正在查询断点 · 第 ' + retries + ' 次', percent(offset));
        await wait(1000 * 2 ** (retries - 1), undefined, { signal });
        query = true;
      }
    }
  } finally { await source.close(); }
}
