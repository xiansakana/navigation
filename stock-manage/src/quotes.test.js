import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustCandlesForSplits, createQuoteService } from './quotes.js';
import { enrichHoldings } from './trades.js';

test('US holding quotes use the same-day premarket price against the prior regular close', async context => {
  const original = global.fetch; context.after(() => { global.fetch = original; });
  let stamp = 'Nov 18, 2026 6:28 AM ET';
  const requests = [];
  global.fetch = async url => {
    requests.push(new URL(url).hostname);
    if (String(url).includes('/QQQ/info?assetclass=stocks')) return response({status:{bCodeMessage:[{code:1001}]}});
    if (String(url).includes('nasdaq.com')) return response({ data: { marketStatus:'Pre-Market', primaryData:{
      lastSalePrice:'$370.993', netChange:'+11.303', lastTradeTimestamp:stamp, isRealTime:true
    } } });
    return response({c:359.69,d:-13.76,dp:-3.68});
  };
  const service = createQuoteService({finnhubApiKey:'fixture'});
  const now = new Date('2026-11-18T11:29:00Z');
  const holdings = [{symbol:'TSM',type:'stock',shares:2,avgCost:350,currency:'USD'}];
  const quote = await service.getQuote('TSM',now);
  assert.deepEqual(requests,['api.nasdaq.com']);
  assert.equal(quote.session,'premarket');
  assert.equal(quote.price,370.993);
  assert.equal(quote.prevClose,359.69);
  assert.equal(enrichHoldings(holdings,{TSM:quote},0).rows[0].dailyPnl,22.61);
  assert.equal((await service.getQuote('QQQ',now)).session,'premarket');
  stamp = 'Nov 17, 2026 6:28 AM ET';
  const stale = await service.getQuote('TSM',now);
  assert.equal(stale.session,'no-premarket');
  assert.equal(stale.price,359.69);
  const [row] = enrichHoldings(holdings,{TSM:stale},0).rows;
  assert.equal(row.dailyPnl,null);
  assert.equal(row.dailyPnlPct,null);
  assert.equal((await service.getQuote('TSM',new Date('2026-11-18T14:31:00Z'))).source,'finnhub');
});

test('after-hours stocks and ETFs distinguish the prior close and the current close', async context => {
  const original = global.fetch; context.after(() => { global.fetch = original; });
  let reportDay = 18;
  let yahooAvailable = true;
  global.fetch = async url => {
    if (String(url).includes('finnhub')) return response({c:105,d:5,dp:5,pc:100});
    if (String(url).includes('yahoo')) return response(yahooAvailable ? closeFixture : {});
    assert.match(String(url), /extended-trading.*markettype=post/);
    return response(String(url).includes('assetclass=stocks') ? { data: null } : afterHoursFixture(reportDay));
  };
  const service = createQuoteService({ finnhubApiKey: 'fixture' });
  const now = new Date('2026-11-18T23:00:00Z');
  const quote = await service.getQuote('QQQ', now);
  assert.equal(quote.session, 'afterhours');
  assert.equal(quote.asOf, '2026-11-18 17:50:00 ET');
  assert.equal(quote.changePercent, 3);
  assert.ok(Math.abs(quote.sessionChangePercent - (-2 / 105 * 100)) < 1e-10);
  const [row] = enrichHoldings([{symbol:'QQQ', shares:2, avgCost:100}], { QQQ:quote }, 0).rows;
  assert.equal(row.dailyPnl, 6);
  assert.equal(row.quoteSessionChangePct, quote.sessionChangePercent);
  yahooAvailable = false;
  assert.equal((await service.getQuote('QQQ', now)).changePercent, null);
  reportDay = 17;
  const fallback = await service.getQuote('QQQ', now);
  assert.equal(fallback.session, 'no-afterhours');
  assert.equal(fallback.price, 105);
  assert.equal(fallback.changePercent, null);
});

const closeFixture = { chart: { result: [{
  meta: { currency: 'USD' },
  timestamp: ['2026-11-17T14:30:00Z', '2026-11-18T14:30:00Z'].map(value => Date.parse(value) / 1000),
  indicators: { quote: [{ close: [100, 105] }] }
}] } };

const afterHoursFixture = day => ({ data: {
  previousInfo: ' Market Close: $105.00',
  lastUpdateInfo: [`Data last updated Nov ${day}, 2026 05:55 PM ET.`],
  tradeDetailTable: { rows: [{ time: '17:50:00', price: '$103.00' }] }
} });

