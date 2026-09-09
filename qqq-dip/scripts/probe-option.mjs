#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { createQuoteService } from '../src/quotes.js';

const c = loadConfig();
const q = createQuoteService(c);
console.log('polygon set', Boolean(c.polygonApiKey), String(c.polygonApiKey || '').slice(0, 4));
for (const sym of ['QQQ270115C700', 'QQQ260116C600']) {
  try {
    const r = await q.getOptionSnapshot(sym);
    console.log(sym, 'OK', r.price, r.source || '', r);
  } catch (e) {
    console.log(sym, 'ERR', e.message);
  }
}
try {
  const contracts = await q.searchLeapCalls('QQQ', 700, 900, '2027-01-01', '2027-01-31');
  console.log('searchLeapCalls', contracts.length, contracts.slice(0, 3));
} catch (e) {
  console.log('search err', e.message);
}
