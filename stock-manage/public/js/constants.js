export const HOLDINGS_COLUMNS = [
  { key: 'type', label: '类型' },
  { key: 'symbol', label: '代码' },
  { key: 'shares', label: '股数' },
  { key: 'cost', label: '成本' },
  { key: 'price', label: '现价' },
  { key: 'pnl', label: '盈亏' },
  { key: 'pnlPct', label: '盈亏比例' },
  { key: 'dailyPnl', label: '当日盈亏' },
  { key: 'dailyPnlPct', label: '当日盈亏比例' },
  { key: 'position', label: '持仓' },
  { key: 'weight', label: '仓位 / 占比' },
  { key: 'target', label: '1y目标价' },
  { key: 'optinfo', label: '期权信息' },
  { key: 'signal', label: '打分' },
  { key: 'actions', label: '操作' }
];

export const LS_COL_VIS = 'smHoldingsColumnVisibility';
export const LS_DASHBOARD = 'smDashboardSummaryVisible';
export const LS_FULL_WIDTH = 'smFullWidthLayout';
export const LS_TABLE_SORT = 'smHoldingsTableSort';

export function defaultTableSort() {
  return { key: 'weight', dir: -1 };
}

export function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

export function defaultColVis() {
  const o = {};
  for (const c of HOLDINGS_COLUMNS) o[c.key] = true;
  return o;
}
