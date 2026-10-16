import calendar from 'lunar-javascript';

const { Solar, Lunar, LunarUtil } = calendar;
export const ENGINE_VERSION = 'lunar-javascript@1.7.7/mingli-v2';

function recordedClock(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(text)) throw new Error('原站真太阳时格式无效（需精确到分钟）');
  const date = new Date(text.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19).replace('T', ' ') !== text) throw new Error('原站真太阳时日期无效');
  return text;
}

function integer(value, min, max, label) {
  if (value === '' || value == null || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(label + '无效');
  }
  return Number(value);
}

export function normalizeBirth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('出生信息无效');
  const input = {
    calendar: raw.calendar ?? 'solar',
    year: integer(raw.year, 1901, 2099, '年份（1901—2099）'),
    month: integer(raw.month, 1, 12, '月份'), day: integer(raw.day, 1, 31, '日期'),
    hour: integer(raw.hour, 0, 23, '小时'), minute: integer(raw.minute, 0, 59, '分钟'),
    gender: integer(raw.gender, 0, 1, '性别'),
    sect: integer(raw.sect ?? 2, 1, 2, '换日规则'),
    yunSect: integer(raw.yunSect ?? 1, 1, 2, '起运规则'),
    leapMonth: raw.leapMonth === true,
    trueSolar: raw.trueSolar === true,
    recordedSolarTime: recordedClock(raw.recordedSolarTime),
    longitude: null,
    location: String(raw.location ?? '').trim().slice(0, 100)
  };
  if (!['solar', 'lunar'].includes(input.calendar)) throw new Error('请选择公历或农历');
  if (input.calendar === 'solar') input.leapMonth = false;
  if (raw.longitude !== '' && raw.longitude != null) {
    input.longitude = Number(raw.longitude);
    if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) throw new Error('经度应在 -180 到 180 之间');
  }
  if (input.trueSolar && input.longitude == null) throw new Error('真太阳时需要出生地经度');
  if (input.trueSolar && input.recordedSolarTime) throw new Error('原站真太阳时与经度修正只能选择一种');
  // All wall-clock inputs are UTC+08:00; never use the server's local timezone.
  if (input.calendar === 'solar') {
    const date = new Date(Date.UTC(input.year, input.month - 1, input.day));
    if (date.getUTCMonth() + 1 !== input.month || date.getUTCDate() !== input.day) throw new Error('公历日期不存在');
  }
  try {
    const solar = birthSolar(input);
    if (solar.getYear() < 1901 || solar.getYear() > 2099) throw new Error();
    if (input.recordedSolarTime && Math.abs(Date.parse(input.recordedSolarTime.replace(' ', 'T') + 'Z') - Date.parse(solar.toYmdHms().replace(' ', 'T') + 'Z')) > 86400000) throw new Error();
  } catch { throw new Error('日期不存在、闰月不匹配或转换后超出 1901—2099 年'); }
  return input;
}

function birthSolar(input) {
  const args = [input.year, input.calendar === 'lunar' && input.leapMonth ? -input.month : input.month, input.day, input.hour, input.minute, 0];
  return input.calendar === 'lunar' ? Lunar.fromYmdHms(...args).getSolar() : Solar.fromYmdHms(...args);
}

// NOAA/Meeus equation of time, evaluated at the actual UTC instant, in minutes.
export function equationOfTime(julianDay) {
  const t = (julianDay - 2451545) / 36525;
  const rad = Math.PI / 180;
  const l = (280.46646 + t * (36000.76983 + t * 0.0003032)) * rad;
  const m = (357.52911 + t * (35999.05029 - 0.0001537 * t)) * rad;
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const eps = (23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * Math.cos((125.04 - 1934.136 * t) * rad)) * rad;
  const y = Math.tan(eps / 2) ** 2;
  return 4 / rad * (y * Math.sin(2 * l) - 2 * e * Math.sin(m) + 4 * e * y * Math.sin(m) * Math.cos(2 * l) - 0.5 * y * y * Math.sin(4 * l) - 1.25 * e * e * Math.sin(2 * m));
}

export function calculateChart(raw) {
  const input = normalizeBirth(raw);
  const solar = birthSolar(input), lunar = solar.getLunar();
  const recorded = input.recordedSolarTime ? Solar.fromYmdHms(...input.recordedSolarTime.match(/\d+/g).map(Number)) : null;
  const correctionMinutes = recorded ? (recorded.getJulianDay() - solar.getJulianDay()) * 1440
    : input.trueSolar ? (input.longitude - 120) * 4 + equationOfTime(solar.getJulianDay() - 8 / 24) : 0;
  const clock = recorded || Solar.fromJulianDay(solar.getJulianDay() + Math.round(correctionMinutes * 60) / 86400);
  const civil = lunar.getEightChar(), adjusted = clock.getLunar().getEightChar();
  civil.setSect(input.sect); adjusted.setSect(input.sect);
  // Solar-term year/month and luck onset use the real instant. Only day/hour use the solar clock.
  const dayGan = adjusted.getDayGan();
  const pillars = ['Year', 'Month', 'Day', 'Time'].map((key, index) => {
    const ec = index < 2 ? civil : adjusted;
    const ganZhi = ec['get' + key](), gan = ganZhi[0], zhi = ganZhi[1];
    return {
      label: ['年柱', '月柱', '日柱', '时柱'][index], ganZhi, gan, zhi,
      elements: [LunarUtil.WU_XING_GAN[gan], LunarUtil.WU_XING_ZHI[zhi]],
      tenGod: index === 2 ? '日主' : LunarUtil.SHI_SHEN[dayGan + gan],
      hidden: LunarUtil.ZHI_HIDE_GAN[zhi].map(g => ({ gan: g, element: LunarUtil.WU_XING_GAN[g], tenGod: LunarUtil.SHI_SHEN[dayGan + g] })),
      naYin: LunarUtil.NAYIN[ganZhi], xunKong: LunarUtil.getXunKong(ganZhi)
    };
  });
  const yun = civil.getYun(input.gender, input.yunSect);
  const cycles = yun.getDaYun(10).map(d => ({
    index: d.getIndex(), ganZhi: d.getGanZhi() || '童限',
    startYear: d.getStartYear(), endYear: d.getEndYear(), startAge: d.getStartAge(), endAge: d.getEndAge(),
    years: d.getLiuNian().map(y => ({ year: y.getYear(), age: y.getAge(), ganZhi: y.getGanZhi(),
      months: y.getLiuYue().map(m => ({ label: m.getMonthInChinese() + '月', ganZhi: m.getGanZhi() })) }))
  })).filter(d => d.years.length);
  const elements = Object.fromEntries(['木', '火', '土', '金', '水'].map(e => [e, pillars.flatMap(p => p.elements).filter(v => v === e).length]));
  const jie = term => ({ name: term.getName(), time: term.getSolar().toYmdHms() });
  return {
    engine: ENGINE_VERSION, input, solar: solar.toYmdHms(), lunar: lunar.toString(),
    clock: clock.toYmdHms(), correctionMinutes: Math.round(correctionMinutes * 100) / 100,
    dayMaster: dayGan, pillars, elements,
    previousJie: jie(lunar.getPrevJie()), nextJie: jie(lunar.getNextJie()),
    luck: { forward: yun.isForward(), years: yun.getStartYear(), months: yun.getStartMonth(), days: yun.getStartDay(), hours: yun.getStartHour(), start: yun.getStartSolar().toYmdHms(), cycles }
  };
}
