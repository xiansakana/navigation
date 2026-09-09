#!/usr/bin/env node
import { loadConfig, createStore } from '../src/storage.js';
import { createQuoteService } from '../src/quotes.js';
import { deriveHoldings } from '../src/trades.js';

const config = loadConfig();
const store = createStore(config);
const data = store.read();
const holdings = deriveHoldings(data.trades || []);
const optSyms = [
  ...new Set([
    ...holdings.filter((h) => h.type === 'option').map((h) => h.symbol),
    ...Object.keys(data.quotes || {}).filter((s) => /^[A-Z]+\d{6}[CP]/i.test(s))
  ])
];
console.log('polygon key set:', Boolean(config.polygonApiKey), String(config.polygonApiKey).slice(0, 4) + '…');
console.log('option symbols:', optSyms.slice(0, 15));
const sample = optSyms[0];
if (!sample) {
  console.log('no options found');
  process.exit(0);
}

const quotes = createQuoteService(config);
console.log('testing getOption', sample);
try {
  console.log(JSON.stringify(await quotes.getOption(sample), null, 2));
} catch (e) {
  console.error('getOption failed:', e.message);
}

const m = sample.toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/);
const strikeInt = Math.round(parseFloat(m[4]) * 1000);
const poly = `O:${m[1]}${m[2]}${m[3]}${String(strikeInt).padStart(8, '0')}`;
const urls = [
  `https://api.polygon.io/v3/snapshot/options/${m[1]}/${encodeURIComponent(poly)}?apiKey=${config.polygonApiKey}`,
  `https://api.polygon.io/v2/last/trade/${encodeURIComponent(poly)}?apiKey=${config.polygonApiKey}`,
  `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(poly)}/prev?adjusted=true&apiKey=${config.polygonApiKey}`
];
for (const url of urls) {
  const label = url.includes('snapshot') ? 'snapshot' : url.includes('last/trade') ? 'lastTrade' : 'prev';
  try {
    const res = await fetch(url);
    const body = await res.json();
    console.log('\n==', label, 'HTTP', res.status, 'status', body.status, body.error || body.message || '');
    if (label === 'snapshot') {
      console.log('results keys', body.results && Object.keys(body.results));
      console.log('last_trade', body.results?.last_trade);
      console.log('last_quote', body.results?.last_quote);
      console.log('day', body.results?.day);
    } else if (label === 'lastTrade') {
      console.log('results', body.results);
    } else {
      console.log('results0', body.results?.[0]);
    }
  } catch (e) {
    console.error(label, e.message);
  }
}
