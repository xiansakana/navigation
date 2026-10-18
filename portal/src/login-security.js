import crypto from 'node:crypto';
import { clientAddress } from '../../shared/http.js';

export function sessionSecret(config) {
  const secret = config.auth?.sessionSecret;
  if (typeof secret !== 'string' || secret.length < 32 || /change-me|example|replace-me/i.test(secret)) {
    throw new Error('请配置至少32字符的独立随机 auth.sessionSecret');
  }
  if (secret === config.auth?.password) throw new Error('会话密钥不能与登录密码相同');
  return secret;
}

export function cookieOptions(config) {
  // Explicit production setting survives TLS termination; no untrusted forwarded header is used.
  return { secure: config.auth?.secureCookies === true || process.env.NODE_ENV === 'production' };
}

export function createLoginLimiter({ clock = Date.now, maxEntries = 10000, windowMs = 15 * 60000 } = {}) {
  const records = new Map();
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const prune = () => { for (const [key, value] of records) if (value.expires <= clock()) records.delete(key); };
  function keys(req, username, config) {
    const address = clientAddress(req, config.auth?.trustedProxies || []);
    return ['ip:' + address, 'account:' + digest(String(username || '').trim().toLowerCase())];
  }
  return {
    check(req, username, config) {
      prune();
      const retryMs = Math.max(0, ...keys(req, username, config).map(key => (records.get(key)?.until || 0) - clock()));
      // Saturation rejects new buckets rather than evicting active throttles.
      return Math.ceil((retryMs || (records.size >= maxEntries && keys(req, username, config).some(key => !records.has(key)) ? 1000 : 0)) / 1000);
    },
    failure(req, username, config) {
      prune();
      for (const key of keys(req, username, config)) {
        if (!records.has(key) && records.size >= maxEntries) continue;
        const prior = records.get(key) || { failures: 0 };
        const failures = prior.failures + 1;
        const threshold = key.startsWith('ip:') ? 20 : 5;
        records.set(key, { failures, expires: clock() + windowMs,
          until: clock() + (failures < threshold ? 0 : Math.min(60000, 1000 * 2 ** Math.min(6, failures - threshold))) });
      }
    },
    success(req, username, config) { records.delete(keys(req, username, config)[1]); }
  };
}
