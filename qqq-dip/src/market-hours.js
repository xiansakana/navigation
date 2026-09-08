/** US cash equity session in America/New_York. Weekends + a small NYSE holiday table. */

const NY_TZ = 'America/New_York';

const US_MARKET_HOLIDAYS = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'
]);

export function nyParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const map = {};
  fmt.formatToParts(date).forEach((p) => {
    if (p.type !== 'literal') map[p.type] = p.value;
  });
  const ymd = `${map.year}-${map.month}-${map.day}`;
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  return {
    ymd,
    weekday: map.weekday,
    hour,
    minute,
    second,
    minutes: hour * 60 + minute
  };
}

export function isWeekend(weekday) {
  return weekday === 'Sat' || weekday === 'Sun';
}

export function isHoliday(ymd) {
  return US_MARKET_HOLIDAYS.has(ymd);
}

export function isSessionDay(parts = nyParts()) {
  return !isWeekend(parts.weekday) && !isHoliday(parts.ymd);
}

export function isRth(date = new Date()) {
  const parts = nyParts(date);
  if (!isSessionDay(parts)) return false;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return parts.minutes >= open && parts.minutes < close;
}

function addNyDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d + delta, 16, 0, 0);
  return nyParts(new Date(utc)).ymd;
}

export function nextSessionOpen(date = new Date()) {
  const parts = nyParts(date);
  if (isRth(date)) return { ymd: parts.ymd, at: 'now', ms: 0, today: true };
  if (isSessionDay(parts) && parts.minutes < 9 * 60 + 30) {
    return {
      ymd: parts.ymd,
      at: `${parts.ymd} 09:30 ET`,
      ms: Math.max(0, nyDateMs(parts.ymd, 9, 30) - date.getTime()),
      today: true
    };
  }
  let ymd = parts.ymd;
  for (let i = 0; i < 14; i++) {
    ymd = addNyDays(ymd, 1);
    const wd = weekdayOf(ymd);
    if (!isWeekend(wd) && !isHoliday(ymd)) {
      return {
        ymd,
        at: `${ymd} 09:30 ET`,
        ms: Math.max(0, nyDateMs(ymd, 9, 30) - date.getTime()),
        today: false
      };
    }
  }
  return { ymd, at: null, ms: 0 };
}

function weekdayOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d, 17, 0, 0)).getUTCDay()];
}

function nyDateMs(ymd, hour, minute) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour + 4, minute, 0);
  for (const offset of [4, 5, 3]) {
    const t = Date.UTC(y, m - 1, d, hour + offset, minute, 0);
    const p = nyParts(new Date(t));
    if (p.ymd === ymd && p.hour === hour && p.minute === minute) return t;
  }
  return guess;
}

export function marketStatus(date = new Date()) {
  const parts = nyParts(date);
  const rth = isRth(date);
  const sessionDay = isSessionDay(parts);
  let label = '已收盘';
  let next = null;
  if (rth) {
    label = '开盘中';
  } else if (sessionDay && parts.minutes < 9 * 60 + 30) {
    const mins = 9 * 60 + 30 - parts.minutes;
    label = `距开盘 ${mins} 分钟`;
    next = nextSessionOpen(date);
  } else {
    next = nextSessionOpen(date);
    const mins = Math.round((next.ms || 0) / 60000);
    if (mins > 0 && mins < 24 * 60) label = `距开盘 ${mins} 分钟`;
    else if (next.at) label = `下一次开盘 ${next.at}`;
  }
  return {
    timezone: NY_TZ,
    ymd: parts.ymd,
    weekday: parts.weekday,
    clock: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    rth,
    sessionDay,
    holiday: isHoliday(parts.ymd),
    label
  };
}
