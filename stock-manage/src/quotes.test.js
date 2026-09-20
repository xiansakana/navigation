import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from './quotes.js';

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

test('stock history uses Polygon aggregates and normalizes candles', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    assert.match(String(url), /api\.polygon\.io\/v2\/aggs\/ticker\/AAPL/);
    return response({
      results: [
        { t: 2000, o: 11, h: 13, l: 10, c: 12, v: 200 },
        { t: 1000, o: 10, h: 12, l: 9, c: 11, v: 100 }
      ]
    });
  };

  const service = createQuoteService({ finnhubApiKey: 'f', polygonApiKey: 'p' });
  const result = await service.getStockHistory('aapl', { days: 120 });
  assert.equal(result.source, 'polygon');
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles[0].timestamp, 1000);
  assert.equal(result.candles[1].close, 12);
  await service.getStockHistory('AAPL', { days: 120 });
  assert.equal(calls, 1);
});

test('stock history falls back to Sina when Polygon is rate limited', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('api.polygon.io')) return response({}, 429);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return response([
      { d: yesterday, o: '10', h: '12', l: '9', c: '11', v: '1000' },
      { d: today, o: '11', h: '13', l: '10', c: '12', v: '1200' }
    ]);
  };

  const service = createQuoteService({ finnhubApiKey: 'f', polygonApiKey: 'p' });
  const result = await service.getStockHistory('MSFT');
  assert.equal(result.source, 'sina');
  assert.equal(result.candles.length, 2);
  assert.equal(requested.length, 2);
});

test('stock history falls back to Finnhub when Polygon and Sina are unavailable', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('api.polygon.io')) return response({}, 403);
    if (String(url).includes('stock.finance.sina.com.cn')) return response({});
    return response({
      s: 'ok',
      t: [100, 200],
      o: [10, 11],
      h: [12, 13],
      l: [9, 10],
      c: [11, 12],
      v: [1000, 1200]
    });
  };

  const service = createQuoteService({ finnhubApiKey: 'f', polygonApiKey: 'p' });
  const result = await service.getStockHistory('MSFT');
  assert.equal(result.source, 'finnhub');
  assert.equal(result.candles[0].timestamp, 100000);
  assert.equal(requested.length, 3);
});
