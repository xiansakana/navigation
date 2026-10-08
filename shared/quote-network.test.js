import test from 'node:test';
import assert from 'node:assert/strict';
import { configureQuoteNetwork, describeQuoteError, fetchQuoteResource } from './quote-network.js';

test('IPv4 preference retains fallback and increases the per-address wait', () => {
  const settings = {};
  configureQuoteNetwork({ dnsApi: { setDefaultResultOrder: (v) => { settings.order = v; } },
    netApi: { setDefaultAutoSelectFamilyAttemptTimeout: (v) => { settings.wait = v; } } });
  assert.deepEqual(settings, { order: 'ipv4first', wait: 2000 });
});

test('aggregate connection errors retain IP and codes without API credentials', () => {
  const error = new TypeError('fetch failed', { cause: new AggregateError([
    Object.assign(new Error('connect'), { code: 'ETIMEDOUT', address: '1.2.3.4' }),
    Object.assign(new Error('connect'), { code: 'ENETUNREACH', address: '::1' })
  ], 'https://name:secret@example.test/quote?token=private') });
  const text = describeQuoteError(error);
  assert.match(text, /ETIMEDOUT\(1.2.3.4\)/);
  assert.match(text, /ENETUNREACH/);
  assert.doesNotMatch(text, /secret|private|token=/);
});

test('hung request and hung response body both release even if abort is ignored', async () => {
  for (const phase of ['headers', 'body']) {
    await assert.rejects(fetchQuoteResource('https://example.test/', {
      retries: 0, timeoutMs: 15, logger: null,
      fetchImpl: async () => phase === 'headers' ? new Promise(() => {}) : ({ ok: true, json: () => new Promise(() => {}) })
    }), /请求硬超时/);
  }
});

test('retries are bounded, HTTP 401 does not retry and 429 keeps configured backoff', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(fetchQuoteResource('https://example.test/', { logger: null, rateLimitDelayMs: 2000,
    sleep: async (ms) => waits.push(ms), fetchImpl: async () => { calls += 1; return { ok: false, status: 429 }; } }), /尝试3次/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 4000]);
  calls = 0;
  await assert.rejects(fetchQuoteResource('https://example.test/', { logger: null,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 401 }; } }), /HTTP 401/);
  assert.equal(calls, 1);
});

test('JSON and encoded text preserve successful response behavior', async () => {
  assert.deepEqual(await fetchQuoteResource('https://example.test/', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ price: 1 }) })
  }), { price: 1 });
  assert.equal(await fetchQuoteResource('https://example.test/', { json: false,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('hello') })
  }), 'hello');
});
