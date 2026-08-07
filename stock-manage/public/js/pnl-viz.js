const MIN_POINTS = 8;
const VIEW_W = 1000;
const VIEW_H = 220;
const PAD_L = 76;
const PAD_R = 54;
const PAD_T = 14;
const PAD_B = 48;
const INNER_W = VIEW_W - PAD_L - PAD_R;

let vizMode = 'line';
let calGranularity = 'month';
let calYM = '';
let calYearFocus = '';
let viewFingerprint = '';
let viewport = { startFloat: 0, span: 0 };
let lastFullLen = 0;
let hoverModel = null;
let hoverCleanup = null;
let panDragging = false;
let panLastX = 0;
let panPointerId = -1;
let gradSeq = 0;
let renderRaf = false;
let lastContainer = null;
let lastGetData = null;
let lastCallbacks = null;

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

function fmtUsdSigned(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}$${fmt(n)}`;
}

function fmtPct(n, totalAssets, cumulativeNet) {
  const base = totalAssets - cumulativeNet;
  if (!Number.isFinite(base) || base <= 1e-9) return '—';
  const p = (cumulativeNet / base) * 100;
  return `${p >= 0 ? '+' : ''}${fmt(p)}%`;
}

function fmtIncPct(delta, cumBefore, totalAssets) {
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-12) return '—';
  const base = totalAssets - cumBefore;
  if (!Number.isFinite(base) || base <= 1e-9) return '—';
  const p = (delta / base) * 100;
  return `${p >= 0 ? '+' : ''}${fmt(p)}%`;
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

function clampViewport(vp, len) {
  if (len <= 0) return { startFloat: 0, span: 0 };
  const minSpan = Math.min(len, MIN_POINTS);
  let span = vp.span;
  if (!Number.isFinite(span) || span <= 0) span = minSpan;
  span = Math.min(Math.max(span, minSpan), len);
  let startFloat = Number.isFinite(vp.startFloat) ? vp.startFloat : 0;
  startFloat = Math.min(Math.max(0, startFloat), Math.max(0, len - span));
  return { startFloat, span };
}

function zoomViewport(prev, len, pivotT, zoomOut) {
  if (len <= MIN_POINTS) return { startFloat: 0, span: len };
  const vp = clampViewport(prev, len);
  const factor = zoomOut ? 1.14 : 0.87;
  let newSpan = Math.min(len, Math.max(MIN_POINTS, Math.round(vp.span * factor)));
  const t = Math.min(1, Math.max(0, pivotT));
  const denomOld = Math.max(1, vp.span - 1);
  const denomNew = Math.max(1, newSpan - 1);
  const pivotPos = vp.startFloat + t * denomOld;
  let newStart = pivotPos - t * denomNew;
  newStart = Math.min(Math.max(0, newStart), Math.max(0, len - newSpan));
  return clampViewport({ startFloat: newStart, span: newSpan }, len);
}

function panViewportByDx(vp, len, dxPx, plotWpx) {
  if (len <= MIN_POINTS || plotWpx <= 0) return vp;
  const c = clampViewport(vp, len);
  return clampViewport({ startFloat: c.startFloat + (-dxPx / plotWpx) * c.span, span: c.span }, len);
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

function cumAtDate(d, expanded) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !expanded.length) return 0;
  const first = expanded[0].date;
  const last = expanded[expanded.length - 1].date;
  if (d < first) return 0;
  if (d > last) return expanded[expanded.length - 1].cumulativeNet;
  let lo = 0;
  let hi = expanded.length - 1;
  let ans = expanded[0].cumulativeNet;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (expanded[mid].date <= d) {
      ans = expanded[mid].cumulativeNet;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function lastKeyBeforeMonth(y, mo) {
  if (mo > 1) return ymKey(y, mo - 1, daysInMonth(y, mo - 1));
  return ymKey(y - 1, 12, daysInMonth(y - 1, 12));
}

function inQuery(d, start, end) {
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

function calBg(net, maxAbs) {
  if (net === 0) return 'rgba(148, 163, 184, 0.12)';
  const t = maxAbs > 0 ? Math.min(1, Math.abs(net) / maxAbs) : 1;
  const bump = 0.18 + 0.62 * t;
  return net > 0 ? `rgba(61, 220, 132, ${bump})` : `rgba(255, 123, 123, ${bump})`;
}

function buildLineSvg(points, hint, panFraction, totalAssets) {
  if (!points.length) return '<div class="sm-pnl-empty">暂无数据</div>';
  const w = VIEW_W;
  const h = VIEW_H;
  const innerH = h - PAD_T - PAD_B;
  const vals = points.map((p) => p.cumulativeNet);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const vSpan = maxV - minV || 1;
  const n = points.length;
  const panF = Math.min(1, Math.max(0, panFraction));
  const denom = n <= 1 ? 1 : n - 1;
  const stepPx = n <= 1 ? INNER_W / 2 : INNER_W / denom;
  const shiftPx = n <= 1 ? 0 : panF * stepPx;
  const xs = points.map((_, i) => PAD_L + (n <= 1 ? INNER_W / 2 : (i / denom) * INNER_W) - shiftPx);
  const ys = points.map((p) => PAD_T + innerH - ((p.cumulativeNet - minV) / vSpan) * innerH);
  const line = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const yMid = minV + vSpan / 2;
  gradSeq += 1;
  const gid = `smGrad${gradSeq}`;
  const cid = `smClip${gradSeq}`;
  let zeroLine = '';
  if (minV < 0 && maxV > 0) {
    const zy = PAD_T + innerH - ((0 - minV) / vSpan) * innerH;
    zeroLine = `<line x1="${PAD_L}" y1="${zy.toFixed(1)}" x2="${PAD_L + INNER_W}" y2="${zy.toFixed(1)}" stroke="#334155" stroke-dasharray="4 4"/>`;
  }
  const area = `${xs[0].toFixed(1)},${PAD_T + innerH} ${line} ${xs[n - 1].toFixed(1)},${PAD_T + innerH}`;
  const firstLbl = points[0].date.slice(5).replace('-', '/');
  const lastLbl = points[n - 1].date.slice(5).replace('-', '/');

  return `
    <div class="sm-pnl-line-wrap">
      <svg class="sm-pnl-line-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-label="累计净盈亏折线">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#5b9cff" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#5b9cff" stop-opacity="0.02"/>
          </linearGradient>
          <clipPath id="${cid}"><rect x="${PAD_L}" y="${PAD_T}" width="${INNER_W}" height="${innerH}"/></clipPath>
        </defs>
        <text x="${PAD_L - 4}" y="${PAD_T + 12}" text-anchor="end" fill="#9aa4b2" font-size="12">$${fmt(maxV)}</text>
        <text x="${PAD_L - 4}" y="${PAD_T + innerH / 2 + 4}" text-anchor="end" fill="#9aa4b2" font-size="12">$${fmt(yMid)}</text>
        <text x="${PAD_L - 4}" y="${PAD_T + innerH + 2}" text-anchor="end" fill="#9aa4b2" font-size="12">$${fmt(minV)}</text>
        <text x="${w - 4}" y="${PAD_T + 12}" text-anchor="end" fill="#64748b" font-size="11">${fmtPct(maxV, totalAssets, maxV)}</text>
        <text x="${w - 4}" y="${PAD_T + innerH / 2 + 4}" text-anchor="end" fill="#64748b" font-size="11">${fmtPct(yMid, totalAssets, yMid)}</text>
        <text x="${w - 4}" y="${PAD_T + innerH + 2}" text-anchor="end" fill="#64748b" font-size="11">${fmtPct(minV, totalAssets, minV)}</text>
        <g clip-path="url(#${cid})">
          ${zeroLine}
          <polygon points="${area}" fill="url(#${gid})"/>
          <polyline points="${line}" fill="none" stroke="#5b9cff" stroke-width="2.25" stroke-linejoin="round"/>
          <circle cx="${xs[n - 1].toFixed(1)}" cy="${ys[n - 1].toFixed(1)}" r="4.5" fill="#5b9cff" stroke="#fff" stroke-width="1.5"/>
        </g>
        <text x="${PAD_L}" y="${h - 8}" fill="#9aa4b2" font-size="11">${firstLbl}</text>
        <text x="${PAD_L + INNER_W}" y="${h - 8}" fill="#9aa4b2" font-size="11" text-anchor="end">${lastLbl}</text>
      </svg>
      <div class="sm-pnl-line-hint">
        <span>${hint}</span>
        <button type="button" class="btn ghost sm-btn-sm" data-pnl-reset>复位视窗</button>
      </div>
    </div>`;
}

function buildMonthCal(y, mo, dayNet, expanded, totalAssets, pnlStart, pnlEnd) {
  const dim = daysInMonth(y, mo);
  let maxAbs = 0;
  for (let d = 1; d <= dim; d++) {
    const key = ymKey(y, mo, d);
    if (!inQuery(key, pnlStart, pnlEnd)) continue;
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
      const ok = inQuery(c.key, pnlStart, pnlEnd);
      const has = dayNet.has(c.key);
      const net = dayNet.get(c.key) ?? 0;
      const bg = ok ? calBg(has ? net : 0, maxAbs) : 'rgba(148,163,184,0.08)';
      const cumEod = ok ? cumAtDate(c.key, expanded) : 0;
      const cumBefore = cumEod - net;
      const yieldDay = fmtIncPct(net, cumBefore, totalAssets);
      const retS = ok ? fmtPct(cumEod, totalAssets, cumEod) : '—';
      const amt = !ok ? '—' : has ? fmtUsdTiny(net) : '$0';
      const pct = !ok ? '—' : [has ? `月 ${yieldDay}` : '', `收 ${retS}`].filter(Boolean).join(' · ');
      return `<div class="sm-cal-cell sm-cal-cell--btn${ok ? '' : ' sm-cal-cell--out'}" style="background:${bg}" role="button" tabindex="0" data-cal-day="${c.key}" title="${c.key}">
        <span class="sm-cal-day">${c.d}</span>
        <span class="sm-cal-amt">${amt}</span>
        <span class="sm-cal-pct">${pct}</span>
      </div>`;
    }).join('');
    rows.push(`<div class="sm-cal-row">${tds}</div>`);
  }
  return `
    <div class="sm-cal-weekdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
    <div class="sm-cal-grid">${rows.join('')}</div>`;
}

function buildYearCal(y, dayNet, expanded, totalAssets, pnlStart, pnlEnd) {
  const monthSums = new Map();
  for (let mo = 1; mo <= 12; mo++) {
    let sm = 0;
    const dim = daysInMonth(y, mo);
    for (let d = 1; d <= dim; d++) {
      const key = ymKey(y, mo, d);
      if (inQuery(key, pnlStart, pnlEnd)) sm += dayNet.get(key) ?? 0;
    }
    monthSums.set(mo, sm);
  }
  let maxAbs = 1;
  for (const v of monthSums.values()) maxAbs = Math.max(maxAbs, Math.abs(v));

  const cells = [];
  for (let mo = 1; mo <= 12; mo++) {
    const sm = monthSums.get(mo) ?? 0;
    const cumBefore = cumAtDate(lastKeyBeforeMonth(y, mo), expanded);
    const cumEom = cumAtDate(ymKey(y, mo, daysInMonth(y, mo)), expanded);
    const monthDelta = cumEom - cumBefore;
    const pctYield = fmtIncPct(monthDelta, cumBefore, totalAssets);
    const retEom = fmtPct(cumEom, totalAssets, cumEom);
    cells.push(`
      <div class="sm-cal-year-cell sm-cal-cell--btn" style="background:${calBg(sm, maxAbs)}" role="button" tabindex="0" data-cal-month="${y}-${mo}">
        <div class="sm-cal-year-mo">${mo}月</div>
        <div class="sm-cal-year-amt">${fmtUsdTiny(sm)}</div>
        <div class="sm-cal-year-pct">年 ${pctYield} · 收 ${retEom}</div>
      </div>`);
  }
  return `<div class="sm-cal-year-grid">${cells.join('')}</div>`;
}

function scheduleRender() {
  if (renderRaf || !lastContainer || !lastGetData) return;
  renderRaf = true;
  requestAnimationFrame(() => {
    renderRaf = false;
    renderPnlVisualization(lastContainer, lastGetData, lastCallbacks);
  });
}

function detachPan() {
  document.removeEventListener('pointermove', onPanMove);
  document.removeEventListener('pointerup', onPanEnd);
  document.removeEventListener('pointercancel', onPanEnd);
}

function onPanMove(ev) {
  if (!panDragging || ev.pointerId !== panPointerId) return;
  const dx = ev.clientX - panLastX;
  panLastX = ev.clientX;
  const svg = lastContainer?.querySelector('.sm-pnl-line-svg');
  if (!(svg instanceof SVGSVGElement) || lastFullLen <= MIN_POINTS) return;
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0) return;
  const plotWpx = rect.width * (INNER_W / VIEW_W);
  viewport = panViewportByDx(viewport, lastFullLen, dx, plotWpx);
  scheduleRender();
}

function onPanEnd(ev) {
  if (!panDragging || ev.pointerId !== panPointerId) return;
  panDragging = false;
  panPointerId = -1;
  detachPan();
}

function clearInteractions() {
  hoverCleanup?.();
  hoverCleanup = null;
  if (panDragging) {
    panDragging = false;
    detachPan();
  }
}

function setupLineInteractions(container) {
  clearInteractions();
  if (!hoverModel?.points.length) return;
  const svg = container.querySelector('.sm-pnl-line-svg');
  const wrap = container.querySelector('.sm-pnl-line-wrap');
  if (!svg || !wrap) return;

  let tip = wrap.querySelector('.sm-pnl-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'sm-pnl-tooltip';
    wrap.appendChild(tip);
  }

  const m = hoverModel;
  const innerW = m.viewW - m.padL - m.padR;
  const hideTip = () => { tip.style.opacity = '0'; tip.style.visibility = 'hidden'; };

  const nearest = (svgX) => {
    const n = m.points.length;
    if (n <= 1) return 0;
    const step = innerW / Math.max(1, n - 1);
    const shift = m.slicePanFraction * step;
    return Math.min(n - 1, Math.max(0, Math.round((svgX - m.padL + shift) / step)));
  };

  const onMove = (ev) => {
    if (panDragging) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((ev.clientX - rect.left) / rect.width) * m.viewW;
    if (relX < m.padL || relX > m.viewW - m.padR) { hideTip(); return; }
    const p = m.points[nearest(relX)];
    if (!p) return;
    const dayNet = m.dayNetByDate.get(p.date);
    tip.innerHTML = `
      <div class="sm-pnl-tooltip-date">${p.date}</div>
      <div>累计净盈亏 <strong>${fmtUsdSigned(p.cumulativeNet)}</strong></div>
      <div class="sm-pnl-tooltip-sub">名义收益率 ${fmtPct(p.cumulativeNet, m.totalAssets, p.cumulativeNet)}</div>
      ${dayNet !== undefined ? `<div class="sm-pnl-tooltip-sub">当日净变动 ${fmtUsdSigned(dayNet)}</div>` : ''}`;
    const wr = wrap.getBoundingClientRect();
    const lx = ev.clientX - wr.left;
    const ly = ev.clientY - wr.top;
    tip.style.left = `${Math.min(Math.max(8, lx - tip.offsetWidth / 2), wrap.clientWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(8, ly - 54)}px`;
    tip.style.opacity = '1';
    tip.style.visibility = 'visible';
  };

  const onWheel = (ev) => {
    if (m.fullSeriesLength <= MIN_POINTS) return;
    ev.preventDefault();
    const wr = wrap.getBoundingClientRect();
    const relX = ((ev.clientX - wr.left) / wr.width) * m.viewW;
    const pivotT = (Math.min(m.viewW - m.padR, Math.max(m.padL, relX)) - m.padL) / innerW;
    viewport = zoomViewport(viewport, m.fullSeriesLength, pivotT, ev.deltaY > 0);
    scheduleRender();
    hideTip();
  };

  const onDown = (ev) => {
    if (ev.button !== 0 || m.fullSeriesLength <= MIN_POINTS) return;
    if (ev.target instanceof Element && ev.target.closest('button')) return;
    ev.preventDefault();
    panDragging = true;
    panLastX = ev.clientX;
    panPointerId = ev.pointerId;
    hideTip();
    wrap.style.cursor = 'grabbing';
    document.addEventListener('pointermove', onPanMove);
    document.addEventListener('pointerup', onPanEnd);
    document.addEventListener('pointercancel', onPanEnd);
  };

  const onDbl = (ev) => {
    ev.preventDefault();
    viewport = clampViewport({ startFloat: 0, span: lastFullLen }, lastFullLen);
    scheduleRender();
  };

  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', hideTip);
  wrap.addEventListener('wheel', onWheel, { passive: false });
  wrap.addEventListener('pointerdown', onDown);
  wrap.addEventListener('dblclick', onDbl);

  hoverCleanup = () => {
    svg.removeEventListener('mousemove', onMove);
    svg.removeEventListener('mouseleave', hideTip);
    wrap.removeEventListener('wheel', onWheel);
    wrap.removeEventListener('pointerdown', onDown);
    wrap.removeEventListener('dblclick', onDbl);
    wrap.style.cursor = '';
  };
}

function bindControls(container, callbacks) {
  container.querySelectorAll('[data-pnl-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      vizMode = btn.dataset.pnlMode;
      scheduleRender();
    });
  });
  container.querySelectorAll('[data-cal-gran]').forEach((btn) => {
    btn.addEventListener('click', () => {
      calGranularity = btn.dataset.calGran;
      scheduleRender();
    });
  });
  container.querySelector('[data-pnl-reset]')?.addEventListener('click', () => {
    viewport = clampViewport({ startFloat: 0, span: lastFullLen }, lastFullLen);
    scheduleRender();
  });
  container.querySelector('[data-cal-prev]')?.addEventListener('click', () => {
    const { y, m } = ymParts();
    const dt = new Date(y, m - 2, 1);
    calYM = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    calYearFocus = `${dt.getFullYear()}`;
    scheduleRender();
  });
  container.querySelector('[data-cal-next]')?.addEventListener('click', () => {
    const { y, m } = ymParts();
    const dt = new Date(y, m, 1);
    calYM = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    calYearFocus = `${dt.getFullYear()}`;
    scheduleRender();
  });
  container.querySelector('[data-cal-reset]')?.addEventListener('click', () => {
    calYM = '';
    calYearFocus = '';
    scheduleRender();
  });
  container.querySelector('#pnl-cal-year')?.addEventListener('change', (e) => {
    const y = +e.target.value;
    const mo = ymParts().m;
    calYM = `${y}-${String(mo).padStart(2, '0')}`;
    calYearFocus = `${y}`;
    scheduleRender();
  });
  container.querySelector('#pnl-cal-month')?.addEventListener('change', (e) => {
    const { y } = ymParts();
    calYM = `${y}-${String(+e.target.value).padStart(2, '0')}`;
    scheduleRender();
  });
  container.querySelector('#pnl-cal-year-only')?.addEventListener('change', (e) => {
    calYearFocus = `${+e.target.value}`;
    scheduleRender();
  });
  container.querySelectorAll('[data-cal-day]').forEach((el) => {
    el.addEventListener('click', () => callbacks?.onCalendarDay?.(el.dataset.calDay));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        callbacks?.onCalendarDay?.(el.dataset.calDay);
      }
    });
  });
  container.querySelectorAll('[data-cal-month]').forEach((el) => {
    el.addEventListener('click', () => {
      const [yy, mo] = el.dataset.calMonth.split('-').map(Number);
      callbacks?.onCalendarMonth?.(yy, mo);
    });
  });
}

export function renderPnlVisualization(container, getData, callbacks = {}) {
  lastContainer = container;
  lastGetData = getData;
  lastCallbacks = callbacks;

  const data = getData();
  const { chartSeries = [], chartSparse = [], chartExpandedFull = [], totalAssets = 0, pnlStart = '', pnlEnd = '' } = data;
  if (!chartSparse.length) {
    clearInteractions();
    container.innerHTML = '<div class="sm-pnl-empty">暂无盈亏数据</div>';
    return;
  }

  const dayNet = new Map(chartSparse.map((p) => [p.date, p.dayNet]));
  const lastCum = chartSparse[chartSparse.length - 1]?.cumulativeNet ?? 0;
  const rangeSlice = chartSeries;
  const isLine = vizMode === 'line';
  const { y: dispY, m: dispM } = ymParts();
  const yEff = effectiveYear();
  const bounds = yearBounds(chartSparse);
  let minYo = Math.min(bounds.minY, dispY, yEff);
  let maxYo = Math.max(bounds.maxY, dispY, yEff);

  let lineHtml = '';
  hoverModel = null;
  if (isLine) {
    if (!rangeSlice.length) {
      lineHtml = '<div class="sm-pnl-empty">当前查询时间段与有数据的日期无交集，请调整起止日期或重置。</div>';
    } else {
      const nFull = rangeSlice.length;
      const fp = rangeFingerprint(rangeSlice);
      if (fp !== viewFingerprint) {
        viewFingerprint = fp;
        viewport = clampViewport({ startFloat: 0, span: nFull }, nFull);
      }
      lastFullLen = nFull;
      viewport = clampViewport(viewport, nFull);
      const i0 = Math.floor(viewport.startFloat);
      const panF = viewport.startFloat - i0;
      const viewPoints = rangeSlice.slice(i0, i0 + viewport.span);
      if (!viewPoints.length) {
        lineHtml = '<div class="sm-pnl-empty">视窗为空，请点击「复位视窗」。</div>';
      } else {
        const hint = `视窗 ${viewPoints[0].date}～${viewPoints[viewPoints.length - 1].date}（${viewPoints.length}/${nFull} 日）· 滚轮缩放 · 拖拽平移 · 双击复位`;
        lineHtml = buildLineSvg(viewPoints, hint, panF, totalAssets);
        hoverModel = {
          points: viewPoints,
          fullSeriesLength: nFull,
          slicePanFraction: panF,
          dayNetByDate: dayNet,
          totalAssets,
          viewW: VIEW_W,
          padL: PAD_L,
          padR: PAD_R
        };
      }
    }
  }

  const cumEnd = rangeSlice.length ? rangeSlice[rangeSlice.length - 1].cumulativeNet : null;
  const cumBadge = cumEnd == null ? '—' : `<strong class="${cumEnd >= 0 ? 'pos' : 'neg'}">${fmtUsdSigned(cumEnd)}</strong>`;

  let yearOpts = '';
  for (let oy = minYo; oy <= maxYo; oy++) {
    yearOpts += `<option value="${oy}" ${oy === dispY ? 'selected' : ''}>${oy} 年</option>`;
  }
  let monthOpts = '';
  for (let mo = 1; mo <= 12; mo++) {
    monthOpts += `<option value="${mo}" ${mo === dispM ? 'selected' : ''}>${mo} 月</option>`;
  }
  let yearOnlyOpts = '';
  for (let oy = minYo; oy <= maxYo; oy++) {
    yearOnlyOpts += `<option value="${oy}" ${oy === yEff ? 'selected' : ''}>${oy} 年</option>`;
  }

  let calHtml = '';
  if (!isLine) {
    if (calGranularity === 'month') {
      calHtml = `
        <div class="sm-cal-toolbar">
          <button type="button" class="btn ghost sm-btn-sm" data-cal-prev>上月</button>
          <button type="button" class="btn ghost sm-btn-sm" data-cal-next>下月</button>
          <label>年 <select id="pnl-cal-year">${yearOpts}</select></label>
          <label>月 <select id="pnl-cal-month">${monthOpts}</select></label>
          <button type="button" class="btn ghost sm-btn-sm" data-cal-reset>回到当月</button>
        </div>
        ${buildMonthCal(dispY, dispM, dayNet, chartExpandedFull, totalAssets, pnlStart, pnlEnd)}`;
    } else {
      calHtml = `
        <div class="sm-cal-toolbar">
          <label>年 <select id="pnl-cal-year-only">${yearOnlyOpts}</select></label>
        </div>
        ${buildYearCal(yEff, dayNet, chartExpandedFull, totalAssets, pnlStart, pnlEnd)}`;
    }
  }

  container.innerHTML = `
    <div class="sm-pnl-viz">
      <div class="sm-pnl-viz-head">
        <div class="sm-pnl-viz-tabs">
          <span class="sm-pnl-viz-label">累计盈亏</span>
          <div class="sm-seg">
            <button type="button" class="sm-seg-btn ${isLine ? 'active' : ''}" data-pnl-mode="line">折线</button>
            <button type="button" class="sm-seg-btn ${!isLine ? 'active' : ''}" data-pnl-mode="calendar">日历</button>
          </div>
        </div>
        <span class="sm-muted sm-pnl-cum-badge">${pnlStart || pnlEnd ? '查询区间期末' : '当前'}累计 ${cumBadge} · 全历史 ${fmtUsdSigned(lastCum)}</span>
      </div>
      ${isLine ? lineHtml : `
        <div class="sm-cal-block">
          <div class="sm-cal-gran">
            <span class="sm-muted">粒度</span>
            <div class="sm-seg">
              <button type="button" class="sm-seg-btn ${calGranularity === 'month' ? 'active' : ''}" data-cal-gran="month">按月</button>
              <button type="button" class="sm-seg-btn ${calGranularity === 'year' ? 'active' : ''}" data-cal-gran="year">按年</button>
            </div>
          </div>
          ${calHtml}
        </div>`}
    </div>`;

  bindControls(container, callbacks);
  if (isLine) setupLineInteractions(container);
}
