import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateChart } from './mingli-chart.js';

const birth = { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1 };
const pillars = c => c.pillars.map(p => p.ganZhi);

test('reference chart: four pillars, ten gods, hidden stems and elements', () => {
  // Published upstream EightChar fixture, kept as literal expectations.
  const c = calculateChart(birth);
  assert.deepEqual(pillars(c), ['乙酉', '戊子', '辛巳', '壬辰']);
  assert.deepEqual(c.pillars.map(p => p.tenGod), ['偏财', '正印', '日主', '伤官']);
  assert.deepEqual(c.pillars[2].hidden.map(h => h.gan), ['丙', '庚', '戊']);
  assert.deepEqual(c.pillars[2].hidden.map(h => h.tenGod), ['正官', '劫财', '正印']);
  assert.equal(c.pillars[2].naYin, '白蜡金');
  assert.deepEqual(c.elements, { 木: 1, 火: 1, 土: 2, 金: 2, 水: 2 });
});

test('late Zi hour supports both day boundaries, and documents the same hour stem', () => {
  const raw = { ...birth, year: 1988, month: 2, day: 15, hour: 23, minute: 30 };
  assert.deepEqual(pillars(calculateChart({ ...raw, sect: 2 })), ['戊辰', '甲寅', '庚子', '戊子']);
  assert.deepEqual(pillars(calculateChart({ ...raw, sect: 1 })), ['戊辰', '甲寅', '辛丑', '戊子']);
  assert.equal(calculateChart({ ...raw, day: 16, hour: 0 }).pillars[2].ganZhi, '辛丑');
});

test('Li Chun changes year and month at the term, not the civil date', () => {
  const raw = { ...birth, year: 2024, month: 2, day: 4, hour: 16 };
  assert.deepEqual(pillars(calculateChart({ ...raw, minute: 26 })).slice(0, 2), ['癸卯', '乙丑']);
  assert.deepEqual(pillars(calculateChart({ ...raw, minute: 28 })).slice(0, 2), ['甲辰', '丙寅']);
  // Jing Zhe switches month while year stays unchanged.
  assert.deepEqual(pillars(calculateChart({ ...raw, month: 3, day: 5, hour: 10, minute: 21 })).slice(0, 2), ['甲辰', '丙寅']);
  assert.deepEqual(pillars(calculateChart({ ...raw, month: 3, day: 5, hour: 10, minute: 24 })).slice(0, 2), ['甲辰', '丁卯']);
});

test('leap lunar input matches its Gregorian date and rejects nonexistent leap months', () => {
  const lunar = calculateChart({ ...birth, calendar: 'lunar', year: 2023, month: 2, day: 1, leapMonth: true });
  assert.equal(lunar.solar, '2023-03-22 08:37:00');
  assert.deepEqual(pillars(lunar), pillars(calculateChart({ ...birth, year: 2023, month: 3, day: 22 })));
  assert.throws(() => calculateChart({ ...birth, calendar: 'lunar', year: 2024, month: 2, leapMonth: true }), /日期不存在/);
});

test('luck onset regression and gender direction, with twelve months per year', () => {
  const c = calculateChart({ ...birth, year: 1981, month: 1, day: 29, hour: 23, minute: 37, gender: 0 });
  assert.equal(c.luck.start.slice(0, 10), '1989-02-18');
  assert.deepEqual([c.luck.years, c.luck.months, c.luck.days], [8, 0, 20]);
  const sample = { ...birth, year: 2022, month: 3, day: 9, hour: 20, minute: 51 };
  assert.equal(calculateChart(sample).luck.start.slice(0, 10), '2030-12-19');
  assert.equal(calculateChart({ ...sample, yunSect: 2 }).luck.start.slice(0, 10), '2030-12-12');
  assert.notEqual(calculateChart(sample).luck.forward, calculateChart({ ...sample, gender: 0 }).luck.forward);
  assert.ok(c.luck.cycles.every(d => d.years.every(y => y.months.length === 12)));
});

test('true solar clock crosses days without shifting real solar-term year/month or luck', () => {
  const raw = { ...birth, year: 2024, month: 2, day: 4, hour: 16, minute: 28 };
  const civil = calculateChart(raw), adjusted = calculateChart({ ...raw, trueSolar: true, longitude: 75 });
  assert.deepEqual(pillars(adjusted).slice(0, 2), pillars(civil).slice(0, 2));
  assert.equal(adjusted.luck.start, civil.luck.start);
  assert.ok(adjusted.correctionMinutes < -193 && adjusted.correctionMinutes > -195);
  const midnight = calculateChart({ ...raw, hour: 0, minute: 10, trueSolar: true, longitude: 75 });
  assert.equal(midnight.clock.slice(0, 10), '2024-02-03');
  assert.notEqual(midnight.pillars[2].ganZhi, calculateChart({ ...raw, hour: 0, minute: 10 }).pillars[2].ganZhi);
});

test('invalid dates, ranges, missing times and malformed inputs are rejected', () => {
  for (const patch of [{ year: 1900 }, { month: 2, day: 30 }, { hour: 24 }, { minute: '' }, { gender: 3 }, { sect: 4 }, { calendar: 'other' }, { trueSolar: true }, { longitude: 'x' }]) {
    assert.throws(() => calculateChart({ ...birth, ...patch }));
  }
  for (const raw of [null, [], 'bad']) assert.throws(() => calculateChart(raw));
  const before = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York'; const a = pillars(calculateChart(birth));
    process.env.TZ = 'Asia/Shanghai'; assert.deepEqual(pillars(calculateChart(birth)), a);
  } finally { if (before == null) delete process.env.TZ; else process.env.TZ = before; }
});
