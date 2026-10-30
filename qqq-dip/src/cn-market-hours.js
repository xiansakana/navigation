// SZSE 2026 calendar: 深证会〔2025〕481号.
// https://www.szse.cn/disclosure/notice/general/t20251222_618087.html
const closures = [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']];

export function cnMarketStatus(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const day = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  const known = parts.year === '2026';
  const md = `${parts.month}-${parts.day}`;
  const session = known && day !== 0 && day !== 6 && !closures.some(([a, b]) => md >= a && md <= b);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  // Regular matching only; exclude the opening auction from executable previews.
  const open = session && ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900));
  return { date, known, open, session, label: !known ? '深交所日历待更新' : open
    ? 'A股交易时段，仍需核对停牌/溢价/最新报价' : '等待A股交易时段（含午休及节假日）' };
}

export function nextCnSessionEnd(now = new Date()) {
  for (let i = 0; i <= 30; i += 1) {
    const candidate = new Date(now.getTime() + i * 86400000);
    const status = cnMarketStatus(candidate);
    if (!status.known) return null;
    const end = new Date(`${status.date}T15:00:00+08:00`);
    if (status.session && end > now) return end.toISOString();
  }
  return null;
}

// Backtests must supply timestamped executable bars, not an unlabeled daily
// close. Select strictly after signal availability, including overnight gaps.
export function nextCnExecutionBar(signalAt, bars) {
  const signal = new Date(signalAt);
  if (!Number.isFinite(signal.getTime())) throw new Error('信号时间无效');
  if (!cnMarketStatus(signal).known) throw new Error('回测年份交易日历未维护');
  return [...bars].filter((bar) => Number.isFinite(bar.t) && bar.t * 1000 > signal.getTime()
    && Number.isFinite(bar.o) && bar.o > 0 && cnMarketStatus(new Date(bar.t * 1000)).open)
    .sort((a, b) => a.t - b.t)[0] || null;
}
