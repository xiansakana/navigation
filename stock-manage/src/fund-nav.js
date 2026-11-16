import { fetchQuoteResource } from '../../shared/quote-network.js';

async function exactMatches(code) {
  const data = await fetchQuoteResource(`https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(code)}`, {
    retries: 0, timeoutMs: 3500
  });
  if (data?.ErrCode !== 0) throw new Error('证券查询暂时不可用');
  return (data.Datas || []).filter(item => item.CODE === code && item.NAME);
}

export async function findInternationalStockName(symbol, market) {
  const code = market === 'HK' ? symbol.replace(/\.HK$/, '') : symbol;
  const category = market === 'HK' ? 200 : 500;
  return (await exactMatches(code)).find(item => item.CATEGORY === category)?.NAME || '';
}

export async function findMainlandInstruments(code) {
  const matches = await exactMatches(code);
  const fund = matches.find(item => item.CATEGORY === 700);
  const info = fund?.FundBaseInfo;
  const listedEtf = fund && /ETF/i.test(fund.NAME) && !/联接/.test(fund.NAME) && !Number(info?.MINSG);
  const listed = matches.find(item => [100, 150].includes(item.CATEGORY) && ['1', '2', '0'].includes(String(item.STOCKMARKET)));
  return { listedName: listed?.NAME || (listedEtf ? fund.NAME : ''),
    fund: fund && !listedEtf ? { name: fund.NAME, moneyMarket: String(info?.FUNDTYPE) === '005' } : null };
}

export async function getFundNav(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('请输入六位基金代码');
  const data = await fetchQuoteResource(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1`, {
    headers: { Referer: 'https://fundf10.eastmoney.com/' }, retries: 0, timeoutMs: 5000
  });
  if (data?.Data?.FundType === '005' || /万份|七日/.test(data?.Data?.SYType || '')) {
    throw new Error('此基金按万份收益估值，暂不支持录入');
  }
  const latest = data?.Data?.LSJZList?.[0];
  const nav = Number(latest?.DWJZ);
  const date = latest?.FSRQ;
  if (!Number.isFinite(nav) || nav <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error('暂无公布的单位净值，请核对基金代码和估值方式');
  }
  return { nav, date };
}
