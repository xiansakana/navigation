import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeCalendarDate, formatZonedDateTime, zonedDateKey } from './trades.js';

test('repeated date formatting reuses native formatters without caching date results', async (t) => {
  const { dateTimeFormatter } = await import('./date-formatters.js?reuse-test');
  const Original = Intl.DateTimeFormat;
  const construct = t.mock.method(Intl, 'DateTimeFormat', function(...args) { return new Original(...args); });
  const options = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' };
  for (let i = 0; i < 5000; i++) dateTimeFormatter('en-CA', options).format(new Date(2026, 0, 1));
  assert.equal(construct.mock.callCount(), 1);
  const first = dateTimeFormatter('en-CA', options).format(new Date('2026-10-21T15:59:59Z'));
  const next = dateTimeFormatter('en-CA', options).format(new Date('2026-10-21T16:00:00Z'));
  assert.notEqual(first, next);
  dateTimeFormatter('en-CA', { ...options, timeZone: 'America/New_York' });
  assert.equal(construct.mock.callCount(), 2);
});

test('formatter cache is bounded and invalid time zones still throw', async () => {
  const { dateTimeFormatter } = await import('./date-formatters.js?bounded-test');
  const first = dateTimeFormatter('en-CA', { timeZone: 'UTC' });
  for (const timeZone of Intl.supportedValuesOf('timeZone').slice(0, 20)) dateTimeFormatter('en-CA', { timeZone });
  assert.notEqual(dateTimeFormatter('en-CA', { timeZone: 'UTC' }), first);
  assert.throws(() => dateTimeFormatter('en-CA', { timeZone: 'invalid/timezone' }), RangeError);
});

test('trade date output preserves midnight boundaries, DST, and invalid date behavior', () => {
  for (const timeZone of ['Asia/Shanghai', 'America/New_York', 'UTC']) {
    for (const iso of ['2026-10-21T15:59:59Z', '2026-10-21T16:00:00Z', '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z']) {
      const date = new Date(iso);
      const expected = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
      assert.equal(zonedDateKey(date, timeZone), expected);
      assert.equal(tradeCalendarDate(iso, timeZone), expected);
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23' }).formatToParts(date);
      const value = (type) => parts.find(p => p.type === type).value;
      assert.equal(formatZonedDateTime(iso, timeZone), `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`);
    }
  }
  assert.equal(tradeCalendarDate('invalid'), null);
  assert.equal(formatZonedDateTime('invalid'), 'invalid');
});
