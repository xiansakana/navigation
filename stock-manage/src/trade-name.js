import { normalizeTrade } from './trades.js';

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
