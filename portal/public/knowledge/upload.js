// Upload only missing chunks; keep memory and simultaneous requests bounded.
export function uploadChunk(url, blob, { signal, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = error => { signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    xhr.open('PUT', url); xhr.timeout = 180000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => onProgress(event.loaded);
    xhr.onload = () => {
      let payload;
      try { payload = JSON.parse(xhr.responseText); } catch { /* Login redirects and proxy errors are not valid upload acknowledgements. */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload?.ok) return finish();
      const error = new Error(payload?.error || '上传失败，请检查网络或登录状态');
      error.retryable = [408, 429].includes(xhr.status) || xhr.status >= 500;
      finish(error);
    };
    xhr.onerror = xhr.ontimeout = () => finish(Object.assign(new Error('上传连接中断或超时'), { retryable: true }));
    xhr.onabort = () => finish(new Error('上传已停止，已完成的分片可续传'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { finish(new Error('上传已停止')); return; }
    xhr.send(blob);
  });
}

export async function uploadParts({ file, parts, chunkBytes, url, onProgress = () => {}, send = uploadChunk, retryDelay = 500 }) {
  const done = new Set(parts.map(p => p.part));
  const count = Math.ceil(file.size / chunkBytes), pending = [];
  const size = number => Math.min(chunkBytes, file.size - (number - 1) * chunkBytes);
  let completed = 0, next = 0, failure = null, transferred = 0;
  for (let number = 1; number <= count; number++) {
    if (done.has(number)) completed += size(number); else pending.push(number);
  }
  const controller = new AbortController(), active = new Map(), started = performance.now();
  const samples = [{ time: started, bytes: 0 }];
  const report = () => {
    const now = performance.now();
    samples.push({ time: now, bytes: transferred });
    while (samples.length > 2 && samples[1].time < now - 5000) samples.shift();
    const speed = (transferred - samples[0].bytes) / Math.max(0.001, (now - samples[0].time) / 1000);
    const loaded = Math.min(file.size, completed + [...active.values()].reduce((sum, n) => sum + n, 0));
    onProgress({ loaded, completed, total: file.size, speed, remaining: speed > 0 ? (file.size - loaded) / speed : null, elapsed: (now - started) / 1000 });
  };
  const timer = setInterval(report, 500);
  report();
  const worker = async () => {
    while (!failure && next < pending.length) {
      const number = pending[next++], bytes = size(number);
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          let previous = 0; active.set(number, 0);
          try {
            await send(url + number, file.slice((number - 1) * chunkBytes, (number - 1) * chunkBytes + bytes), {
              signal: controller.signal, onProgress(value) {
                const loaded = Math.min(bytes, Math.max(previous, value));
                transferred += loaded - previous; previous = loaded; active.set(number, loaded);
              }
            });
            transferred += bytes - previous; completed += bytes; active.delete(number); report(); break;
          } catch (error) {
            active.delete(number);
            if (failure || error.retryable === false || attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, retryDelay * 2 ** attempt));
            if (failure) return;
          }
        }
      } catch (error) { if (!failure) { failure = error; controller.abort(); } }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
    if (failure) throw failure;
    return { elapsedMs: Math.round(performance.now() - started) };
  } finally { clearInterval(timer); }
}
