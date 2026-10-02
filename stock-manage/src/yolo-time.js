const etDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
});

export function yoloMarketDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('行情时间戳无效');
  const parts = Object.fromEntries(etDateFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
