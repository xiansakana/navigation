const W = 1000;
const H = 220;
const PAD_L = 76;
const PAD_R = 54;
const PAD_T = 14;
const PAD_B = 48;

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

function fmtPct(n, totalAssets, cumulativeNet) {
  const base = totalAssets - cumulativeNet;
  if (!Number.isFinite(base) || base === 0) return '—';
  return ((cumulativeNet / base) * 100).toFixed(2) + '%';
}

export function buildLineChartSvg(points, totalAssets) {
  if (!points.length) {
    return '<div class="sm-chart-empty">暂无盈亏数据</div>';
  }
  const vals = points.map((p) => p.cumulativeNet);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const span = maxV - minV || 1;
  const n = points.length;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const xs = points.map((_, i) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW));
  const ys = points.map((p) => PAD_T + innerH - ((p.cumulativeNet - minV) / span) * innerH);
  const line = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const gid = 'smGrad' + Date.now();

  let zeroLine = '';
  if (minV < 0 && maxV > 0) {
    const zy = PAD_T + innerH - ((0 - minV) / span) * innerH;
    zeroLine = `<line x1="${PAD_L}" y1="${zy.toFixed(1)}" x2="${PAD_L + innerW}" y2="${zy.toFixed(1)}" stroke="#334155" stroke-dasharray="4 4"/>`;
  }

  const area = `${xs[0].toFixed(1)},${(PAD_T + innerH).toFixed(1)} ${line} ${xs[n - 1].toFixed(1)},${(PAD_T + innerH).toFixed(1)}`;
  const firstLbl = points[0].date.slice(5).replace('-', '/');
  const lastLbl = points[n - 1].date.slice(5).replace('-', '/');

  return `
    <div class="sm-chart-wrap" id="pnl-chart-wrap">
      <div class="sm-chart-badge">累计净盈亏 ${fmt(last.cumulativeNet)}</div>
      <svg class="sm-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#5b9cff" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#5b9cff" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <text x="${PAD_L - 4}" y="${PAD_T + 12}" text-anchor="end" fill="#9aa4b2" font-size="12">$${fmt(maxV)}</text>
        <text x="${PAD_L - 4}" y="${PAD_T + innerH + 2}" text-anchor="end" fill="#9aa4b2" font-size="12">$${fmt(minV)}</text>
        <text x="${W - 4}" y="${PAD_T + 12}" text-anchor="end" fill="#64748b" font-size="11">${fmtPct(maxV, totalAssets, maxV)}</text>
        <text x="${W - 4}" y="${PAD_T + innerH + 2}" text-anchor="end" fill="#64748b" font-size="11">${fmtPct(minV, totalAssets, minV)}</text>
        ${zeroLine}
        <polygon points="${area}" fill="url(#${gid})"/>
        <polyline points="${line}" fill="none" stroke="#5b9cff" stroke-width="2.25" stroke-linejoin="round"/>
        <circle cx="${xs[n - 1].toFixed(1)}" cy="${ys[n - 1].toFixed(1)}" r="4.5" fill="#5b9cff" stroke="#fff" stroke-width="1.5"/>
        <text x="${PAD_L}" y="${H - 8}" fill="#9aa4b2" font-size="11">${firstLbl}</text>
        <text x="${PAD_L + innerW}" y="${H - 8}" fill="#9aa4b2" font-size="11" text-anchor="end">${lastLbl}</text>
      </svg>
    </div>`;
}
