import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRth, isHoliday, isOpenSummaryTime, nyParts, isSessionDay } from './market-hours.js';

test('2026-09-07 Labor Day is a holiday', () => {
  assert.equal(isHoliday('2026-09-07'), true);
});

test('weekend is not a session day', () => {
  const sat = new Date('2026-09-05T16:00:00Z');
  const parts = nyParts(sat);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') {
    assert.equal(isSessionDay(parts), false);
    assert.equal(isRth(sat), false);
  }
});

test('nyParts returns ymd', () => {
  const p = nyParts(new Date('2026-06-15T18:00:00Z'));
  assert.match(p.ymd, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(p.minutes));
});

test('open summary waits until 09:35 New York time', () => {
  assert.equal(isOpenSummaryTime(new Date('2026-09-14T13:34:59Z')), false);
  assert.equal(isOpenSummaryTime(new Date('2026-09-14T13:35:00Z')), true);
  assert.equal(isOpenSummaryTime(new Date('2026-09-14T20:00:00Z')), false);
});
