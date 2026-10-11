import https from 'node:https';
import dns from 'node:dns';

const endpoints = new Map([
  ['https://oauth2.googleapis.com/token', '/token'],
  ['https://openidconnect.googleapis.com/v1/userinfo', '/userinfo']
]);

export async function requestOAuthRelay(url, options, requestImpl = https.request,
  lookupImpl = (hostname) => dns.promises.lookup(hostname, { all: true, family: 4 })) {
  const signal = options.signal || AbortSignal.timeout(15000);
  signal.throwIfAborted();
  let rejectLookup;
  const aborted = new Promise((_, reject) => { rejectLookup = () => reject(signal.reason); });
  signal.addEventListener('abort', rejectLookup, { once: true });
  let addresses;
  try { addresses = await Promise.race([lookupImpl(new URL(url).hostname), aborted]); }
  finally { signal.removeEventListener('abort', rejectLookup); }
  let lastError;
  for (const address of [...new Set(addresses.map((item) => item.address))].slice(0, 8)) {
    signal.throwIfAborted();
    try { return await connectAddress(address); }
    catch (error) {
      if (error.sent || signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('Google OAuth 转发服务没有 IPv4 地址');

  function connectAddress(address) {
    return new Promise((resolve, reject) => {
      let sent = false;
      let timer;
      const fail = (error) => { clearTimeout(timer); error.sent = sent; reject(error); };
      const request = requestImpl(url, { ...options, signal, agent: false, family: 4,
        lookup: (_hostname, _options, callback) => callback(null, address, 4)
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 65536) request.destroy(new Error('Google OAuth 响应过大'));
          else chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('aborted', () => fail(new Error('Google OAuth 响应中断')));
        response.on('end', () => {
          if (size > 65536) { fail(new Error('Google OAuth 响应过大')); return; }
          if (response.statusCode >= 300 && response.statusCode < 400) {
            fail(new Error('Google OAuth 转发服务不应重定向'));
            return;
          }
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode }));
        });
      });
      // TCP can connect while TLS hangs. Try another address before sending the
      // authorization code, but never retry once any HTTP request was sent.
      timer = setTimeout(() => request.destroy(new Error('Google OAuth TLS 连接超时')), 3000);
      request.on('error', fail);
      request.on('socket', (socket) => socket.once('secureConnect', () => {
        clearTimeout(timer);
        sent = true;
        request.end(options.body);
      }));
    });
  }
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