test('overnight uses the current overnight session across midnight and labels fallback prices', async context => {
  const original = global.fetch; context.after(() => { global.fetch = original; });
  let time = '2026-11-19T04:30:00Z';
  let alpacaRequests = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('nasdaq')) return response(afterHoursFixture(18));
    if (String(url).includes('yahoo')) return response(closeFixture);
    alpacaRequests++;
    assert.match(String(url), /alpaca\.markets.*symbols=TSM&feed=overnight/);
    assert.equal(options.headers['APCA-API-KEY-ID'], 'fixture');
    return response({ trades: { TSM: { p: 107, t: time } } });
  };
  const service = createQuoteService({ alpacaApiKeyId:'fixture', alpacaApiSecretKey:'fixture' });
  const now = new Date('2026-11-19T05:20:00Z');
  const quote = await service.getQuote('TSM', now);
  assert.equal(quote.session, 'overnight');
  assert.equal(quote.asOf, '2026-11-18 23:30 ET');
  assert.equal(quote.delayed, true);
  assert.equal(quote.change, 2);
  time = '2026-11-19T05:01:00Z';
  assert.equal((await service.getQuote('TSM', now)).asOf, '2026-11-19 00:01 ET');
  time = '2026-11-19T00:30:00Z'; // Same evening, still after-hours.
  assert.equal((await service.getQuote('TSM', now)).session, 'no-overnight-afterhours');
  time = '2026-11-18T05:01:00Z'; // Previous overnight session.
  assert.equal((await service.getQuote('TSM', now)).session, 'no-overnight-afterhours');
  const fallback = await createQuoteService({}).getQuote('TSM', now);
  assert.equal(alpacaRequests, 4);
  assert.equal(fallback.price, 103);
  assert.equal(fallback.change, null);
});

test('USD/CNY uses the shared Finnhub/FRED fallback and caches observation metadata', async context => {
  const original = global.fetch; context.after(() => { global.fetch = original; });
  let requests = 0;
  global.fetch = async url => {
    requests++;
    if (String(url).includes('finnhub')) return new Response('{}', { status:403 });
    assert.match(String(url), /fredgraph.csv\?id=DEXCHUS&/);
    return new Response('observation_date,DEXCHUS\n2026-10-01,7.1\n2026-10-02,.\n');
  };
  const service = createQuoteService({ finnhubApiKey:'x', polygonApiKey:'' });
  const first = await service.getUsdCny(), second = await service.getUsdCny();
  assert.equal(first.rate,7.1);assert.equal(first.source,'fred');assert.equal(second.asOf,'2026-10-01');assert.equal(requests,2);
});

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

test('held QQQ option uses an exact Cboe match without Polygon and shares concurrent requests', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  let requests = 0;
  global.fetch = async url => {
    requests++;
    assert.match(String(url), /cdn\.cboe\.com.*QQQ\.json/);
    return response({ timestamp: '2026-10-26 14:49:08', data: { options: [
      { option: 'QQQ261027C00715000', bid: 1.55, ask: 1.56, prev_day_close: 2.21 },
      { option: 'QQQ261027P00720000', bid: 2, ask: 2.2, prev_day_close: 3 }
    ] } });
  };
  const service = createQuoteService({});
  const [call, put] = await Promise.all([service.getOption('QQQ261027C715'), service.getOption('QQQ261027P720')]);
  assert.ok(Math.abs(call.price - 1.555) < 1e-9);
  assert.equal(call.delayed, true);
  assert.equal(call.asOf, '2026-10-26T14:49:08.000Z');
  assert.equal(call.source, 'cboe-delayed-midpoint');
  assert.ok(Math.abs(call.change - (1.555 - 2.21)) < 1e-9);
  assert.equal(put.price, 2.1);
  await service.getOption('QQQ261027C715');
  assert.equal(requests, 1);
  await assert.rejects(service.getOption('QQQ261027C999'), /Cboe 未找到合约/);
});

