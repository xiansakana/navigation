import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from './quotes.js';

test('Hong Kong NAV sources select the exact ISIN or share class and preserve the dealing date', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const row = (isin, price) => '<tr>' + ['A', 'HKD', price, '99', '<span>0.0088%</span>', '2026-11-19', isin, 'ticker']
    .map(value => '<td>' + value + '</td>').join('') + '</tr>';
  globalThis.fetch = async url => {
    const u = new URL(url);
    if (u.hostname === 'www.gaotengasset.com') return new Response(row('HK0000478914', '12') + row('HK0000478872', '11.67977'));
    assert.equal(u.hostname, 'www.chinaamc.com.hk');
    assert.equal(u.searchParams.get('fundId'), 'HKSELMMF');
    if (u.pathname.endsWith('fullNavHistory')) return Response.json({ result: [{
      ssShareClassId: 'B-HKD', currencyEn: 'HKD', navHistoryList: [{ date: '20261120', nav: 11.143 }, { date: '20261119', nav: 11.1421 }]
    }] });
    return Response.json({ result: [
      { shareClassId: 'A-HKD', currencyEn: 'HKD', tradingDate: '20261120', nav: '11.6681' },
      { shareClassId: 'B-HKD', currencyEn: 'HKD', tradingDate: '20261120', nav: '11.1430' }
    ] });
  };
  const service = createQuoteService({});
  const a = await service.getQuote('hk0000478872');
  assert.deepEqual([a.price, a.currency, a.asOf], [11.67977, 'HKD', '2026-11-19']);
  assert.ok(Math.abs(a.changePercent - 0.0088) < 1e-9);
  const b = await service.getQuote('HK0000489952');
  assert.deepEqual([b.price, b.prevClose, b.currency, b.asOf], [11.143, 11.1421, 'HKD', '2026-11-20']);
  await assert.rejects(service.getQuote('HK0000000000'), /暂未接入/);
});
