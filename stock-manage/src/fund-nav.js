import { fetchQuoteResource } from '../../shared/quote-network.js';

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
