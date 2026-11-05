// Forward-adjusted prices share the latest quote's price basis.
export function parseCnyHistory(data, source) {
  // The qfq endpoint can return `day` when no adjustment is needed, rather
  // than `qfqday`. Prefer the adjusted series whenever it is present.
  const series = data?.data?.sz159509;
  const rows = source === 'tencent' ? (series?.qfqday ?? series?.day) : data?.data?.klines;
  if (!Array.isArray(rows)) throw new Error('无前复权历史日线');
  const candles = rows.map((row) => {
    const p = Array.isArray(row) ? row : String(row).split(',');
    const [date, o, c, h, l, v] = p;
    return { t: Date.parse(`${date}T00:00:00+08:00`) / 1000,
      o: Number(o), c: Number(c), h: Number(h), l: Number(l), v: Number(v) };
  }).filter((r) => Number.isFinite(r.t) && [r.o, r.c, r.h, r.l].every((n) => Number.isFinite(n) && n > 0));
  const sorted = [...new Map(candles.map((r) => [r.t, r])).values()].sort((a, b) => a.t - b.t);
  if (sorted.length < 60) throw new Error('历史日线不足60个交易日');
  return sorted;
}

export function createCnyHistoryLoader(fetchJson) {
  let cache = null;
  return async function load() {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    if (cache?.date === date) return cache.candles;
    const errors = [];
    for (const [source, url] of [
      ['tencent', 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz159509,day,,,120,qfq'],
      ['eastmoney', 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.159509&klt=101&fqt=1&beg=0&end=20500101&lmt=120&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56']
    ]) {
      try {
        const candles = parseCnyHistory(await fetchJson(url, { Referer: 'https://quote.eastmoney.com/' }), source);
        cache = { date, candles };
        return candles;
      } catch (error) { errors.push(`${source}: ${error.message}`); }
    }
    throw new Error(errors.join('; '));
  };
}
