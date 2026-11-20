import { fetchQuoteResource } from '../../shared/quote-network.js';

const gaoteng = 'https://www.gaotengasset.com/en-US/product-services';
const chinaamc = 'https://www.chinaamc.com.hk/jeecg-boot';
const request = { retries: 0, timeoutMs: 6000 };
const products = {
  HK0000478872: { name: '高腾微财货币基金 A 类港元累积', currency: 'HKD' },
  HK0000478930: { name: '高腾微财货币基金 P 类港元累积', currency: 'HKD' },
  HK0000478914: { name: '高腾微财货币基金 I 类港元累积', currency: 'HKD' },
  HK0000584737: { name: '高腾微值美元货币基金 A 类美元累积', currency: 'USD' },
  HK0000489952: { name: '华夏精选货币基金 B 类港元', currency: 'HKD', shareClassId: 'B-HKD' },
  HK0000489945: { name: '华夏精选货币基金 A 类港元', currency: 'HKD', shareClassId: 'A-HKD' },
  HK0000489960: { name: '华夏精选货币基金 I 类港元', currency: 'HKD', shareClassId: 'I-HKD' },
  HK0000502390: { name: '华夏精选货币基金 F 类港元', currency: 'HKD', shareClassId: 'F-HKD' }
};

export function hkFundInfo(isin) {
  return Object.hasOwn(products, isin) ? products[isin] : null;
}

const dateOf = raw => /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(raw ?? ''))?.slice(1).join('-');
const positive = raw => Number.isFinite(Number(raw)) && Number(raw) > 0;
const changeFrom = (price, previous) => positive(previous)
  ? { change: price - previous, changePercent: (price - previous) / previous * 100, prevClose: previous }
  : {};

export async function getHkFundQuote(isin) {
  const info = hkFundInfo(isin);
  if (!info) throw new Error('暂未接入此香港基金份额的净值来源');
  const { name, currency, shareClassId } = info;
  const base = { symbol: isin, name, currency };
  if (!shareClassId) {
    const html = await fetchQuoteResource(gaoteng, { ...request, json: false });
    for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = Array.from(row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi), cell => cell[1].replace(/<[^>]*>/g, '').trim());
      if (cells[6] !== isin || cells[1] !== currency) continue;
      const asOf = dateOf(cells[5]);
      if (!asOf || !positive(cells[2])) break;
      const price = Number(cells[2]);
      const pct = /^([+-]?\d+(?:\.\d+)?)%$/.exec(cells[4])?.[1];
      const previous = pct != null && Number(pct) > -100 ? price / (1 + Number(pct) / 100) : null;
      return { ...base, price, asOf, source: 'gaoteng-fund-nav', ...changeFrom(price, previous) };
    }
  } else {
    const query = '?fundId=HKSELMMF';
    const latest = await fetchQuoteResource(chinaamc + '/mainFund/fundQuery/price/list' + query, request);
    const row = latest.result?.find(item => item.shareClassId === shareClassId && item.currencyEn === currency);
    const asOf = dateOf(row?.tradingDate);
    if (asOf && positive(row.nav)) {
      const price = Number(row.nav);
      const history = await fetchQuoteResource(chinaamc + '/mainFundShareClass/tMainFundShareClass/fullNavHistory' + query, request).catch(() => null);
      const rows = history?.result?.find(item => item.ssShareClassId === shareClassId && item.currencyEn === currency)?.navHistoryList;
      const previous = (rows || []).find(item => dateOf(item.date) < asOf && positive(item.nav));
      return { ...base, price, asOf, source: 'chinaamc-hk-fund-nav', ...changeFrom(price, Number(previous?.nav)) };
    }
  }
  throw new Error('未查到该香港基金份额的有效单位净值');
}
