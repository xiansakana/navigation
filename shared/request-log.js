import crypto from 'node:crypto';

export function instrumentRequest(req, res, service, log = console.log) {
  const id = crypto.randomUUID();
  const start = performance.now();
  req.requestId = id;
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-Id', id);
  if (process.env.NODE_TEST_CONTEXT) return;
  res.once('finish', () => {
    let path = '/';
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { /* Malformed requests must not crash logging. */ }
    // Namespace only: paths and query strings can contain bearer tickets or personal identifiers.
    log(JSON.stringify({ at: new Date().toISOString(), service, requestId: id,
      method: req.method, namespace: path.startsWith('/api/') ? path.split('/')[2] : 'page',
      status: res.statusCode, durationMs: Math.round(performance.now() - start) }));
  });
}
