import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
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

test('the stock portfolio API forwards gzip while preserving the JSON representation', { timeout: 10000 }, async () => {
  const portfolio = { trades: [{ note: '/webui is literal text in these notes' }] };
  const upstream = http.createServer((req, res) => {
    const gzip = req.headers['accept-encoding'] === 'gzip';
    const body = JSON.stringify(portfolio);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Vary': 'Accept-Encoding',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(gzip ? gzipSync(body) : body);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const service = { id: 'stock-manage', path: '/stock-manage', internalUrl: `http://127.0.0.1:${upstream.address().port}` };
  const portal = http.createServer((req, res) => void proxyHttpRequest(service, req, res));
  portal.listen(0, '127.0.0.1'); await once(portal, 'listening');
  try {
    const url = `http://127.0.0.1:${portal.address().port}/stock-manage/api/portfolio`;
    const [compressed, identity] = await Promise.all(['gzip', 'identity'].map(encoding =>
      fetch(url, { headers: { 'accept-encoding': encoding } })));
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
    assert.equal(identity.headers.get('content-encoding'), null);
    assert.deepEqual(await compressed.json(), portfolio);
    assert.deepEqual(await identity.json(), portfolio);
  } finally {
    portal.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => portal.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});
