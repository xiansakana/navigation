import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGoogleOAuth } from './google-oauth-network.js';
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
      assert.equal(options.redirect, 'error');
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
