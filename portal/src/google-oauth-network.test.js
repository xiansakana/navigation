import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fetchGoogleOAuth, requestOAuthRelay } from './google-oauth-network.js';
import worker, { handleRequest } from '../../scripts/google-oauth-relay/worker.js';

test('Google relay preserves form and token headers without changing direct requests', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return {}; };
  const body = 'code=test';
  await fetchGoogleOAuth('https://oauth2.googleapis.com/token', { method: 'POST', body },
    { relayUrl: 'https://oauth.saoyu.fun', relaySecret: 'secret' }, fetchImpl);
  assert.equal(calls[0][0], 'https://oauth.saoyu.fun/token');
  assert.equal(calls[0][1].body, body);
  assert.equal(calls[0][1].headers['X-OAuth-Relay-Secret'], 'secret');
  assert.equal(calls[0][1].redirect, 'error');
  await fetchGoogleOAuth('https://openidconnect.googleapis.com/v1/userinfo',
    { headers: { Authorization: 'Bearer token' } }, {}, fetchImpl);
  assert.equal(calls[1][0], 'https://openidconnect.googleapis.com/v1/userinfo');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer token');
  assert.equal(calls[1][1].headers['X-OAuth-Relay-Secret'], undefined);
  assert.throws(() => fetchGoogleOAuth('https://example.com', {},
    { relayUrl: 'https://oauth.saoyu.fun', relaySecret: 'secret' }), /配置无效/);
});

test('relay denies unauthenticated requests and limits endpoints and redirect URI', async () => {
  const env = { RELAY_SECRET: 'secret' };
  const fetchImpl = () => { throw new Error('Must not reach upstream'); };
  assert.equal((await worker.fetch(new Request('https://relay/token'), env, {})).status, 401);
  const headers = { 'X-OAuth-Relay-Secret': 'secret' };
  assert.equal((await handleRequest(new Request('https://relay/other', { headers }), env, fetchImpl)).status, 404);
  assert.equal((await handleRequest(new Request('https://relay/token', {
    method: 'POST', headers, body: 'redirect_uri=https://evil.example&grant_type=authorization_code'
  }), env, fetchImpl)).status, 400);
});

test('relay forwards only fixed Google endpoints and does not cache token responses', async () => {
  const env = { RELAY_SECRET: 'secret' };
  const headers = { 'X-OAuth-Relay-Secret': 'secret' };
  const body = new URLSearchParams({ redirect_uri: 'https://saoyu.fun/api/oauth/google/callback',
    grant_type: 'authorization_code', code: 'test' }).toString();
  const response = await handleRequest(new Request('https://relay/token', { method: 'POST', headers, body }),
    env, async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.body, body);
      assert.equal(options.redirect, 'manual');
      return Response.json({ access_token: 'token' });
    });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { access_token: 'token' });
  const profile = await handleRequest(new Request('https://relay/userinfo', {
    headers: { ...headers, Authorization: 'Bearer token' }
  }), env, async (url, options) => {
    assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal(options.headers.Authorization, 'Bearer token');
    return Response.json({ sub: '123' });
  });
  assert.deepEqual(await profile.json(), { sub: '123' });
});

test('relay masks upstream failures and secrets', async () => {
  const response = await handleRequest(new Request('https://relay/userinfo', {
    headers: { 'X-OAuth-Relay-Secret': 'secret', Authorization: 'Bearer token' }
  }), { RELAY_SECRET: 'secret' }, () => { throw new Error('secret-token'); });
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('secret-token'), false);
});

test('Worker entrypoint preserves the global fetch receiver required by Cloudflare', async (t) => {
  t.mock.method(globalThis, 'fetch', function () {
    assert.equal(this, globalThis);
    return Promise.resolve(Response.json({ sub: '123' }));
  });
  const response = await worker.fetch(new Request('https://relay/userinfo', {
    headers: { 'X-OAuth-Relay-Secret': 'secret', Authorization: 'Bearer token' }
  }), { RELAY_SECRET: 'secret' }, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sub: '123' });
});

test('relay transport uses IPv4, preserves request body and rejects redirect responses', async () => {
  const requestImpl = (url, options, callback) => {
    assert.equal(options.family, 4);
    assert.equal(options.agent, false);
    assert.equal(url, 'https://oauth.saoyu.fun/token');
    const request = new EventEmitter();
    request.end = (body) => {
      assert.equal(body, 'code=test');
      const response = new PassThrough();
      response.statusCode = options.status || 200;
      callback(response);
      response.end('{"access_token":"test"}');
    };
    queueMicrotask(() => {
      const socket = new EventEmitter();
      request.emit('socket', socket);
      socket.emit('secureConnect');
    });
    return request;
  };
  const lookupImpl = async () => [{ address: '127.0.0.1' }];
  const response = await requestOAuthRelay('https://oauth.saoyu.fun/token', { body: 'code=test' }, requestImpl, lookupImpl);
  assert.deepEqual(await response.json(), { access_token: 'test' });
  await assert.rejects(requestOAuthRelay('https://oauth.saoyu.fun/token',
    { body: 'code=test', status: 302 }, requestImpl, lookupImpl), /不应重定向/);
});

test('relay retries connection failures but never retries a code after TLS completed', async () => {
  const addresses = async () => [{ address: '127.0.0.1' }, { address: '127.0.0.2' }];
  for (const connected of [false, true]) {
    let attempts = 0;
    let sends = 0;
    const requestImpl = (_url, _options, callback) => {
      attempts++;
      const attempt = attempts;
      const request = new EventEmitter();
      request.end = () => { sends++; request.emit('error', new Error('response lost')); };
      queueMicrotask(() => {
        if (attempt === 1 && !connected) request.emit('error', new Error('connect failed'));
        else if (attempt === 1) {
          const socket = new EventEmitter(); request.emit('socket', socket); socket.emit('secureConnect');
        } else {
          const socket = new EventEmitter(); request.emit('socket', socket);
          request.end = () => {
            sends++; const response = new PassThrough(); response.statusCode = 200;
            callback(response); response.end('{}');
          };
          socket.emit('secureConnect');
        }
      });
      return request;
    };
    const operation = requestOAuthRelay('https://relay/token', { body: 'code=test' }, requestImpl, addresses);
    if (connected) await assert.rejects(operation, /response lost/);
    else assert.equal((await operation).status, 200);
    assert.equal(attempts, connected ? 1 : 2);
    assert.equal(sends, 1);
  }
});
