import { isSessionDay, nyParts } from './market-hours.js';
import { cnMarketStatus } from './cn-market-hours.js';
import { fetchQuoteResource } from '../../shared/quote-network.js';

function overnightSession(time) {
  const { ymd, minutes } = nyParts(time);
  if (minutes >= 240 && minutes < 1200) return null;
  const day = new Date(ymd + 'T12:00:00Z');
  if (minutes >= 1200) day.setUTCDate(day.getUTCDate() + 1);
  const parts = nyParts(day);
  return isSessionDay(parts) ? parts.ymd : null;
}

export async function fetchQqqOvernight({ alpacaApiKeyId, alpacaApiSecretKey, alpacaOvernightFeed }) {
  if (!alpacaApiKeyId || !alpacaApiSecretKey) throw new Error('未配置 Alpaca 夜盘行情');
  const feed = alpacaOvernightFeed === 'boats' ? 'boats' : 'overnight';
  const data = await fetchQuoteResource(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=QQQ&feed=${feed}`, {
    headers: { 'APCA-API-KEY-ID': alpacaApiKeyId, 'APCA-API-SECRET-KEY': alpacaApiSecretKey },
    retries: 0, timeoutMs: 6000
  });
  return { price: Number(data?.trades?.QQQ?.p), asOf: data?.trades?.QQQ?.t, delayed: feed !== 'boats', source: 'alpaca' };
}

export function currentQqqOvernight(quote, now = new Date()) {
  const at = Date.parse(quote?.asOf);
  const maxAge = quote?.delayed ? 20 * 60000 : 120000;
  if (!Number.isFinite(quote?.price) || !(quote.price > 0) || !Number.isFinite(at)
    || at > now.getTime() || now - at > maxAge) return null;
  const session = overnightSession(now);
  return session && overnightSession(new Date(at)) === session ? quote : null;
}

export function cnyNightGate(tier, quote, now = new Date()) {
  if (!/^T[1-7]$/.test(tier?.id) || !cnMarketStatus(now).open) return { ok: true };
  const night = currentQqqOvernight(quote, now);
  if (!night) return { ok: false, reason: '缺少有效 QQQ 夜盘报价，暂停人民币买入提醒及登记' };
  return night.price <= tier.triggerPrice
    ? { ok: true, quote: night }
    : { ok: false, quote: night, reason: `QQQ 夜盘 ${night.price.toFixed(3)} 高于 ${tier.id} 触发价 ${tier.triggerPrice.toFixed(3)}，暂缓人民币买入` };
}
