import { isRth, nyParts } from './market-hours.js';
import { cnMarketStatus } from './cn-market-hours.js';

function freshQuote(quote, now) {
  const at = Date.parse(quote?.asOf);
  return quote?.price > 0 && !quote.stale && !quote.previousCloseOnly
    && at <= now.getTime() && now.getTime() - at <= 120000;
}

export function equityTouchMarket(qqq, proxy, expectedCloseDate, now) {
  if (isRth(now) && freshQuote(qqq, now) && isRth(new Date(qqq.asOf))) return 'US';
  if (!cnMarketStatus(now).open || !freshQuote(proxy, now) || !cnMarketStatus(new Date(proxy.asOf)).open) return null;
  // The next CN session may use the last US regular-session close-time quote
  // as a price reference for equity only. Reject after-hours and older sessions.
  const at = Date.parse(qqq?.asOf);
  if (!(qqq?.price > 0) || qqq.stale || qqq.previousCloseOnly || !Number.isFinite(at)
    || at > now.getTime() || now.getTime() - at > 18 * 3600000) return null;
  const parts = nyParts(new Date(at));
  return parts.ymd === expectedCloseDate && parts.minutes === 16 * 60 && parts.second === 0 ? 'CN' : null;
}
