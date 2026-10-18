import net from 'node:net';

export function sameOriginWrite(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  return !origin || ['http://' + req.headers.host, 'https://' + req.headers.host].includes(origin);
}

export function clientAddress(req, trustedProxies = []) {
  const peer = String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  if (!trustedProxies.includes(peer)) return peer;
  // Only trust a single configured ingress hop; never use an arbitrary client supplied chain.
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
  return net.isIP(forwarded) ? forwarded : peer;
}

export async function readJson(req, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象');
  return body;
}