test('held QQQ quote falls back after Polygon errors and rejects invalid books', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async url => String(url).includes('polygon.io') ? response({}, 403) : response({ timestamp: '2026-10-26 14:49:08', data: { options: [
    { option: 'QQQ261027C00715000', bid: 1, ask: 1.2 }
  ] } });
  assert.equal((await createQuoteService({ polygonApiKey: 'fixture' }).getOption('QQQ261027C715')).source, 'cboe-delayed-midpoint');
  for (const row of [{bid:2,ask:1},{bid:0,ask:0},{bid:null,ask:2}]) {
    global.fetch = async () => response({ timestamp:'2026-10-26 14:49:08', data:{options:[{option:'QQQ261027C00715000',...row}]} });
    await assert.rejects(createQuoteService({}).getOption('QQQ261027C715'), /无有效买卖报价/);
  }
  global.fetch = async () => response({ data:{options:[]} });
  await assert.rejects(createQuoteService({}).getOption('QQQ261027C715'), /缺少有效报价时间/);
});

test('US stock quote falls back to Yahoo when Finnhub is not configured', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    assert.match(String(url), /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/GOOG/);
    return response({ chart: { result: [{ meta: {
      symbol: 'GOOG', regularMarketPrice: 245.5, chartPreviousClose: 242.25
    } }], error: null } });
  };
  const service = createQuoteService({ finnhubApiKey: '', polygonApiKey: '' });
  const quote = await service.getQuote('goog', new Date('2026-11-18T15:00:00Z'));
  assert.equal(quote.symbol, 'GOOG');
  assert.equal(quote.price, 245.5);
  assert.equal(quote.prevClose, 242.25);
  assert.equal(quote.source, 'yahoo');
  assert.equal(quote.delayed, true);
  assert.equal(requested.length, 1);
});

test('US stock quote falls back to Yahoo when Finnhub request fails', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('finnhub.io')) return response({ error: 'rate limited' });
    return response({ chart: { result: [{ meta: {
      symbol: 'SOFI', regularMarketPrice: 25.2, previousClose: 24.8
    } }], error: null } });
  };
  const service = createQuoteService({ finnhubApiKey: 'key', polygonApiKey: '' });
  const quote = await service.getStock('SOFI');
  assert.equal(quote.symbol, 'SOFI');
  assert.equal(quote.source, 'yahoo');
  assert.ok(Math.abs(quote.change - 0.4) < 1e-9);
  assert.equal(requested.length, 2);
});

test('US stock quote falls back to Nasdaq when Yahoo is blocked', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes('query1.finance.yahoo.com')) return response({ error: 'blocked' }, 403);
    assert.match(target, /api\.nasdaq\.com\/api\/quote\/SOFI\/info/);
    return response({ data: {
      companyName: 'SoFi Technologies, Inc.',
      primaryData: { lastSalePrice: '$25.20', netChange: '+0.40', percentageChange: '+1.61%' }
    } });
  };
  const service = createQuoteService({ finnhubApiKey: '', polygonApiKey: '' });
  const quote = await service.getQuote('SOFI', new Date('2026-11-18T15:00:00Z'));
  assert.equal(quote.source, 'nasdaq');
  assert.equal(quote.price, 25.2);
  assert.equal(quote.prevClose, 24.8);
  assert.equal(quote.delayed, true);
});

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
  assert.equal(chain.capturedAt, '2099-12-30T10:00:00.000Z');
  assert.equal(chain.expiration, '2099-12-31');
  assert.equal(chain.contracts[0].right, 'P');
  assert.equal(chain.contracts[0].delta, -0.45);
});

test('QQQ option chain collector preserves multiple Cboe expirations', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => response({ timestamp: '2026-09-22 15:00:00', data: { current_price: 600, options: [
    { option: 'QQQ260923C00600000', bid: 1.2, ask: 1.3, delta: 0.45, iv: 0.25, open_interest: 20, volume: 10, last_trade_price: 1.25 },
    { option: 'QQQ260924P00600000', bid: 1.4, ask: 1.5, delta: -0.45, iv: 0.26, open_interest: 21, volume: 11, last_trade_price: 1.45 }
  ] } });
  const service = createQuoteService({ finnhubApiKey: '', polygonApiKey: '' });
  const result = await service.getQqqOptionChains();
  assert.equal(result.chains.length, 2);
  assert.deepEqual(result.chains.map((chain) => chain.expiration), ['2026-09-23', '2026-09-24']);
  assert.equal(result.chains[1].contracts[0].right, 'P');
});

