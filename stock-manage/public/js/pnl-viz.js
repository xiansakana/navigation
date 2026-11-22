let vizMode = 'line';
let calGranularity = 'month';
let calYM = '';
let calYearFocus = '';
let viewFingerprint = '';
let zoomRange = null;
let lastContainer = null;
let lastGetData = null;
let lastCallbacks = null;
let cachedDayNet = new Map();
let lineChart = null;
let resizeObs = null;
let lastSeriesFp = '';

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

function fmtUsdSigned(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}$${fmt(n)}`;
}

function fmtCalendarRate(net, totalAssets, priorNet) {
  const base = totalAssets - priorNet;
  if (!Number.isFinite(totalAssets) || totalAssets <= 0 || base <= 1e-9) return '—';
  const rate = net / base * 100;
  return `${rate >= 0 ? '+' : ''}${fmt(rate)}%`;
}

function fmtUsdTiny(net) {
  const a = Math.abs(net);
  const sign = net >= 0 ? '+' : '-';
  if (a >= 1_000_000) return `${sign}$${fmt(a / 1_000_000)}m`;
  if (a >= 10_000) return `${sign}$${fmt(a / 1_000)}k`;
  if (a >= 1000) return `${sign}$${fmt(a / 1_000)}k`;
  return `${sign}$${fmt(a)}`;
}

function rangeFingerprint(series) {
  if (!series.length) return '';
  return `${series.length}\u0001${series[0].date}\u0001${series[series.length - 1].date}`;
}

function defaultZoom() {
  return { start: 0, end: 100 };
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function chartColors() {
  return {
    text: cssVar('--text', '#e8edf5'),
    muted: cssVar('--muted', '#9aa4b2'),
    accent: cssVar('--accent', '#5b9cff'),
    border: cssVar('--border', '#2a3140'),
    card: cssVar('--card', '#171b22')
  };
}

function getEcharts() {
  return globalThis.echarts;
}

function effectiveYM() {
  if (calYM) return calYM;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ymParts() {
  const m = /^(\d{4})-(\d{2})$/.exec(effectiveYM());
  if (!m) {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
  }
  return { y: +m[1], m: +m[2] };
}

function effectiveYear() {
  const m = /^(\d{4})$/.exec(calYearFocus.trim());
  if (m) {
    const y = +m[1];
    if (y >= 1980 && y <= 2100) return y;
  }
  return ymParts().y;
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0, 12)).getUTCDate();
}

function ymKey(y, mo, d) {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function mondayOffset(y, mo) {
  const wd = new Date(Date.UTC(y, mo - 1, 1, 12)).getUTCDay();
  return (wd + 6) % 7;
}

function yearBounds(sparse) {
  const cy = new Date().getFullYear();
  if (!sparse.length) return { minY: cy, maxY: cy };
  const ys = sparse.map((p) => +p.date.slice(0, 4)).filter(Number.isFinite);
  return { minY: Math.min(...ys, cy), maxY: Math.max(...ys, cy) };
}

function pointAtDate(d, expanded) {
  let lo = 0;
  let hi = expanded.length - 1;
  let ans;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (expanded[mid].date <= d) {
      ans = expanded[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function sumMonthNet(dayNet, y, mo) {
  let sum = 0;
  const dim = daysInMonth(y, mo);
  for (let d = 1; d <= dim; d++) {
    const key = ymKey(y, mo, d);
    sum += dayNet.get(key) ?? 0;
  }
  return sum;
}

function sumYearNet(dayNet, y) {
  let sum = 0;
  for (let mo = 1; mo <= 12; mo++) sum += sumMonthNet(dayNet, y, mo);
  return sum;
}

function fmtNetBadge(net, periodLabel) {
  const cls = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
  return `<span class="sm-cal-gran-net">${periodLabel} 净盈亏 <strong class="${cls}">${fmtUsdSigned(net)}</strong></span>`;
}

function calBg(net, maxAbs) {
  if (net === 0) return '';
  const t = maxAbs > 0 ? Math.min(1, Math.abs(net) / maxAbs) : 1;
  const bump = 0.05 + 0.12 * t;
  return net > 0 ? `rgba(61, 220, 132, ${bump})` : `rgba(255, 123, 123, ${bump})`;
}

function calTone(net, has) {
  if (!has || net === 0) return 'zero';
  return net > 0 ? 'pos' : 'neg';
}

function buildMonthCal(y, mo, dayNet, sparse, totalAssets) {
  const dim = daysInMonth(y, mo);
  let maxAbs = 0;
  for (let d = 1; d <= dim; d++) {
    const key = ymKey(y, mo, d);
    maxAbs = Math.max(maxAbs, Math.abs(dayNet.get(key) ?? 0));
  }
  if (maxAbs === 0) maxAbs = 1;

  const cells = [];
  for (let i = 0; i < mondayOffset(y, mo); i++) cells.push({ d: null, key: null });
  for (let d = 1; d <= dim; d++) cells.push({ d, key: ymKey(y, mo, d) });
  while (cells.length % 7) cells.push({ d: null, key: null });

  const rows = [];
  for (let r = 0; r < cells.length; r += 7) {
    const tds = cells.slice(r, r + 7).map((c) => {
      if (!c.key) return '<div class="sm-cal-cell sm-cal-cell--ph" aria-hidden="true"></div>';
      const has = dayNet.has(c.key);
      const net = dayNet.get(c.key) ?? 0;
      const tone = calTone(net, has);
      const bg = calBg(net, maxAbs);
      const amt = has ? fmtUsdTiny(net) : '$0';
      const cumulative = pointAtDate(c.key, sparse)?.cumulativeNet ?? 0;
      const rates = calendarRates(net, cumulative, totalAssets, '当日');
      const bgStyle = bg ? `background:${bg};` : '';
      return `<div class="sm-cal-cell sm-cal-cell--btn sm-cal-cell--${tone}" style="${bgStyle}" role="button" tabindex="0" data-cal-day="${c.key}" title="${c.key}">
        <span class="sm-cal-day">${c.d}</span>
        <span class="sm-cal-amt ${has && net !== 0 ? (net > 0 ? 'pos' : 'neg') : ''}">${amt}</span>
        ${rates}
      </div>`;
    }).join('');
    rows.push(`<div class="sm-cal-row">${tds}</div>`);
  }
  return `
    <div class="sm-cal-weekdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
    <div class="sm-cal-grid">${rows.join('')}</div>`;
}

function calendarRates(net, cumulative, totalAssets, label) {
  const rate = fmtCalendarRate(net, totalAssets, cumulative - net);
  const cumulativeRate = fmtCalendarRate(cumulative, totalAssets, cumulative);
  const tone = net > 0 ? 'pos' : 'neg';
  return `<span class="sm-cal-rates">
    ${net !== 0 ? `<span class="${tone}" title="${label}净盈亏 ÷（当前总资产 − 期初累计净盈亏）">${label} ${rate}</span>` : ''}
    <span title="期末累计净盈亏 ÷（当前总资产 − 期末累计净盈亏）">累计 ${cumulativeRate}</span>
  </span>`;
}

function buildYearCal(y, dayNet, sparse, totalAssets) {
  const monthSums = new Map();
  for (let mo = 1; mo <= 12; mo++) {
    monthSums.set(mo, sumMonthNet(dayNet, y, mo));
  }
  let maxAbs = 1;
  for (const v of monthSums.values()) maxAbs = Math.max(maxAbs, Math.abs(v));

  const cells = [];
  for (let mo = 1; mo <= 12; mo++) {
    const sm = monthSums.get(mo) ?? 0;
    const cumulative = pointAtDate(ymKey(y, mo, daysInMonth(y, mo)), sparse)?.cumulativeNet ?? 0;
    const tone = calTone(sm, sm !== 0);
    const bg = sm !== 0 ? calBg(sm, maxAbs) : '';
    const bgStyle = bg ? `background:${bg};` : '';
    cells.push(`
      <div class="sm-cal-year-cell sm-cal-cell--btn sm-cal-cell--${tone}" style="${bgStyle}" role="button" tabindex="0" data-cal-month="${y}-${mo}">
        <div class="sm-cal-year-mo">${mo}月</div>
        <div class="sm-cal-year-amt ${sm !== 0 ? (sm > 0 ? 'pos' : 'neg') : ''}">${fmtUsdTiny(sm)}</div>
        ${calendarRates(sm, cumulative, totalAssets, '当月')}
      </div>`);
  }
  return `<div class="sm-cal-year-grid">${cells.join('')}</div>`;
}

function buildAnnualCalendar(range, dayNet) {
  if (!range.length) return '<p class="sm-pnl-empty">暂无盈亏数据</p>';
  const years = [];
  for (const point of range) {
    const year = point.date.slice(0, 4);
    let row = years.at(-1);
    if (!row || row.year !== year) {
      row = { year, opening: point.cumulativeNet - (dayNet.get(point.date) ?? 0) };
      years.push(row);
    }
    row.closing = point.cumulativeNet;
  }
  const maxAbs = years.reduce((max, row) => Math.max(max, Math.abs(row.closing - row.opening)), 0);
  const cards = years.reverse().map(({ year, opening, closing }) => {
    const net = Math.round((closing - opening) * 100) / 100;
    const tone = calTone(net, true);
    const bg = calBg(net, maxAbs);
    return `<button type="button" class="sm-cal-year-cell sm-cal-annual-cell sm-cal-cell--btn sm-cal-cell--${tone}" data-cal-annual-year="${year}"${bg ? ` style="background:${bg}"` : ''}>
      <span class="sm-cal-year-mo">${year}年</span>
      <span class="sm-cal-year-amt ${tone}">净盈亏 ${fmtUsdSigned(net)}</span>
      <span class="sm-cal-ret">期末累计 ${fmtUsdSigned(closing)}</span>
    </button>`;
  });
  return `<div class="sm-cal-year-grid">${cards.join('')}</div>`;
}

function scheduleRender() {
  if (!lastContainer || !lastGetData) return;
  renderPnlVisualization(lastContainer, lastGetData, lastCallbacks);
}

function eachCalendarDay(start, end) {
  if (!start || !end || start > end) return [];
  let y = +start.slice(0, 4);
  let mo = +start.slice(5, 7);
  let day = +start.slice(8, 10);
  const out = [];
  for (;;) {
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    out.push(key);
    if (key === end) break;
    const d = new Date(y, mo - 1, day + 1);
    y = d.getFullYear();
    mo = d.getMonth() + 1;
    day = d.getDate();
  }
  return out;
}

function expandDailySeries(sparse) {
  if (!sparse.length) return [];
  const map = new Map(sparse.map((p) => [p.date, p]));
  const start = sparse[0].date;
  const end = sparse[sparse.length - 1].date;
  let run = sparse[0];
  return eachCalendarDay(start, end).map((d) => {
    if (map.has(d)) run = map.get(d);
    return { ...run, date: d };
  });
}

export function sliceSeries(series, startDate, endDate) {
  const opening = startDate ? pointAtDate(startDate, series.filter(p => p.date < startDate)) : null;
  return series.filter((p) => {
    if (startDate && p.date < startDate) return false;
    if (endDate && p.date > endDate) return false;
    return true;
  }).map(point => {
    const net = Math.round((point.cumulativeNet - (opening?.cumulativeNet ?? 0)) * 100) / 100;
    return { ...point, cumulativeNet: net };
  });
}

function disposeLineChart() {
  resizeObs?.disconnect();
  resizeObs = null;
  lineChart?.dispose();
  lineChart = null;
  lastSeriesFp = '';
}

export function disposePnlChart() {
  disposeLineChart();
}

function resetLineZoom() {
  if (!lineChart) {
    zoomRange = { start: 0, end: 100 };
    return;
  }
  zoomRange = { start: 0, end: 100 };
  lineChart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
}

function buildChartOption(rangeSlice) {
  const colors = chartColors();
  const dates = rangeSlice.map((p) => p.date);
  const values = rangeSlice.map((p) => p.cumulativeNet);
  const zoom = zoomRange && Number.isFinite(zoomRange.start)
    ? zoomRange
    : defaultZoom();
  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 16, right: 18, top: 24, bottom: 62, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: colors.card,
      borderColor: colors.border,
      textStyle: { color: colors.text, fontSize: 13 },
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p) return '';
        const date = p.axisValue;
        const point = rangeSlice[p.dataIndex];
        if (!point) return '';
        const dayNet = cachedDayNet.get(date);
        const dayHtml = dayNet !== undefined
          ? `<div style="margin-top:4px;color:${colors.muted}">当日净变动 ${fmtUsdSigned(dayNet)}</div>`
          : '';
        return `<div style="color:${colors.muted};margin-bottom:4px">${date}</div>
          <div>区间净盈亏 <b>${fmtUsdSigned(point.cumulativeNet)}</b></div>
          ${dayHtml}`;
      }
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: colors.border } },
      axisLabel: {
        color: colors.muted,
        hideOverlap: true,
        formatter: (d) => (typeof d === 'string' && d.length >= 10 ? d.slice(5).replace('-', '/') : d)
      },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: colors.border, opacity: 0.55 } },
      axisLabel: {
        color: colors.muted,
        formatter: (v) => `$${fmt(v)}`
      }
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        preventDefaultMouseMove: true,
        start: zoom.start,
        end: zoom.end
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        height: 22,
        bottom: 8,
        borderColor: colors.border,
        fillerColor: 'rgba(91, 156, 255, 0.22)',
        handleStyle: { color: colors.accent, borderColor: colors.accent },
        moveHandleStyle: { color: colors.accent },
        emphasis: { handleStyle: { color: colors.accent } },
        textStyle: { color: colors.muted },
        start: zoom.start,
        end: zoom.end
      }
    ],
    series: [{
      type: 'line',
      name: '区间净盈亏',
      data: values,
      showSymbol: dates.length === 1,
      sampling: 'lttb',
      lineStyle: { color: colors.accent, width: 2.25 },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(91, 156, 255, 0.28)' },
            { offset: 1, color: 'rgba(91, 156, 255, 0.02)' }
          ]
        }
      },
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { color: '#334155', type: 'dashed', width: 1 },
        data: [{ yAxis: 0, label: { show: false } }]
      }
    }]
  };
}

function seriesFingerprint(rangeSlice) {
  if (!rangeSlice.length) return '';
  return JSON.stringify(rangeSlice.map(p => [p.date, p.cumulativeNet, p.dayNet]));
}

function mountLineChart(host, rangeSlice) {
  const echarts = getEcharts();
  if (!echarts) {
    host.innerHTML = '<div class="sm-pnl-empty">图表组件未加载，请刷新页面。</div>';
    return;
  }
  if (lineChart && (!document.contains(lineChart.getDom()) || lineChart.getDom() !== host)) {
    disposeLineChart();
  }
  const fp = seriesFingerprint(rangeSlice);
  if (lineChart && lineChart.getDom() === host && lastSeriesFp === fp) {
    requestAnimationFrame(() => lineChart?.resize());
    return;
  }
  if (!lineChart) {
    host.innerHTML = '';
    lineChart = echarts.init(host, null, { renderer: 'canvas' });
    lineChart.on('dataZoom', () => {
      const opt = lineChart.getOption();
      const z = opt?.dataZoom?.[0];
      if (z && Number.isFinite(z.start) && Number.isFinite(z.end)) {
        zoomRange = { start: z.start, end: z.end };
      }
    });
    lineChart.getZr().on('dblclick', () => resetLineZoom());
    resizeObs = new ResizeObserver(() => lineChart?.resize());
    resizeObs.observe(host);
  }
  lastSeriesFp = fp;
  lineChart.setOption(buildChartOption(rangeSlice), { notMerge: true });
  requestAnimationFrame(() => lineChart?.resize());
}

function bindShell(container) {
  if (container.dataset.pnlBound === '1') return;
  container.dataset.pnlBound = '1';
  container.addEventListener('click', (e) => {
    const modeBtn = e.target.closest('[data-pnl-mode]');
    if (modeBtn) {
      vizMode = modeBtn.dataset.pnlMode;
      scheduleRender();
      return;
    }
    const granBtn = e.target.closest('[data-cal-gran]');
    if (granBtn) {
      calGranularity = granBtn.dataset.calGran;
      scheduleRender();
      return;
    }
    if (e.target.closest('[data-pnl-reset]')) {
      resetLineZoom();
      return;
    }
    if (e.target.closest('[data-cal-prev]')) {
      const { y, m } = ymParts();
      const dt = new Date(y, m - 2, 1);
      calYM = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      calYearFocus = `${dt.getFullYear()}`;
      scheduleRender();
      return;
    }
    if (e.target.closest('[data-cal-next]')) {
      const { y, m } = ymParts();
      const dt = new Date(y, m, 1);
      calYM = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      calYearFocus = `${dt.getFullYear()}`;
      scheduleRender();
      return;
    }
    if (e.target.closest('[data-cal-reset]')) {
      calYM = '';
      calYearFocus = '';
      scheduleRender();
      return;
    }
    const dayEl = e.target.closest('[data-cal-day]');
    if (dayEl) {
      lastCallbacks?.onCalendarDay?.(dayEl.dataset.calDay);
      return;
    }
    const moEl = e.target.closest('[data-cal-month]');
    if (moEl) {
      const [yy, mo] = moEl.dataset.calMonth.split('-').map(Number);
      lastCallbacks?.onCalendarMonth?.(yy, mo);
    }
    const annualEl = e.target.closest('[data-cal-annual-year]');
    if (annualEl) lastCallbacks?.onCalendarYear?.(annualEl.dataset.calAnnualYear);
  });
  container.addEventListener('change', (e) => {
    if (e.target.id === 'pnl-cal-year') {
      const y = +e.target.value;
      const mo = ymParts().m;
      calYM = `${y}-${String(mo).padStart(2, '0')}`;
      calYearFocus = `${y}`;
      scheduleRender();
    } else if (e.target.id === 'pnl-cal-month') {
      const { y } = ymParts();
      calYM = `${y}-${String(+e.target.value).padStart(2, '0')}`;
      scheduleRender();
    } else if (e.target.id === 'pnl-cal-year-only') {
      calYearFocus = `${+e.target.value}`;
      scheduleRender();
    }
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const dayEl = e.target.closest('[data-cal-day]');
    if (!dayEl) return;
    e.preventDefault();
    lastCallbacks?.onCalendarDay?.(dayEl.dataset.calDay);
  });
}

function ensureShell(container) {
  if (container.querySelector('.sm-pnl-viz')) {
    bindShell(container);
    return;
  }
  disposeLineChart();
  container.innerHTML = `
    <div class="sm-pnl-viz">
      <div class="sm-pnl-viz-head">
        <div class="sm-pnl-viz-tabs">
          <span class="sm-pnl-viz-label">盈亏走势</span>
          <div class="sm-seg">
            <button type="button" class="sm-seg-btn" data-pnl-mode="line">折线</button>
            <button type="button" class="sm-seg-btn" data-pnl-mode="calendar">日历</button>
          </div>
        </div>
        <span class="sm-muted sm-pnl-cum-badge"></span>
      </div>
      <div class="sm-pnl-line-block">
        <div class="sm-pnl-echarts" id="sm-pnl-echarts"></div>
        <div class="sm-pnl-line-hint">
          <span>拖动平移，滚轮缩放。</span>
          <button type="button" class="btn ghost sm-btn-sm" data-pnl-reset>复位视窗</button>
        </div>
      </div>
      <div class="sm-pnl-empty hidden" id="sm-pnl-empty"></div>
      <div class="sm-cal-block hidden"></div>
    </div>`;
  bindShell(container);
}

export function renderPnlVisualization(container, getData, callbacks = {}) {
  lastContainer = container;
  lastGetData = getData;
  lastCallbacks = callbacks;

  const data = getData();
  const { chartSparse = [], totalAssets, pnlStart = '', pnlEnd = '' } = data;
  const isLine = vizMode === 'line';
  callbacks.onModeChange?.(vizMode);
  const dayNet = new Map(chartSparse.map((p) => [p.date, p.dayNet]));
  const { y: dispY, m: dispM } = ymParts();
  const yEff = effectiveYear();
  const bounds = yearBounds(chartSparse);
  const minYo = Math.min(bounds.minY, dispY, yEff);
  const maxYo = Math.max(bounds.maxY, dispY, yEff);

  cachedDayNet = dayNet;

  ensureShell(container);

  const badge = container.querySelector('.sm-pnl-cum-badge');
  badge.classList.toggle('hidden', !isLine);
  container.querySelectorAll('[data-pnl-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pnlMode === vizMode);
  });

  const lineBlock = container.querySelector('.sm-pnl-line-block');
  const emptyEl = container.querySelector('#sm-pnl-empty');
  const calBlock = container.querySelector('.sm-cal-block');

  if (isLine) {
    const rangeSlice = sliceSeries(expandDailySeries(chartSparse), pnlStart, pnlEnd);
    const fp = rangeFingerprint(rangeSlice);
    if (fp !== viewFingerprint) {
      viewFingerprint = fp;
      zoomRange = defaultZoom();
    }
    const cumEnd = rangeSlice.at(-1)?.cumulativeNet;
    const cumBadge = cumEnd == null ? '—' : `<strong class="${cumEnd >= 0 ? 'pos' : 'neg'}">${fmtUsdSigned(cumEnd)}</strong>`;
    badge.innerHTML = `区间净盈亏 ${cumBadge}`;
    calBlock?.classList.add('hidden');
    if (!rangeSlice.length) {
      disposeLineChart();
      lineBlock?.classList.add('hidden');
      if (emptyEl) {
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = chartSparse.length ? '该区间没有盈亏数据。' : '暂无盈亏数据';
      }
      return;
    }
    emptyEl?.classList.add('hidden');
    lineBlock?.classList.remove('hidden');
    const host = container.querySelector('#sm-pnl-echarts');
    if (host) mountLineChart(host, rangeSlice);
    return;
  }

  disposeLineChart();
  lineBlock?.classList.add('hidden');
  emptyEl?.classList.add('hidden');
  if (!calBlock) return;
  calBlock.classList.remove('hidden');

  let yearOpts = '';
  for (let oy = minYo; oy <= maxYo; oy++) {
    yearOpts += `<option value="${oy}" ${oy === dispY ? 'selected' : ''}>${oy}</option>`;
  }
  let monthOpts = '';
  for (let mo = 1; mo <= 12; mo++) {
    monthOpts += `<option value="${mo}" ${mo === dispM ? 'selected' : ''}>${mo}</option>`;
  }
  let yearOnlyOpts = '';
  for (let oy = minYo; oy <= maxYo; oy++) {
    yearOnlyOpts += `<option value="${oy}" ${oy === yEff ? 'selected' : ''}>${oy}</option>`;
  }

  let calHtml = '';
  let calGranNetHtml = '';
  if (calGranularity === 'month') {
    const monthNet = sumMonthNet(dayNet, dispY, dispM);
    calGranNetHtml = fmtNetBadge(monthNet, `${dispY}年${dispM}月`);
    calHtml = `
      <div class="sm-cal-toolbar">
        <button type="button" class="btn ghost sm-btn-sm" data-cal-prev>上月</button>
        <button type="button" class="btn ghost sm-btn-sm" data-cal-next>下月</button>
        <label class="sm-cal-toolbar-field">
          <span class="sm-cal-toolbar-label">年</span>
          <select id="pnl-cal-year">${yearOpts}</select>
        </label>
        <label class="sm-cal-toolbar-field">
          <span class="sm-cal-toolbar-label">月</span>
          <select id="pnl-cal-month">${monthOpts}</select>
        </label>
        <button type="button" class="btn ghost sm-btn-sm" data-cal-reset>回到当月</button>
      </div>
      ${buildMonthCal(dispY, dispM, dayNet, chartSparse, totalAssets)}`;
  } else if (calGranularity === 'year') {
    const yearNet = sumYearNet(dayNet, yEff);
    calGranNetHtml = fmtNetBadge(yearNet, `${yEff}年`);
    calHtml = `
      <div class="sm-cal-toolbar">
        <label class="sm-cal-toolbar-field">
          <span class="sm-cal-toolbar-label">年</span>
          <select id="pnl-cal-year-only">${yearOnlyOpts}</select>
        </label>
      </div>
      ${buildYearCal(yEff, dayNet, chartSparse, totalAssets)}`;
  } else {
    calHtml = buildAnnualCalendar(chartSparse, dayNet);
  }

  calBlock.innerHTML = `
    <div class="sm-cal-gran">
      <div class="sm-cal-gran-left">
        <span class="sm-muted">粒度</span>
        <div class="sm-seg">
          <button type="button" class="sm-seg-btn ${calGranularity === 'month' ? 'active' : ''}" data-cal-gran="month">按月</button>
          <button type="button" class="sm-seg-btn ${calGranularity === 'year' ? 'active' : ''}" data-cal-gran="year">按年</button>
          <button type="button" class="sm-seg-btn ${calGranularity === 'annual' ? 'active' : ''}" data-cal-gran="annual">年度汇总</button>
        </div>
      </div>
      ${calGranNetHtml}
    </div>
    ${calHtml}`;
}
