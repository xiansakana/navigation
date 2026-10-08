import dns from 'node:dns';
import net from 'node:net';

// Opt in only in the two market-data services. Keep address fallback, but allow
// cross-border IPv4 TCP handshakes to finish before trying an unreachable IPv6.
export function configureQuoteNetwork({ dnsApi = dns, netApi = net } = {}) {
  dnsApi.setDefaultResultOrder('ipv4first');
  netApi.setDefaultAutoSelectFamilyAttemptTimeout(2000);
  return { dnsOrder: 'ipv4first', addressAttemptMs: 2000 };
}

function safeMessage(value) {
  return String(value || '').replace(/https?:\/\/[^\s)]+/gi, (value) => {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
    catch { return '[url]'; }
  }).slice(0, 250);
}

export function describeQuoteError(error) {
  const parts = [];
  const seen = new Set();
  function visit(item, depth = 0) {
    if (!item || seen.has(item) || depth > 4 || parts.length >= 8) return;
    seen.add(item);
    if (item.code) parts.push(`${item.code}${item.address ? `(${item.address})` : ''}`);
    else if (item.message && item.message !== 'fetch failed') parts.push(safeMessage(item.message));
    if (item.cause) visit(item.cause, depth + 1);
    for (const child of item.errors || []) visit(child, depth + 1);
  }
  visit(error);
  return [...new Set(parts)].join('; ') || '网络请求失败';
}

function retryable(error) {
  return error.status === 429 || error.status >= 500 ||
    /AbortError|TimeoutError/.test(error.name || '') ||
    /fetch failed|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR_|socket|network|timeout|aborted/i.test(describeQuoteError(error));
}

async function deadline(operation, remainingMs, abort) {
  if (remainingMs <= 0) {
    abort();
    const error = new Error('请求硬超时');
    error.name = 'TimeoutError';
    throw error;
  }
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('请求硬超时');
      error.name = 'TimeoutError';
      reject(error);
      abort();
    }, Math.max(1, remainingMs));
  });
  try { return await Promise.race([Promise.resolve().then(operation), expired]); }
  finally { clearTimeout(timer); }
}

export async function fetchQuoteResource(url, {
  headers = {}, retries = 2, timeoutMs = 12000, json = true, encoding = 'utf-8',
  rateLimitDelayMs = 500, fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), logger = console
} = {}) {
  const host = new URL(url).hostname;
  const maxRetries = Number.isInteger(retries) ? Math.max(0, Math.min(2, retries)) : 2;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const remaining = () => timeoutMs - (Date.now() - startedAt);
    const abort = () => controller.abort();
    let phase = '连接/响应头';
    try {
      const response = await deadline(() => fetchImpl(url, { headers, signal: controller.signal }), remaining(), abort);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        abort();
        throw error;
      }
      phase = '响应体';
      if (json) return await deadline(() => response.json(), remaining(), abort);
      const bytes = Buffer.from(await deadline(() => response.arrayBuffer(), remaining(), abort));
      try { return new TextDecoder(encoding).decode(bytes); }
      catch { return bytes.toString('utf8'); }
    } catch (error) {
      abort();
      if (attempt < maxRetries && retryable(error)) {
        await sleep((error.status === 429 ? rateLimitDelayMs : 500) * (attempt + 1));
        continue;
      }
      const message = `${host} ${phase}失败（尝试${attempt + 1}次，本次${Date.now() - startedAt}ms）：${describeQuoteError(error)}`;
      logger?.warn?.(`行情请求失败: ${JSON.stringify({ at: new Date().toISOString(), host, phase, attempts: attempt + 1, error: message })}`);
      throw new Error(message);
    }
  }
}
