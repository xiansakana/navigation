import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workerProxyEnvironment } from '../../scripts/knowledge-worker-launcher.mjs';

test('Windows worker inherits enabled proxies, preserves explicit overrides, bypasses loopback and reboots only once', () => {
  const readProxy = () => ({ enabled: 1, server: 'http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892' });
  const env = workerProxyEnvironment({ platform: 'win32', env: { no_proxy: 'internal.test' }, readProxy });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890/'); assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7891/');
  assert.match(env.NO_PROXY, /internal.test,localhost,127\.0\.0\.1/); assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(workerProxyEnvironment({ platform: 'win32', env, readProxy }), null);
  const explicit = workerProxyEnvironment({ platform: 'win32', env: { HTTPS_PROXY: 'http://private-proxy:80' }, readProxy: () => assert.fail('explicit proxy wins') });
  assert.equal(explicit.HTTPS_PROXY, 'http://private-proxy:80');
  for (const proxy of [{ enabled: 0, server: '127.0.0.1:7890' }, { enabled: 1, server: 'socks=127.0.0.1:7890' }, { enabled: 1, server: '' }]) {
    assert.equal(workerProxyEnvironment({ platform: 'win32', env: {}, readProxy: () => proxy }), null);
  }
  assert.equal(workerProxyEnvironment({ platform: 'linux', env: {}, readProxy: () => assert.fail('Windows settings only') }), null);
  assert.equal(workerProxyEnvironment({ platform: 'win32', env: {}, readProxy: () => { throw new Error('registry unavailable'); } }), null);
});

test('worker Node fetch reaches a proxy-only hostname while local GPU endpoints remain direct', { skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy') }, async () => {
  let tunnels = 0, direct = 0;
  const upstream = http.createServer((req, res) => res.end('proxied'));
  const local = http.createServer((req, res) => { direct++; res.end('local-gpu'); });
  const proxy = http.createServer((req, res) => res.end('proxied'));
  proxy.on('connect', (req, socket) => {
    tunnels++; socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.emit('connection', socket);
  });
  proxy.listen(0, '127.0.0.1'); local.listen(0, '127.0.0.1');
  await Promise.all([once(proxy, 'listening'), once(local, 'listening')]);
  try {
    const env = workerProxyEnvironment({ platform: 'win32', env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NAVIGATION_WORKER_PROXY_READY: '' }, readProxy: () => ({ enabled: 1, server: '127.0.0.1:' + proxy.address().port }) });
    const code = `const results=await Promise.all(['http://navigation-proxy.invalid/video','http://127.0.0.1:${local.address().port}/health'].map(async url=>(await fetch(url,{signal:AbortSignal.timeout(5000)})).text())); console.log(JSON.stringify(results));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--use-env-proxy', '--input-type=module', '-e', code], { env, timeout: 10000, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout), ['proxied', 'local-gpu']); assert.equal(tunnels, 1); assert.equal(direct, 1);
  } finally {
    for (const server of [upstream, proxy, local]) { server.closeAllConnections(); server.close(); }
  }
});


test('Portal bypass is exact, preserves model proxies and upgrades an already-proxied parent once', () => {
  const readProxy = () => ({ enabled: 1, server: '127.0.0.1:7890' });
  const options = { platform: 'win32', portalUrl: 'https://saoyu.fun', readProxy };
  const env = workerProxyEnvironment({ ...options, env: { no_proxy: 'internal.test' } });
  assert.ok(env.NO_PROXY.split(',').includes('saoyu.fun'));
  assert.ok(!env.NO_PROXY.split(',').includes('*'));
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(workerProxyEnvironment({ ...options, env }), null);
  const old = { HTTP_PROXY: 'http://127.0.0.1:7890', NAVIGATION_WORKER_PROXY_READY: '1', NO_PROXY: 'localhost' };
  const upgraded = workerProxyEnvironment({ ...options, env: old });
  assert.ok(upgraded.NO_PROXY.split(',').includes('saoyu.fun'));
  assert.equal(workerProxyEnvironment({ ...options, env: upgraded }), null);
});

test('a broken proxy cannot intercept Portal traffic but still handles external model hosts', { skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy') }, async () => {
  let direct = 0, tunnels = 0;
  const portal = http.createServer((req, res) => { direct++; res.end('portal-direct'); });
  const proxy = http.createServer();
  proxy.on('connect', (_req, socket) => { tunnels++; socket.destroy(); });
  portal.listen(0, '127.0.0.2'); proxy.listen(0, '127.0.0.1');
  await Promise.all([once(portal, 'listening'), once(proxy, 'listening')]);
  try {
    const env = workerProxyEnvironment({ platform: 'win32', portalUrl: 'http://127.0.0.2:' + portal.address().port,
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NAVIGATION_WORKER_PROXY_READY: '', NO_PROXY: '', no_proxy: '' },
      readProxy: () => ({ enabled: 1, server: '127.0.0.1:' + proxy.address().port }) });
    const code = `const r=await fetch('http://127.0.0.2:${portal.address().port}',{signal:AbortSignal.timeout(2000)});const value=await r.text();let external=false;try{await fetch('https://model-proxy.invalid',{signal:AbortSignal.timeout(2000)})}catch{external=true}console.log(JSON.stringify({value,external}));process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--use-env-proxy', '--input-type=module', '-e', code], { env, timeout: 10000, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout), { value: 'portal-direct', external: true });
    assert.equal(direct, 1); assert.ok(tunnels >= 1);
  } finally { for (const server of [portal, proxy]) { server.closeAllConnections(); server.close(); } }
});
