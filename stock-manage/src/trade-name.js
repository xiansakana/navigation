import { normalizeTrade } from './trades.js';
import { normalizeSymbol } from './markets.js';

export function needsTradeName(trade) {
  if (!['buy', 'sell'].includes(trade?.type)) return false;
  const symbol = normalizeSymbol(trade.symbol);
  const name = String(trade.name || '').trim();
  return !!symbol && (!name || normalizeSymbol(name) === symbol);
}

export function backfillTradeName(trade, names) {
  if (!needsTradeName(trade)) return trade;
  const symbol = normalizeSymbol(trade.symbol);
  const name = String(names.get(symbol) || '').trim();
  return name && normalizeSymbol(name) !== symbol ? { ...trade, name } : trade;
}

export async function normalizeNamedTrade(input, getQuote) {
  const name = String(input?.name || '').trim();
  const trade = normalizeTrade({ ...input, name });
  if (name || trade.type === 'other') return trade;
  try {
    const quote = await getQuote(trade.symbol);
    const resolved = String(quote?.name || '').trim();
    if (resolved && resolved !== trade.symbol) trade.name = resolved;
  } catch {
    // A name lookup outage must not prevent recording a valid trade.
  }
  return trade;
}
