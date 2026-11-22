export function parseCboeCalls(data) {
  const raw = String(data?.timestamp || '');
  const asOf = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? raw.replace(' ', 'T') + 'Z' : raw;
  if (!Number.isFinite(Date.parse(asOf))) throw new Error('Cboe 期权链缺少报价时间');
  return (data?.data?.options || []).flatMap((row) => {
    const match = /^QQQ(\d{2})(\d{2})(\d{2})C(\d{8})$/.exec(row.option || '');
    const bid = row.bid == null ? NaN : Number(row.bid);
    const ask = row.ask == null ? NaN : Number(row.ask);
    if (!match || !Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask <= 0 || ask < bid) return [];
    return [{ ticker: 'O:' + row.option, underlying: 'QQQ',
      expiry: `20${match[1]}-${match[2]}-${match[3]}`, strike: Number(match[4]) / 1000,
      sharesPerContract: 100, bid, ask, asOf, source: 'cboe-delayed', delayed: true }];
  });
}

export function createCboeChainLoader(fetchJson) {
  let cache;
  let pending;
  let retryAt = 0;
  let failure;
  return async () => {
    if (cache && Date.now() - cache.at < 60000) return cache.rows;
    if (Date.now() < retryAt) throw failure;
    if (!pending) pending = (async () => {
      try {
        const rows = parseCboeCalls(await fetchJson(
          'https://cdn.cboe.com/api/global/delayed_quotes/options/QQQ.json',
          { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.cboe.com/' }));
        cache = { at: Date.now(), rows };
        return rows;
      } catch (error) {
        failure = error;
        retryAt = Date.now() + 60000;
        throw error;
      } finally { pending = null; }
    })();
    return pending;
  };
}
