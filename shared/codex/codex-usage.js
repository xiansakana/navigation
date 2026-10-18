import { spawn } from 'node:child_process';

export function isUsageQuery(text) {
  const value = text.trim();
  if (/^(额度|用量|usage|quota|limits|\/status)[？?。！!]*$/i.test(value)) return true;
  // Only intercept short questions, never implementation requests or mixed coding tasks.
  return value.length <= 200 && !/修复|实现|增加|添加|修改|代码|部署|提交|为什么|为何|接口|功能|按钮|页面|测试|然后|并且/i.test(value)
    && /额度|用量|quota|usage limit/i.test(value)
    && /还剩|剩余|多少|什么时候|啥时候|何时|重置|查一下|查询|查看|how much|remaining|reset/i.test(value);
}

const failure = '额度查询失败：请检查服务器 Codex CLI 版本、ChatGPT 登录状态及代理连接后重试。';

export function readCodexUsage(config, { signal, timeout = 20000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('额度查询已停止'));
    const env = { ...process.env, ...(config.proxyUrl ? { HTTPS_PROXY: config.proxyUrl, HTTP_PROXY: config.proxyUrl, ALL_PROXY: config.proxyUrl } : {}) };
    let child;
    try { child = spawnProcess(config.binary || 'codex', ['app-server'], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new Error(failure)); return; }
    let buffer = '', settled = false, initialized = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child.stdin.end();
      child.kill();
      // app-server can take time to shut down. Do not leave a stuck subprocess behind.
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
      force.unref(); child.once('close', () => clearTimeout(force));
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error('额度查询已停止'));
    const timer = setTimeout(() => finish(new Error('额度查询超时，请稍后重试。')), timeout);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error(failure)));
    child.on('close', () => finish(new Error(failure)));
    child.stdin.on('error', () => finish(new Error(failure)));
    child.stderr.resume(); // Never forward diagnostics, which may contain account data.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(new Error(failure)); return; }
      let index;
      while (!settled && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id !== 1 && message?.id !== 2) continue;
        if (message.error) { finish(new Error(failure)); return; }
        if (message.id === 1 && !initialized) {
          initialized = true;
          send({ method: 'initialized', params: {} });
          send({ method: 'account/rateLimits/read', id: 2 });
        } else if (message.id === 2 && initialized) {
          const result = message.result;
          if (!result || typeof result !== 'object' || !('rateLimits' in result || 'rateLimitsByLimitId' in result)) finish(new Error(failure));
          else finish(null, result);
        }
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'qq_codex_usage', title: 'QQ Codex Usage', version: '1.0.0' } } });
  });
}

function beijingTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '未提供';
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '未提供';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
}

export function formatCodexUsage(snapshot, now = Date.now()) {
  const mapped = snapshot.rateLimitsByLimitId;
  const buckets = mapped && typeof mapped === 'object' && Object.keys(mapped).length
    ? Object.entries(mapped) : snapshot.rateLimits ? [[snapshot.rateLimits.limitId || 'codex', snapshot.rateLimits]] : [];
  const lines = ['Codex 账户额度（QQ 服务器当前登录账号）', '查询时间：' + beijingTime(now / 1000) + '（北京时间）'];
  if (!buckets.length) lines.push('服务器未返回账户额度，无法确定剩余量或重置时间。');
  for (const [id, bucket] of buckets.slice(0, 10)) {
    lines.push(id === 'codex' ? '普通 Codex 额度：' : `额度池 ${id}：`);
    const windows = [bucket?.primary, bucket?.secondary].filter(Boolean);
    for (const minutes of [300, 10080]) {
      const window = windows.find(w => w.windowDurationMins === minutes);
      const label = minutes === 300 ? '5 小时' : '周';
      if (!window) { lines.push(`${label}额度：未提供`); continue; }
      const used = window.usedPercent;
      const remaining = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100
        ? Number((100 - used).toFixed(2)) + '%' : '未知';
      lines.push(`${label}额度：剩余 ${remaining}；重置：${beijingTime(window.resetsAt)}`);
    }
    for (const window of windows.filter(w => ![300, 10080].includes(w.windowDurationMins))) {
      const used = window.usedPercent;
      const remaining = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 ? Number((100 - used).toFixed(2)) + '%' : '未知';
      lines.push(`${window.windowDurationMins ?? '未知'} 分钟额度：剩余 ${remaining}；重置：${beijingTime(window.resetsAt)}`);
    }
  }
  lines.push('重置时间均为北京时间；未提供表示本次接口未返回，不代表剩余为 0。');
  return lines.join('\n');
}
