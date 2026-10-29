import crypto from 'node:crypto';
import { readJson, sameOriginWrite } from '../../shared/http.js';
import { sessionSecret } from './login-security.js';

export const TORN_WORKER_MODULES = ['torn-shopping', 'torn-chain', 'torn-factions'];
export function tornWorkerPort(config) {
  const port = config.runtime?.tornMonitorWorkerPort ?? 8792;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Torn worker port');
  return port;
}
export function workerSignature(text, config) {
  const key = crypto.createHmac('sha256', sessionSecret(config)).update('torn-monitor-worker/v1').digest();
  return crypto.createHmac('sha256', key).update(text).digest('hex');
}
export function verifyWorkerMessage(text, signature, config, seen, now = Date.now()) {
  const expected = workerSignature(text, config);
  if (!/^[a-f0-9]{64}$/.test(signature || '') || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new Error('Unauthorized');
  const message = JSON.parse(text);
  if (!Number.isSafeInteger(message.at) || Math.abs(now - message.at) > 30000 || typeof message.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(message.nonce)) throw new Error('Expired request');
  for (const [nonce, at] of seen) if (now - at > 60000) seen.delete(nonce);
  if (seen.has(message.nonce) || seen.size >= 10000) throw new Error('Replayed request');
  seen.set(message.nonce, now);
  return message;
}

export async function forwardTornWorker(req, res, url, session, { config, json, fetchImpl = fetch }) {
  if (!sameOriginWrite(req)) return json(res, 403, { ok: false, error: '不允许跨站操作' });
  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? null : await readJson(req, 65536);
    const text = JSON.stringify({ at: Date.now(), nonce: crypto.randomBytes(16).toString('hex'), method: req.method,
      path: url.pathname + url.search, headers: { host: req.headers.host, origin: req.headers.origin, 'sec-fetch-site': req.headers['sec-fetch-site'] },
      session: { userId: session.userId, isGuest: session.isGuest, permissions: session.permissions, dataAccess: session.dataAccess }, body });
    const response = await fetchImpl('http://127.0.0.1:' + tornWorkerPort(config) + '/dispatch', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Torn-Signature': workerSignature(text, config) }, body: text, signal: AbortSignal.timeout(45000) });
    const result = await response.json();
    res.setHeader('Cache-Control', 'no-store');
    return json(res, response.status, result);
  } catch (error) {
    return json(res, error.status || 503, { ok: false, error: error.status === 413 ? '请求体过大' : 'Torn 监控进程暂不可用，请稍后重试；后台任务不会转回 Portal 重复执行' });
  }
}
