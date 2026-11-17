import { normalizeTrade } from './trades.js';
import { normalizeSymbol } from './markets.js';

export function needsTradeName(trade) {
  if (!['buy', 'sell'].includes(trade?.type)) return false;
  const symbol = normalizeSymbol(trade.symbol);
  const name = String(trade.name || '').trim();
  return !!symbol && (!name || /^(?:--?|—|N\/A)$/i.test(name) || normalizeSymbol(name) === symbol);
}

export function knownTradeNames(trades, quotes = {}) {
  const names = new Map();
  for (const trade of trades) {
    if (['buy', 'sell'].includes(trade.type) && !needsTradeName(trade)) {
      const symbol = normalizeSymbol(trade.symbol);
      if (symbol) names.set(symbol, String(trade.name).trim());
    }
  }
  for (const [key, quote] of Object.entries(quotes)) {
    const symbol = normalizeSymbol(key);
    if (!needsTradeName({ type: 'buy', symbol, name: quote?.name })) {
      if (symbol) names.set(symbol, String(quote.name).trim());
    }
  }
  return names;
}

export function backfillTradeName(trade, names) {
  if (!needsTradeName(trade)) return trade;
  const symbol = normalizeSymbol(trade.symbol);
  const name = String(names.get(symbol) || '').trim();
  return !needsTradeName({ ...trade, name }) ? { ...trade, name } : trade;
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
