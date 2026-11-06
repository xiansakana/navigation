import { latestCompletedSession, nyParts } from './market-hours.js';

// VXN's regular close is later than the QQQ equity close.
export function expectedVxnSession(now = new Date()) {
  return latestCompletedSession(new Date(now.getTime() - 15 * 60000));
}

export function parseVxnClose(data, now = new Date()) {
  const row = data?.data;
  const time = Date.parse(row?.last_trade_time);
  if (row?.index !== 'VXN' || !Number.isFinite(time) || time > now.getTime()) throw new Error('VXN 报价时间或代码无效');
  const market = nyParts(new Date(time));
  const expected = expectedVxnSession(now);
  const today = nyParts(now).ymd;
  const usePrevious = market.ymd === today && market.ymd > expected && market.minutes < 975;
  // After rollover Cboe can carry the finished close with its session date
  // and a midnight Central Time placeholder instead of the closing tick.
  const rolledClose = market.ymd === expected && today > expected
    && /T00:00:00(?:\.0+)?-0[56]:00$/.test(row.last_trade_time)
    && Number(row.close) === Number(row.prev_day_close)
    && Number(row.close) === Number(row.current_price);
  const price = Number(usePrevious ? row.prev_day_close : row.close);
  if (!(price > 0) || !Number.isFinite(price) || (!usePrevious && !rolledClose && market.minutes < 975)) {
    throw new Error('未取得有效 VXN 收盘值');
  }
  return { symbol: 'VXN', price, close: price, source: 'cboe',
    asOf: usePrevious ? expected : market.ymd, quoteAt: new Date(time).toISOString() };
}