test('Cboe chain uses New York date across UTC midnight and preserves timestamp provenance', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => response({ timestamp: '2026-09-23 03:56:14', data: { current_price: 600, options: [
    { option: 'QQQ260923C00600000', bid: 1.2, ask: 1.3, delta: 0.45, iv: 0.25 }
  ] } });
  const result = await createQuoteService({}).getQqqOptionChains();
  assert.equal(result.marketDate, '2026-09-22');
  assert.equal(result.capturedAt, '2026-09-23T03:56:14.000Z');
  assert.equal(result.timestampOrigin, 'provider');
  assert.equal(result.providerTimestampRaw, '2026-09-23 03:56:14');
});

test('QQQ previous-session summary preserves daily OHLC and uses the 16:00 ET close', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => response({
    timestamp: '2026-09-22 11:00:00',
    data: {
      current_price: 742.4,
      close: 741.47,
      options: [{
        option: 'QQQ260922C00740000', bid: 5.1, ask: 5.3, bid_size: 2, ask_size: 3,
        delta: 0.55, gamma: 0.02, theta: -0.1, vega: 0.04, iv: 0.25,
        open_interest: 20, volume: 10, last_trade_price: 5.2,
        last_trade_time: '2026-09-21T15:59:10', open: 4.1, high: 6.2, low: 3.8,
        prev_day_close: 4
      }]
    }
  });
  const service = createQuoteService({ finnhubApiKey: '', polygonApiKey: '' });
  const summary = await service.getQqqPreviousSessionSummary();
  assert.equal(summary.captureKind, 'daily-summary');
  assert.equal(summary.marketDate, '2026-09-21');
  assert.equal(summary.capturedAt, '2026-09-21T20:00:00.000Z');
  assert.equal(summary.underlyingPrice, 741.47);
  assert.equal(summary.expiration, '2026-09-22');
  assert.equal(summary.contracts[0].lastTradeAt, '2026-09-21T19:59:10.000Z');
  assert.equal(summary.contracts[0].open, 4.1);
  assert.equal(summary.contracts[0].prevClose, 4);
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


test('instrument name uses the exact Finnhub search result instead of the quote symbol', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    assert.match(String(url), /finnhub.io\/api\/v1\/search/);
    return response({ result: [
      { symbol: 'AAPL.W', description: 'Wrong security', type: 'Common Stock' },
      { symbol: 'AAPL', description: 'Apple Inc.', type: 'Common Stock' }
    ] });
  };
  const service = createQuoteService({ finnhubApiKey: 'test-key', polygonApiKey: '' });
  assert.equal(await service.getInstrumentName('aapl'), 'Apple Inc.');
});

test('instrument name uses Yahoo company metadata without a Finnhub key', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => response({ chart: { result: [{ meta: {
    regularMarketPrice: 100, longName: 'Apple Inc.', shortName: 'Apple'
  } }] } });
  const service = createQuoteService({ finnhubApiKey: '', polygonApiKey: '' });
  assert.equal(await service.getInstrumentName('AAPL'), 'Apple Inc.');
});


test('Tencent ETF premiums use valid IOPV and preserve the quote timestamp', async context => {
  const original = global.fetch;
  context.after(() => { global.fetch = original; });
  global.fetch = async url => {
    const parts = Array(82).fill('');
    const code = String(url).slice(-6);
    parts[1] = 'Fund';
    parts[3] = code === '513500' ? '0.95' : '1.1';
    parts[30] = '20261109161433';
    parts[61] = code === '600519' ? 'GP' : 'ETF';
    parts[78] = code === '518600' ? '-' : '1';
    if (code === '161125') { parts[61] = 'LOF'; parts[78] = ''; parts[81] = '1'; }
    return new Response(`v="${parts.join('~')}";`);
  };
  const service = createQuoteService({});
  const up = await service.getAShareQuote('159509');
  assert.ok(Math.abs(up.etfPremiumPct - 10) < 1e-9);
  assert.equal(up.etfPremiumAsOf, '2026-11-09T08:14:33.000Z');
  assert.ok(Math.abs((await service.getAShareQuote('513500')).etfPremiumPct + 5) < 1e-9);
  assert.equal((await service.getAShareQuote('518600')).etfPremiumPct, undefined);
  assert.equal((await service.getAShareQuote('600519')).etfPremiumPct, undefined);
  const lof = await service.getAShareQuote('161125');
  assert.ok(Math.abs(lof.etfPremiumPct - 10) < 1e-9);
  assert.equal(lof.fundPremiumBasis, '单位净值');
});
