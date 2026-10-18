import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { proxyHttpRequest } from './proxy.js';

test('uploads reach upstream before completion and preserve chunked bytes', { timeout: 10000 }, async () => {
  let signal;
  const receivedFirstChunk = new Promise(resolve => { signal = resolve; });
  let total = 0;
  const upstream = http.createServer((req, res) => {
    req.on('data', chunk => { total += chunk.length; signal(); });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Security-Policy': "default-src 'none'" }); res.end(String(total)); });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const portal = http.createServer((req, res) => void proxyHttpRequest({ id: 'alist', path: '/alist', internalUrl: `http://127.0.0.1:${upstream.address().port}` }, req, res));
  portal.listen(0, '127.0.0.1'); await once(portal, 'listening');
  let client;
  try {
    const response = new Promise((resolve, reject) => {
      client = http.request({ hostname: '127.0.0.1', port: portal.address().port, path: '/alist/upload', method: 'PUT' }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString(), csp: res.headers['content-security-policy'] }));
      });
      client.on('error', reject);
    });
    client.write(Buffer.alloc(1024 * 1024, 7));
    await receivedFirstChunk;
    client.end(Buffer.alloc(1024, 8));
    const result = await response;
    assert.equal(result.body, String(1024 * 1024 + 1024));
    assert.equal(result.csp, "default-src 'none'");
  } finally {
    client?.destroy();
    portal.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => portal.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});
