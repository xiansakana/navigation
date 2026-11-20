const fields = ['type', 'symbol', 'account_id', 'trade_date', 'shares', 'price', 'total_amount', 'commission', 'reinvestmentNav'];

// Match by persisted trade ID so an unchanged broker re-import does no price work.
export function changedHoldingSymbols(before, after) {
  const previous = new Map(before.map(trade => [trade.id, trade]));
  const changed = new Set();
  const add = trade => {
    if (trade && ['buy', 'sell'].includes(trade.type) && trade.symbol) changed.add(trade.symbol);
  };
  for (const trade of after) {
    const old = previous.get(trade.id);
    previous.delete(trade.id);
    if (!old || fields.some(field => (old[field] ?? null) !== (trade[field] ?? null))
      || !!old.reinvestedDividend !== !!trade.reinvestedDividend
      || !!old.historicalBackfill !== !!trade.historicalBackfill) {
      add(old);
      add(trade);
    }
  }
  previous.forEach(add);
  return changed;
}
