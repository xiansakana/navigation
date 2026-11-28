/**
 * OHLC aggregation for the bookkeeping trend charts.
 *
 * A candle needs four values per period, but bookkeeping only stores one value
 * per date. So a candle is built from the points that fall inside a period:
 * 开 = 区间首个值, 收 = 区间末个值, 高/低 = 区间极值. The period is chosen from
 * the data density (week → month → quarter → half year → year) so a chart of
 * daily points and a chart of monthly points both end up with a readable
 * number of candles instead of a row of dojis.
 *
 * Loaded as a classic script (like analysis.js) and exposed on window so the
 * existing script order keeps working; unit tests evaluate this file directly.
 */
(function () {
  'use strict';

  var DAY = 86400000;
  var BUCKETS = [
    { unit: 'week', days: 7 },
    { unit: 'month', days: 30 },
    { unit: 'quarter', days: 91 },
    { unit: 'half', days: 182 },
    { unit: 'year', days: 365 }
  ];
  var MAX_CANDLES = 26;

  function parseDay(date) {
    var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(date || ''));
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: m[3] ? +m[3] : 1 };
  }

  function time(date) {
    var p = parseDay(date);
    if (!p) return NaN;
    return Date.UTC(p.y, p.mo - 1, p.d, 12);
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** Period that a date belongs to, as the period's first day. */
  function bucketKey(date, unit) {
    var p = parseDay(date);
    if (!p) return '';
    if (unit === 'day') return p.y + '-' + pad(p.mo) + '-' + pad(p.d);
    if (unit === 'week') {
      var base = new Date(Date.UTC(p.y, p.mo - 1, p.d, 12));
      var offset = (base.getUTCDay() + 6) % 7; // Monday start
      base.setUTCDate(base.getUTCDate() - offset);
      return base.toISOString().slice(0, 10);
    }
    if (unit === 'month') return p.y + '-' + pad(p.mo) + '-01';
    if (unit === 'quarter') return p.y + '-' + pad(Math.floor((p.mo - 1) / 3) * 3 + 1) + '-01';
    if (unit === 'half') return p.y + '-' + (p.mo <= 6 ? '01' : '07') + '-01';
    return p.y + '-01-01';
  }

  function bucketLabel(start, unit) {
    var p = parseDay(start);
    if (!p) return start;
    if (unit === 'day') return start;
    if (unit === 'week') return p.y + '-' + pad(p.mo) + '-' + pad(p.d) + ' 起一周';
    if (unit === 'month') return p.y + '-' + pad(p.mo);
    if (unit === 'quarter') return p.y + ' Q' + (Math.floor((p.mo - 1) / 3) + 1);
    if (unit === 'half') return p.y + (p.mo <= 6 ? ' 上半年' : ' 下半年');
    return String(p.y);
  }

  /**
   * Pick the smallest period that keeps the candle count readable.
   * `dates` must be date strings; order does not matter.
   */
  function chooseBucket(dates, maxCandles) {
    var limit = Number.isFinite(maxCandles) && maxCandles > 0 ? maxCandles : MAX_CANDLES;
    var times = (dates || []).map(time).filter(function (value) { return Number.isFinite(value); }).sort(function (a, b) { return a - b; });
    if (times.length < 2) return BUCKETS[0];
    var rangeDays = (times[times.length - 1] - times[0]) / DAY;
    var spacing = rangeDays / (times.length - 1);
    var minDays = Math.max(spacing * 1.6, 1);
    for (var i = 0; i < BUCKETS.length; i++) {
      var bucket = BUCKETS[i];
      if (bucket.days < minDays) continue;
      if (rangeDays / bucket.days <= limit) return bucket;
    }
    return BUCKETS[BUCKETS.length - 1];
  }

  /**
   * Group points into candles for one series key.
   * Points without a finite value are skipped, so gaps stay gaps.
   */
  function buildCandles(points, key, bucket) {
    var unit = bucket && bucket.unit ? bucket.unit : 'day';
    var groups = new Map();
    var previous = null;
    for (var i = 0; i < (points || []).length; i++) {
      var point = points[i];
      var raw = point ? point[key] : null;
      // Number(null) is 0, so an explicit guard keeps gaps as gaps.
      if (raw === null || raw === undefined || raw === '') continue;
      var value = Number(raw);
      if (!Number.isFinite(value)) continue;
      var start = bucketKey(point.date, unit);
      if (!start) continue;
      var group = groups.get(start);
      if (group) {
        group.close = value;
        if (value > group.high) group.high = value;
        if (value < group.low) group.low = value;
        group.to = point.date;
        group.count++;
      } else {
        // 开 = 上一个观测值（K 线惯例），首根才用区间首值；这样日 K 也有实体。
        var open = previous === null ? value : previous;
        groups.set(start, {
          start: start,
          from: point.date,
          to: point.date,
          open: open,
          close: value,
          high: Math.max(open, value),
          low: Math.min(open, value),
          count: 1
        });
      }
      previous = value;
    }
    return Array.from(groups.values())
      .sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; })
      .map(function (candle) {
        candle.label = bucketLabel(candle.start, unit);
        candle.unit = unit;
        return candle;
      });
  }

  window.bkCandles = {
    chooseBucket: chooseBucket,
    buildCandles: buildCandles,
    bucketKey: bucketKey,
    bucketLabel: bucketLabel,
    MAX_CANDLES: MAX_CANDLES
  };
})();
