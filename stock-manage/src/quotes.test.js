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

test('QQQ 1DTE chain selects the next expiry and normalizes executable quotes', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('/reference/options/contracts')) {
      return response({ results: [{ expiration_date: '2026-09-23' }] });
    }
    return response({ results: [{
      details: { ticker: 'O:QQQ260923C00600000', contract_type: 'call', expiration_date: '2026-09-23', strike_price: 600 },
      underlying_asset: { price: 600.5 }, last_quote: { bid: 1.1, ask: 1.2, bid_size: 4, ask_size: 7 },
      last_trade: { price: 1.15 }, greeks: { delta: 0.45, gamma: 0.03, theta: -0.2, vega: 0.05 },
      implied_volatility: 0.25, open_interest: 100, day: { volume: 50 }
    }] });
  };
  const service = createQuoteService({ finnhubApiKey: '', polygonApiKey: 'secret' });
  const chain = await service.getQqq1dteChain();
  assert.equal(chain.expiration, '2026-09-23');
  assert.equal(chain.contracts.length, 1);
  assert.equal(chain.contracts[0].right, 'C');
  assert.equal(chain.contracts[0].bid, 1.1);
  assert.equal(chain.contracts[0].delta, 0.45);
  assert.equal(requested.length, 2);
});

test('QQQ 1DTE chain falls back to the free Cboe delayed chain without a Polygon key', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    assert.match(String(url), /cdn\.cboe\.com\/api\/global\/delayed_quotes\/options\/QQQ\.json/);
    return response({ timestamp: '2099-12-30 10:00:00', data: { current_price: 600, options: [{
      option: 'QQQ991231P00600000', bid: 1.2, ask: 1.3, bid_size: 2, ask_size: 3,
      delta: -0.45, gamma: 0.02, theta: -0.1, vega: 0.04, iv: 0.25,
      open_interest: 20, volume: 10, last_trade_price: 1.25
    }] } });
  };
  const service = createQuoteService({ finnhubApiKey: '', polygonApiKey: '' });
  const chain = await service.getQqq1dteChain();
  assert.equal(chain.source, 'cboe-delayed');
  assert.equal(chain.marketDate, '2099-12-30');
  assert.match(chain.capturedAt, /^2099-12-30T/);
  assert.equal(chain.expiration, '2099-12-31');
  assert.equal(chain.contracts[0].right, 'P');
  assert.equal(chain.contracts[0].delta, -0.45);
});

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
