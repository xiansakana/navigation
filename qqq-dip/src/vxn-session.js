import { latestCompletedSession, nyParts } from './market-hours.js';

// Published U.S. early-close sessions for the years covered by market-hours.js.
const earlyCloseDates = new Set([
  '2025-07-03', '2025-11-28', '2025-12-24',
  '2026-11-27', '2026-12-24',
  '2027-11-26'
]);

export function vxnCloseMinutes(ymd) {
  return (earlyCloseDates.has(ymd) ? 13 : 16) * 60 + 15;
}

export function expectedVxnSession(now = new Date()) {
  return latestCompletedSession(now, vxnCloseMinutes);
}

export function parseVxnClose(data, now = new Date()) {
  const row = data?.data;
  const time = Date.parse(row?.last_trade_time);
  if (row?.index !== 'VXN' || !Number.isFinite(time) || time > now.getTime()) throw new Error('VXN 报价时间或代码无效');
  const market = nyParts(new Date(time));
  const expected = expectedVxnSession(now);
  const today = nyParts(now).ymd;
  const closeMinutes = vxnCloseMinutes(market.ymd);
  const usePrevious = market.ymd === today && market.ymd > expected && market.minutes < closeMinutes;
  // After rollover Cboe can carry the finished close with its session date
  // and a midnight Central Time placeholder instead of the closing tick.
  const rolledClose = market.ymd === expected && today > expected
    && /T00:00:00(?:\.0+)?-0[56]:00$/.test(row.last_trade_time)
    && Number(row.close) === Number(row.prev_day_close)
    && Number(row.close) === Number(row.current_price);
  const price = Number(usePrevious ? row.prev_day_close : row.close);
  if (!(price > 0) || !Number.isFinite(price) || (!usePrevious && !rolledClose && market.minutes < closeMinutes)) {
    throw new Error('未取得有效 VXN 收盘值');
  }
  return { symbol: 'VXN', price, close: price, source: 'cboe',
    asOf: usePrevious ? expected : market.ymd, quoteAt: new Date(time).toISOString() };
}

export function parseVxnDailyClose(csv, expected) {
  const [year, month, day] = expected.split('-');
  const session = `${month}/${day}/${year}`;
  const lines = csv.trim().split(/\r?\n/);
  if (lines[0].trim() !== 'DATE,OPEN,HIGH,LOW,CLOSE') throw new Error('VXN 日线格式无效');
  const row = lines.slice(1).findLast((line) => line.startsWith(`${session},`));
  const price = Number(row?.split(',')[4]);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`日线未发布 ${expected} 的有效收盘值`);
  return { symbol: 'VXN', price, close: price, source: 'cboe', asOf: expected };
}
