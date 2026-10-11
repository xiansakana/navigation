import test from 'node:test';
import assert from 'node:assert/strict';
import { createForeignExchangeService, parseFredRates } from './foreign-exchange.js';

const csv = 'observation_date,DEXCHUS,DEXHKUS,DEXJPUS,DEXMAUS,DEXUSEU,DEXUSUK,DEXSIUS\n2026-10-01,7,7.8,140,4,1.1,1.3,1.4\n2026-10-02,7.1,.,142,4.1,1.2,1.4,1.5\n2026-10-03,.,7.9,145,4.2,1.2,1.4,1.5\n';
test('FRED cross rates use correct units and observations from the same date', () => {
  const r = parseFredRates(csv);
  assert.equal(r.USD.rate, 7.1); assert.equal(r.USD.asOf, '2026-10-02');
  assert.equal(r.HKD.rate, 7 / 7.8); assert.equal(r.HKD.asOf, '2026-10-01');
  assert.equal(r.JPY.rate, 7.1 / 142); assert.equal(r.MYR.rate, 7.1 / 4.1);
  assert.equal(r.EUR.rate, 7.1 * 1.2); assert.equal(r.GBP.rate, 7.1 * 1.4); assert.equal(r.SGD.rate, 7.1 / 1.5);
});
test('Finnhub batches all currencies, coalesces concurrent readers and preserves metadata in cache', async () => {
  let calls = 0;
  const service = createForeignExchangeService({ finnhubApiKey: 'secret', clock: () => Date.parse('2026-10-11'),
    request: async url => { calls++; assert.match(url, /finnhub/); return { date:'2026-10-09', quote:{ CNY:7,HKD:7.8,JPY:140,MYR:4,EUR:0.9,GBP:0.8,SGD:1.3 } }; } });
  const results = await Promise.all([service.getRates(),service.getRates(),service.getRates()]);
  assert.equal(calls,1);assert.equal(results[0].quotes.HKD.rate,7/7.8);
  const usd = await service.getRate('USD'); assert.equal(usd.source,'finnhub');assert.equal(usd.asOf,'2026-10-09');assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(results), /secret/);
});
test('invalid Finnhub prices fall back to FRED; single USD readers request no other currencies', async () => {
  const requests = [];
  const service = createForeignExchangeService({ finnhubApiKey:'x',request:async (url,opts)=>{
    requests.push(url); if(url.includes('finnhub'))return {quote:{CNY:-7}};
    assert.equal(opts.json,false);assert.match(url,/id=DEXCHUS&/);return csv;
  } });
  const r = await service.getRate('USD'); assert.equal(r.rate,7.1);assert.equal(r.source,'fred');assert.equal(requests.length,2);
});
test('provider failure returns stale cache and partial Yahoo results without inventing rates', async () => {
  let time=Date.parse('2026-10-11'),fail=false,calls=0;
  const service=createForeignExchangeService({clock:()=>time,cacheMs:1000,request:async url=>{
    calls++;if(fail)throw new Error('secret transport error');if(url.includes('fred'))return 'observation_date,DEXCHUS\n2026-10-09,7\n';
    if(url.includes('HKDCNY'))return {chart:{result:[{meta:{regularMarketPrice:0.9,currency:'CNY',regularMarketTime:1791504000}}]}};
    return {chart:{result:[]}};
  }});
  const first=await service.getRates(['USD','HKD','JPY']);assert.equal(first.quotes.HKD.source,'yahoo');assert.equal(first.quotes.JPY,undefined);
  fail=true;time+=1001;const second=await service.getRates(['USD','HKD']);assert.equal(second.quotes.USD.stale,true);assert.equal(second.quotes.HKD.rate,0.9);
  assert.doesNotMatch(JSON.stringify(second),/secret/);const n=calls;await service.getRates(['USD','HKD']);assert.equal(calls,n);
  await assert.rejects(()=>service.getRate('USD'),/不可用/);
});
