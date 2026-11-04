// Project the owner's real trades; never create trades or mutate cash here.
// FIFO attribution includes ordinary purchases, so their sales do not blindly
// remove an unrelated strategy lot in the same account.
export function portfolioDipLots(trades = [], previous = [], hidden = []) {
  const groups = new Map();
  const saved = new Map(previous.map((lot) => [lot.id, lot]));
  for (const trade of [...trades].sort((a, b) => Date.parse(a.trade_date) - Date.parse(b.trade_date) || String(a.id).localeCompare(String(b.id)))) {
    const key = JSON.stringify([trade.account_id || '', trade.currency || 'USD', trade.symbol]);
    const queue = groups.get(key) || [];
    groups.set(key, queue);
    const qty = Number(trade.shares);
    if (!(qty > 0)) continue;
    if (trade.type === 'buy') queue.push({ trade, qty });
    if (trade.type === 'sell') {
      let remaining = qty;
      for (const lot of queue) {
        const take = Math.min(remaining, lot.qty);
        lot.qty -= take;
        remaining -= take;
        if (remaining <= 0) break;
      }
    }
  }
  return [...groups.values()].flat().filter(({ trade, qty }) => trade.source === 'qqq-dip' && qty > 1e-8)
    .map(({ trade, qty }) => {
      const id = `portfolio:${trade.id}`;
      const option = String(trade.symbol).replace(/^O:/, '').match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?)$/);
      const strike = option ? Number(option[6]) / (/^\d{8}$/.test(option[6]) ? 1000 : 1) : null;
      return { ...saved.get(id), id, source: 'portfolio-trade', tradeId: trade.id, accountId: trade.account_id,
        symbol: trade.symbol, currency: trade.currency || 'USD', type: option ? 'call' : 'equity',
        qty, cost: Number(trade.price), tier: trade.tier, openedAt: trade.trade_date,
        ...(option ? { strike, expiry: `20${option[2]}-${option[3]}-${option[4]}` } : {}),
        otmClass: saved.get(id)?.otmClass || (option ? 'medium' : ['TQQQ', 'SOXL'].includes(trade.symbol) ? 'levered' : 'equity') };
    }).filter((lot) => !hidden.includes(lot.id));
}
