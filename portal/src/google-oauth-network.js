import https from 'node:https';
import dns from 'node:dns';

const endpoints = new Map([
  ['https://oauth2.googleapis.com/token', '/token'],
  ['https://openidconnect.googleapis.com/v1/userinfo', '/userinfo']
]);

export function requestOAuthRelay(url, options, requestImpl = https.request) {
  return new Promise((resolve, reject) => {
    // Race the relay's IPv4 addresses without waiting on an unreachable address.
    // Only the winning connection sends the one-use authorization code.
    const request = requestImpl(url, { ...options, family: 0, autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 2000,
      lookup: (hostname, lookupOptions, callback) => dns.lookup(hostname,
        { ...lookupOptions, family: 4 }, callback)
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) request.destroy(new Error('Google OAuth 响应过大'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Google OAuth 响应中断')));
      response.on('end', () => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          reject(new Error('Google OAuth 转发服务不应重定向'));
          return;
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode }));
      });
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

export function fetchGoogleOAuth(url, options, config, fetchImpl) {
  let target = url;
  const headers = { ...options.headers };
  if (config.relayUrl) {
    const path = endpoints.get(url);
    const relay = new URL(config.relayUrl);
    if (!path || relay.protocol !== 'https:' || relay.username || relay.password || !config.relaySecret) {
      throw new Error('Google OAuth 转发配置无效');
    }
    target = new URL(path, relay.origin).href;
    headers['X-OAuth-Relay-Secret'] = config.relaySecret;
  }
  const transport = fetchImpl || (config.relayUrl ? requestOAuthRelay : globalThis.fetch);
  return transport(target, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
}
