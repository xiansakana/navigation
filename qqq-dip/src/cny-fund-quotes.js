import { CNY_FUNDS } from './cny-routing.js';

function quoteMovement(price, previousClose) {
  const prevClose = Number(previousClose);
  if (!Number.isFinite(prevClose) || prevClose <= 0) return {};
  const change = price - prevClose;
  return { prevClose, change, changePercent: change / prevClose * 100 };
}

export function createCnyFundLoader(fetchJson, fetchText, legacyQuote) {
  const navCache = new Map();
  const quoteCache = new Map();
  const pending = new Map();
  async function load(symbol) {
    const prefix = symbol.startsWith('5') ? 'sh' : 'sz';
    let quote;
    if (symbol === '159509') quote = await legacyQuote();
    else {
      try {
        const text = await fetchText('https://qt.gtimg.cn/q=' + prefix + symbol, { 'User-Agent': 'Mozilla/5.0' }, 'gbk');
        const p = (text.match(/="([^"]*)"/)?.[1] || '').split('~');
        if (!(Number(p[3]) > 0) || p[2] !== symbol) throw new Error('腾讯无有效行情');
        quote = { symbol, name: CNY_FUNDS[symbol].name, price: Number(p[3]), source: 'tencent',
          ...quoteMovement(Number(p[3]), p[4]),
          asOf: /^\d{14}$/.test(p[30] || '') ? p[30].replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00') : null };
      } catch {
        const text = await fetchText('https://hq.sinajs.cn/list=' + prefix + symbol,
          { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' }, 'gbk');
        const p = (text.match(/="([^"]*)"/)?.[1] || '').split(',');
        if (!(Number(p[3]) > 0)) throw new Error(symbol + ' 无有效行情');
        quote = { symbol, name: CNY_FUNDS[symbol].name, price: Number(p[3]), source: 'sina',
          ...quoteMovement(Number(p[3]), p[2]),
          asOf: p[30] && p[31] ? p[30] + 'T' + p[31] + '+08:00' : null };
      }
    }
    let nav = navCache.get(symbol);
    if (!nav || Date.now() - nav.at > (nav.error ? 60000 : 3600000)) {
      try {
        const data = await fetchJson('https://api.fund.eastmoney.com/f10/lsjz?fundCode=' + symbol + '&pageIndex=1&pageSize=1',
          { Referer: 'https://fundf10.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' });
        const row = data?.Data?.LSJZList?.[0];
        if (!(Number(row?.DWJZ) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(row?.FSRQ || '')) throw new Error('无有效已公布净值');
        nav = { at: Date.now(), nav: Number(row.DWJZ), navDate: row.FSRQ, navSource: 'eastmoney-published-nav' };
      } catch (error) { nav = { at: Date.now(), error: error.message }; }
      navCache.set(symbol, nav);
    }
    return { ...quote, nav: nav.nav ?? null, navDate: nav.navDate ?? null,
      navSource: nav.navSource, navError: nav.error };
  }
  return async function get(symbol = '159509') {
    if (!CNY_FUNDS[symbol]) throw new Error('不支持的人民币抄底标的');
    const cached = quoteCache.get(symbol);
    if (cached && Date.now() - cached.at < 30000) return cached.quote;
    if (!pending.has(symbol)) pending.set(symbol, load(symbol).then((quote) => {
      quoteCache.set(symbol, { at: Date.now(), quote }); return quote;
    }).finally(() => pending.delete(symbol)));
    return pending.get(symbol);
  };
}
