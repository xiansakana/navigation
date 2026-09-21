import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustCandlesForSplits, createQuoteService } from './quotes.js';

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
    assert.match(String(url), /adjusted=true/);
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
  assert.equal(result.adjustedForSplits, true);
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
    if (String(url).includes('query1.finance.yahoo.com')) return response({ chart: { error: { description: 'unavailable' } } });
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
  assert.equal(requested.length, 3);
});

test('stock history falls back to Finnhub when Polygon and Sina are unavailable', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('api.polygon.io')) return response({}, 403);
    if (String(url).includes('query1.finance.yahoo.com')) return response({ chart: { error: { description: 'unavailable' } } });
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
  assert.equal(requested.length, 4);
});

test('stock history rejects a truncated provider range for five-year requests', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  const endTimestamp = Date.UTC(2026, 8, 21);
  global.fetch = async (url) => {
    if (String(url).includes('api.polygon.io')) {
      return response({
        results: Array.from({ length: 499 }, (_, index) => ({
          t: Date.UTC(2024, 8, 20) + index * 86400000,
          o: 100,
          h: 102,
          l: 99,
          c: 101,
          v: 1000
        }))
      });
    }
    if (String(url).includes('query1.finance.yahoo.com')) {
      return response({ chart: { error: { description: 'unavailable' } } });
    }
    return response(Array.from({ length: 40 }, (_, index) => ({
      d: new Date(Date.UTC(2021, 8, 21) + index * 45 * 86400000).toISOString().slice(0, 10),
      o: '100',
      h: '102',
      l: '99',
      c: '101',
      v: '1000'
    })));
  };

  const service = createQuoteService({ finnhubApiKey: 'f', polygonApiKey: 'p' });
  const result = await service.getStockHistory('AAPL', { days: 1825, endTimestamp });
  assert.equal(result.source, 'sina');
  assert.ok(result.candles[0].timestamp <= Date.UTC(2021, 10, 15));
});

test('Yahoo history provides split-adjusted OHLC candles', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    if (String(url).includes('api.polygon.io')) return response({}, 429);
    return response({
      chart: {
        result: [{
          timestamp: [1717718400, 1717977600],
          indicators: { quote: [{
            open: [119.77, 120.37],
            high: [121.69, 123.09],
            low: [118.02, 117.01],
            close: [120.888, 121.79],
            volume: [412384990, 314162647]
          }] },
          events: { splits: { 1717977600: { numerator: 10, denominator: 1 } } }
        }],
        error: null
      }
    });
  };

  const service = createQuoteService({ finnhubApiKey: 'f', polygonApiKey: 'p' });
  const result = await service.getStockHistory('NVDA', { days: 120, endTimestamp: Date.UTC(2024, 5, 11) });
  assert.equal(result.source, 'yahoo');
  assert.equal(result.adjustedForSplits, true);
  assert.equal(result.splitCount, 1);
  assert.equal(result.candles[0].close, 120.888);
});

test('normalizes raw forward split discontinuities', () => {
  const result = adjustCandlesForSplits([
    { timestamp: 1, open: 1197.7, high: 1216.92, low: 1180.22, close: 1208.88, volume: 41238499 },
    { timestamp: 2, open: 120.37, high: 123.09, low: 117.01, close: 121.79, volume: 314162647 },
    { timestamp: 3, open: 12.1, high: 12.5, low: 12, close: 12.2, volume: 500000000 }
  ]);

  assert.equal(result.splitCount, 2);
  assert.ok(Math.abs(result.candles[0].close - 12.0888) < 0.000001);
  assert.ok(Math.abs(result.candles[1].close - 12.179) < 0.000001);
  assert.ok(Math.abs(result.candles[0].volume - 4123849900) < 0.001);
});

test('normalizes raw reverse split discontinuities', () => {
  const result = adjustCandlesForSplits([
    { timestamp: 1, open: 9.8, high: 10.2, low: 9.7, close: 10, volume: 1000000 },
    { timestamp: 2, open: 98, high: 103, low: 97, close: 101, volume: 120000 }
  ]);

  assert.equal(result.splitCount, 1);
  assert.equal(result.candles[0].close, 100);
  assert.equal(result.candles[0].volume, 100000);
});
