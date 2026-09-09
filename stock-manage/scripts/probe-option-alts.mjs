#!/usr/bin/env node
import { loadConfig, createStore } from '../src/storage.js';
import { deriveHoldings } from '../src/trades.js';

const config = loadConfig();
const store = createStore(config);
const data = store.read();
const holdings = deriveHoldings(data.trades || []);
const sample = holdings.find((h) => h.type === 'option')?.symbol || 'BULL270115C5';
const m = sample.toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/);
const strikeInt = Math.round(parseFloat(m[4]) * 1000);
const poly = `O:${m[1]}${m[2]}${m[3]}${String(strikeInt).padStart(8, '0')}`;
const key = config.polygonApiKey;
const today = new Date();
const yday = new Date(today.getTime() - 86400000 * 5);
const fmt = (d) => d.toISOString().slice(0, 10);

const tests = [
  ['prev', `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(poly)}/prev?adjusted=true&apiKey=${key}`],
  ['range5d', `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(poly)}/range/1/day/${fmt(yday)}/${fmt(today)}?adjusted=true&sort=asc&apiKey=${key}`],
  ['open-close', `https://api.polygon.io/v1/open-close/${encodeURIComponent(poly)}/${fmt(today)}?adjusted=true&apiKey=${key}`],
  ['yahoo-chart', `https://query1.finance.yahoo.com/v8/finance/chart/${m[1]}?interval=1d&range=5d`],
];

// Yahoo option: try OCC without O:
const yahooOpt = `${m[1]}${m[2]}${m[3]}${String(strikeInt).padStart(8, '0')}`;
tests.push(['yahoo-opt', `https://query1.finance.yahoo.com/v8/finance/chart/${yahooOpt}?interval=1d&range=5d`]);
tests.push(['yahoo-opt-O', `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(poly)}?interval=1d&range=5d`]);

// Finnhub quote on underlying only
tests.push(['fh-quote', `https://finnhub.io/api/v1/quote?symbol=${m[1]}&token=${config.finnhubApiKey}`]);
tests.push(['fh-chain', `https://finnhub.io/api/v1/stock/option-chain?symbol=${m[1]}&token=${config.finnhubApiKey}`]);

console.log('sample', sample, poly);
for (const [label, url] of tests) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    const summary = typeof body === 'string' ? body : {
      status: body.status || body.error || body.message,
      resultsLen: Array.isArray(body.results) ? body.results.length : undefined,
      last: Array.isArray(body.results) ? body.results.at(-1) : undefined,
      meta: body.chart?.result?.[0]?.meta ? {
        price: body.chart.result[0].meta.regularMarketPrice,
        prev: body.chart.result[0].meta.chartPreviousClose || body.chart.result[0].meta.previousClose
      } : undefined,
      chainLen: body.data?.length
    };
    console.log('\n==', label, 'HTTP', res.status, JSON.stringify(summary).slice(0, 500));
  } catch (e) {
    console.log('\n==', label, 'ERR', e.message);
  }
}
