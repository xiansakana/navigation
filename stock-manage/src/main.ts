// 类型定义
import { apiUrl } from './api';
import {
  buildDailyCumulativeNetPnlSeries,
  computeProfitLoss,
  computeSymbolTradePnlSummaries,
  deriveHoldingsFromTrades,
  expandCumulativeDailyToAllDays
} from './localTrades';
import {
  parseAppTradeBackupXlsxArrayBuffer,
  parseBbaeXlsxArrayBuffer,
  parseImportedTradeDatetime,
  parseMoomooXlsxArrayBuffer,
  parseTradeImportLegacyCsv,
  TRADE_RECORD_EXPORT_SHEET_NAME
} from './tradeImport';

type TradeSignal = 'buy' | 'hold' | 'sell';

/** 单笔买入（股数 / 合约张数 + 单价成本），列表展示为加权平均成本 */
interface CostLot {
  shares: number;
  /** 正股：每股成本；期权：每份合约成本 */
  costPerShare: number;
}

interface Stock {
  symbol: string;
  name: string;
  shares: number;
  /** 未填写表示无目标价，展示与导出可为空 */
  targetPrice?: number;
  /** 加权平均成本（由 costLots 汇总或与单笔 legacy 一致）；正股每股 / 期权每份 */
  avgCost?: number;
  /** 多次买入明细；存在时 shares、avgCost 由同步函数维护 */
  costLots?: CostLot[];
  /** 买入 / 持有 / 卖出 */
  signal?: TradeSignal;
  currentPrice: number;
  position: number;
  weight: number;
  type?: 'stock' | 'option'; // 股票或期权
  optionStrike?: number;      // 期权执行价
  optionExpiry?: string;       // 期权到期日
  optionType?: 'C' | 'P';      // 期权类型 C=看涨 P=看跌
  /** Symbol Search 返回的 type，如 ETP、Common Stock（表格「类型」列） */
  instrumentType?: string;
  /** 手动拖到某一品类后，归入该主标的代码；不设则按 Finnhub/代码自动分组 */
  groupWith?: string;
  /** 行情接口给出的当日每股涨跌额（股票为相对昨收的 d；数据源口径见表格提示）；未刷新或无效则无 */
  quoteChangePerShare?: number;
  /** 行情接口给出的当日涨跌幅 %（数据源口径）；未刷新或无效则无 */
  quoteChangePercent?: number;
}

// 导出数据结构（含交易快照便于完整恢复）
interface ExportData {
  version: string;
  exportDate: string;
  cash: number;
  stocks: Stock[];
  trades?: TradeRecord[];
}

// 股票数据接口 (来自后端 API)
interface StockData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

interface AppState {
  stocks: Stock[];
  totalValue: number;
  /** 正股持仓市值 */
  stockMarketValue: number;
  /** 期权持仓市值 */
  optionMarketValue: number;
  /** 已填成本行盈亏合计；无任一行填成本时为 null */
  totalPnl: number | null;
  cash: number;
  loading: boolean;
  error: string;
  /** 交易历史记录 */
  trades: TradeRecord[];
  /** 当前用户盈亏统计 */
  pnlStats: PnlStats | null;
  /** 盈亏统计时间范围 */
  pnlStartDate: string;
  pnlEndDate: string;
}

// 交易记录类型
interface TradeRecord {
  id: string;
  symbol: string;
  name: string;
  type: 'buy' | 'sell' | 'other';
  /** 仅 other：用户填写的类别名 */
  other_category?: string;
  shares: number;
  price: number;
  total_amount: number;
  commission: number;
  trade_date: string;
  created_at: string;
}

// 盈亏统计类型
interface PnlStats {
  totalBuyAmount: number;
  totalSellAmount: number;
  realizedPL: number;
  commission: number;
  otherAmount: number;
  netPL: number;
}

// 应用状态
const state: AppState = {
  stocks: [],
  totalValue: 0,
  stockMarketValue: 0,
  optionMarketValue: 0,
  totalPnl: null,
  cash: 0,
  loading: false,
  error: '',
  trades: [],
  pnlStats: null,
  pnlStartDate: '',
  pnlEndDate: ''
};

/** 交易面板状态 */
let tradePanelOpen = false;
let tradeFormSymbol = '';
let tradeFormName = '';
/** 交易表单：true 时代码可编辑（新增交易） */
let tradeFormFreeEntry = false;
let tradeFormType: 'buy' | 'sell' = 'buy';
let tradeHistoryModalOpen = false;
let tradeHistoryFilter = {
  symbol: '',
  type: '' as '' | 'buy' | 'sell' | 'other',
  /** 仅匹配 `其它` 类记录的 `other_category`（子串、不区分大小写）；空则不筛 */
  otherCategory: '',
  startDate: '',
  endDate: ''
};
let tradeHistoryPage = 1;
/** 交易记录弹窗每页条数（可选 10 / 20 / 50 / 100） */
let tradeHistoryPageSize = 10;
const TRADE_HISTORY_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
/** 交易记录弹窗：明细列表 / 标的盈亏汇总 */
let tradeHistoryModalTab: 'list' | 'summary' = 'list';
/** 盈亏汇总表格排序 */
type TradeHistorySymbolPnlSortKey = 'symbol' | 'totalBuy' | 'totalSell' | 'netPnl' | 'netPnlRate';
let tradeHistorySymbolPnlSortKey: TradeHistorySymbolPnlSortKey = 'symbol';
/** 1 升序，-1 降序（代码 A→Z / 金额小→大 为升序） */
let tradeHistorySymbolPnlSortDir: 1 | -1 = 1;

/** 盈亏累计可视化：折线 / 收益日历 */
let pnlVizMode: 'line' | 'calendar' = 'line';
/** 日历当前月 YYYY-MM；空表示跟随浏览器「本月」用于 effective 计算 */
let pnlCalendarYM = '';
/** 年视图所选公历年 YYYY；空则与月视图年份或本年一致 */
let pnlCalendarYearFocus = '';
/** 日历粒度：月格 / 年内各月汇总 */
let pnlCalendarGranularity: 'month' | 'year' = 'month';

const PNL_LINE_CHART_MIN_POINTS = 8;

let pnlLineChartGradientSeq = 0;

/** 视窗：左边缘为浮点日索引（可亚日滑动），span 为截取天数 */
interface PnlLineChartViewport {
  startFloat: number;
  span: number;
}

interface PnlLineChartHoverModel {
  points: ReadonlyArray<{ date: string; cumulativeNet: number }>;
  /** 查询裁剪后的整条序列长度，用于滚轮缩放/拖拽平移 */
  fullSeriesLength: number;
  /** 与视窗 startFloat 的小数部分一致，用于折线横移与悬停反算 */
  slicePanFraction: number;
  dayNetByDate: ReadonlyMap<string, number>;
  /** 看板总资产（持仓市值+现金），用于名义收益率 tooltip */
  totalAssets: number;
  viewW: number;
  viewH: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
}

let pnlLineChartHoverModel: PnlLineChartHoverModel | null = null;
let pnlLineChartHoverCleanup: (() => void) | null = null;

/** 编辑交易弹窗状态 */
let editTradeModalOpen = false;
let editingTrade: TradeRecord | null = null;

/** 导入交易弹窗状态 */
let importTradeModalOpen = false;
let importPreviewData: TradeRecord[] = [];
let importError: string | null = null;

/** 新增「其它收支」弹窗（利息、分红等） */
let otherTradeModalOpen = false;

/** 表格标的分组排序：代码=标的字母序，仓位=品类占组合%（dir：1 升序，-1 降序） */
type TableSortKey = 'symbol' | 'weight';
let tableSortKey: TableSortKey = 'weight';
let tableSortDir: 1 | -1 = -1;

/** 持仓表列（用于显示/隐藏） */
type HoldingsColumnKey =
  | 'type'
  | 'symbol'
  | 'shares'
  | 'cost'
  | 'price'
  | 'pnl'
  | 'pnlPct'
  | 'dailyPnl'
  | 'dailyPnlPct'
  | 'position'
  | 'weight'
  | 'target'
  | 'optinfo'
  | 'signal'
  | 'actions';

const HOLDINGS_COLUMN_META: ReadonlyArray<{ key: HoldingsColumnKey; label: string }> = [
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

const HOLDINGS_COL_SUFFIX: Record<HoldingsColumnKey, string> = {
  type: 'type',
  symbol: 'symbol',
  shares: 'shares',
  cost: 'cost',
  price: 'price',
  pnl: 'pnl',
  pnlPct: 'pnl-pct',
  dailyPnl: 'daily-pnl',
  dailyPnlPct: 'daily-pnl-pct',
  position: 'pos',
  weight: 'weight',
  target: 'target',
  optinfo: 'optinfo',
  signal: 'signal',
  actions: 'actions'
};

function holdingsCellClass(key: HoldingsColumnKey): string {
  return `col-h-${HOLDINGS_COL_SUFFIX[key]}`;
}

/** 安全计算金额，避免浮点数精度问题（如 0.1 * 0.2 = 0.30000000000000004） */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function loadColumnVisibility(): Record<HoldingsColumnKey, boolean> {
  const defaults = (): Record<HoldingsColumnKey, boolean> => {
    const o = {} as Record<HoldingsColumnKey, boolean>;
    for (const { key } of HOLDINGS_COLUMN_META) o[key] = true;
    return o;
  };
  return defaults();
}

let columnVisibility: Record<HoldingsColumnKey, boolean> = loadColumnVisibility();

function persistColumnVisibility(): void {
  saveToStorage();
}

/** 勾选关闭时仅遮盖单元格数据，列与表头仍保留 */
const HOLDINGS_DATA_MASK_HTML = '<span class="col-data-masked">—</span>';

function maskOr(key: HoldingsColumnKey, visibleHtml: string): string {
  return columnVisibility[key] ? visibleHtml : HOLDINGS_DATA_MASK_HTML;
}

function setHoldingsColumnVisible(key: string, visible: boolean): void {
  const k = key as HoldingsColumnKey;
  if (!HOLDINGS_COLUMN_META.some(m => m.key === k)) return;
  columnVisibility[k] = visible;
  persistColumnVisibility();
  render();
}

const LS_DASHBOARD_SUMMARY_VISIBLE = 'portfolioDashboardSummaryVisible'; // legacy key, settings now on server

function loadDashboardSummaryVisible(): boolean {
  return true;
}

let dashboardSummaryVisible: boolean = loadDashboardSummaryVisible();

function persistDashboardSummaryVisible(): void {
  saveToStorage();
}

function setDashboardSummaryVisible(visible: boolean): void {
  dashboardSummaryVisible = visible;
  persistDashboardSummaryVisible();
  render();
}

function renderHoldingsColumnTogglePanel(): string {
  const boxes = HOLDINGS_COLUMN_META.map(
    ({ key, label }) => `
    <label class="holdings-col-toggle-label">
      <input type="checkbox" ${columnVisibility[key] ? 'checked' : ''}
             onchange="setHoldingsColumnVisible('${key}', this.checked)" />
      <span>${escapeHtml(label)}</span>
    </label>`
  ).join('');
  return `
    <div class="holdings-column-panel">
      <div class="holdings-column-panel-title">列数据（勾选显示该列数据）</div>
      <div class="holdings-column-panel-body">${boxes}</div>
    </div>`;
}

// Alpha Vantage API
const ALPHA_VANTAGE_API = 'https://www.alphavantage.co/query';
const ALPHA_VANTAGE_API_KEY = 'DU6YOC69XS1OR37G';

/** 无单独名称库时仅展示代码（名称以持仓/接口中的字段为准） */
function getStockDisplayName(ticker: string): string {
  return ticker.trim().toUpperCase();
}

const FINNHUB_EQ_LS_KEY = 'portfolioFinnhubUnderlyingEq';

/** 浏览器本地持仓（JSON） */
const LS_PORTFOLIO_KEY = 'stockPortfolio';

/** 浏览器本地交易记录（JSON 数组） */
const LS_TRADES_KEY = 'stockTrades';

/** Finnhub /symbol/canonical-underlying 推断结果缓存（含「映射为自身」以避免重复请求） */
function loadFinnhubUnderlyingEqCache(): Record<string, string> {
  return {};
}

let finnhubUnderlyingEquivalent: Record<string, string> = loadFinnhubUnderlyingEqCache();

function persistFinnhubUnderlyingEqCache(): void {
  saveToStorage();
}

/** 收集持仓中出现的原始标的代码（正股一条、期权解析出的标的一条） */
function collectRawTickersForGrouping(): string[] {
  const set = new Set<string>();
  for (const s of state.stocks) {
    const sym = s.symbol.trim().toUpperCase();
    if (s.type === 'option' || isOptionSymbol(sym)) {
      const full = sym.match(/^([A-Z]+)\d{6}[CP]\d+(?:\.\d+)?$/i);
      if (full) set.add(full[1]);
    } else {
      set.add(sym);
    }
  }
  return [...set];
}

/** 请求后端用 Finnhub ETF 持仓推断主标的，并写入缓存（慢路径，带节流） */
async function refreshFinnhubCanonicalEquivalents(): Promise<void> {
  const tickers = collectRawTickersForGrouping();
  let changed = false;
  for (const t of tickers) {
    if (finnhubUnderlyingEquivalent[t] !== undefined) continue;

    try {
      const r = await fetch(apiUrl(`api/symbol/canonical-underlying/${encodeURIComponent(t)}`));
      if (!r.ok) continue;
      const data = (await r.json()) as { canonical?: string };
      const can = (data.canonical ?? t).toUpperCase();
      const prev = finnhubUnderlyingEquivalent[t];
      finnhubUnderlyingEquivalent[t] = can;
      if (prev !== can) changed = true;
    } catch {
      /* ignore */
    }
    await new Promise<void>(resolve => setTimeout(resolve, 320));
  }
  if (changed) {
    persistFinnhubUnderlyingEqCache();
    calculateTotals();
    render();
  }
}

/** Finnhub ETF 推断链（仅自动分组，不含手动拖拽） */
function resolveCanonicalUnderlying(ticker: string): string {
  let u = ticker.trim().toUpperCase();
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    if (seen.has(u)) break;
    seen.add(u);
    const inferred = finnhubUnderlyingEquivalent[u];
    if (!inferred || inferred === u) break;
    u = inferred;
  }
  return u;
}

/** 与后端 parseOptionSymbol 一致：标的 + YYMMDD + C/P + 行权价 */
function isOptionSymbol(symbol: string): boolean {
  return /^[A-Z]+\d{6}[CP]\d+(?:\.\d+)?$/i.test(symbol.trim());
}

/** 从标准期权码解析展示字段（与表格期权列一致） */
function parseOptionFieldsFromSymbol(symbol: string): Pick<Stock, 'optionStrike' | 'optionExpiry' | 'optionType'> | undefined {
  const sym = symbol.trim().toUpperCase();
  const m = sym.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?)$/);
  if (!m) return undefined;
  const [, , yy, mm, dd, cp, strikeStr] = m;
  return {
    optionStrike: parseFloat(strikeStr),
    optionExpiry: `20${yy}-${mm}-${dd}`,
    optionType: cp.toUpperCase() === 'P' ? 'P' : 'C'
  };
}

/** 从本地持仓快照生成首笔买入（仅当尚无交易记录时执行一次） */
function migratePortfolioStocksToTradesIfNeeded(): void {
  if (state.trades.length > 0) return;
  if (state.stocks.length === 0) return;
  const toAdd: TradeRecord[] = [];
  for (const s of state.stocks) {
    if (s.shares <= 0) continue;
    const price =
      s.avgCost !== undefined && Number.isFinite(Number(s.avgCost)) && Number(s.avgCost) > 0
        ? Number(s.avgCost)
        : s.currentPrice > 0
          ? s.currentPrice
          : 0;
    if (price <= 0) continue;
    const shares = s.shares;
    const optMult = isOptionSymbol(s.symbol) ? 100 : 1;
    toAdd.push({
      id: crypto.randomUUID(),
      symbol: s.symbol,
      name: s.name || s.symbol,
      type: 'buy',
      shares,
      price,
      total_amount: roundMoney(shares * price * optMult),
      commission: 0,
      trade_date: new Date().toISOString(),
      created_at: new Date().toISOString()
    });
  }
  if (toAdd.length === 0) return;
  state.trades.push(...toAdd);
  sortTradesByDateDesc(state.trades);
  saveToStorage();
}

/** 用交易记录 FIFO 汇总持仓；无交易时清空持仓表 */
function syncStocksFromTrades(): void {
  if (state.trades.length === 0) {
    calculateTotals();
    return;
  }
  const prevBySym = new Map(state.stocks.map((s) => [s.symbol, s]));
  const derived = deriveHoldingsFromTrades(state.trades);
  state.stocks = derived.map((d) => {
    const prev = prevBySym.get(d.symbol);
    const isOpt = isOptionSymbol(d.symbol);
    const optFields = isOpt ? parseOptionFieldsFromSymbol(d.symbol) : undefined;
    return {
      symbol: d.symbol,
      name: d.name,
      shares: d.shares,
      avgCost: d.avgCost,
      costLots: d.costLots.map((lot) => ({ shares: lot.shares, costPerShare: lot.costPerShare })),
      currentPrice: prev?.currentPrice ?? 0,
      position: 0,
      weight: 0,
      signal: prev?.signal ?? 'hold',
      targetPrice: prev?.targetPrice,
      groupWith: prev?.groupWith,
      type: isOpt ? 'option' : 'stock',
      instrumentType: prev?.instrumentType,
      optionStrike: prev?.optionStrike ?? optFields?.optionStrike,
      optionExpiry: prev?.optionExpiry ?? optFields?.optionExpiry,
      optionType: prev?.optionType ?? optFields?.optionType,
      quoteChangePerShare: prev?.quoteChangePerShare,
      quoteChangePercent: prev?.quoteChangePercent
    };
  });
  calculateTotals();
}

/** 从合约/代码得到原始标的 ticker（未合并） */
function extractRawTickerForStock(stock: Stock): string {
  const sym = stock.symbol.trim().toUpperCase();
  if (stock.type === 'option' || isOptionSymbol(sym)) {
    const full = sym.match(/^([A-Z]+)\d{6}[CP]\d+(?:\.\d+)?$/i);
    if (full) return full[1];
    const prefix = sym.match(/^([A-Z]+)/);
    return prefix ? prefix[1] : sym;
  }
  return sym;
}

/** 自动推断的品类主代码（Finnhub + 原始代码） */
function autoGroupKeyForStock(stock: Stock): string {
  return resolveCanonicalUnderlying(extractRawTickerForStock(stock));
}

/** 实际用于表格分组的标的：手动 groupWith 优先 */
function getEffectiveGroupKey(stock: Stock): string {
  const g = stock.groupWith?.trim();
  if (g) return g.toUpperCase();
  return autoGroupKeyForStock(stock);
}

/** 品类分组用（与 getEffectiveGroupKey 一致） */
function getUnderlyingForStock(stock: Stock): string {
  return getEffectiveGroupKey(stock);
}

let dragSourceSymbol: string | null = null;

function mergeStockIntoGroup(draggedSymbol: string, anchorGroupKey: string): void {
  const key = anchorGroupKey.trim().toUpperCase();
  if (!key) return;
  if (draggedSymbol.toUpperCase() === key) return;
  const s = state.stocks.find(x => x.symbol === draggedSymbol);
  if (!s) return;
  s.groupWith = key;
  calculateTotals();
  saveToStorage();
  render();
}

function clearGroupOverride(symbol: string): void {
  const s = state.stocks.find(x => x.symbol === symbol);
  if (!s) return;
  s.groupWith = undefined;
  calculateTotals();
  saveToStorage();
  render();
}

function symbolDragStart(e: DragEvent, symbol: string): void {
  dragSourceSymbol = symbol;
  e.dataTransfer?.setData('text/plain', symbol);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function symbolDragOver(e: DragEvent): void {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
}

function symbolDragEnd(): void {
  dragSourceSymbol = null;
}

function symbolDropOnRow(e: DragEvent, targetSymbol: string): void {
  e.preventDefault();
  e.stopPropagation();
  const src = (e.dataTransfer?.getData('text/plain') || dragSourceSymbol || '').trim();
  if (!src || src === targetSymbol) return;
  const target = state.stocks.find(s => s.symbol === targetSymbol);
  if (!target) return;
  mergeStockIntoGroup(src, getEffectiveGroupKey(target));
}

function positionMultiplier(stock: Stock): number {
  return stock.type === 'option' || isOptionSymbol(stock.symbol) ? 100 : 1;
}

/** 盈亏 = (现价 - 成本) × 股数 × 合约乘数；未填成本返回 null */
function computeLinePnL(stock: Stock): number | null {
  const c = stock.avgCost;
  if (c === undefined || c === null || Number.isNaN(Number(c))) return null;
  return (stock.currentPrice - Number(c)) * stock.shares * positionMultiplier(stock);
}

/** 盈亏比例 = (现价 − 成本) ÷ 成本 × 100%；无有效成本返回 null */
function computeLinePnLPercent(stock: Stock): number | null {
  const c = stock.avgCost;
  if (c === undefined || c === null || Number.isNaN(Number(c)) || Number(c) <= 0) return null;
  return ((stock.currentPrice - Number(c)) / Number(c)) * 100;
}

/** 当日持仓盈亏（美元）＝每股当日涨跌 × 股数 × 合约乘数；未拉取当日行情或无有效涨跌时为 null */
function computePositionDailyPnL(stock: Stock): number | null {
  const ch = stock.quoteChangePerShare;
  if (ch === undefined || ch === null || !Number.isFinite(ch)) return null;
  if (!Number.isFinite(stock.shares) || stock.shares <= 0) return null;
  return roundMoney(ch * stock.shares * positionMultiplier(stock));
}

/** 当日涨跌幅（%），取自行情接口；无有效数据时为 null */
function computePositionDailyPnLPct(stock: Stock): number | null {
  const p = stock.quoteChangePercent;
  if (p === undefined || p === null || !Number.isFinite(p)) return null;
  return p;
}

function formatPnLCell(pnl: number | null): string {
  if (pnl === null || Number.isNaN(pnl)) {
    return '<span style="color:#94a3b8;">—</span>';
  }
  const color = pnl >= 0 ? '#059669' : '#dc2626';
  const sign = pnl >= 0 ? '+' : '';
  return `<span style="color:${color}; font-weight:600;">${sign}$${formatNumber(pnl)}</span>`;
}

function formatPnLPercentCell(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) {
    return '<span style="color:#94a3b8;">—</span>';
  }
  const color = pct >= 0 ? '#059669' : '#dc2626';
  const sign = pct >= 0 ? '+' : '';
  return `<span style="color:${color}; font-weight:600;">${sign}${formatNumber(pct, 2)}%</span>`;
}

/** 顶部总盈亏卡片（白字卡片上用浅色区分正负） */
function formatTotalPnlSummaryHtml(pnl: number): string {
  const color = pnl >= 0 ? '#ecfdf5' : '#fecaca';
  const sign = pnl >= 0 ? '+' : '';
  return `<span style="color:${color}; font-weight:700;">${sign}$${formatNumber(pnl)}</span>`;
}

function formatTargetInputValue(tp: number | undefined): string {
  if (tp === undefined || tp === null || Number.isNaN(Number(tp))) return '';
  return formatNumber(Number(tp), 2);
}

function formatCostInputValue(c: number | undefined): string {
  if (c === undefined || c === null || Number.isNaN(Number(c))) return '';
  return formatNumber(Number(c), 2);
}

/** 根据 costLots 写回 shares、avgCost；无有效明细则清空 */
function syncStockCostFromLots(stock: Stock): void {
  const raw = stock.costLots ?? [];
  const lots = raw.filter(l => l.shares > 0 && Number.isFinite(l.costPerShare));
  if (lots.length === 0) {
    stock.costLots = undefined;
    stock.shares = 0;
    stock.avgCost = undefined;
    return;
  }
  let sumShares = 0;
  let sumCost = 0;
  for (const l of lots) {
    sumShares += l.shares;
    sumCost += l.shares * l.costPerShare;
  }
  stock.costLots = lots.map(l => ({
    shares: Math.round(l.shares * 100) / 100,
    costPerShare: Math.round(l.costPerShare * 10000) / 10000
  }));
  stock.shares = Math.round(sumShares * 100) / 100;
  stock.avgCost =
    sumShares > 0 ? Math.round((sumCost / sumShares) * 10000) / 10000 : undefined;
}

function formatCostLotsModalRows(lots: CostLot[]): string {
  return lots
    .map(
      (lot, i) => `
    <tr data-lot-index="${i}">
      <td style="padding: 8px;">
        <input type="number" class="lot-shares-input" value="${lot.shares}" step="0.01" min="0"
               style="width: 110px; padding: 8px; border: 1px solid #e5e7eb; border-radius: 8px;" />
      </td>
      <td style="padding: 8px;">
        <input type="number" class="lot-cost-input" value="${lot.costPerShare}" step="0.0001" min="0"
               style="width: 110px; padding: 8px; border: 1px solid #e5e7eb; border-radius: 8px;" />
      </td>
      <td style="padding: 8px;">
        <button type="button" class="lot-remove-btn btn btn-secondary" style="padding: 6px 10px; font-size: 0.8rem;">删除</button>
      </td>
    </tr>`
    )
    .join('');
}

function openCostLotsEditor(symbol: string): void {
  void symbol;
  renderError('成本由买入交易按 FIFO 自动计算，请编辑对应买入记录。');
}

function removeStock(symbol: string): void {
  void symbol;
  renderError('持仓由交易汇总，请使用「卖出」或调整交易记录。');
}

/** 按标的分组排序：先正股后期权，再按代码 */
function compareStocksForTable(a: Stock, b: Stock): number {
  const ua = getUnderlyingForStock(a);
  const ub = getUnderlyingForStock(b);
  if (ua !== ub) return ua.localeCompare(ub);
  const oa = a.type === 'option' || isOptionSymbol(a.symbol) ? 1 : 0;
  const ob = b.type === 'option' || isOptionSymbol(b.symbol) ? 1 : 0;
  if (oa !== ob) return oa - ob;
  return a.symbol.localeCompare(b.symbol);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// 工具函数：格式化数字
function formatNumber(num: number, decimals: number = 2): string {
  return num.toFixed(decimals);
}

/** `<input type="datetime-local" step="60">` 用的本地时间字符串（精确到分钟） */
function formatDatetimeLocalMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 表单里 `datetime-local` 的常见值 `YYYY-MM-DDTHH:mm`（可选 `:ss`）须按本地墙钟解析；
 * `new Date(该串)` 在 Chromium 等对无 Z ISO 倾向于按 UTC，东八区会差 8 小时。
 */
function parseDatetimeLocalPickerToIso(raw: string): string | null {
  const t = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10);
  const mi = parseInt(m[5], 10);
  const ss = m[6] !== undefined ? parseInt(m[6], 10) : 0;
  const d = new Date(y, mo, day, hh, mi, ss);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 交易表单 / 录入：优先按 datetime-local，否则走导入共用解析（斜杠手写等）。 */
function parseUserEnteredTradeDatetimeToIso(raw: string): string {
  const t = raw.trim();
  if (!t) return new Date().toISOString();
  return parseDatetimeLocalPickerToIso(t) ?? parseImportedTradeDatetime(t);
}

/** CSV 旧版单列「类型」：期权 / 股票 / Finnhub 证券类型 */
function parseLegacyCsvTypeColumn(combined: string): { isOption: boolean; instrumentType?: string } {
  const raw = combined.trim();
  if (raw === '期权') return { isOption: true };
  if (!raw || raw === '股票') return { isOption: false, instrumentType: undefined };
  return { isOption: false, instrumentType: raw };
}

/** CSV 新版「类型」列（与页面类型列一致：期权 或 证券类型 或 股票） */
function instrumentTypeFromDisplayTypeCol(isOption: boolean, typeCol: string): string | undefined {
  if (isOption) return undefined;
  const t = typeCol.trim();
  if (!t || t === '股票') return undefined;
  return t;
}

// 工具函数：格式化百分比
function formatPercent(num: number): string {
  return `${formatNumber(num, 2)}%`;
}

// 工具函数：渲染错误信息
function renderError(message: string): void {
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  
  const existingError = document.querySelector('.error');
  if (existingError) {
    existingError.remove();
  }
  
  const card = document.querySelector('.card');
  if (card) {
    card.appendChild(errorDiv);
    
    setTimeout(() => {
      errorDiv.remove();
    }, 5000);
  }
}

// 工具函数：显示成功消息
function renderSuccess(message: string): void {
  const successDiv = document.createElement('div');
  successDiv.className = 'success';
  successDiv.textContent = message;
  
  const existingSuccess = document.querySelector('.success');
  if (existingSuccess) {
    existingSuccess.remove();
  }
  
  const card = document.querySelector('.card');
  if (card) {
    card.appendChild(successDiv);
    
    setTimeout(() => {
      successDiv.remove();
    }, 3000);
  }
}

// ========== 交易 UI 函数 ==========

// 打开交易表单（从持仓行打开：代码/名称只读）
function openTradeForm(symbol: string, name: string, type: 'buy' | 'sell'): void {
  tradeFormFreeEntry = false;
  tradeFormSymbol = symbol.trim().toUpperCase();
  tradeFormName = name;
  tradeFormType = type;
  tradePanelOpen = true;
  render();
}

/** 新增交易：可编辑代码；若顶部搜索框有内容会预填代码；保存时名称与代码一致 */
function openNewTradeForm(type: 'buy' | 'sell'): void {
  const inp = document.getElementById('symbol') as HTMLInputElement | null;
  const raw = (inp?.value ?? '').trim().toUpperCase();
  tradeFormFreeEntry = true;
  tradeFormSymbol = raw;
  tradeFormName = '';
  tradeFormType = type;
  tradePanelOpen = true;
  render();
}

// 关闭交易表单
function closeTradeForm(): void {
  tradePanelOpen = false;
  tradeFormFreeEntry = false;
  render();
}

// 打开编辑交易弹窗
function openEditTradeModal(trade: TradeRecord): void {
  editingTrade = trade;
  editTradeModalOpen = true;
  render();
}

// 关闭编辑交易弹窗
function closeEditTradeModal(): void {
  editTradeModalOpen = false;
  editingTrade = null;
  render();
}

// 提交编辑交易
function submitEditTrade(): void {
  if (!editingTrade) return;

  const commissionEl = document.getElementById('edit-trade-commission') as HTMLInputElement | null;
  const dateEl = document.getElementById('edit-trade-date') as HTMLInputElement | null;
  const commission = parseFloat(commissionEl?.value || '0');
  const rawDt = (dateEl?.value ?? '').trim();
  let tradeAtIso: string | undefined;
  if (rawDt) {
    const tradeAtIsoCand = parseUserEnteredTradeDatetimeToIso(rawDt);
    const tradeAt = new Date(tradeAtIsoCand);
    if (Number.isNaN(tradeAt.getTime())) {
      renderError('交易时间无效');
      return;
    }
    if (tradeAt.getTime() > Date.now()) {
      renderError('交易时间不能晚于当前时刻');
      return;
    }
    tradeAtIso = tradeAtIsoCand;
  }

  if (editingTrade.type === 'other') {
    const catEl = document.getElementById('edit-other-category') as HTMLInputElement | null;
    const symEl = document.getElementById('edit-other-symbol') as HTMLInputElement | null;
    const nameEl = document.getElementById('edit-other-name') as HTMLInputElement | null;
    const amtEl = document.getElementById('edit-other-amount') as HTMLInputElement | null;
    const cat = (catEl?.value ?? '').trim();
    const amt = parseFloat(amtEl?.value ?? '');
    if (!cat) {
      renderError('请填写类别');
      return;
    }
    if (!Number.isFinite(amt) || amt === 0) {
      renderError('金额须为非零数字（正数为入账，负数为扣款）');
      return;
    }
    if (!Number.isFinite(commission) || commission < 0) {
      renderError('手续费须 ≥ 0');
      return;
    }
    let sym = (symEl?.value ?? '').trim().toUpperCase();
    if (!sym) sym = 'OTHER';

    const success = updateTradeRecord(editingTrade.id, {
      other_category: cat,
      symbol: sym,
      name: (nameEl?.value ?? '').trim(),
      total_amount: amt,
      commission,
      trade_date: tradeAtIso
    });

    if (success) {
      loadPnlStatsOnStartup();
      renderSuccess('记录已更新');
      closeEditTradeModal();
      render();
    } else {
      renderError('更新失败：未找到该笔交易');
    }
    return;
  }

  const sharesEl = document.getElementById('edit-trade-shares') as HTMLInputElement | null;
  const priceEl = document.getElementById('edit-trade-price') as HTMLInputElement | null;
  const shares = parseFloat(sharesEl?.value || '0');
  const price = parseFloat(priceEl?.value || '0');

  if (shares <= 0 || price <= 0) {
    renderError('股数和价格必须大于 0');
    return;
  }

  const success = updateTradeRecord(editingTrade.id, {
    shares,
    price,
    commission,
    trade_date: tradeAtIso
  });

  if (success) {
    loadPnlStatsOnStartup();
    renderSuccess('交易记录已更新');
    closeEditTradeModal();
    render();
  } else {
    renderError('更新失败：未找到该笔交易');
  }
}

// 提交交易
function submitTrade(): void {
  const sharesEl = document.getElementById('trade-shares') as HTMLInputElement | null;
  const priceEl = document.getElementById('trade-price') as HTMLInputElement | null;
  const commissionEl = document.getElementById('trade-commission') as HTMLInputElement | null;
  const dateEl = document.getElementById('trade-date') as HTMLInputElement | null;
  
  const shares = parseFloat(sharesEl?.value || '0');
  const price = parseFloat(priceEl?.value || '0');
  const commission = parseFloat(commissionEl?.value || '0');
  const rawDt = (dateEl?.value ?? '').trim();
  let tradeAt: Date;
  if (!rawDt) {
    tradeAt = new Date();
  } else {
    tradeAt = new Date(parseUserEnteredTradeDatetimeToIso(rawDt));
    if (Number.isNaN(tradeAt.getTime())) {
      renderError('交易时间无效');
      return;
    }
    if (tradeAt.getTime() > Date.now()) {
      renderError('交易时间不能晚于当前时刻');
      return;
    }
  }

  let sym = tradeFormSymbol.trim().toUpperCase();
  let trName: string;
  if (tradeFormFreeEntry) {
    const symIn = document.getElementById('trade-symbol-input') as HTMLInputElement | null;
    sym = (symIn?.value ?? '').trim().toUpperCase();
    trName = '';
  } else {
    trName = tradeFormName.trim();
  }

  if (!sym) {
    renderError('请填写标的代码');
    return;
  }
  if (!trName) trName = sym;
  
  if (shares <= 0 || price <= 0) {
    renderError('股数和价格必须大于 0');
    return;
  }
  
  const success = addTradeRecord({
    symbol: sym,
    name: trName,
    type: tradeFormType,
    shares,
    price,
    commission,
    trade_date: tradeAt.toISOString()
  });
  
  if (success) {
    loadPnlStatsOnStartup();
    renderSuccess(`${tradeFormType === 'buy' ? '买入' : '卖出'}成功：${shares} 股 ${sym} @ $${price}`);
    closeTradeForm();
    render();
  }
}

// 切换交易类型
function setTradeType(type: 'buy' | 'sell'): void {
  tradeFormType = type;
  render();
}

// 删除交易记录
function handleDeleteTrade(tradeId: string, symbol: string): void {
  if (!confirm(`确定删除这笔 ${symbol} 的交易记录吗？`)) return;
  
  if (deleteTradeRecord(tradeId)) {
    loadPnlStatsOnStartup();
    renderSuccess('交易记录已删除');
    render();
  }
}

// 刷新单个股票/期权价格
async function refreshSingleStock(symbol: string): Promise<void> {
  const stock = state.stocks.find(s => s.symbol === symbol);
  if (!stock) return;

  // 找到刷新按钮并显示加载状态（按钮紧跟在 price span 之后）
  const priceSpan = document.getElementById(`price-${symbol}`);
  const btn = priceSpan?.nextElementSibling as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = '⏳';
    btn.disabled = true;
  }

  try {
    let price = 0;
    let change = 0;

    let changePct: number | undefined;
    if (stock.type === 'option' || isOptionSymbol(symbol)) {
      // 期权走 /api/option/:symbol（旧数据可能缺少 type）
      const response = await fetch(apiUrl(`api/option/${encodeURIComponent(symbol)}`));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      price = (data.price as number) ?? 0;
      change = (data.change as number) ?? 0;
      changePct =
        typeof data.changePercent === 'number' && Number.isFinite(data.changePercent)
          ? data.changePercent
          : undefined;
    } else {
      const data = await fetchStockDataFromAPI(symbol);
      price = data.price;
      change = data.change;
      changePct =
        typeof data.changePercent === 'number' && Number.isFinite(data.changePercent)
          ? data.changePercent
          : undefined;
    }

    state.stocks = state.stocks.map(s => {
      if (s.symbol === symbol) {
        return {
          ...s,
          currentPrice: price,
          position: s.shares * price * positionMultiplier(s),
          quoteChangePerShare: Number.isFinite(change) ? change : undefined,
          quoteChangePercent: changePct
        };
      }
      return s;
    });

    calculateTotals();
    saveToStorage();
    render();

  } catch (error) {
    console.error(`刷新 ${symbol} 数据失败:`, error);
    renderError(`刷新 ${symbol} 失败`);
    render();
  }
}

// 函数：从后端 API 获取股票数据 (Finnhub)
async function fetchStockDataFromAPI(symbol: string): Promise<StockData> {
  try {
    const response = await fetch(apiUrl(`api/stock/${encodeURIComponent(symbol)}`));
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data: StockData = await response.json();
    return data;
  } catch (error) {
    console.error('获取股票数据失败:', error);
    throw error;
  }
}

// 单条持仓拉取行情（股票走 Finnhub，期权走 Polygon）
async function fetchQuoteForStock(stock: Stock): Promise<StockData> {
  const isOption = stock.type === 'option' || isOptionSymbol(stock.symbol);
  if (isOption) {
    const response = await fetch(apiUrl(`api/option/${encodeURIComponent(stock.symbol)}`));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as StockData;
    return data;
  }
  return fetchStockDataFromAPI(stock.symbol);
}

// 函数：批量获取股票/期权数据
async function fetchBatchStockData(stocks: Stock[]): Promise<StockData[]> {
  const results: StockData[] = [];

  for (const stock of stocks) {
    try {
      const data = await fetchQuoteForStock(stock);
      results.push(data);
      // 添加延迟以遵守 API rate limit
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`获取 ${stock.symbol} 数据失败:`, error);
      results.push({
        symbol: stock.symbol.toUpperCase(),
        name: getStockDisplayName(stock.symbol),
        price: 0,
        change: 0,
        changePercent: 0
      });
    }
  }

  return results;
}

// 函数：计算总计
function calculateTotals(): void {
  let stockMv = 0;
  let optionMv = 0;
  let pnlSum = 0;
  let pnlRowCount = 0;

  for (const stock of state.stocks) {
    const line = stock.shares * stock.currentPrice * positionMultiplier(stock);
    if (stock.type === 'option' || isOptionSymbol(stock.symbol)) {
      optionMv += line;
    } else {
      stockMv += line;
    }
    const pnl = computeLinePnL(stock);
    if (pnl !== null && !Number.isNaN(pnl)) {
      pnlSum += pnl;
      pnlRowCount += 1;
    }
  }

  const stocksValue = stockMv + optionMv;
  const totalAssets = stocksValue + state.cash;
  state.stockMarketValue = stockMv;
  state.optionMarketValue = optionMv;
  state.totalValue = stocksValue;
  state.totalPnl = pnlRowCount > 0 ? pnlSum : null;

  const groupSum = new Map<string, number>();
  for (const stock of state.stocks) {
    const u = getUnderlyingForStock(stock);
    const line = stock.shares * stock.currentPrice * positionMultiplier(stock);
    groupSum.set(u, (groupSum.get(u) ?? 0) + line);
  }

  state.stocks = state.stocks.map(stock => {
    const position = stock.shares * stock.currentPrice * positionMultiplier(stock);
    const u = getUnderlyingForStock(stock);
    const groupPosition = groupSum.get(u) ?? position;
    const weight = totalAssets > 0 ? (groupPosition / totalAssets) * 100 : 0;
    return {
      ...stock,
      position,
      weight
    };
  });
}

function buildPortfolioPayload(): {
  stocks: Array<{
    symbol: string;
    name: string;
    shares: number;
    targetPrice?: number;
    avgCost?: number;
    signal?: TradeSignal;
    groupWith?: string;
    currentPrice: number;
    type?: 'stock' | 'option';
    optionStrike?: number;
    optionExpiry?: string;
    optionType?: 'C' | 'P';
    instrumentType?: string;
    costLots?: CostLot[];
    quoteChangePerShare?: number;
    quoteChangePercent?: number;
  }>;
  cash: number;
} {
  return {
    stocks: state.stocks.map(s => ({
      symbol: s.symbol,
      name: s.name,
      shares: s.shares,
      targetPrice: s.targetPrice,
      avgCost: s.avgCost,
      signal: s.signal,
      groupWith: s.groupWith,
      currentPrice: s.currentPrice,
      type: s.type,
      optionStrike: s.optionStrike,
      optionExpiry: s.optionExpiry,
      optionType: s.optionType,
      instrumentType: s.instrumentType,
      costLots: s.costLots,
      ...(typeof s.quoteChangePerShare === 'number' && Number.isFinite(s.quoteChangePerShare)
        ? { quoteChangePerShare: s.quoteChangePerShare }
        : {}),
      ...(typeof s.quoteChangePercent === 'number' && Number.isFinite(s.quoteChangePercent)
        ? { quoteChangePercent: s.quoteChangePercent }
        : {})
    })),
    cash: state.cash
  };
}

let persistDebounceId: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 400;

function sortTradesByDateDesc(trades: TradeRecord[]): void {
  trades.sort((a, b) => new Date(b.trade_date).getTime() - new Date(a.trade_date).getTime());
}

async function flushPersistToServer(): Promise<void> {
  if (persistDebounceId !== null) {
    clearTimeout(persistDebounceId);
    persistDebounceId = null;
  }
  try {
    const response = await fetch(apiUrl('api/data'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portfolio: buildPortfolioPayload(),
        trades: state.trades,
        settings: {
          columnVisibility,
          dashboardSummaryVisible,
          finnhubUnderlyingEq: finnhubUnderlyingEquivalent,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
  } catch (e) {
    console.error('写入服务端失败:', e);
  }
}

/** 防抖写入服务端（持仓 + 交易记录 + 界面偏好） */
function saveToStorage(): void {
  if (persistDebounceId !== null) clearTimeout(persistDebounceId);
  persistDebounceId = setTimeout(() => {
    persistDebounceId = null;
    void flushPersistToServer();
  }, PERSIST_DEBOUNCE_MS);
}

function parseStoredQuoteFinite(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return n;
}

function applyPortfolioFromParsed(parsed: { stocks: unknown; cash?: unknown }): void {
  if (!Array.isArray(parsed.stocks)) return;
  state.stocks = parsed.stocks.map((s: Record<string, unknown>) => {
    const sym = String(s.symbol ?? '').toUpperCase();
    const inferredOption = isOptionSymbol(sym);
    const qCh = parseStoredQuoteFinite(s.quoteChangePerShare);
    const qPct = parseStoredQuoteFinite(s.quoteChangePercent);
    return {
      ...(s as unknown as Stock),
      symbol: sym,
      type: (s.type as Stock['type']) ?? (inferredOption ? 'option' : 'stock'),
      position: 0,
      weight: 0,
      quoteChangePerShare: qCh,
      quoteChangePercent: qPct
    };
  });
  const c = parsed.cash;
  state.cash = typeof c === 'number' && Number.isFinite(c) ? c : 0;
  calculateTotals();
}

function parseTradesFromArray(arr: unknown[]): TradeRecord[] {
  try {
    if (!Array.isArray(arr)) return [];
    const out: TradeRecord[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const id = String(o.id ?? '');
      const typRaw = String(o.type ?? '').toLowerCase();
      const isOther = typRaw === 'other' || typRaw === '其它';
      if (isOther) {
        let symbol = String(o.symbol ?? '').trim().toUpperCase();
        if (!symbol) symbol = 'OTHER';
        const cat = String(o.other_category ?? o.otherCategory ?? '').trim();
        if (!cat) continue;
        const totalRaw = Number(o.total_amount);
        if (!Number.isFinite(totalRaw) || totalRaw === 0) continue;
        const commissionRaw = Number(o.commission);
        out.push({
          id: id || crypto.randomUUID(),
          symbol,
          name: String(o.name ?? cat),
          type: 'other',
          other_category: cat,
          shares: 1,
          price: 0,
          total_amount: totalRaw,
          commission: Number.isFinite(commissionRaw) && commissionRaw >= 0 ? commissionRaw : 0,
          trade_date: String(o.trade_date ?? new Date().toISOString()),
          created_at: String(o.created_at ?? new Date().toISOString())
        });
        continue;
      }
      const symbol = String(o.symbol ?? '').trim().toUpperCase();
      if (!symbol) continue;
      const shares = Number(o.shares);
      const price = Number(o.price);
      if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0 || price <= 0) continue;
      const totalRaw = Number(o.total_amount);
      const commissionRaw = Number(o.commission);
      const isSell = o.type === 'sell' || o.type === '卖出';
      out.push({
        id: id || crypto.randomUUID(),
        symbol,
        name: String(o.name ?? ''),
        type: isSell ? 'sell' : 'buy',
        shares,
        price,
        total_amount:
          Number.isFinite(totalRaw) && totalRaw > 0
            ? totalRaw
            : roundMoney(shares * price * (isOptionSymbol(symbol) ? 100 : 1)),
        commission: Number.isFinite(commissionRaw) ? commissionRaw : 0,
        trade_date: String(o.trade_date ?? new Date().toISOString()),
        created_at: String(o.created_at ?? new Date().toISOString())
      });
    }
    sortTradesByDateDesc(out);
    return out;
  } catch {
    return [];
  }
}

function applySettingsFromServer(settings: Record<string, unknown> | undefined): void {
  if (!settings || typeof settings !== 'object') return;
  const cols = settings.columnVisibility;
  if (cols && typeof cols === 'object') {
    for (const k of Object.keys(columnVisibility) as HoldingsColumnKey[]) {
      if (typeof (cols as Record<string, unknown>)[k] === 'boolean') {
        columnVisibility[k] = (cols as Record<string, boolean>)[k];
      }
    }
  }
  if (typeof settings.dashboardSummaryVisible === 'boolean') {
    dashboardSummaryVisible = settings.dashboardSummaryVisible;
  }
  const eq = settings.finnhubUnderlyingEq;
  if (eq && typeof eq === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(eq as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string') {
        out[k.trim().toUpperCase()] = v.trim().toUpperCase();
      }
    }
    finnhubUnderlyingEquivalent = out;
  }
}

async function loadPersistedData(): Promise<void> {
  try {
    const response = await fetch(apiUrl('api/data'));
    if (!response.ok) return;
    const data = await response.json() as {
      portfolio?: { stocks?: unknown; cash?: unknown };
      trades?: unknown[];
      settings?: Record<string, unknown>;
    };
    if (data.portfolio) {
      const stocksArr = Array.isArray(data.portfolio.stocks) ? data.portfolio.stocks : [];
      const cashNum = typeof data.portfolio.cash === 'number' && Number.isFinite(data.portfolio.cash)
        ? data.portfolio.cash
        : 0;
      if (stocksArr.length > 0 || cashNum !== 0) {
        applyPortfolioFromParsed({ stocks: stocksArr, cash: cashNum });
      }
    }
    if (Array.isArray(data.trades)) {
      state.trades = parseTradesFromArray(data.trades);
    }
    applySettingsFromServer(data.settings);
  } catch (e) {
    console.error('读取服务端数据失败:', e);
  }
}

function loadPersistedTrades(): void {
  /* 由 loadPersistedData 统一加载 */
}

// ========== 交易记录（服务端持久化） ==========

/** 单笔交易对现金的净变动：买入付出本金+手续费；卖出/其它为毛额−手续费（其它毛额可正可负） */
function cashDeltaForTrade(trade: Pick<TradeRecord, 'type' | 'total_amount' | 'commission'>): number {
  const fee = Math.round((Number(trade.commission) || 0) * 100) / 100;
  const notional = Math.round(trade.total_amount * 100) / 100;
  if (trade.type === 'buy') return roundMoney(-(notional + fee));
  if (trade.type === 'sell') return roundMoney(notional - fee);
  return roundMoney(notional - fee);
}

function addTradeRecord(trade: {
  symbol: string;
  name: string;
  type: 'buy' | 'sell';
  shares: number;
  price: number;
  commission?: number;
  trade_date?: string;
}): boolean {
  const shares = trade.shares;
  const price = trade.price;
  if (shares <= 0 || price <= 0) return false;
  const optMult = isOptionSymbol(trade.symbol) ? 100 : 1;
  const total_amount = roundMoney(shares * price * optMult);
  const row: TradeRecord = {
    id: crypto.randomUUID(),
    symbol: trade.symbol.trim().toUpperCase(),
    name: trade.name,
    type: trade.type,
    shares,
    price,
    total_amount,
    commission: trade.commission ?? 0,
    trade_date: trade.trade_date ?? new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  state.cash += cashDeltaForTrade(row);
  state.trades.push(row);
  sortTradesByDateDesc(state.trades);
  void flushPersistToServer();
  syncStocksFromTrades();
  return true;
}

/** 利息/分红/卡券等：毛额可正可负；净额=毛额−手续费；不参与 FIFO 持仓 */
function addOtherTradeRecord(input: {
  other_category: string;
  symbol?: string;
  name?: string;
  total_amount: number;
  commission?: number;
  trade_date?: string;
}): boolean {
  const cat = input.other_category.trim();
  if (!cat) return false;
  const amt = Number(input.total_amount);
  if (!Number.isFinite(amt) || amt === 0) return false;
  const fee = input.commission ?? 0;
  if (!Number.isFinite(fee) || fee < 0) return false;
  let sym = (input.symbol ?? '').trim().toUpperCase();
  if (!sym) sym = 'OTHER';
  const nm = (input.name ?? '').trim() || cat;
  const row: TradeRecord = {
    id: crypto.randomUUID(),
    symbol: sym,
    name: nm,
    type: 'other',
    other_category: cat,
    shares: 1,
    price: 0,
    total_amount: amt,
    commission: fee,
    trade_date: input.trade_date ?? new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  state.cash += cashDeltaForTrade(row);
  state.trades.push(row);
  sortTradesByDateDesc(state.trades);
  void flushPersistToServer();
  syncStocksFromTrades();
  return true;
}

function deleteTradeRecord(tradeId: string): boolean {
  const removed = state.trades.find((t) => t.id === tradeId);
  if (!removed) return false;
  state.cash -= cashDeltaForTrade(removed);
  state.trades = state.trades.filter((t) => t.id !== tradeId);
  void flushPersistToServer();
  if (state.trades.length === 0) {
    state.stocks = [];
    calculateTotals();
  } else {
    syncStocksFromTrades();
  }
  return true;
}

function updateTradeRecord(
  tradeId: string,
  updates: {
    shares?: number;
    price?: number;
    commission?: number;
    trade_date?: string;
    symbol?: string;
    name?: string;
    other_category?: string;
    total_amount?: number;
  }
): boolean {
  const t = state.trades.find((x) => x.id === tradeId);
  if (!t) return false;
  const oldSnap: Pick<TradeRecord, 'type' | 'total_amount' | 'commission'> = {
    type: t.type,
    total_amount: t.total_amount,
    commission: t.commission
  };

  if (t.type === 'other') {
    if (updates.other_category !== undefined) {
      const c = updates.other_category.trim();
      if (!c) return false;
      t.other_category = c;
    }
    if (updates.symbol !== undefined) {
      let s = updates.symbol.trim().toUpperCase();
      if (!s) s = 'OTHER';
      t.symbol = s;
    }
    if (updates.name !== undefined) t.name = updates.name.trim();
    if (updates.total_amount !== undefined) {
      if (!Number.isFinite(updates.total_amount) || updates.total_amount === 0) return false;
      t.total_amount = updates.total_amount;
    }
    if (updates.commission !== undefined) {
      if (updates.commission < 0) return false;
      t.commission = updates.commission;
    }
    if (updates.trade_date !== undefined) t.trade_date = updates.trade_date;
    state.cash += cashDeltaForTrade(t) - cashDeltaForTrade(oldSnap);
    sortTradesByDateDesc(state.trades);
    void flushPersistToServer();
    syncStocksFromTrades();
    return true;
  }

  if (updates.shares !== undefined) {
    if (updates.shares <= 0) return false;
    t.shares = updates.shares;
  }
  if (updates.price !== undefined) {
    if (updates.price <= 0) return false;
    t.price = updates.price;
  }
  if (updates.commission !== undefined) {
    if (updates.commission < 0) return false;
    t.commission = updates.commission;
  }
  if (updates.trade_date !== undefined) {
    t.trade_date = updates.trade_date;
  }
  t.total_amount = roundMoney(t.shares * t.price * (isOptionSymbol(t.symbol) ? 100 : 1));
  state.cash += cashDeltaForTrade(t) - cashDeltaForTrade(oldSnap);
  sortTradesByDateDesc(state.trades);
  void flushPersistToServer();
  syncStocksFromTrades();
  return true;
}

// 导出交易记录为 xlsx（与本应用「本应用导出」导入一致）
async function exportTradesToXlsx(): Promise<void> {
  const tradesToExport = getTradeHistoryFilteredTrades();
  if (tradesToExport.length === 0) {
    renderError('没有交易记录可导出');
    return;
  }
  try {
    const XLSX = await import('xlsx');
    const header = ['时间', '类型', '其它类别', '代码', '名称', '股数', '价格', '金额', '手续费'];
    const dataRows: (string | number)[][] = tradesToExport.map((trade) => [
      new Date(trade.trade_date).toLocaleString('zh-CN'),
      trade.type === 'buy' ? '买入' : trade.type === 'sell' ? '卖出' : '其它',
      trade.type === 'other' ? (trade.other_category ?? '') : '',
      trade.symbol,
      trade.name,
      trade.shares,
      trade.price,
      trade.total_amount,
      trade.commission
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, TRADE_RECORD_EXPORT_SHEET_NAME);
    XLSX.writeFile(wb, `交易记录_${new Date().toISOString().split('T')[0]}.xlsx`);
    renderSuccess('交易记录已导出为 Excel');
  } catch (error) {
    console.error(error);
    renderError(`导出失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 打开导入弹窗
function openImportTradeModal(): void {
  importTradeModalOpen = true;
  importPreviewData = [];
  importError = null;
  render();
}

// 关闭导入弹窗
function closeImportTradeModal(): void {
  importTradeModalOpen = false;
  importPreviewData = [];
  importError = null;
  render();
}

function readXlsxArrayBuffer(
  file: File,
  input: HTMLInputElement,
  parser: (buf: ArrayBuffer) => Promise<TradeRecord[]>,
  emptyMessage: string
): void {
  const reader = new FileReader();
  reader.onload = (e) => {
    void (async () => {
      try {
        const buf = e.target?.result;
        if (!(buf instanceof ArrayBuffer)) {
          importError = '无法读取表格文件';
          importPreviewData = [];
          input.value = '';
          render();
          return;
        }
        importPreviewData = await parser(buf);
        importError = importPreviewData.length === 0 ? emptyMessage : null;
      } catch (err) {
        importError = `解析 Excel 失败: ${(err as Error).message}`;
        importPreviewData = [];
      }
      input.value = '';
      render();
    })();
  };
  reader.readAsArrayBuffer(file);
}

/** Moomoo：历史 / 现金账户 xlsx */
function handleMoomooTradeImport(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  readXlsxArrayBuffer(file, input, async (buf) =>
    (await parseMoomooXlsxArrayBuffer(buf)) as TradeRecord[]
  , '未解析到有效记录：请确认 xlsx 为 Moomoo 历史导出，且表头含方向、代码、交易状态、成交金额等（仅导入「全部成交」）');
}

/** BBAE：股票 / 期权订单 xlsx */
function handleBbaeTradeImport(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  readXlsxArrayBuffer(file, input, async (buf) =>
    (await parseBbaeXlsxArrayBuffer(buf)) as TradeRecord[]
  , '未解析到有效记录：请确认 xlsx 为 BBAE 订单导出（工作表含「股票代码」或「期权代码」，订单状态为「已成」）');
}

/** 本应用导出的交易 xlsx（推荐）；仍可读旧版 .csv / .json */
function handleTradeBackupImport(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'xlsx' || ext === 'xls') {
    readXlsxArrayBuffer(file, input, async (buf) =>
      (await parseAppTradeBackupXlsxArrayBuffer(buf)) as TradeRecord[]
    , '文件中无有效交易记录（请使用本应用导出的「交易记录」xlsx，或首张表与本应用导出表头一致）');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target?.result as string;
    try {
      if (ext === 'csv') {
        importPreviewData = parseTradeImportLegacyCsv(content) as TradeRecord[];
      } else if (ext === 'json') {
        importPreviewData = parseJSON(content);
      } else {
        importError = '请上传本应用导出的 .xlsx，或旧的 .csv / .json';
        importPreviewData = [];
        input.value = '';
        render();
        return;
      }
      importError =
        importPreviewData.length === 0 ? '文件中无有效交易记录' : null;
    } catch (err) {
      importError = `解析失败: ${(err as Error).message}`;
      importPreviewData = [];
    }
    input.value = '';
    render();
  };
  reader.readAsText(file);
}

// 解析 JSON
function parseJSON(content: string): TradeRecord[] {
  const data: unknown = JSON.parse(content);
  let arr: unknown[];
  if (Array.isArray(data)) {
    arr = data;
  } else if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { trades?: unknown }).trades)
  ) {
    arr = (data as { trades: unknown[] }).trades;
  } else {
    arr = [];
  }

  const mapped: Array<TradeRecord | null> = arr.map((item: unknown, index: number): TradeRecord | null => {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const typeRaw = String(record.type ?? '');
    const isOther =
      typeRaw === '其它' ||
      typeRaw.toLowerCase() === 'other' ||
      typeRaw === 'other_income';

    if (isOther) {
      const symbolU = String(record.symbol ?? record.code ?? 'OTHER')
        .trim()
        .toUpperCase()
        || 'OTHER';
      const cat = String(record.other_category ?? record.otherCategory ?? '').trim();
      const totalAmt = Number(record.total_amount ?? record.amount);
      if (!cat || !Number.isFinite(totalAmt) || totalAmt === 0) return null;
      const feeRaw = parseFloat(String(record.commission ?? record.fee ?? 0));
      return {
        id: `import-${index}-${Date.now()}`,
        symbol: symbolU,
        name: String(record.name ?? cat),
        type: 'other',
        other_category: cat,
        shares: 1,
        price: 0,
        total_amount: totalAmt,
        commission: Number.isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : 0,
        trade_date: parseImportedTradeDatetime(record.trade_date),
        created_at: new Date().toISOString()
      };
    }

    const shares = parseFloat(String(record.shares ?? 0));
    const price = parseFloat(String(record.price ?? 0));
    const symbolU = String(record.symbol ?? record.code ?? '').toUpperCase();
    let totalAmt = parseFloat(String(record.total_amount ?? record.amount ?? ''));
    if (!Number.isFinite(totalAmt) || totalAmt <= 0) {
      totalAmt = roundMoney(shares * price * (isOptionSymbol(symbolU) ? 100 : 1));
    }

    return {
      id: `import-${index}-${Date.now()}`,
      symbol: symbolU,
      name: String(record.name ?? record.stockName ?? ''),
      type:
        typeRaw === '买入' || typeRaw === 'buy' || typeRaw === 'BUY'
          ? 'buy'
          : 'sell',
      shares,
      price,
      total_amount: totalAmt,
      commission: (() => {
        const f = parseFloat(String(record.commission ?? record.fee ?? 0));
        return Number.isFinite(f) && f >= 0 ? f : 0;
      })(),
      trade_date: parseImportedTradeDatetime(record.trade_date),
      created_at: new Date().toISOString()
    };
  });

  return mapped.filter((t: TradeRecord | null): t is TradeRecord => {
    if (t === null) return false;
    if (!t.symbol) return false;
    return t.type === 'other'
      ? !!(t.other_category && t.total_amount !== 0)
      : t.shares > 0 && t.price > 0;
  });
}
// 确认导入
function confirmImportTrades(): void {
  if (importPreviewData.length === 0) {
    renderError('没有可导入的交易记录');
    return;
  }

  let failCount = 0;
  for (const trade of importPreviewData) {
    if (trade.type === 'other') {
      if (
        !trade.other_category?.trim() ||
        !Number.isFinite(trade.total_amount) ||
        trade.total_amount === 0
      ) {
        failCount++;
        continue;
      }
      const row: TradeRecord = {
        id: crypto.randomUUID(),
        symbol: trade.symbol.trim().toUpperCase() || 'OTHER',
        name: trade.name,
        type: 'other',
        other_category: trade.other_category.trim(),
        shares: 1,
        price: 0,
        total_amount: trade.total_amount,
        commission: trade.commission ?? 0,
        trade_date: trade.trade_date,
        created_at: new Date().toISOString()
      };
      state.cash += cashDeltaForTrade(row);
      state.trades.push(row);
      continue;
    }
    const shares = trade.shares;
    const price = trade.price;
    if (shares <= 0 || price <= 0 || !trade.symbol) {
      failCount++;
      continue;
    }
    const optMult = isOptionSymbol(trade.symbol) ? 100 : 1;
    const total =
      trade.total_amount > 0 ? trade.total_amount : roundMoney(shares * price * optMult);
    const row: TradeRecord = {
      id: crypto.randomUUID(),
      symbol: trade.symbol.trim().toUpperCase(),
      name: trade.name,
      type: trade.type,
      shares,
      price,
      total_amount: total,
      commission: trade.commission ?? 0,
      trade_date: trade.trade_date,
      created_at: new Date().toISOString()
    };
    state.cash += cashDeltaForTrade(row);
    state.trades.push(row);
  }
  sortTradesByDateDesc(state.trades);
  void flushPersistToServer();
  syncStocksFromTrades();
  loadPnlStatsOnStartup();

  const successCount = importPreviewData.length - failCount;
  closeImportTradeModal();
  render();

  if (failCount === 0) {
    renderSuccess(`成功导入 ${successCount} 笔交易记录`);
  } else {
    renderError(`导入完成：成功 ${successCount} 笔，失败 ${failCount} 笔`);
  }
}

function loadPnlStatsOnStartup(): void {
  state.pnlStats = computeProfitLoss(state.trades, {
    startDate: state.pnlStartDate || undefined,
    endDate: state.pnlEndDate || undefined
  });
}

function setPnlQueryStartDate(value: string): void {
  state.pnlStartDate = value;
}

function setPnlQueryEndDate(value: string): void {
  state.pnlEndDate = value;
}

/** 清空盈亏查询时间段，按全部交易日重算 */
function resetPnlQuery(): void {
  state.pnlStartDate = '';
  state.pnlEndDate = '';
  loadPnlStatsOnStartup();
  render();
}

// 刷新盈亏统计
function refreshPnlStats(): void {
  const sEl = document.getElementById('pnl-start-date') as HTMLInputElement | null;
  const eEl = document.getElementById('pnl-end-date') as HTMLInputElement | null;
  if (sEl) state.pnlStartDate = sEl.value;
  if (eEl) state.pnlEndDate = eEl.value;
  loadPnlStatsOnStartup();
  render();
}

function setPnlVizMode(mode: string): void {
  if (mode === 'line' || mode === 'calendar') {
    pnlVizMode = mode;
    render();
  }
}

function effectivePnlCalendarYM(): string {
  if (pnlCalendarYM) return pnlCalendarYM;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftPnlCalendarMonth(delta: number): void {
  const base = effectivePnlCalendarYM();
  const y = Number(base.slice(0, 4));
  const m = Number(base.slice(5, 7));
  const dt = new Date(y, m - 1 + delta, 1);
  pnlCalendarYM = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  pnlCalendarYearFocus = `${dt.getFullYear()}`;
  render();
}

function resetPnlCalendarMonth(): void {
  pnlCalendarYM = '';
  pnlCalendarYearFocus = '';
  render();
}

function sparseTradeYearBounds(sparse: readonly { date: string }[]): { minY: number; maxY: number } {
  let cy = new Date().getFullYear();
  if (sparse.length === 0) return { minY: cy, maxY: cy };
  const ys: number[] = [];
  for (const p of sparse) {
    const y = Number(p.date.slice(0, 4));
    if (Number.isFinite(y)) ys.push(y);
  }
  if (ys.length === 0) return { minY: cy, maxY: cy };
  return { minY: Math.min(...ys), maxY: Math.max(...ys, cy) };
}

function utcGregorianMondayOffset(year: number, month1Based: number): number {
  const wd = new Date(Date.UTC(year, month1Based - 1, 1, 12, 0, 0)).getUTCDay();
  return (wd + 6) % 7;
}

function utcDaysInGregorianMonth(year: number, month1Based: number): number {
  return new Date(Date.UTC(year, month1Based, 0, 12, 0, 0)).getUTCDate();
}

function ymKey(y: number, m1: number, d: number): string {
  return `${y}-${String(m1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function effectiveYmPartsNow(): { y: number; m: number } {
  const ym = effectivePnlCalendarYM();
  const mch = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!mch) {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
  }
  return { y: Number(mch[1]), m: Number(mch[2]) };
}

/** 年视图用到的公历年 */
function effectiveCalendarYearForYearView(): number {
  const raw = pnlCalendarYearFocus.trim();
  const mch = /^(\d{4})$/.exec(raw);
  if (mch) {
    const y = Number(mch[1]);
    if (y >= 1980 && y <= 2100) return y;
  }
  return effectiveYmPartsNow().y;
}

function setPnlCalendarYmFromDom(): void {
  const yEl = document.getElementById('pnl-cal-year-sel') as HTMLSelectElement | null;
  const moEl = document.getElementById('pnl-cal-month-sel') as HTMLSelectElement | null;
  if (!yEl || !moEl) return;
  setPnlCalendarYmSelect(parseInt(yEl.value, 10), parseInt(moEl.value, 10));
}

function setPnlCalendarYmSelect(year: number, mo: number): void {
  if (!Number.isFinite(year) || !Number.isFinite(mo)) return;
  const m = Math.min(12, Math.max(1, Math.floor(mo)));
  const yy = Math.min(2100, Math.max(1980, Math.floor(year)));
  pnlCalendarYM = `${yy}-${String(m).padStart(2, '0')}`;
  pnlCalendarYearFocus = `${yy}`;
  render();
}

function setPnlCalendarYearFocusOnlyFromDom(): void {
  const el = document.getElementById('pnl-cal-year-grid-sel') as HTMLSelectElement | null;
  if (!el) return;
  setPnlCalendarYearFocusSelect(parseInt(el.value, 10));
}

function setPnlCalendarYearFocusSelect(y: number): void {
  if (!Number.isFinite(y)) return;
  const yy = Math.min(2100, Math.max(1980, Math.floor(y)));
  pnlCalendarYearFocus = `${yy}`;
  render();
}

function setPnlCalendarGranularity(mode: string): void {
  if (mode === 'month' || mode === 'year') {
    pnlCalendarGranularity = mode;
    render();
  }
}

function shiftPnlCalendarYearFocus(delta: number): void {
  const y = effectiveCalendarYearForYearView() + delta;
  pnlCalendarYearFocus = `${Math.min(2100, Math.max(1980, y))}`;
  render();
}

function formatPnlUsdTinyOneLine(net: number): string {
  const sign = net >= 0 ? '+' : '-';
  const a = Math.abs(net);
  if (a >= 1_000_000) return `${sign}$${formatNumber(a / 1_000_000, 2)}m`;
  if (a >= 10_000) return `${sign}$${formatNumber(a / 1_000, 1)}k`;
  if (a >= 1000) return `${sign}$${formatNumber(a / 1_000, 2)}k`;
  if (a < 1e-6 && a > 0) return `${sign}$${formatNumber(a, 2)}`;
  return `${sign}$${formatNumber(a, Math.abs(net) < 1 ? 2 : 0)}`;
}

/**
 * 名义收益率（小数）：累计净盈亏 ÷（当前总资产 − 累计净盈亏）。
 * 总资产取看板「总资产」= 持仓市值 + 现金；分母须为正。
 */
function pnlNominalReturnDecimal(cumulativeNet: number, totalAssets: number): number | null {
  if (!Number.isFinite(totalAssets) || !Number.isFinite(cumulativeNet)) return null;
  const base = totalAssets - cumulativeNet;
  if (base <= 1e-9) return null;
  return cumulativeNet / base;
}

function formatPnlNominalReturnPct(cumulativeNet: number, totalAssets: number): string {
  const r = pnlNominalReturnDecimal(cumulativeNet, totalAssets);
  if (r === null) return '—';
  return formatPercent(r * 100);
}

/** 区间净变动 Δ（非零）相对隐含本金 TA−cum<sub>Δ前</sub> 的收益率，与名义收益率同源分母。 */
function formatPnlIncrementalYieldPct(
  deltaNet: number,
  cumBeforeDelta: number,
  totalAssets: number
): string {
  if (!Number.isFinite(deltaNet) || !Number.isFinite(cumBeforeDelta) || !Number.isFinite(totalAssets)) {
    return '—';
  }
  if (Math.abs(deltaNet) < 1e-12) return '—';
  const base = totalAssets - cumBeforeDelta;
  if (base <= 1e-9) return '—';
  const p = (deltaNet / base) * 100;
  return `${p >= 0 ? '+' : ''}${formatNumber(p, 2)}%`;
}

function lastGregorianCalendarKeyStrictlyBeforeMonth(y: number, month: number): string {
  if (month > 1) {
    const dim = utcDaysInGregorianMonth(y, month - 1);
    return ymKey(y, month - 1, dim);
  }
  const dim = utcDaysInGregorianMonth(y - 1, 12);
  return ymKey(y - 1, 12, dim);
}

/** 区间内净盈亏 Δ ÷ 全历史末日累计净盈亏（×100%）；末日累计绝对值过小时不可用。 */
function formatPnlPeriodDeltaVsLifetimePct(periodDelta: number, cumLifetimeEnd: number): string {
  if (!Number.isFinite(periodDelta) || !Number.isFinite(cumLifetimeEnd)) return '—';
  if (Math.abs(cumLifetimeEnd) < 1e-9) return '—';
  const pct = (periodDelta / cumLifetimeEnd) * 100;
  return `${pct >= 0 ? '+' : ''}${formatNumber(pct, 1)}%`;
}

/** 自然日 d 日终累计净盈亏（expanded 序列为按日填充的累计值） */
function cumulativeNetAtEndOfDayFromExpanded(
  d: string,
  expanded: ReadonlyArray<{ date: string; cumulativeNet: number }>
): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || expanded.length === 0) return 0;
  const first = expanded[0].date;
  const last = expanded[expanded.length - 1].date;
  if (d < first) return 0;
  if (d > last) return expanded[expanded.length - 1].cumulativeNet;
  let lo = 0;
  let hi = expanded.length - 1;
  let ans = expanded[0].cumulativeNet;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const md = expanded[mid].date;
    if (md <= d) {
      ans = expanded[mid].cumulativeNet;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function buildPnlMonthCalendarGridInner(
  yNum: number,
  mNum: number,
  dayNetByDate: ReadonlyMap<string, number>,
  expandedCumulative: ReadonlyArray<{ date: string; cumulativeNet: number }>,
  totalAssets: number
): string {
  const dim = utcDaysInGregorianMonth(yNum, mNum);
  let maxAbs = 0;
  for (let d = 1; d <= dim; d++) {
    const key = ymKey(yNum, mNum, d);
    if (!pnlTradeDateWithinQuery(key)) continue;
    const v = dayNetByDate.get(key) ?? 0;
    maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  if (maxAbs === 0) maxAbs = 1;

  const mondayLead = utcGregorianMondayOffset(yNum, mNum);
  const gridCells: Array<{ d: number | null; key: string | null }> = [];
  for (let i = 0; i < mondayLead; i++) {
    gridCells.push({ d: null, key: null });
  }
  for (let d = 1; d <= dim; d++) {
    gridCells.push({ d, key: ymKey(yNum, mNum, d) });
  }
  while (gridCells.length % 7 !== 0) {
    gridCells.push({ d: null, key: null });
  }

  const rows: string[] = [];
  for (let r = 0; r < gridCells.length; r += 7) {
    const chunk = gridCells.slice(r, r + 7);
    const tds = chunk
      .map((c) => {
        if (c.d === null || c.key === null) {
          return '<div class="pnl-cal-cell pnl-cal-cell-placeholder" aria-hidden="true"></div>';
        }
        const inRange = pnlTradeDateWithinQuery(c.key);
        const hasTrade = dayNetByDate.has(c.key);
        const net = dayNetByDate.get(c.key) ?? 0;
        const bg = inRange ? pnlCalendarCellBackground(hasTrade ? net : 0, maxAbs) : '#f8fafc';
        const cumEod = inRange ? cumulativeNetAtEndOfDayFromExpanded(c.key, expandedCumulative) : 0;
        const cumBeforeDay = cumEod - net;
        const yieldDay = formatPnlIncrementalYieldPct(net, cumBeforeDay, totalAssets);
        const retS = inRange ? formatPnlNominalReturnPct(cumEod, totalAssets) : '—';

        let title: string;
        if (!inRange) {
          title = `${c.key}（不在查询时间段）`;
        } else if (!hasTrade) {
          title = `${c.key} 无成交 · 日终名义收益率 ${retS}`;
        } else {
          title = `${c.key} 当日净变动 ${net >= 0 ? '+' : ''}$${formatNumber(net)} · 当日收益率 ${yieldDay} · 累计名义 ${retS}`;
        }
        const amtLine = !inRange ? '—' : hasTrade ? formatPnlUsdTinyOneLine(net) : '$0';
        const retPart = retS;
        const sharePart = inRange && hasTrade ? `月 ${yieldDay}` : '';
        const pctLine =
          !inRange ? '—' : [sharePart, `收 ${retPart}`].filter((s) => s.length > 0).join(' · ');
        const titleClickHint = '点击查看当日交易';
        const oc = inRange ? '' : ' pnl-cal-cell-out-range';
        const keyAttr = escapeHtmlAttr(c.key);
        return `<div class="pnl-cal-cell pnl-cal-cell--interactive${oc}" style="background:${bg}" role="button" tabindex="0"
          title="${escapeHtmlAttr(`${title} · ${titleClickHint}`)}"
          onclick="openTradeHistoryModalForCalendarDay('${keyAttr}')"
          onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTradeHistoryModalForCalendarDay('${keyAttr}')}">
          <div class="pnl-cal-cell-stack">
            <span class="pnl-cal-daynum">${c.d}</span>
            <span class="pnl-cal-amt">${escapeHtml(amtLine)}</span>
            <span class="pnl-cal-pct">${escapeHtml(pctLine)}</span>
          </div>
        </div>`;
      })
      .join('');
    rows.push(`<div class="pnl-cal-row">${tds}</div>`);
  }
  return rows.join('');
}

function buildPnlYearCalendarInner(
  yNum: number,
  dayNetByDate: ReadonlyMap<string, number>,
  expandedCumulative: ReadonlyArray<{ date: string; cumulativeNet: number }>,
  totalAssets: number
): string {
  const monthSums = new Map<number, number>();
  for (let m = 1; m <= 12; m++) {
    let sm = 0;
    const dim = utcDaysInGregorianMonth(yNum, m);
    for (let d = 1; d <= dim; d++) {
      const key = ymKey(yNum, m, d);
      if (!pnlTradeDateWithinQuery(key)) continue;
      sm += dayNetByDate.get(key) ?? 0;
    }
    monthSums.set(m, sm);
  }

  let maxMonthAbs = 0;
  for (const v of monthSums.values()) {
    maxMonthAbs = Math.max(maxMonthAbs, Math.abs(v));
  }
  if (maxMonthAbs === 0) maxMonthAbs = 1;

  const cells: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const sm = monthSums.get(m) ?? 0;
    const prevLastKey = lastGregorianCalendarKeyStrictlyBeforeMonth(yNum, m);
    const cumBeforeMonth = cumulativeNetAtEndOfDayFromExpanded(prevLastKey, expandedCumulative);
    const dimM = utcDaysInGregorianMonth(yNum, m);
    const lastKeyM = ymKey(yNum, m, dimM);
    const cumEom = cumulativeNetAtEndOfDayFromExpanded(lastKeyM, expandedCumulative);
    const monthDeltaFull = cumEom - cumBeforeMonth;
    const pctMonthYield = formatPnlIncrementalYieldPct(monthDeltaFull, cumBeforeMonth, totalAssets);
    const retEom = formatPnlNominalReturnPct(cumEom, totalAssets);
    const bg = pnlCalendarCellBackground(sm, maxMonthAbs);
    const titleY = `${yNum}年${m}月 合计 ${sm >= 0 ? '+' : ''}$${formatNumber(sm)} · 自然月收益率 ${pctMonthYield}（净变动÷(总资产−月初累计)） · 月末累计名义 ${retEom}`;
    cells.push(`
      <div class="pnl-cal-year-cell pnl-cal-year-cell--interactive" style="background:${bg}" role="button" tabindex="0"
        title="${escapeHtmlAttr(`${titleY} · 点击查看当月交易`)}"
        onclick="openTradeHistoryModalForCalendarMonth(${yNum}, ${m})"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTradeHistoryModalForCalendarMonth(${yNum}, ${m})}">
        <div class="pnl-cal-year-mo">${m}月</div>
        <div class="pnl-cal-year-amt">${escapeHtml(formatPnlUsdTinyOneLine(sm))}</div>
        <div class="pnl-cal-year-pct">年 ${escapeHtml(pctMonthYield)} · 收 ${escapeHtml(retEom)}</div>
      </div>`);
  }
  return `<div class="pnl-cal-year-grid">${cells.join('')}</div>`;
}

function slicePnlExpandedSeriesByQuery(
  expanded: ReadonlyArray<{ date: string; cumulativeNet: number }>,
  start: string,
  end: string
): Array<{ date: string; cumulativeNet: number }> {
  const s = start.trim();
  const e = end.trim();
  if (!s && !e) {
    return [...expanded];
  }
  return expanded.filter((p) => {
    if (s && p.date < s) return false;
    if (e && p.date > e) return false;
    return true;
  });
}

/** 标的是否落在「查询盈亏」起止日期内（空表示不限制该端） */
function pnlTradeDateWithinQuery(d: string): boolean {
  const s = state.pnlStartDate.trim();
  const e = state.pnlEndDate.trim();
  if (!s && !e) return true;
  if (s && d < s) return false;
  if (e && d > e) return false;
  return true;
}

function pnlLineChartRangeFingerprint(series: readonly { date: string }[]): string {
  if (series.length === 0) return '';
  return `${series.length}\u0001${series[0].date}\u0001${series[series.length - 1].date}`;
}

function clampPnlChartViewport(vp: PnlLineChartViewport, len: number): PnlLineChartViewport {
  if (len <= 0) return { startFloat: 0, span: 0 };
  const minSpan = Math.min(len, PNL_LINE_CHART_MIN_POINTS);
  let span = vp.span;
  if (!Number.isFinite(span) || span <= 0) {
    span = minSpan;
  }
  span = Math.min(Math.max(span, minSpan), len);

  let startFloat = vp.startFloat;
  if (!Number.isFinite(startFloat)) startFloat = 0;
  const maxStart = Math.max(0, len - span);
  startFloat = Math.min(Math.max(0, startFloat), maxStart);

  return { startFloat, span };
}

function zoomPnlChartViewportWheel(
  prev: PnlLineChartViewport,
  len: number,
  pivotT: number,
  zoomOut: boolean
): PnlLineChartViewport {
  if (len <= PNL_LINE_CHART_MIN_POINTS) {
    return { startFloat: 0, span: len };
  }
  const vp = clampPnlChartViewport(prev, len);
  const span = vp.span;
  const factor = zoomOut ? 1.14 : 0.87;
  let newSpan = Math.max(PNL_LINE_CHART_MIN_POINTS, Math.round(span * factor));
  newSpan = Math.min(len, newSpan);

  const t = Math.min(1, Math.max(0, pivotT));
  const denomOld = Math.max(1, span - 1);
  const denomNew = Math.max(1, newSpan - 1);
  const pivotPos = vp.startFloat + t * denomOld;
  let newStart = pivotPos - t * denomNew;
  const maxStart = Math.max(0, len - newSpan);
  newStart = Math.min(Math.max(0, newStart), maxStart);

  return clampPnlChartViewport({ startFloat: newStart, span: newSpan }, len);
}

function panPnlChartViewportByDx(vp: PnlLineChartViewport, len: number, dxPlotPx: number, plotWpx: number): PnlLineChartViewport {
  if (len <= 0 || plotWpx <= 0) return vp;
  if (len <= PNL_LINE_CHART_MIN_POINTS) {
    return { startFloat: 0, span: len };
  }
  const c = clampPnlChartViewport(vp, len);
  const deltaIdx = (-dxPlotPx / plotWpx) * c.span;
  return clampPnlChartViewport({ startFloat: c.startFloat + deltaIdx, span: c.span }, len);
}

let pnlLineChartViewFingerprint = '';
let pnlLineChartViewport: PnlLineChartViewport = { startFloat: 0, span: 0 };
let pnlLineChartLastFullLen = 0;
let pnlChartViewportRenderRaf = false;

/** 与 buildPnlCumulativeLineChartSvg 中 viewBox 一致，用于屏幕像素 → 视窗数据域换算 */
const PNL_LINE_CHART_PAD_L = 76;
const PNL_LINE_CHART_PAD_R = 54;
const PNL_LINE_CHART_VIEW_W = 1000;
const PNL_LINE_CHART_INNER_W = PNL_LINE_CHART_VIEW_W - PNL_LINE_CHART_PAD_L - PNL_LINE_CHART_PAD_R;

let pnlLineChartPanDragging = false;
let pnlLineChartPanLastClientX = 0;
let pnlLineChartPanPointerId = -1;

function pnlLineChartDetachDocumentPanListeners(): void {
  document.removeEventListener('pointermove', pnlLineChartOnDocumentPointerMove);
  document.removeEventListener('pointerup', pnlLineChartOnDocumentPointerEnd);
  document.removeEventListener('pointercancel', pnlLineChartOnDocumentPointerEnd);
}

function pnlLineChartOnDocumentPointerMove(ev: PointerEvent): void {
  if (!pnlLineChartPanDragging || ev.pointerId !== pnlLineChartPanPointerId) return;
  const dx = ev.clientX - pnlLineChartPanLastClientX;
  pnlLineChartPanLastClientX = ev.clientX;
  const len = pnlLineChartLastFullLen;
  if (len <= PNL_LINE_CHART_MIN_POINTS) return;
  const el = document.querySelector('.pnl-line-chart-svg');
  if (!(el instanceof SVGSVGElement)) return;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return;
  const plotWpx = rect.width * (PNL_LINE_CHART_INNER_W / PNL_LINE_CHART_VIEW_W);
  pnlLineChartViewport = panPnlChartViewportByDx(pnlLineChartViewport, len, dx, plotWpx);
  schedulePnlChartViewportRender();
}

function pnlLineChartOnDocumentPointerEnd(ev: PointerEvent): void {
  if (!pnlLineChartPanDragging || ev.pointerId !== pnlLineChartPanPointerId) return;
  pnlLineChartPanDragging = false;
  pnlLineChartPanPointerId = -1;
  pnlLineChartDetachDocumentPanListeners();
  const wrapEl = document.querySelector('.pnl-line-chart-wrap') as HTMLElement | null;
  const svgEl = document.querySelector('.pnl-line-chart-svg') as SVGSVGElement | null;
  if (wrapEl) wrapEl.style.cursor = '';
  if (svgEl) svgEl.style.cursor = 'crosshair';
}

function schedulePnlChartViewportRender(): void {
  if (pnlChartViewportRenderRaf) return;
  pnlChartViewportRenderRaf = true;
  requestAnimationFrame(() => {
    pnlChartViewportRenderRaf = false;
    render();
  });
}

function resetPnlLineChartViewport(): void {
  const len = pnlLineChartLastFullLen;
  if (len > 0) {
    pnlLineChartViewport = clampPnlChartViewport({ startFloat: 0, span: len }, len);
  }
  schedulePnlChartViewportRender();
}

function clearPnlLineChartInteractions(): void {
  pnlLineChartHoverCleanup?.();
  pnlLineChartHoverCleanup = null;
}

/** 无折线图可交互（切换日历/HMR 等）时释放 document 级平移监听 */
function pnlLineChartAbortDocumentPan(): void {
  if (!pnlLineChartPanDragging) return;
  pnlLineChartPanDragging = false;
  pnlLineChartPanPointerId = -1;
  pnlLineChartDetachDocumentPanListeners();
  const wrapEl = document.querySelector('.pnl-line-chart-wrap') as HTMLElement | null;
  const svgEl = document.querySelector('.pnl-line-chart-svg') as SVGSVGElement | null;
  if (wrapEl) wrapEl.style.cursor = '';
  if (svgEl) svgEl.style.cursor = 'crosshair';
}

function setupPnlLineChartInteractions(): void {
  clearPnlLineChartInteractions();
  if (!pnlLineChartHoverModel || pnlLineChartHoverModel.points.length === 0) {
    pnlLineChartAbortDocumentPan();
    return;
  }

  const svg = document.querySelector('.pnl-line-chart-svg') as SVGSVGElement | null;
  const wrap = document.querySelector('.pnl-line-chart-wrap') as HTMLElement | null;
  if (!svg || !wrap) {
    pnlLineChartAbortDocumentPan();
    return;
  }

  let tipEl = wrap.querySelector('.pnl-line-chart-tooltip') as HTMLDivElement | null;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'pnl-line-chart-tooltip';
    tipEl.setAttribute('role', 'tooltip');
    wrap.appendChild(tipEl);
  }

  const m = pnlLineChartHoverModel;
  const innerW = m.viewW - m.padL - m.padR;

  const hideTip = (): void => {
    if (!tipEl) return;
    tipEl.style.opacity = '0';
    tipEl.style.visibility = 'hidden';
  };

  const nearestIndex = (svgX: number): number => {
    const n = m.points.length;
    if (n <= 1) return 0;
    const denom = Math.max(1, n - 1);
    const step = innerW / denom;
    const shiftPx = m.slicePanFraction * step;
    const iFloat = (svgX - m.padL + shiftPx) / step;
    const idx = Math.round(iFloat);
    return Math.min(n - 1, Math.max(0, idx));
  };

  const onMove = (ev: MouseEvent): void => {
    if (pnlLineChartPanDragging) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !tipEl) return;
    const relX = ((ev.clientX - rect.left) / rect.width) * m.viewW;
    if (relX < m.padL || relX > m.viewW - m.padR) {
      hideTip();
      return;
    }
    const idx = nearestIndex(relX);
    const p = m.points[idx];
    if (!p) return;

    tipEl.replaceChildren();
    const line1 = document.createElement('div');
    line1.className = 'pnl-line-chart-tooltip-date';
    line1.textContent = p.date;
    const line2 = document.createElement('div');
    line2.className = 'pnl-line-chart-tooltip-val';
    const strong = document.createElement('strong');
    strong.textContent = `${p.cumulativeNet >= 0 ? '+' : ''}$${formatNumber(p.cumulativeNet)}`;
    line2.append('累计净盈亏 ', strong);
    tipEl.append(line1, line2);

    const lineRet = document.createElement('div');
    lineRet.className = 'pnl-line-chart-tooltip-delta';
    lineRet.style.fontSize = '0.71rem';
    lineRet.style.color = '#64748b';
    lineRet.style.marginTop = '4px';
    lineRet.textContent = `名义收益率 ${formatPnlNominalReturnPct(p.cumulativeNet, m.totalAssets)}（÷(总资产−累计)）`;
    tipEl.appendChild(lineRet);

    const dayNetVal = m.dayNetByDate.get(p.date);
    if (dayNetVal !== undefined) {
      const line3 = document.createElement('div');
      line3.className = 'pnl-line-chart-tooltip-delta';
      line3.style.fontSize = '0.71rem';
      line3.style.color = '#64748b';
      line3.style.marginTop = '4px';
      line3.textContent = `当日净变动 ${dayNetVal >= 0 ? '+' : ''}$${formatNumber(dayNetVal)}`;
      tipEl.appendChild(line3);
    }

    void tipEl.offsetWidth;
    const wrapRect = wrap.getBoundingClientRect();
    const lx = ev.clientX - wrapRect.left;
    const ly = ev.clientY - wrapRect.top;
    const tw = tipEl.offsetWidth;
    tipEl.style.left = `${Math.min(Math.max(8, lx - tw / 2), Math.max(8, wrap.clientWidth - tw - 8))}px`;
    tipEl.style.top = `${Math.max(8, ly - 54)}px`;
    tipEl.style.opacity = '1';
    tipEl.style.visibility = 'visible';
  };

  const onLeave = (): void => {
    if (pnlLineChartPanDragging) return;
    hideTip();
  };

  const onWheel = (ev: WheelEvent): void => {
    if (m.fullSeriesLength <= PNL_LINE_CHART_MIN_POINTS) return;
    ev.preventDefault();
    const wrapRect = wrap.getBoundingClientRect();
    if (wrapRect.width <= 0) return;
    const relX = ((ev.clientX - wrapRect.left) / wrapRect.width) * m.viewW;
    const clampedRelX = Math.min(m.viewW - m.padR, Math.max(m.padL, relX));
    const pivotT = (clampedRelX - m.padL) / innerW;
    const zoomOut = ev.deltaY > 0;
    pnlLineChartViewport = zoomPnlChartViewportWheel(
      pnlLineChartViewport,
      m.fullSeriesLength,
      pivotT,
      zoomOut
    );
    schedulePnlChartViewportRender();
    hideTip();
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    if (m.fullSeriesLength <= PNL_LINE_CHART_MIN_POINTS) return;
    const t = ev.target;
    if (t instanceof Element && t.closest('button')) {
      return;
    }
    const rect0 = svg.getBoundingClientRect();
    if (rect0.width <= 0) return;
    ev.preventDefault();
    pnlLineChartPanDragging = true;
    pnlLineChartPanLastClientX = ev.clientX;
    pnlLineChartPanPointerId = ev.pointerId;
    hideTip();
    wrap.style.cursor = 'grabbing';
    svg.style.cursor = 'grabbing';
    document.addEventListener('pointermove', pnlLineChartOnDocumentPointerMove);
    document.addEventListener('pointerup', pnlLineChartOnDocumentPointerEnd);
    document.addEventListener('pointercancel', pnlLineChartOnDocumentPointerEnd);
  };

  const onDblClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    resetPnlLineChartViewport();
  };

  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', onLeave);
  wrap.addEventListener('wheel', onWheel, { passive: false });
  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('dblclick', onDblClick);

  pnlLineChartHoverCleanup = (): void => {
    svg.removeEventListener('mousemove', onMove);
    svg.removeEventListener('mouseleave', onLeave);
    wrap.removeEventListener('wheel', onWheel);
    wrap.removeEventListener('pointerdown', onPointerDown);
    wrap.removeEventListener('dblclick', onDblClick);
    wrap.style.cursor = '';
    svg.style.cursor = '';
  };
}

function pnlCalendarCellBackground(dayNet: number, maxAbs: number): string {
  if (dayNet === 0) return '#f1f5f9';
  const t = maxAbs > 0 ? Math.min(1, Math.abs(dayNet) / maxAbs) : 1;
  const bump = Math.round((0.18 + 0.62 * t) * 1000) / 1000;
  return dayNet > 0 ? `rgba(16,185,129,${bump})` : `rgba(239,68,68,${bump})`;
}

function buildPnlCumulativeLineChartSvg(
  points: ReadonlyArray<{ date: string; cumulativeNet: number }>,
  gradientId: string,
  hintLine: string,
  panFractionInCell: number,
  clipId: string,
  totalAssets: number
): string {
  const w = PNL_LINE_CHART_VIEW_W;
  const h = 220;
  const padL = PNL_LINE_CHART_PAD_L;
  const padR = PNL_LINE_CHART_PAD_R;
  const padT = 14;
  const padB = 48;
  const vals = points.map((p) => p.cumulativeNet);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const vSpan = maxV - minV || 1;
  const n = points.length;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const panF = Math.min(1, Math.max(0, panFractionInCell));
  const denom = n <= 1 ? 1 : n - 1;
  const stepPx = n <= 1 ? innerW / 2 : innerW / denom;
  const shiftPx = n <= 1 ? 0 : panF * stepPx;
  const xs = points.map((_, i) => padL + (n <= 1 ? innerW / 2 : (i / denom) * innerW) - shiftPx);
  const ys = points.map((p) => padT + innerH - ((p.cumulativeNet - minV) / vSpan) * innerH);
  const linePtsStr = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const lastY = ys[ys.length - 1] ?? padT + innerH / 2;
  const lastX = xs[xs.length - 1] ?? padL + innerW / 2;
  const firstX = xs[0] ?? padL;

  let zeroLine = '';
  if (minV < 0 && maxV > 0) {
    const zy = padT + innerH - ((0 - minV) / vSpan) * innerH;
    zeroLine = `<line x1="${padL}" y1="${zy.toFixed(1)}" x2="${padL + innerW}" y2="${zy.toFixed(1)}" stroke="#cbd5e1" stroke-dasharray="4 4" stroke-width="1" />`;
  }

  const yTop = `${formatNumber(maxV)}`;
  const yBot = `${formatNumber(minV)}`;
  const yMidVal = minV + vSpan / 2;
  const yMid = `${formatNumber(yMidVal)}`;

  const rTop = formatPnlNominalReturnPct(maxV, totalAssets);
  const rMid = formatPnlNominalReturnPct(yMidVal, totalAssets);
  const rBot = formatPnlNominalReturnPct(minV, totalAssets);
  const rZero =
    minV < 0 && maxV > 0 ? formatPnlNominalReturnPct(0, totalAssets) : '';

  const areaPts = `${firstX.toFixed(1)},${(padT + innerH).toFixed(1)} ${linePtsStr} ${lastX.toFixed(1)},${(padT + innerH).toFixed(1)}`;

  const firstLbl = points[0].date.slice(5).replace(/^(\d{2})-(\d{2})$/, '$1/$2');
  const lastLbl = points[points.length - 1].date.slice(5).replace(/^(\d{2})-(\d{2})$/, '$1/$2');
  const gid = escapeHtmlAttr(gradientId);
  const cid = escapeHtmlAttr(clipId);

  return `
    <div class="pnl-line-chart-wrap">
      <svg class="pnl-line-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-label="累计净盈亏折线">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#6366f1" stop-opacity="0.22" />
            <stop offset="100%" stop-color="#6366f1" stop-opacity="0.02" />
          </linearGradient>
          <clipPath id="${cid}">
            <rect x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" />
          </clipPath>
        </defs>
        <text x="${padL - 4}" y="${padT + 12}" text-anchor="end" font-size="12" fill="#64748b">$${escapeHtml(yTop)}</text>
        <text x="${padL - 4}" y="${padT + innerH / 2 + 4}" text-anchor="end" font-size="12" fill="#64748b">$${escapeHtml(yMid)}</text>
        <text x="${padL - 4}" y="${padT + innerH + 2}" text-anchor="end" font-size="12" fill="#64748b">$${escapeHtml(yBot)}</text>
        <text x="${w - 4}" y="${padT + 12}" text-anchor="end" font-size="11" fill="#94a3b8">${escapeHtml(rTop)}</text>
        <text x="${w - 4}" y="${padT + innerH / 2 + 4}" text-anchor="end" font-size="11" fill="#94a3b8">${escapeHtml(rMid)}</text>
        <text x="${w - 4}" y="${padT + innerH + 2}" text-anchor="end" font-size="11" fill="#94a3b8">${escapeHtml(rBot)}</text>
        ${
          rZero && minV < 0 && maxV > 0
            ? `<text x="${w - 4}" y="${(
                padT + innerH - ((0 - minV) / vSpan) * innerH +
                4
              ).toFixed(1)}" text-anchor="end" font-size="10" fill="#94a3b8">${escapeHtml(rZero)}</text>`
            : ''
        }
        <g clip-path="url(#${cid})">
        ${zeroLine}
        <polygon points="${areaPts}" fill="url(#${gid})" stroke="none" />
        <polyline points="${linePtsStr}" fill="none" stroke="#4f46e5" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4.5" fill="#4f46e5" stroke="white" stroke-width="1.5" />
        </g>
        <text x="${padL}" y="${h - 10}" font-size="11" fill="#64748b">${escapeHtml(firstLbl)}</text>
        <text x="${padL + innerW}" y="${h - 10}" font-size="11" fill="#64748b" text-anchor="end">${escapeHtml(lastLbl)}</text>
      </svg>
      <div class="pnl-line-chart-hint-row">
        <span class="pnl-line-chart-hint-text">${escapeHtml(hintLine)}</span>
        <button type="button" class="btn btn-secondary pnl-line-chart-reset-btn" onclick="resetPnlLineChartViewport()">
          复位视窗
        </button>
      </div>
    </div>
  `;
}

function renderPnlCumulativeVisualization(): string {
  pnlLineChartHoverModel = null;

  if (state.trades.length === 0) return '';

  const sparse = buildDailyCumulativeNetPnlSeries(state.trades);
  if (sparse.length === 0) return '';

  const expanded = expandCumulativeDailyToAllDays(sparse);
  const rangeSlice = slicePnlExpandedSeriesByQuery(expanded, state.pnlStartDate, state.pnlEndDate);
  const dayNetByDate = new Map(sparse.map((p) => [p.date, p.dayNet]));
  const lastCumFull = sparse[sparse.length - 1].cumulativeNet;
  const hasQueryRange = state.pnlStartDate.trim() !== '' || state.pnlEndDate.trim() !== '';
  const pnlDashboardTotalAssets = state.totalValue + state.cash;

  const { y: dispY, m: dispM } = effectiveYmPartsNow();
  const yBounds = sparseTradeYearBounds(sparse);
  const yEffYear = effectiveCalendarYearForYearView();
  const cy = new Date().getFullYear();
  let minYo = Math.min(yBounds.minY, dispY, yEffYear, cy);
  let maxYo = Math.max(yBounds.maxY, dispY, yEffYear, cy);
  let yearDropdownOpts = '';
  for (let oy = minYo; oy <= maxYo; oy++) {
    yearDropdownOpts += `<option value="${oy}" ${oy === dispY ? 'selected' : ''}>${escapeHtml(String(oy))} 年</option>`;
  }
  let monthDropdownOpts = '';
  for (let mo = 1; mo <= 12; mo++) {
    monthDropdownOpts += `<option value="${mo}" ${mo === dispM ? 'selected' : ''}>${mo} 月</option>`;
  }
  let yearGridDropdownOpts = '';
  for (let oy = minYo; oy <= maxYo; oy++) {
    yearGridDropdownOpts += `<option value="${oy}" ${oy === yEffYear ? 'selected' : ''}>${escapeHtml(String(oy))} 年</option>`;
  }

  const calMonthInner = buildPnlMonthCalendarGridInner(
    dispY,
    dispM,
    dayNetByDate,
    expanded,
    pnlDashboardTotalAssets
  );
  const calYearInner = buildPnlYearCalendarInner(
    yEffYear,
    dayNetByDate,
    expanded,
    pnlDashboardTotalAssets
  );

  const isLine = pnlVizMode === 'line';

  let lineSvgHtml = '';
  if (isLine) {
    if (rangeSlice.length === 0) {
      lineSvgHtml =
        '<div class="pnl-line-chart-empty">当前「查询盈亏」所选时间段与有数据的日期区间无交集，折线无法绘制。请调整起止日期或点击「重置」。</div>';
    } else {
      const nFull = rangeSlice.length;
      const fp = pnlLineChartRangeFingerprint(rangeSlice);
      if (fp !== pnlLineChartViewFingerprint) {
        pnlLineChartViewFingerprint = fp;
        pnlLineChartViewport = clampPnlChartViewport({ startFloat: 0, span: nFull }, nFull);
      }
      pnlLineChartLastFullLen = nFull;
      pnlLineChartViewport = clampPnlChartViewport(pnlLineChartViewport, nFull);
      const vpC = pnlLineChartViewport;
      const i0 = Math.floor(vpC.startFloat);
      const slicePanFraction = vpC.startFloat - i0;
      const viewPoints = rangeSlice.slice(i0, i0 + vpC.span);
      if (viewPoints.length === 0) {
        lineSvgHtml =
          '<div class="pnl-line-chart-empty">视窗为空，请点击「复位视窗」或刷新页面。</div>';
      } else {
        const v0 = viewPoints[0];
        const v1 = viewPoints[viewPoints.length - 1];
        const hintShort =
          viewPoints.length >= 1 && v0 && v1
            ? `视窗 ${v0.date}～${v1.date}（${viewPoints.length}/${nFull} 日）· 整块区域滚轮缩放 · 左键拖拽平移 · 双击或「复位」恢复全宽`
            : '';
        pnlLineChartGradientSeq += 1;
        const gid = `pnlGrad${pnlLineChartGradientSeq}`;
        const cid = `pnlClip${pnlLineChartGradientSeq}`;
        lineSvgHtml = buildPnlCumulativeLineChartSvg(
          viewPoints,
          gid,
          hintShort,
          slicePanFraction,
          cid,
          pnlDashboardTotalAssets
        );
        pnlLineChartHoverModel = {
          points: viewPoints,
          fullSeriesLength: nFull,
          slicePanFraction,
          dayNetByDate,
          totalAssets: pnlDashboardTotalAssets,
          viewW: PNL_LINE_CHART_VIEW_W,
          viewH: 220,
          padL: PNL_LINE_CHART_PAD_L,
          padR: PNL_LINE_CHART_PAD_R,
          padT: 14,
          padB: 48
        };
      }
    }
  }

  const cumLabel = hasQueryRange ? '查询区间期末累计净盈亏' : '当前累计净盈亏';
  const cumValueEnd = rangeSlice.length > 0 ? rangeSlice[rangeSlice.length - 1].cumulativeNet : null;
  const cumBadge =
    cumValueEnd === null
      ? `<span style="color: #94a3b8;">—</span>`
      : `<strong style="color: ${cumValueEnd >= 0 ? '#059669' : '#dc2626'};">${cumValueEnd >= 0 ? '+' : ''}$${formatNumber(
          cumValueEnd
        )}</strong>`;

  const fmtLastAll = `$${formatNumber(lastCumFull)}`;

  /** 日历粒度行右侧：所选自然月/自然年末累计；区间净盈亏及占末日累计比例（仅日历内展示一处） */
  let pnlCalPeriodSummaryHtml = '';
  if (!isLine) {
    if (pnlCalendarGranularity === 'month') {
      const pkBefore = lastGregorianCalendarKeyStrictlyBeforeMonth(dispY, dispM);
      const cumBeforeMo = cumulativeNetAtEndOfDayFromExpanded(pkBefore, expanded);
      const dimMS = utcDaysInGregorianMonth(dispY, dispM);
      const lastMoKey = ymKey(dispY, dispM, dimMS);
      const cumMoEnd = cumulativeNetAtEndOfDayFromExpanded(lastMoKey, expanded);
      const deltaMo = cumMoEnd - cumBeforeMo;
      const pctShare = formatPnlPeriodDeltaVsLifetimePct(deltaMo, lastCumFull);
      const moCol = cumMoEnd >= 0 ? '#059669' : '#dc2626';
      const deltaCol = deltaMo >= 0 ? '#059669' : '#dc2626';
      pnlCalPeriodSummaryHtml = `<div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
        <span style="font-size: 0.75rem;">
          <span style="color: #94a3b8;">截至 ${dispY}年${dispM}月末 累计净盈亏</span>
          <strong style="color: ${moCol}; margin-left: 4px;">${cumMoEnd >= 0 ? '+' : ''}$${formatNumber(cumMoEnd)}</strong>
        </span>
        <span style="font-size: 0.72rem; color: #94a3b8;">
          ${dispY}年${dispM}月 净盈亏 <strong style="color: ${deltaCol};">${deltaMo >= 0 ? '+' : ''}$${formatNumber(deltaMo)}</strong>
          <span style="margin-left: 6px;">占全历史末日累计</span> <strong style="color: #475569;">${pctShare}</strong>
        </span>
      </div>`;
    } else {
      const pkBeforeYear = lastGregorianCalendarKeyStrictlyBeforeMonth(yEffYear, 1);
      const cumBeforeY = cumulativeNetAtEndOfDayFromExpanded(pkBeforeYear, expanded);
      const dimDec = utcDaysInGregorianMonth(yEffYear, 12);
      const lastYearKey = ymKey(yEffYear, 12, dimDec);
      const cumYeEnd = cumulativeNetAtEndOfDayFromExpanded(lastYearKey, expanded);
      const deltaY = cumYeEnd - cumBeforeY;
      const pctShareY = formatPnlPeriodDeltaVsLifetimePct(deltaY, lastCumFull);
      const yrCol = cumYeEnd >= 0 ? '#059669' : '#dc2626';
      const deltaYCol = deltaY >= 0 ? '#059669' : '#dc2626';
      pnlCalPeriodSummaryHtml = `<div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
        <span style="font-size: 0.75rem;">
          <span style="color: #94a3b8;">截至 ${yEffYear}年末 累计净盈亏</span>
          <strong style="color: ${yrCol}; margin-left: 4px;">${cumYeEnd >= 0 ? '+' : ''}$${formatNumber(cumYeEnd)}</strong>
        </span>
        <span style="font-size: 0.72rem; color: #94a3b8;">
          ${yEffYear}年 净盈亏 <strong style="color: ${deltaYCol};">${deltaY >= 0 ? '+' : ''}$${formatNumber(deltaY)}</strong>
          <span style="margin-left: 6px;">占全历史末日累计</span> <strong style="color: #475569;">${pctShareY}</strong>
        </span>
      </div>`;
    }
  }

  const rangeExplain = hasQueryRange
    ? `折线横轴为上方「查询盈亏」起止日与有数据自然日的交集；左侧纵轴为当日结束时的<strong>累计净盈亏</strong>（与全历史末日累计 ${fmtLastAll} 同源，仅裁剪横轴）；右侧灰白色刻度为对应<strong>名义收益率</strong>：累计净盈亏÷(当前<strong>总资产</strong>−累计净盈亏)，总资产为看板「持仓市值+现金」。折线区可滚轮缩放、拖拽平移；悬停可看金额与收益率。日历：<strong>「月 x%」</strong>（月粒度）为<strong>当日</strong>变动收益率；<strong>「年 x%」</strong>（年粒度各月格）为该<strong>公历自然月</strong>变动收益率；均为净变动÷(总资产−变动前累计)；<strong>「收」</strong>为<strong>累计</strong>名义收益率（累计÷(总资产−累计)）。`
    : `未设置查询时间段时，折线横轴为首笔至末笔的每个自然日；左轴<strong>累计净盈亏</strong>为 FIFO 已实现（期权 ×100）减累计手续费，再加<strong>其它收支毛额</strong>（利息/分红等）；右轴名义收益率=累计÷(看板<strong>总资产</strong>−累计)。日历「月/年 x%」为<strong>变动收益率</strong>（净变动÷(总资产−变动前累计)）；「收」为累计名义收益率，口径同上。`;

  return `
    <div class="pnl-cumulative-viz" style="margin-top: 18px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
      <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between;">
        <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
          <span style="font-size: 0.85rem; font-weight: 600; color: #334155;">累计盈亏</span>
          <div style="display: inline-flex; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <button type="button" onclick="setPnlVizMode('line')"
              style="border: none; padding: 6px 14px; font-size: 0.82rem; cursor: pointer; ${
                isLine ? 'background: #eef2ff; color: #4338ca; font-weight: 600;' : 'background: white; color: #64748b;'
              }">折线</button>
            <button type="button" onclick="setPnlVizMode('calendar')"
              style="border: none; padding: 6px 14px; font-size: 0.82rem; cursor: pointer; border-left: 1px solid #e2e8f0; ${
                !isLine ? 'background: #eef2ff; color: #4338ca; font-weight: 600;' : 'background: white; color: #64748b;'
              }">日历</button>
          </div>
        </div>
        <span style="font-size: 0.75rem; color: #64748b;">${cumLabel} ${cumBadge}</span>
      </div>
      <p style="margin: 8px 0 0 0; font-size: 0.72rem; color: #94a3b8; line-height: 1.45;">
        ${rangeExplain}
      </p>
      ${
        isLine
          ? lineSvgHtml
          : `
        <div class="pnl-calendar-block" style="margin-top: 12px;">
          <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; justify-content: space-between; margin-bottom: 12px;">
            <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
            <span style="font-size: 0.82rem; color: #64748b;">粒度</span>
            <div style="display: inline-flex; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
              <button type="button" onclick="setPnlCalendarGranularity('month')"
                style="border: none; padding: 6px 12px; font-size: 0.8rem; cursor: pointer; ${
                  pnlCalendarGranularity === 'month'
                    ? 'background: #eef2ff; color: #4338ca; font-weight: 600;'
                    : 'background: white; color: #64748b;'
                }">按月</button>
              <button type="button" onclick="setPnlCalendarGranularity('year')"
                style="border: none; padding: 6px 12px; font-size: 0.8rem; cursor: pointer; border-left: 1px solid #e2e8f0; ${
                  pnlCalendarGranularity === 'year'
                    ? 'background: #eef2ff; color: #4338ca; font-weight: 600;'
                    : 'background: white; color: #64748b;'
                }">按年</button>
            </div>
            </div>
            ${pnlCalPeriodSummaryHtml}
          </div>
          ${
            pnlCalendarGranularity === 'month'
              ? `
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px;">
            <button type="button" class="btn btn-secondary" onclick="shiftPnlCalendarMonth(-1)" style="padding: 4px 10px; font-size: 0.8rem;">上月</button>
            <button type="button" class="btn btn-secondary" onclick="shiftPnlCalendarMonth(1)" style="padding: 4px 10px; font-size: 0.8rem;">下月</button>
            <label style="font-size: 0.82rem; color: #475569;">年
              <select id="pnl-cal-year-sel" onchange="setPnlCalendarYmFromDom()" style="margin-left: 6px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.82rem;">
                ${yearDropdownOpts}
              </select>
            </label>
            <label style="font-size: 0.82rem; color: #475569;">月
              <select id="pnl-cal-month-sel" onchange="setPnlCalendarYmFromDom()" style="margin-left: 6px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.82rem;">
                ${monthDropdownOpts}
              </select>
            </label>
            <button type="button" class="btn btn-secondary" onclick="resetPnlCalendarMonth()" style="padding: 4px 10px; font-size: 0.8rem; color: #64748b;">重置到本月</button>
          </div>
          <div class="pnl-cal-weekdays" aria-hidden="true">
            <span>周一</span><span>周二</span><span>周三</span><span>周四</span><span>周五</span><span>周六</span><span>周日</span>
          </div>
          <div class="pnl-cal-grid">${calMonthInner}</div>
          <div class="pnl-cal-legend" style="display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 0.7rem; color: #94a3b8;">
            <span>首行数字为日；第二行为当日盈亏（有成交日）；「月 x%」= 当日<strong>变动收益率</strong>；「收」= 日终<strong>累计</strong>名义收益率。<strong>点击日期格</strong>可打开交易记录（已按该日筛选）。</span>
          </div>
          `
              : `
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px;">
            <button type="button" class="btn btn-secondary" onclick="shiftPnlCalendarYearFocus(-1)" style="padding: 4px 10px; font-size: 0.8rem;">上一年</button>
            <button type="button" class="btn btn-secondary" onclick="shiftPnlCalendarYearFocus(1)" style="padding: 4px 10px; font-size: 0.8rem;">下一年</button>
            <label style="font-size: 0.82rem; color: #475569;">年份
              <select id="pnl-cal-year-grid-sel" onchange="setPnlCalendarYearFocusOnlyFromDom()" style="margin-left: 6px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.82rem;">
                ${yearGridDropdownOpts}
              </select>
            </label>
          </div>
          ${calYearInner}
          <div class="pnl-cal-legend" style="display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 0.7rem; color: #94a3b8;">
            <span>各格金额为当月<strong>查询范围内</strong>净变动合计（着色）；「年 x%」为该<strong>公历自然月整月</strong>的变动收益率；「收」= 该月末累计名义收益率。<strong>点击月格</strong>可打开交易记录（已按该自然月筛选）。</span>
          </div>
          `
          }
        </div>
      `
      }
    </div>
  `;
}

function exportToJSON(): void {
  const exportData: ExportData = {
    version: '1.1',
    exportDate: new Date().toISOString(),
    cash: state.cash,
    trades: state.trades,
    stocks: state.stocks.map(s => ({
      symbol: s.symbol,
      name: s.name,
      shares: s.shares,
      targetPrice: s.targetPrice,
      avgCost: s.avgCost,
      signal: s.signal,
      currentPrice: s.currentPrice,
      position: s.position,
      weight: s.weight,
      type: s.type,
      optionStrike: s.optionStrike,
      optionExpiry: s.optionExpiry,
      optionType: s.optionType,
      groupWith: s.groupWith,
      instrumentType: s.instrumentType,
      costLots: s.costLots,
      ...(typeof s.quoteChangePerShare === 'number' && Number.isFinite(s.quoteChangePerShare)
        ? { quoteChangePerShare: s.quoteChangePerShare }
        : {}),
      ...(typeof s.quoteChangePercent === 'number' && Number.isFinite(s.quoteChangePercent)
        ? { quoteChangePercent: s.quoteChangePercent }
        : {})
    }))
  };
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `portfolio_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  renderSuccess('数据已导出为 JSON 文件');
}

// 导出数据为 CSV 文件
function exportToCSV(): void {
  const headers = [
    '代码',
    '名称',
    '品种',
    '类型',
    '股数',
    '成本',
    '现价',
    '盈亏',
    '盈亏比例',
    '持仓',
    '品类占组合%',
    '1y目标价',
    '期权执行价',
    '期权到期日',
    '期权类型',
    '评级',
    '合并至品类'
  ];
  const totalA = state.totalValue + state.cash;
  const cashW = totalA > 0 ? (state.cash / totalA) * 100 : 0;
  const rows = state.stocks.map(s => {
    const pnl = computeLinePnL(s);
    const pnlPct = computeLinePnLPercent(s);
    const category = s.type === 'option' ? '期权' : '股票';
    const displayType = s.type === 'option' ? '期权' : (s.instrumentType ?? '股票');
    return [
      s.symbol,
      s.name,
      category,
      displayType,
      s.shares,
      s.avgCost ?? '',
      s.currentPrice,
      pnl === null ? '' : pnl,
      pnlPct === null ? '' : formatNumber(pnlPct, 2),
      s.position,
      s.weight,
      s.targetPrice ?? '',
      s.optionStrike ?? '',
      s.optionExpiry ?? '',
      s.optionType ?? '',
      s.signal === 'buy' ? '买入' : s.signal === 'sell' ? '卖出' : '持有',
      s.groupWith ?? ''
    ];
  });

  /** 17 列：持仓列存现金金额，品类占比列为现金占总资产比例 */
  const cashCsvRow: (string | number)[] = [
    'CASH',
    '现金',
    '现金',
    '现金',
    '',
    '',
    '',
    '',
    '',
    state.cash,
    formatNumber(cashW, 2),
    '',
    '',
    '',
    '',
    '',
    ''
  ];

  const csvContent = [
    headers.join(','),
    ...rows.map(r => r.map(cell => `"${cell}"`).join(',')),
    cashCsvRow.map(cell => `"${cell}"`).join(',')
  ].join('\n');
  
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `portfolio_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  renderSuccess('数据已导出为 CSV 文件');
}

// 从备份 JSON 恢复交易记录
function normalizeImportedTrades(arr: unknown[]): TradeRecord[] {
  const out: TradeRecord[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? crypto.randomUUID());
    const typRaw = String(o.type ?? '').toLowerCase();
    const isOther =
      typRaw === 'other' ||
      typRaw === '其它' ||
      (typeof o.type === 'string' && o.type === '其它');
    const typeZh = typeof o.type === 'string' ? o.type : '';
    if (isOther || typeZh === '其它') {
      let symbol = String(o.symbol ?? '').trim().toUpperCase();
      if (!symbol) symbol = 'OTHER';
      const cat = String(o.other_category ?? o.otherCategory ?? '').trim();
      if (!cat) continue;
      const totalRaw = Number(o.total_amount);
      if (!Number.isFinite(totalRaw) || totalRaw === 0) continue;
      const commission = Number.isFinite(Number(o.commission)) ? Number(o.commission) : 0;
      out.push({
        id,
        symbol,
        name: String(o.name ?? cat),
        type: 'other',
        other_category: cat,
        shares: 1,
        price: 0,
        total_amount: totalRaw,
        commission,
        trade_date: parseImportedTradeDatetime(o.trade_date),
        created_at: String(o.created_at ?? new Date().toISOString())
      });
      continue;
    }

    const symbol = String(o.symbol ?? '').trim().toUpperCase();
    if (!symbol) continue;
    const shares = Number(o.shares);
    const price = Number(o.price);
    if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0 || price <= 0) continue;
    const typ = o.type === 'sell' || o.type === '卖出' ? 'sell' : 'buy';
    const commission = Number.isFinite(Number(o.commission)) ? Number(o.commission) : 0;
    const totalRaw = Number(o.total_amount);
    out.push({
      id,
      symbol,
      name: String(o.name ?? symbol),
      type: typ,
      shares,
      price,
      total_amount:
        Number.isFinite(totalRaw) && totalRaw > 0
          ? totalRaw
          : roundMoney(shares * price * (isOptionSymbol(symbol) ? 100 : 1)),
      commission,
      trade_date: parseImportedTradeDatetime(o.trade_date),
      created_at: String(o.created_at ?? new Date().toISOString())
    });
  }
  return out;
}

// 从 JSON 文件导入
function importFromJSON(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target?.result as string;
      const data = JSON.parse(content) as ExportData & { trades?: unknown[] };
      
      if (Array.isArray(data.trades) && data.trades.length > 0) {
        state.trades = normalizeImportedTrades(data.trades as unknown[]);
        state.cash = typeof data.cash === 'number' && Number.isFinite(data.cash) ? data.cash : 0;
        sortTradesByDateDesc(state.trades);
        syncStocksFromTrades();
        saveToStorage();
        loadPnlStatsOnStartup();
        render();
        void refreshFinnhubCanonicalEquivalents();
        if (state.stocks.length > 0) {
          setTimeout(() => updateStockPrices(), 500);
        }
        renderSuccess(`已导入 ${state.trades.length} 笔交易，持仓已同步`);
        return;
      }

      if (data.stocks && Array.isArray(data.stocks)) {
        state.stocks = data.stocks.map(s => {
          const sym = s.symbol.toUpperCase();
          const opt = s.type === 'option' || isOptionSymbol(sym);
          return {
            ...s,
            symbol: sym,
            type: s.type ?? (isOptionSymbol(sym) ? 'option' : 'stock'),
            position: s.shares * s.currentPrice * (opt ? 100 : 1),
            weight: 0
          };
        });
        state.cash = data.cash || 0;
        calculateTotals();
        saveToStorage();
        migratePortfolioStocksToTradesIfNeeded();
        syncStocksFromTrades();
        loadPnlStatsOnStartup();
        render();

        void refreshFinnhubCanonicalEquivalents();

        if (state.stocks.length > 0) {
          setTimeout(() => updateStockPrices(), 500);
        }

        renderSuccess(`成功导入持仓；已按需生成交易草稿并汇总`);
      } else {
        renderError('无效的数据格式');
      }
    } catch {
      renderError('导入失败：文件格式错误');
    }
  };
  reader.readAsText(file);

  input.value = '';
}

// 从 CSV 文件导入
function importFromCSV(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target?.result as string;
      const lines = content.split('\n').filter(line => line.trim());
      
      if (lines.length < 2) {
        renderError('CSV 文件内容为空或格式错误');
        return;
      }
      
      // 跳过标题行，解析数据（新版 CSV 含「品种」+「类型」，旧版仅一列「类型」）
      const newStocks: Stock[] = [];
      let cashFromCsv: number | null = null;
      const hasPinZhong = lines[0].includes('品种');
      const hasPnlPctCol = lines[0].includes('盈亏比例');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values: string[] = [];
        let current = '';
        let inQuotes = false;

        for (const char of line) {
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        values.push(current.trim());

        const code = values[0] ?? '';
        if (code.includes('现金') || code.toUpperCase() === 'CASH') {
          let cashIdx = 7;
          if (hasPinZhong) cashIdx = hasPnlPctCol ? 9 : 8;
          else if (hasPnlPctCol) cashIdx = 8;
          const raw = String(values[cashIdx] ?? '').replace(/,/g, '');
          const v = parseFloat(raw);
          if (Number.isFinite(v)) cashFromCsv = v;
          continue;
        }

        const shareIdx = hasPinZhong ? 4 : 3;
        if (!values[0] || values[shareIdx] === undefined || values[shareIdx] === '') {
          continue;
        }

        const pinOff = hasPnlPctCol ? 1 : 0;
        if (hasPinZhong && values.length >= 16 + pinOff) {
          const category = (values[2] || '').trim();
          const typeDisp = (values[3] || '').trim();
          const isOption = category === '期权';
          const instrumentType = instrumentTypeFromDisplayTypeCol(isOption, typeDisp);
          const sigText = (values[14 + pinOff] || '持有').trim();
          const signal: TradeSignal =
            sigText === '买入' ? 'buy' : sigText === '卖出' ? 'sell' : 'hold';
          const tpRaw = values[10 + pinOff]?.trim() ?? '';
          const gwRaw = (values[15 + pinOff] || '').trim();
          newStocks.push({
            symbol: values[0].toUpperCase(),
            name: values[1] || getStockDisplayName(values[0]),
            type: isOption ? 'option' : 'stock',
            instrumentType,
            shares: parseFloat(values[4]) || 0,
            avgCost:
              values[5] !== '' && values[5] !== undefined
                ? (() => {
                    const n = parseFloat(values[5]);
                    return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
                  })()
                : undefined,
            currentPrice: parseFloat(values[6]) || 0,
            position: parseFloat(values[8 + pinOff]) || 0,
            weight: 0,
            targetPrice:
              tpRaw === ''
                ? undefined
                : (() => {
                    const n = parseFloat(tpRaw);
                    return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
                  })(),
            optionStrike: values[11 + pinOff] ? parseFloat(values[11 + pinOff]) : undefined,
            optionExpiry: values[12 + pinOff] || undefined,
            optionType: (values[13 + pinOff] as 'C' | 'P') || undefined,
            signal,
            groupWith: gwRaw === '' ? undefined : gwRaw.toUpperCase()
          });
        } else if (!hasPinZhong && values.length >= 13 + pinOff) {
          const { isOption, instrumentType } = parseLegacyCsvTypeColumn(values[2] || '');
          const sigText = (values[13 + pinOff] || '持有').trim();
          const signal: TradeSignal =
            sigText === '买入' ? 'buy' : sigText === '卖出' ? 'sell' : 'hold';
          const tpRaw = values[9 + pinOff]?.trim() ?? '';
          const gwRaw = values.length >= 15 + pinOff ? (values[14 + pinOff] || '').trim() : '';
          newStocks.push({
            symbol: values[0].toUpperCase(),
            name: values[1] || getStockDisplayName(values[0]),
            type: isOption ? 'option' : 'stock',
            instrumentType,
            shares: parseFloat(values[3]) || 0,
            avgCost:
              values[4] !== '' && values[4] !== undefined
                ? (() => {
                    const n = parseFloat(values[4]);
                    return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
                  })()
                : undefined,
            currentPrice: parseFloat(values[5]) || 0,
            position: parseFloat(values[7 + pinOff]) || 0,
            weight: 0,
            targetPrice:
              tpRaw === ''
                ? undefined
                : (() => {
                    const n = parseFloat(tpRaw);
                    return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
                  })(),
            optionStrike: values[10 + pinOff] ? parseFloat(values[10 + pinOff]) : undefined,
            optionExpiry: values[11 + pinOff] || undefined,
            optionType: (values[12 + pinOff] as 'C' | 'P') || undefined,
            signal,
            groupWith: gwRaw === '' ? undefined : gwRaw.toUpperCase()
          });
        } else if (!hasPinZhong && values.length < 13 + pinOff) {
          const { isOption, instrumentType } = parseLegacyCsvTypeColumn(values[2] || '');
          const tpRaw = values[7]?.trim() ?? '';
          newStocks.push({
            symbol: values[0].toUpperCase(),
            name: values[1] || getStockDisplayName(values[0]),
            type: isOption ? 'option' : 'stock',
            instrumentType,
            shares: parseFloat(values[3]) || 0,
            targetPrice:
              tpRaw === ''
                ? undefined
                : (() => {
                    const n = parseFloat(tpRaw);
                    return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
                  })(),
            currentPrice: parseFloat(values[4]) || 0,
            position: parseFloat(values[5]) || 0,
            weight: 0,
            optionStrike: values[8] ? parseFloat(values[8]) : undefined,
            optionExpiry: values[9] || undefined,
            optionType: (values[10] as 'C' | 'P') || undefined
          });
        }
      }
      
      if (newStocks.length > 0 || cashFromCsv !== null) {
        state.stocks = newStocks;
        if (cashFromCsv !== null) state.cash = cashFromCsv;
        calculateTotals();
        saveToStorage();
        render();

        void refreshFinnhubCanonicalEquivalents();

        if (state.stocks.length > 0) {
          setTimeout(() => updateStockPrices(), 500);
        }

        const cashNote = cashFromCsv !== null ? `，现金 $${formatNumber(cashFromCsv, 2)}` : '';
        renderSuccess(`成功导入 ${state.stocks.length} 条持仓${cashNote}`);
      } else {
        renderError('未找到有效的持仓数据');
      }
    } catch (error) {
      renderError('导入失败：文件格式错误');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

function getGroupPortfolioPercent(
  u: string,
  groupMap: Map<string, Stock[]>,
  totalAssets: number
): number {
  const items = groupMap.get(u)!;
  const groupPos = items.reduce((acc, x) => acc + x.position, 0);
  return totalAssets > 0 ? (groupPos / totalAssets) * 100 : 0;
}

/** 持仓表格 tbody：按标的分组排序，仅输出明细行（无品类汇总栏） */
// 渲染交易面板
function renderTradePanel(): string {
  return `
    <div class="trade-panel-block">
    <!-- 交易操作区域 -->
    <div style="margin-bottom: 20px;">
      <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
        <button type="button" class="btn btn-primary" onclick="openNewTradeForm('buy')" style="padding: 8px 16px; font-size: 0.85rem; background: #10b981; border: none; color: white;">
          ＋ 新增买入
        </button>
        <button type="button" class="btn btn-secondary" onclick="openNewTradeForm('sell')" style="padding: 8px 16px; font-size: 0.85rem; border: 1px solid #fecaca; color: #b91c1c; background: #fef2f2;">
          ＋ 新增卖出
        </button>
        <button type="button" class="btn btn-secondary" onclick="openOtherTradeModal()" style="padding: 8px 16px; font-size: 0.85rem; border: 1px solid #c7d2fe; color: #4338ca; background: #eef2ff;">
          ＋ 其它收支
        </button>
        <button class="btn btn-secondary" onclick="openTradeHistoryModal()" style="padding: 8px 16px; font-size: 0.85rem;">
          📋 交易记录 (${state.trades.length})
        </button>
        ${state.pnlStats ? `
          <div style="display: flex; gap: 12px; padding: 8px 16px; background: linear-gradient(135deg, #1e293b 0%, #334155 100%); border-radius: 8px; color: white; font-size: 0.85rem;">
            <span>已实现盈亏: <strong style="color: ${state.pnlStats.realizedPL >= 0 ? '#4ade80' : '#f87171'};">$${formatNumber(state.pnlStats.realizedPL)}</strong></span>
            <span>手续费: <strong>$${formatNumber(state.pnlStats.commission)}</strong></span>
            <span>其它收支(毛额): <strong style="color: ${state.pnlStats.otherAmount >= 0 ? '#93c5fd' : '#fca5a5'};">${state.pnlStats.otherAmount >= 0 ? '+' : ''}$${formatNumber(state.pnlStats.otherAmount)}</strong></span>
            <span>净盈亏: <strong style="color: ${state.pnlStats.netPL >= 0 ? '#4ade80' : '#f87171'};">$${formatNumber(state.pnlStats.netPL)}</strong></span>
          </div>
        ` : ''}
      </div>
    </div>
    
    <!-- 盈亏统计区域 -->
    <div style="margin-bottom: 20px; padding: 16px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
      <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 12px;">
        <span style="font-weight: 600; color: #334155;">查询盈亏:</span>
        <input type="date" id="pnl-start-date" value="${state.pnlStartDate}" onchange="setPnlQueryStartDate(this.value)"
               style="padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem;" />
        <span>至</span>
        <input type="date" id="pnl-end-date" value="${state.pnlEndDate}" onchange="setPnlQueryEndDate(this.value)"
               style="padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem;" />
        <button class="btn btn-secondary" onclick="refreshPnlStats()" style="padding: 6px 12px; font-size: 0.85rem;">
          查询
        </button>
        <button type="button" class="btn btn-secondary" onclick="resetPnlQuery()" style="padding: 6px 12px; font-size: 0.85rem; color: #64748b;">
          重置
        </button>
      </div>
      ${state.pnlStats ? `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px;">
          <div style="padding: 12px; background: white; border-radius: 6px; border: 1px solid #e2e8f0;">
            <div style="font-size: 0.75rem; color: #64748b;">买入总额</div>
            <div style="font-size: 1.1rem; font-weight: 600; color: #334155;">$${formatNumber(state.pnlStats.totalBuyAmount)}</div>
          </div>
          <div style="padding: 12px; background: white; border-radius: 6px; border: 1px solid #e2e8f0;">
            <div style="font-size: 0.75rem; color: #64748b;">卖出总额</div>
            <div style="font-size: 1.1rem; font-weight: 600; color: #334155;">$${formatNumber(state.pnlStats.totalSellAmount)}</div>
          </div>
          <div style="padding: 12px; background: white; border-radius: 6px; border: 1px solid #e2e8f0;">
            <div style="font-size: 0.75rem; color: #64748b;">已实现盈亏</div>
            <div style="font-size: 1.1rem; font-weight: 600; color: ${state.pnlStats.realizedPL >= 0 ? '#10b981' : '#ef4444'};">
              ${state.pnlStats.realizedPL >= 0 ? '+' : ''}$${formatNumber(state.pnlStats.realizedPL)}
            </div>
          </div>
          <div style="padding: 12px; background: white; border-radius: 6px; border: 1px solid #e2e8f0;">
            <div style="font-size: 0.75rem; color: #64748b;">手续费</div>
            <div style="font-size: 1.1rem; font-weight: 600; color: #ef4444;">-$${formatNumber(state.pnlStats.commission)}</div>
          </div>
          <div style="padding: 12px; background: white; border-radius: 6px; border: 1px solid #e2e8f0;">
            <div style="font-size: 0.75rem; color: #64748b;">其它收支（毛额）</div>
            <div style="font-size: 1.1rem; font-weight: 600; color: ${state.pnlStats.otherAmount >= 0 ? '#10b981' : '#ef4444'};">
              ${state.pnlStats.otherAmount >= 0 ? '+' : ''}$${formatNumber(state.pnlStats.otherAmount)}
            </div>
          </div>
          <div style="padding: 12px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 6px; color: white;">
            <div style="font-size: 0.75rem; opacity: 0.9;">净盈亏</div>
            <div style="font-size: 1.2rem; font-weight: 700;">
              ${state.pnlStats.netPL >= 0 ? '+' : ''}$${formatNumber(state.pnlStats.netPL)}
            </div>
          </div>
        </div>
      ` : `
        <div style="color: #94a3b8; font-size: 0.85rem;">点击「查询」查看盈亏统计</div>
      `}
      ${renderPnlCumulativeVisualization()}
    </div>
    </div>
  `;
}

// 打开交易记录弹窗
function openTradeHistoryModal(): void {
  tradeHistoryModalOpen = true;
  tradeHistoryModalTab = 'list';
  tradeHistoryPage = 1;
  render();
}

/** 从持仓行打开：按标的筛选，列表按日期倒序，首页即最近成交 */
function openTradeHistoryModalForSymbol(symbol: string): void {
  const s = symbol.trim();
  if (!s) return;
  tradeHistoryModalOpen = true;
  tradeHistoryModalTab = 'list';
  tradeHistoryFilter = { symbol: s, type: '', otherCategory: '', startDate: '', endDate: '' };
  tradeHistoryPage = 1;
  render();
}

/** 日历月视图：某日 yyyy-mm-dd 的成交 */
function openTradeHistoryModalForCalendarDay(isoDate: string): void {
  const d = isoDate.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  tradeHistoryModalOpen = true;
  tradeHistoryModalTab = 'list';
  tradeHistoryFilter = { symbol: '', type: '', otherCategory: '', startDate: d, endDate: d };
  tradeHistoryPage = 1;
  render();
}

/** 日历年视图：公历整月 [start,end]  inclusive */
function openTradeHistoryModalForCalendarMonth(y: number, mo: number): void {
  const yi = Math.trunc(y);
  const moi = Math.trunc(mo);
  if (!Number.isFinite(yi) || !Number.isFinite(moi) || moi < 1 || moi > 12) return;
  const dim = utcDaysInGregorianMonth(yi, moi);
  const start = ymKey(yi, moi, 1);
  const end = ymKey(yi, moi, dim);
  tradeHistoryModalOpen = true;
  tradeHistoryModalTab = 'list';
  tradeHistoryFilter = { symbol: '', type: '', otherCategory: '', startDate: start, endDate: end };
  tradeHistoryPage = 1;
  render();
}

function setTradeHistoryModalTab(tab: 'list' | 'summary'): void {
  tradeHistoryModalTab = tab;
  if (tab === 'list') {
    tradeHistoryPage = 1;
  }
  render();
}

function setTradeHistorySymbolPnlSort(key: TradeHistorySymbolPnlSortKey): void {
  if (tradeHistorySymbolPnlSortKey === key) {
    tradeHistorySymbolPnlSortDir = tradeHistorySymbolPnlSortDir === 1 ? -1 : 1;
  } else {
    tradeHistorySymbolPnlSortKey = key;
    tradeHistorySymbolPnlSortDir = 1;
  }
  patchTradeHistoryModalTableRootOrRender();
}

// 关闭交易记录弹窗
function closeTradeHistoryModal(): void {
  tradeHistoryModalOpen = false;
  render();
}

/**
 * 遮罩关闭：仅在按下与释放在同一遮罩层上时关闭（从内层拖出到遮罩外释放不会误关）。
 * 若用 `click`，在内容区按下拖到遮罩释放会合成对遮罩的一次 click。
 */
type ModalBackdropKind = 'tradeHistory' | 'otherTrade' | 'importTrade' | 'editTrade' | 'tradeForm';

let modalBackdropPointerDown: ModalBackdropKind | null = null;

function onModalBackdropMouseDown(event: MouseEvent, kind: ModalBackdropKind): void {
  if (event.target !== event.currentTarget) return;
  modalBackdropPointerDown = kind;
}

function onModalBackdropMouseUp(event: MouseEvent, kind: ModalBackdropKind): void {
  const armed = modalBackdropPointerDown;
  modalBackdropPointerDown = null;
  if (armed !== kind) return;
  if (event.target !== event.currentTarget) return;
  switch (kind) {
    case 'tradeHistory':
      closeTradeHistoryModal();
      break;
    case 'otherTrade':
      closeOtherTradeModal();
      break;
    case 'importTrade':
      closeImportTradeModal();
      break;
    case 'editTrade':
      closeEditTradeModal();
      break;
    case 'tradeForm':
      closeTradeForm();
      break;
    default:
      break;
  }
}

// 筛选（交易记录始终在本地 state.trades，此处仅重绘弹窗）
function loadTradesFiltered(): void {
  render();
}

// 设置筛选条件
function setTradeHistoryFilter(
  field: 'symbol' | 'type' | 'otherCategory' | 'startDate' | 'endDate',
  value: string
): void {
  if (field === 'type') {
    tradeHistoryFilter.type = value as '' | 'buy' | 'sell' | 'other';
  } else {
    (tradeHistoryFilter as Record<string, string>)[field] = value;
  }
  tradeHistoryPage = 1;
  if (field === 'symbol' || field === 'otherCategory') {
    patchTradeHistoryModalTableRoot();
    return;
  }
  loadTradesFiltered();
}

// 重置筛选
function resetTradeHistoryFilter(): void {
  tradeHistoryFilter = { symbol: '', type: '', otherCategory: '', startDate: '', endDate: '' };
  tradeHistoryPage = 1;
  loadTradesFiltered();
}

// 切换分页
function setTradeHistoryPage(page: number): void {
  tradeHistoryPage = page;
  patchTradeHistoryModalTableRootOrRender();
}

function setTradeHistoryPageSize(size: number): void {
  if (!(TRADE_HISTORY_PAGE_SIZE_OPTIONS as readonly number[]).includes(size)) return;
  tradeHistoryPageSize = size;
  tradeHistoryPage = 1;
  patchTradeHistoryModalTableRootOrRender();
}

function getTradeHistoryFilteredTrades(): TradeRecord[] {
  let filtered = [...state.trades];
  if (tradeHistoryFilter.symbol) {
    filtered = filtered.filter(t =>
      t.symbol.toUpperCase().includes(tradeHistoryFilter.symbol.toUpperCase())
    );
  }
  if (tradeHistoryFilter.type) {
    filtered = filtered.filter(t => t.type === tradeHistoryFilter.type);
  }
  const catNeedle = tradeHistoryFilter.otherCategory.trim().toLowerCase();
  if (catNeedle) {
    filtered = filtered.filter((t) => {
      if (t.type !== 'other') return false;
      const c = (t.other_category ?? '').trim().toLowerCase();
      return c.includes(catNeedle);
    });
  }
  if (tradeHistoryFilter.startDate) {
    filtered = filtered.filter(
      (t) => t.trade_date.slice(0, 10) >= tradeHistoryFilter.startDate
    );
  }
  if (tradeHistoryFilter.endDate) {
    filtered = filtered.filter(
      (t) => t.trade_date.slice(0, 10) <= tradeHistoryFilter.endDate
    );
  }
  return filtered;
}

/** 交易记录弹窗 · 盈亏汇总表（按标的 FIFO，盈亏 = 已实现毛额 − 本标的买卖手续费） */
function buildTradeHistorySymbolPnlSummaryTableInnerHtml(): string {
  const rangeOpts: { startDate?: string; endDate?: string } = {};
  if (tradeHistoryFilter.startDate) rangeOpts.startDate = tradeHistoryFilter.startDate;
  if (tradeHistoryFilter.endDate) rangeOpts.endDate = tradeHistoryFilter.endDate;

  const rowsRaw = computeSymbolTradePnlSummaries(state.trades, rangeOpts);
  const dir = tradeHistorySymbolPnlSortDir;
  const key = tradeHistorySymbolPnlSortKey;
  const rows = [...rowsRaw].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'symbol':
        cmp = a.symbol.localeCompare(b.symbol);
        break;
      case 'totalBuy':
        cmp = a.totalBuyAmount - b.totalBuyAmount;
        break;
      case 'totalSell':
        cmp = a.totalSellAmount - b.totalSellAmount;
        break;
      case 'netPnl':
        cmp = a.netPnl - b.netPnl;
        break;
      case 'netPnlRate': {
        const aVal = a.netPnlRate ?? -Infinity;
        const bVal = b.netPnlRate ?? -Infinity;
        cmp = aVal - bVal;
        break;
      }
      default:
        cmp = 0;
    }
    if (cmp !== 0) return cmp * dir;
    return a.symbol.localeCompare(b.symbol);
  });

  let sumBuy = 0;
  let sumSell = 0;
  let sumComm = 0;
  let sumNet = 0;
  for (const r of rows) {
    sumBuy += r.totalBuyAmount;
    sumSell += r.totalSellAmount;
    sumComm += r.totalCommission;
    sumNet += r.netPnl;
  }
  const sumRate = sumBuy !== 0 ? (sumNet / sumBuy) * 100 : null;

  const rangeLabel =
    tradeHistoryFilter.startDate && tradeHistoryFilter.endDate
      ? `${tradeHistoryFilter.startDate} ~ ${tradeHistoryFilter.endDate}`
      : tradeHistoryFilter.startDate
        ? `${tradeHistoryFilter.startDate} 起`
        : tradeHistoryFilter.endDate
          ? `至 ${tradeHistoryFilter.endDate}`
          : '全部时间';

  const bodyRows =
    rows.length === 0
      ? `
    <tr>
      <td colspan="6" style="padding: 40px; text-align: center; color: #94a3b8;">
        暂无买卖记录
      </td>
    </tr>
  `
      : rows
          .map((r) => {
            const netColor = r.netPnl >= 0 ? '#10b981' : '#ef4444';
            const netSign = r.netPnl >= 0 ? '+' : '-';
            const symArg = JSON.stringify(r.symbol);
            const pnlRateDisplay = r.netPnlRate !== null
              ? `<span style="color: ${netColor}; font-size: 0.8rem;">${netSign}${r.netPnlRate.toFixed(2)}%</span>`
              : '—';
            return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 12px;">
          <button type="button" onclick="openTradeHistoryModalForSymbol(${symArg})"
                  style="padding: 0; border: none; background: none; font-weight: 600; color: #667eea; cursor: pointer; font-size: 0.9rem;">
            ${escapeHtml(r.symbol)}
          </button>
        </td>
        <td style="padding: 12px; text-align: right; font-weight: 500; color: #334155;">$${formatNumber(r.totalBuyAmount)}</td>
        <td style="padding: 12px; text-align: right; font-weight: 500; color: #334155;">$${formatNumber(r.totalSellAmount)}</td>
        <td style="padding: 12px; text-align: right; color: #ef4444; font-size: 0.85rem;">
          ${r.totalCommission > 0 ? `-$${formatNumber(r.totalCommission)}` : '—'}
        </td>
        <td style="padding: 12px; text-align: right; font-weight: 600; color: ${netColor};">
          ${netSign}$${formatNumber(Math.abs(r.netPnl))}
        </td>
        <td style="padding: 12px; text-align: right;">${pnlRateDisplay}</td>
      </tr>
    `;
          })
          .join('');

  const totalRow =
    rows.length === 0
      ? ''
      : `
      <tr style="border-top: 2px solid #cbd5e1; background: #f8fafc; font-weight: 600;">
        <td style="padding: 12px;">合计</td>
        <td style="padding: 12px; text-align: right;">$${formatNumber(sumBuy)}</td>
        <td style="padding: 12px; text-align: right;">$${formatNumber(sumSell)}</td>
        <td style="padding: 12px; text-align: right; color: #ef4444;">
          ${sumComm > 0 ? `-$${formatNumber(sumComm)}` : '—'}
        </td>
        <td style="padding: 12px; text-align: right; color: ${sumNet >= 0 ? '#10b981' : '#ef4444'};">
          ${sumNet >= 0 ? '+' : '-'}$${formatNumber(Math.abs(sumNet))}
        </td>
        <td style="padding: 12px; text-align: right; color: ${sumNet >= 0 ? '#10b981' : '#ef4444'};">
          ${sumRate !== null ? `${sumNet >= 0 ? '+' : ''}${sumRate.toFixed(2)}%` : '—'}
        </td>
      </tr>
    `;

  const metaLine = `${escapeHtml(rangeLabel)} · 合计 ${rows.length} 个标的 · FIFO 与累计日历一致（区间内卖出的数量可匹配区间前先入队的买入）`;

  const sortMark = (k: TradeHistorySymbolPnlSortKey): string =>
    tradeHistorySymbolPnlSortKey === k ? (tradeHistorySymbolPnlSortDir === 1 ? ' ▲' : ' ▼') : '';

  const thSortable = (k: TradeHistorySymbolPnlSortKey, label: string, extraTitle = '') =>
    `<th style="padding: 10px 12px; text-align: ${k === 'symbol' ? 'left' : 'right'}; font-size: 0.8rem; color: #64748b; font-weight: 600; background: #ffffff; cursor: pointer; user-select: none; white-space: nowrap;" onclick="setTradeHistorySymbolPnlSort('${k}')" title="点击排序${extraTitle ? ` · ${extraTitle}` : ''}">${label}${sortMark(k)}</th>`;

  const tableSection = `
        <div style="flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;">
          <p style="flex-shrink: 0; margin: 0; padding: 16px 24px 12px; color: #64748b; font-size: 0.8rem;">${metaLine}</p>
          <div style="flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px 8px;">
          <table style="width: 100%; border-collapse: separate; border-spacing: 0; min-width: 680px;">
            <thead style="position: sticky; top: 0; z-index: 2; background: #ffffff;">
              <tr style="box-shadow: inset 0 -2px 0 #e2e8f0;">
                ${thSortable('symbol', '代码')}
                ${thSortable('totalBuy', '总买入金额')}
                ${thSortable('totalSell', '总卖出金额')}
                <th style="padding: 10px 12px; text-align: right; font-size: 0.8rem; color: #64748b; font-weight: 600; background: #ffffff;">总费用</th>
                ${thSortable('netPnl', '盈亏金额', 'FIFO 已实现 − 本标的买卖手续费')}
                ${thSortable('netPnlRate', '盈亏比例', '盈亏金额 / 总买入金额')}
              </tr>
            </thead>
            <tbody>
              ${bodyRows}
              ${totalRow}
            </tbody>
          </table>
          </div>
        </div>`;

  const footerSection = `
        <div style="flex-shrink: 0; padding: 12px 24px 16px; border-top: 1px solid #e2e8f0; background: #f8fafc;">
          <span style="color: #64748b; font-size: 0.85rem;">不含「其它」类收支；其不影响按标的拆分。</span>
        </div>`;

  return tableSection + footerSection;
}

/** 交易记录弹窗内表格 + 分页（供 full render 与股票代码筛选时局部更新共用） */
function buildTradeHistoryModalTableRootInnerHtml(): string {
  if (tradeHistoryModalTab === 'summary') {
    return buildTradeHistorySymbolPnlSummaryTableInnerHtml();
  }
  const filtered = getTradeHistoryFilteredTrades();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / tradeHistoryPageSize));
  if (tradeHistoryPage > totalPages) {
    tradeHistoryPage = totalPages;
  }
  const startIdx = (tradeHistoryPage - 1) * tradeHistoryPageSize;
  const pageItems = filtered.slice(startIdx, startIdx + tradeHistoryPageSize);

  const rows =
    pageItems.length === 0
      ? `
    <tr>
      <td colspan="9" style="padding: 40px; text-align: center; color: #94a3b8;">
        暂无符合条件的交易记录
      </td>
    </tr>
  `
      : pageItems
          .map((trade) => {
            const date = new Date(trade.trade_date).toLocaleDateString('zh-CN');
            const time = new Date(trade.trade_date).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit'
            });
            const isBuy = trade.type === 'buy';
            const isOther = trade.type === 'other';
            const amtCol = isOther
              ? trade.total_amount >= 0
                ? '#10b981'
                : '#ef4444'
              : isBuy
                ? '#334155'
                : '#10b981';
            const amtPrefix = isOther
              ? trade.total_amount >= 0
                ? '+'
                : '-'
              : isBuy
                ? '-'
                : '+';
            const typeLabel = isOther
              ? escapeHtml(trade.other_category ?? '其它')
              : isBuy
                ? '买入'
                : '卖出';
            const typeBg = isOther ? '#6366f1' : isBuy ? '#10b981' : '#ef4444';
            const sharesCell = isOther ? '—' : `${formatNumber(trade.shares)} 股`;
            const priceCell = isOther ? '—' : `@ $${formatNumber(trade.price)}`;
            const nameCell = escapeHtml(
              isOther ? (trade.name || trade.other_category || trade.symbol) : trade.name
            );

            return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 12px; color: #64748b; font-size: 0.85rem;">${date}<br/><span style="font-size: 0.75rem;">${time}</span></td>
        <td style="padding: 12px;">
          <span style="background: ${typeBg}; color: white; padding: 2px 10px; border-radius: 4px; font-size: 0.8rem; font-weight: 600;">
            ${typeLabel}
          </span>
        </td>
        <td style="padding: 12px; font-weight: 600; color: #667eea;">${escapeHtml(trade.symbol)}</td>
        <td style="padding: 12px; color: #334155; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${nameCell}">${nameCell}</td>
        <td style="padding: 12px; text-align: right; font-weight: 600;">${sharesCell}</td>
        <td style="padding: 12px; text-align: right;">${priceCell}</td>
        <td style="padding: 12px; text-align: right; font-weight: 600; color: ${amtCol};">
          ${amtPrefix}$${formatNumber(Math.abs(trade.total_amount))}
        </td>
        <td style="padding: 12px; text-align: right; color: #ef4444; font-size: 0.85rem;">
          ${trade.commission > 0 ? `-$${formatNumber(trade.commission)}` : '-'}
        </td>
        <td style="padding: 12px;">
          <div style="display: flex; gap: 6px;">
            <button onclick="openEditTradeModal(${JSON.stringify(trade).replace(/"/g, '&quot;')})"
                    style="padding: 4px 10px; background: #e0e7ff; border: 1px solid #c7d2fe; border-radius: 4px; color: #4f46e5; cursor: pointer; font-size: 0.8rem;">
              编辑
            </button>
            <button onclick="handleDeleteTrade('${trade.id}', '${trade.symbol.replace(/'/g, "\\'")}')"
                    style="padding: 4px 10px; background: #fee2e2; border: 1px solid #fecaca; border-radius: 4px; color: #ef4444; cursor: pointer; font-size: 0.8rem;">
              删除
            </button>
          </div>
        </td>
      </tr>
    `;
          })
          .join('');

  const pageNumbers = [];
  const maxPageButtons = 5;
  let startPage = Math.max(1, tradeHistoryPage - Math.floor(maxPageButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxPageButtons - 1);
  if (endPage - startPage < maxPageButtons - 1) {
    startPage = Math.max(1, endPage - maxPageButtons + 1);
  }

  for (let i = startPage; i <= endPage; i++) {
    pageNumbers.push(i);
  }

  const pageSizeSelectHtml = TRADE_HISTORY_PAGE_SIZE_OPTIONS.map(
    (n) => `<option value="${n}"${tradeHistoryPageSize === n ? ' selected' : ''}>${n}</option>`
  ).join('');

  const pageNavHtml =
    totalPages > 1
      ? `
      <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
        <button onclick="setTradeHistoryPage(${tradeHistoryPage - 1})" ${tradeHistoryPage === 1 ? 'disabled' : ''}
                style="padding: 6px 12px; border: 1px solid #e2e8f0; background: white; border-radius: 4px; cursor: ${tradeHistoryPage === 1 ? 'not-allowed' : 'pointer'}; color: ${tradeHistoryPage === 1 ? '#cbd5e1' : '#334155'};">
          上一页
        </button>
        ${pageNumbers
          .map(
            (p) => `
          <button onclick="setTradeHistoryPage(${p})" 
                  style="padding: 6px 12px; border: 1px solid ${p === tradeHistoryPage ? '#667eea' : '#e2e8f0'}; background: ${p === tradeHistoryPage ? '#667eea' : 'white'}; color: ${p === tradeHistoryPage ? 'white' : '#334155'}; border-radius: 4px; cursor: pointer; font-weight: ${p === tradeHistoryPage ? '600' : '400'};">
            ${p}
          </button>
        `
          )
          .join('')}
        <button onclick="setTradeHistoryPage(${tradeHistoryPage + 1})" ${tradeHistoryPage === totalPages ? 'disabled' : ''}
                style="padding: 6px 12px; border: 1px solid #e2e8f0; background: white; border-radius: 4px; cursor: ${tradeHistoryPage === totalPages ? 'not-allowed' : 'pointer'}; color: ${tradeHistoryPage === totalPages ? '#cbd5e1' : '#334155'};">
          下一页
        </button>
      </div>`
      : '';

  const tableSection = `
        <div style="flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px;">
          <table style="width: 100%; border-collapse: collapse; min-width: 800px;">
            <thead style="position: sticky; top: 0; background: white; z-index: 1;">
              <tr style="border-bottom: 2px solid #e2e8f0;">
                <th style="padding: 12px; text-align: left; font-size: 0.8rem; color: #64748b; font-weight: 600;">时间</th>
                <th style="padding: 12px; text-align: left; font-size: 0.8rem; color: #64748b; font-weight: 600;">类型</th>
                <th style="padding: 12px; text-align: left; font-size: 0.8rem; color: #64748b; font-weight: 600;">代码</th>
                <th style="padding: 12px; text-align: left; font-size: 0.8rem; color: #64748b; font-weight: 600;">名称</th>
                <th style="padding: 12px; text-align: right; font-size: 0.8rem; color: #64748b; font-weight: 600;">股数</th>
                <th style="padding: 12px; text-align: right; font-size: 0.8rem; color: #64748b; font-weight: 600;">价格</th>
                <th style="padding: 12px; text-align: right; font-size: 0.8rem; color: #64748b; font-weight: 600;">金额</th>
                <th style="padding: 12px; text-align: right; font-size: 0.8rem; color: #64748b; font-weight: 600;">手续费</th>
                <th style="padding: 12px; text-align: center; font-size: 0.8rem; color: #64748b; font-weight: 600;">操作</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>`;

  const footerSection = `
        <div style="flex-shrink: 0; padding: 12px 24px 16px; border-top: 1px solid #e2e8f0; background: #f8fafc;">
          <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <label style="color: #64748b; font-size: 0.85rem; white-space: nowrap;">每页条数</label>
              <select onchange="setTradeHistoryPageSize(parseInt(this.value, 10))"
                      style="padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem; background: white; color: #334155;">
                ${pageSizeSelectHtml}
              </select>
              <span style="color: #64748b; font-size: 0.85rem;">共 ${total} 条</span>
            </div>
            ${pageNavHtml}
          </div>
        </div>`;

  return tableSection + footerSection;
}

function patchTradeHistoryModalTableRoot(): void {
  if (!tradeHistoryModalOpen) return;
  const root = document.getElementById('trade-history-modal-table-root');
  if (!root) {
    render();
    return;
  }
  root.innerHTML = buildTradeHistoryModalTableRootInnerHtml();
}

function patchTradeHistoryModalTableRootOrRender(): void {
  if (!tradeHistoryModalOpen) {
    render();
    return;
  }
  const root = document.getElementById('trade-history-modal-table-root');
  if (!root) {
    render();
    return;
  }
  root.innerHTML = buildTradeHistoryModalTableRootInnerHtml();
}

// 渲染交易历史弹窗
function renderTradeHistoryModal(): string {
  if (!tradeHistoryModalOpen) return '';

  return `
    <div onmousedown="onModalBackdropMouseDown(event, 'tradeHistory')" onmouseup="onModalBackdropMouseUp(event, 'tradeHistory')" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;">
      <div onclick="event.stopPropagation()" style="background: white; border-radius: 12px; width: 100%; max-width: min(1320px, calc(100vw - 40px)); max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);">
        <!-- 头部 -->
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 20px 24px; border-bottom: 1px solid #e2e8f0;">
          <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap; min-width: 0;">
            <h2 style="margin: 0; color: #334155; font-size: 1.25rem;">交易记录</h2>
            <div style="display: inline-flex; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden;">
              <button type="button" onclick="setTradeHistoryModalTab('list')" style="padding: 6px 14px; font-size: 0.82rem; border: none; cursor: pointer;${tradeHistoryModalTab === 'list' ? ' background: #667eea; color: white; font-weight: 600;' : ' background: white; color: #64748b; font-weight: 500;'}">
                明细
              </button>
              <button type="button" onclick="setTradeHistoryModalTab('summary')" style="padding: 6px 14px; font-size: 0.82rem; border: none; border-left: 1px solid #e2e8f0; cursor: pointer;${tradeHistoryModalTab === 'summary' ? ' background: #667eea; color: white; font-weight: 600;' : ' background: white; color: #64748b; font-weight: 500;'}">
                盈亏汇总
              </button>
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
            <button onclick="openOtherTradeModal()" style="padding: 8px 16px; border: 1px solid #c7d2fe; border-radius: 6px; background: #eef2ff; color: #4338ca; font-size: 0.85rem; cursor: pointer;">
              ＋ 其它收支
            </button>
            <button onclick="openImportTradeModal()" style="padding: 8px 16px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; color: #334155; font-size: 0.85rem; cursor: pointer;">
              导入
            </button>
            <button type="button" onclick="void exportTradesToXlsx()" style="padding: 8px 16px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; color: #334155; font-size: 0.85rem; cursor: pointer;">
              导出 xlsx
            </button>
          </div>
          <button onclick="closeTradeHistoryModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #94a3b8; padding: 4px;">&times;</button>
        </div>
        
        <!-- 筛选区域 -->
        <div style="padding: 16px 24px; border-bottom: 1px solid #e2e8f0; background: #f8fafc;">
          ${
            tradeHistoryModalTab === 'summary'
              ? `<p style="margin: 0 0 12px; color: #64748b; font-size: 0.78rem; line-height: 1.45;">盈亏汇总可按下方起止日期限定区间。「代码」「交易类型」「其它类别」不参与本表，仅用于「明细」视图。</p>`
              : ''
          }
          <div style="display: flex; gap: 12px; flex-wrap: nowrap; align-items: flex-end; overflow-x: auto;">
            <div style="flex-shrink: 0;">
              <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.8rem;">股票代码</label>
              <input type="text" id="trade-history-symbol-filter" value="${escapeHtmlAttr(tradeHistoryFilter.symbol)}" oninput="setTradeHistoryFilter('symbol', this.value)" placeholder="如：AAPL"
                     style="padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem; width: 140px;" />
            </div>
            <div style="flex-shrink: 0;">
              <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.8rem;">交易类型</label>
              <select onchange="setTradeHistoryFilter('type', this.value)"
                      style="padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem; min-width: 110px;">
                <option value="" ${!tradeHistoryFilter.type ? 'selected' : ''}>全部</option>
                <option value="buy" ${tradeHistoryFilter.type === 'buy' ? 'selected' : ''}>买入</option>
                <option value="sell" ${tradeHistoryFilter.type === 'sell' ? 'selected' : ''}>卖出</option>
                <option value="other" ${tradeHistoryFilter.type === 'other' ? 'selected' : ''}>其它</option>
              </select>
            </div>
            <div style="flex-shrink: 0;">
              <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.8rem;">其它类别</label>
              <input type="text" id="trade-history-other-category-filter" value="${escapeHtmlAttr(tradeHistoryFilter.otherCategory)}" oninput="setTradeHistoryFilter('otherCategory', this.value)" placeholder="子串匹配"
                     style="padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem; width: 130px;" />
            </div>
            <div style="flex-shrink: 0;">
              <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.8rem;">开始日期</label>
              <input type="date" value="${tradeHistoryFilter.startDate}" onchange="setTradeHistoryFilter('startDate', this.value)"
                     style="padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem;" />
            </div>
            <div style="flex-shrink: 0;">
              <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.8rem;">结束日期</label>
              <input type="date" value="${tradeHistoryFilter.endDate}" onchange="setTradeHistoryFilter('endDate', this.value)"
                     style="padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem;" />
            </div>
            <div style="flex-shrink: 0;">
              <button onclick="resetTradeHistoryFilter()" style="padding: 8px 16px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; color: #64748b; cursor: pointer; font-size: 0.85rem;">
                重置
              </button>
            </div>
          </div>
        </div>
        
        <!-- 表格区域：中间滚动，底部分页条固定（代码 / 其它类别输入时仅替换本节点 innerHTML） -->
        <div id="trade-history-modal-table-root" style="flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding: 0;">
          ${buildTradeHistoryModalTableRootInnerHtml()}
        </div>
      </div>
    </div>
  `;
}

function openOtherTradeModal(): void {
  otherTradeModalOpen = true;
  render();
}

function closeOtherTradeModal(): void {
  otherTradeModalOpen = false;
  render();
}

function submitOtherTradeForm(): void {
  const catEl = document.getElementById('new-other-category') as HTMLInputElement | null;
  const symEl = document.getElementById('new-other-symbol') as HTMLInputElement | null;
  const nameEl = document.getElementById('new-other-name') as HTMLInputElement | null;
  const amtEl = document.getElementById('new-other-amount') as HTMLInputElement | null;
  const feeEl = document.getElementById('new-other-commission') as HTMLInputElement | null;
  const dateEl = document.getElementById('new-other-date') as HTMLInputElement | null;

  const cat = (catEl?.value ?? '').trim();
  const amt = parseFloat(amtEl?.value ?? '');
  const fee = parseFloat(feeEl?.value || '0');
  const rawDt = (dateEl?.value ?? '').trim();
  if (!cat) {
    renderError('请填写类别说明');
    return;
  }
  if (!Number.isFinite(amt) || amt === 0) {
    renderError('金额须为非零数字（正数为入账，负数为扣款）');
    return;
  }
  if (!Number.isFinite(fee) || fee < 0) {
    renderError('手续费须 ≥ 0');
    return;
  }
  let tradeIso: string;
  if (!rawDt) {
    tradeIso = new Date().toISOString();
  } else {
    const tradeIsoCand = parseUserEnteredTradeDatetimeToIso(rawDt);
    const tradeAt = new Date(tradeIsoCand);
    if (Number.isNaN(tradeAt.getTime())) {
      renderError('时间无效');
      return;
    }
    if (tradeAt.getTime() > Date.now()) {
      renderError('时间不能晚于当前时刻');
      return;
    }
    tradeIso = tradeIsoCand;
  }

  const ok = addOtherTradeRecord({
    other_category: cat,
    symbol: symEl?.value,
    name: nameEl?.value,
    total_amount: amt,
    commission: fee,
    trade_date: tradeIso
  });
  if (!ok) {
    renderError('保存失败');
    return;
  }
  loadPnlStatsOnStartup();
  closeOtherTradeModal();
  renderSuccess('已记入其它收支');
  render();
}

function renderOtherTradeModal(): string {
  if (!otherTradeModalOpen) return '';
  const tradeDtNow = formatDatetimeLocalMinute(new Date());
  const tradeDtMax = tradeDtNow;
  return `
    <div onmousedown="onModalBackdropMouseDown(event, 'otherTrade')" onmouseup="onModalBackdropMouseUp(event, 'otherTrade')" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1150; display: flex; align-items: center; justify-content: center; padding: 20px;">
      <div onclick="event.stopPropagation()" style="background: white; border-radius: 12px; width: 100%; max-width: 440px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); padding: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h3 style="margin: 0; color: #334155; font-size: 1.15rem;">新增其它收支</h3>
          <button onclick="closeOtherTradeModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #94a3b8;">&times;</button>
        </div>
        <p style="margin: 0 0 16px 0; color: #64748b; font-size: 0.82rem; line-height: 1.45;">
          用于利息、分红、卡券等自定义项：<strong>正数毛额</strong>表示入账，<strong>负数</strong>表示扣款；不计入 FIFO 持仓，但计入<strong>现金</strong>与<strong>净盈亏</strong>（毛额减去手续费）。
        </p>
        <div style="margin-bottom: 14px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">类别 *</label>
          <input type="text" id="new-other-category" placeholder="如：利息、分红、卡券抵扣…"
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
        </div>
        <div style="margin-bottom: 14px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">关联代码（可选）</label>
          <input type="text" id="new-other-symbol" placeholder="可与标的关联或留空（存为 OTHER）"
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
        </div>
        <div style="margin-bottom: 14px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">备注名称（可选）</label>
          <input type="text" id="new-other-name" placeholder="默认与类别相同"
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
        </div>
        <div style="margin-bottom: 14px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">毛额 USD *</label>
          <input type="number" id="new-other-amount" placeholder="± 金额" step="any"
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;">
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">手续费</label>
            <input type="number" id="new-other-commission" value="0" min="0" step="0.01"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">时间</label>
            <input type="datetime-local" id="new-other-date" value="${tradeDtNow}" max="${tradeDtMax}" step="60"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
        </div>
        <div style="display: flex; gap: 10px;">
          <button type="button" onclick="closeOtherTradeModal()" style="flex: 1; padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; color: #64748b; font-weight: 600; cursor: pointer;">
            取消
          </button>
          <button type="button" onclick="submitOtherTradeForm()" style="flex: 1; padding: 12px; border: none; border-radius: 6px; background: #6366f1; color: white; font-weight: 600; cursor: pointer;">
            保存
          </button>
        </div>
      </div>
    </div>
  `;
}

// 渲染导入交易弹窗
function renderImportTradeModal(): string {
  if (!importTradeModalOpen) return '';
  
  const previewRows = importPreviewData.length > 0 ? importPreviewData.slice(0, 5).map(trade => {
    const date = new Date(trade.trade_date).toLocaleDateString('zh-CN');
    const isOther = trade.type === 'other';
    const isBuy = trade.type === 'buy';
    const label = isOther ? (trade.other_category ?? '其它') : isBuy ? '买入' : '卖出';
    const bg = isOther ? '#6366f1' : isBuy ? '#10b981' : '#ef4444';
    return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px; font-size: 0.85rem; color: #64748b;">${date}</td>
        <td style="padding: 8px;">
          <span style="background: ${bg}; color: white; padding: 1px 6px; border-radius: 3px; font-size: 0.75rem;">
            ${label}
          </span>
        </td>
        <td style="padding: 8px; font-weight: 600; color: #667eea;">${trade.symbol}</td>
        <td style="padding: 8px; font-size: 0.85rem;">${trade.name}</td>
        <td style="padding: 8px; text-align: right; font-size: 0.85rem;">${isOther ? '—' : formatNumber(trade.shares)}</td>
        <td style="padding: 8px; text-align: right; font-size: 0.85rem;">${isOther ? '—' : `$${formatNumber(trade.price)}`}</td>
      </tr>
    `;
  }).join('') : '';
  
  return `
    <div onmousedown="onModalBackdropMouseDown(event, 'importTrade')" onmouseup="onModalBackdropMouseUp(event, 'importTrade')" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 20px;">
      <div onclick="event.stopPropagation()" style="background: white; border-radius: 12px; width: 100%; max-width: 600px; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);">
        <!-- 头部 -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; border-bottom: 1px solid #e2e8f0;">
          <h2 style="margin: 0; color: #334155; font-size: 1.25rem;">导入交易记录</h2>
          <button onclick="closeImportTradeModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #94a3b8; padding: 4px;">&times;</button>
        </div>
        
        <!-- 内容 -->
        <div style="padding: 24px; overflow-y: auto;">
          <!-- 文件选择 -->
          <div style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid #e2e8f0;">
            <label style="display: block; margin-bottom: 8px; color: #334155; font-weight: 600;">Moomoo 导入</label>
            <input type="file" accept=".xlsx,.xls" onchange="handleMoomooTradeImport(event)"
                   style="width: 100%; padding: 12px; border: 2px dashed #cbd5e1; border-radius: 8px; background: #f8fafc;" />
            <p style="margin: 8px 0 0 0; color: #64748b; font-size: 0.82rem;">
              上传 Moomoo（富途）导出的<strong>历史 / 现金账户 xlsx</strong>。仅导入「全部成交」：方向、代码、成交价格（或成交价）、成交金额、成交时间、合计费用；有「成交数量」则优先。
              期权代码中行权价若为 ×1000 的长数字（如 …C40000→C40，…C5000→C5），会自动转为与本应用行情一致的紧凑码。
            </p>
          </div>
          <div style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid #e2e8f0;">
            <label style="display: block; margin-bottom: 8px; color: #334155; font-weight: 600;">BBAE 导入</label>
            <input type="file" accept=".xlsx,.xls" onchange="handleBbaeTradeImport(event)"
                   style="width: 100%; padding: 12px; border: 2px dashed #cbd5e1; border-radius: 8px; background: #f8fafc;" />
            <p style="margin: 8px 0 0 0; color: #64748b; font-size: 0.82rem;">
              上传 BBAE 订单导出 xlsx（可多表）：<strong>股票</strong>表（已成、股票代码、成交价、成交数量、佣金…）；<strong>期权</strong>表的手续费为<strong>套餐外费用 + 期权监管费</strong>（不扣套餐抵扣）；仅有一列「套餐外费用加期权监管费减去套餐抵扣」时读取该格数值。
            </p>
          </div>
          <div style="margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 8px; color: #334155; font-weight: 500;">本应用导出（可选）</label>
            <input type="file" accept=".xlsx,.xls,.csv,.json" onchange="handleTradeBackupImport(event)"
                   style="width: 100%; padding: 12px; border: 2px dashed #e2e8f0; border-radius: 8px; background: #fafafa;" />
            <p style="margin: 8px 0 0 0; color: #94a3b8; font-size: 0.8rem;">优先使用应用内「导出 xlsx」生成的 <strong>交易记录.xlsx</strong>；仍支持旧版 CSV / JSON。</p>
          </div>
          
          <!-- 错误提示 -->
          ${importError ? `
            <div style="padding: 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; color: #ef4444; margin-bottom: 16px;">
              ${importError}
            </div>
          ` : ''}
          
          <!-- 预览 -->
          ${importPreviewData.length > 0 ? `
            <div style="margin-top: 16px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <span style="color: #334155; font-weight: 500;">预览（前 5 条，共 ${importPreviewData.length} 条）</span>
              </div>
              <table style="width: 100%; border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden;">
                <thead>
                  <tr style="background: #f8fafc;">
                    <th style="padding: 8px; text-align: left; font-size: 0.8rem; color: #64748b;">时间</th>
                    <th style="padding: 8px; text-align: left; font-size: 0.8rem; color: #64748b;">类型</th>
                    <th style="padding: 8px; text-align: left; font-size: 0.8rem; color: #64748b;">代码</th>
                    <th style="padding: 8px; text-align: left; font-size: 0.8rem; color: #64748b;">名称</th>
                    <th style="padding: 8px; text-align: right; font-size: 0.8rem; color: #64748b;">数量</th>
                    <th style="padding: 8px; text-align: right; font-size: 0.8rem; color: #64748b;">价格</th>
                  </tr>
                </thead>
                <tbody>
                  ${previewRows}
                </tbody>
              </table>
              ${importPreviewData.length > 5 ? `<p style="margin-top: 8px; color: #64748b; font-size: 0.85rem;">... 还有 ${importPreviewData.length - 5} 条记录</p>` : ''}
            </div>
          ` : ''}
        </div>
        
        <!-- 底部按钮 -->
        <div style="display: flex; gap: 12px; padding: 16px 24px; border-top: 1px solid #e2e8f0;">
          <button onclick="closeImportTradeModal()" style="flex: 1; padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; color: #64748b; font-weight: 500; cursor: pointer;">
            取消
          </button>
          <button onclick="confirmImportTrades()" ${importPreviewData.length === 0 ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : 'style="flex: 1; padding: 12px; border: none; border-radius: 6px; background: #10b981; color: white; font-weight: 600; cursor: pointer;"'} >
            导入 ${importPreviewData.length > 0 ? `(${importPreviewData.length} 条)` : ''}
          </button>
        </div>
      </div>
    </div>
  `;
}

// 渲染编辑交易弹窗
function renderEditTradeModal(): string {
  if (!editTradeModalOpen || !editingTrade) return '';

  const tradeDtForInput = formatDatetimeLocalMinute(new Date(editingTrade.trade_date));
  const editTradeDtMax = formatDatetimeLocalMinute(new Date());

  if (editingTrade.type === 'other') {
    const oc = escapeHtmlAttr(editingTrade.other_category ?? '');
    const net = editingTrade.total_amount - editingTrade.commission;
    const netCol = net >= 0 ? '#10b981' : '#ef4444';
    return `
    <div onmousedown="onModalBackdropMouseDown(event, 'editTrade')" onmouseup="onModalBackdropMouseUp(event, 'editTrade')" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1100; display: flex; align-items: center; justify-content: center;">
      <div onclick="event.stopPropagation()" style="background: white; border-radius: 12px; padding: 24px; width: 90%; max-width: 450px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h3 style="margin: 0; color: #334155;">
            <span style="background: #6366f1; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; margin-right: 8px;">
              其它
            </span>
            ${escapeHtml(editingTrade.other_category ?? '')}
          </h3>
          <button onclick="closeEditTradeModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #94a3b8;">&times;</button>
        </div>

        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">类别 *</label>
          <input type="text" id="edit-other-category" value="${oc}" placeholder="如：利息、分红、卡券"
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">关联代码（可选，空则 OTHER）</label>
          <input type="text" id="edit-other-symbol" value="${escapeHtmlAttr(editingTrade.symbol)}" placeholder="留空或与某标的关联"
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">备注名称</label>
          <input type="text" id="edit-other-name" value="${escapeHtmlAttr(editingTrade.name)}"
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
        </div>

        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">毛额 USD *（正=入账，负=扣款）</label>
          <input type="number" id="edit-other-amount" value="${editingTrade.total_amount}" step="any"
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">手续费</label>
            <input type="number" id="edit-trade-commission" value="${editingTrade.commission}" min="0" step="0.01"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">时间</label>
            <input type="datetime-local" id="edit-trade-date" value="${tradeDtForInput}" max="${editTradeDtMax}" step="60"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
        </div>

        <div style="padding: 12px; background: #f8fafc; border-radius: 6px; margin-bottom: 16px; text-align: center;">
          <span style="color: #64748b; font-size: 0.85rem;">对现金/P&amp;L 净影响: </span>
          <span style="font-weight: 600; color: ${netCol};">${net >= 0 ? '+' : ''}$${formatNumber(net)}</span>
        </div>

        <div style="display: flex; gap: 10px;">
          <button onclick="closeEditTradeModal()"
                  style="flex: 1; padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; color: #64748b; font-weight: 600; cursor: pointer;">
            取消
          </button>
          <button onclick="submitEditTrade()"
                  style="flex: 1; padding: 12px; border: none; border-radius: 6px; background: #667eea; color: white; font-weight: 600; font-size: 1rem; cursor: pointer;">
            保存
          </button>
        </div>
      </div>
    </div>
  `;
  }

  const isBuy = editingTrade.type === 'buy';

  return `
    <div onmousedown="onModalBackdropMouseDown(event, 'editTrade')" onmouseup="onModalBackdropMouseUp(event, 'editTrade')" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1100; display: flex; align-items: center; justify-content: center;">
      <div onclick="event.stopPropagation()" style="background: white; border-radius: 12px; padding: 24px; width: 90%; max-width: 450px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h3 style="margin: 0; color: #334155;">
            <span style="background: ${isBuy ? '#10b981' : '#ef4444'}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; margin-right: 8px;">
              ${isBuy ? '买入' : '卖出'}
            </span>
            编辑 ${editingTrade.symbol}
          </h3>
          <button onclick="closeEditTradeModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #94a3b8;">&times;</button>
        </div>

        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">股票名称</label>
          <input type="text" value="${escapeHtmlAttr(editingTrade.name)}" readonly
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc; color: #334155;" />
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">股数 *</label>
            <input type="number" id="edit-trade-shares" value="${editingTrade.shares}" min="0.01" step="0.01"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">价格 *</label>
            <input type="number" id="edit-trade-price" value="${editingTrade.price}" min="0.01" step="0.01"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">手续费</label>
            <input type="number" id="edit-trade-commission" value="${editingTrade.commission}" min="0" step="0.01"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">交易时间</label>
            <input type="datetime-local" id="edit-trade-date" value="${tradeDtForInput}" max="${editTradeDtMax}" step="60"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
        </div>

        <div id="edit-trade-amount-preview" style="padding: 12px; background: #f8fafc; border-radius: 6px; margin-bottom: 16px; text-align: center;">
          <span style="color: #64748b; font-size: 0.85rem;">金额: </span>
          <span style="font-weight: 600; color: #334155;" id="edit-trade-amount-value">
            ${isBuy ? '-' : '+'}$${formatNumber(editingTrade.shares * editingTrade.price * (isOptionSymbol(editingTrade.symbol) ? 100 : 1))}
          </span>
        </div>

        <div style="display: flex; gap: 10px;">
          <button onclick="closeEditTradeModal()"
                  style="flex: 1; padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; color: #64748b; font-weight: 600; cursor: pointer;">
            取消
          </button>
          <button onclick="submitEditTrade()"
                  style="flex: 1; padding: 12px; border: none; border-radius: 6px; background: #667eea; color: white; font-weight: 600; font-size: 1rem; cursor: pointer;">
            保存修改
          </button>
        </div>
      </div>
    </div>
  `;
}

// 渲染交易表单
function renderTradeForm(): string {
  const tradeDtNow = formatDatetimeLocalMinute(new Date());
  const isBuy = tradeFormType === 'buy';
  const symEsc = escapeHtml(tradeFormSymbol);
  const nameEsc = escapeHtml(tradeFormName);

  const headTitle = tradeFormFreeEntry
    ? `${isBuy ? '买入' : '卖出'}（新建交易）`
    : `${isBuy ? '买入' : '卖出'} ${symEsc}`;

  const symbolBlock = tradeFormFreeEntry
    ? `
        <div class="input-group trade-form-symbol-search" style="position: relative; flex: 2; min-width: 200px; margin-bottom: 16px;">
          <label for="trade-symbol-input">标的代码 *</label>
          <input type="text" id="trade-symbol-input" value="${symEsc}" placeholder="股票 / 期权代码…"
                 autocomplete="off" ${state.loading ? 'disabled' : ''} />
          <div id="trade-stock-suggestions" class="suggestions-dropdown" style="display: none; z-index: 2000;"></div>
        </div>`
    : `
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">股票名称</label>
          <input type="text" value="${nameEsc}" readonly
                 style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc; color: #334155;" />
        </div>`;

  return `
    <div onmousedown="onModalBackdropMouseDown(event, 'tradeForm')" onmouseup="onModalBackdropMouseUp(event, 'tradeForm')" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center;">
      <div onclick="event.stopPropagation()" style="background: white; border-radius: 12px; padding: 24px; width: 90%; max-width: 400px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1); overflow: visible;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h3 style="margin: 0; color: #334155;">${headTitle}</h3>
          <button onclick="closeTradeForm()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #94a3b8;">&times;</button>
        </div>

        ${symbolBlock}
        
        <div style="display: flex; gap: 10px; margin-bottom: 16px;">
          <button onclick="setTradeType('buy')" 
                  style="flex: 1; padding: 10px; border: 2px solid ${isBuy ? '#10b981' : '#e2e8f0'}; border-radius: 6px; background: ${isBuy ? '#ecfdf5' : 'white'}; color: ${isBuy ? '#10b981' : '#64748b'}; font-weight: 600; cursor: pointer;">
            买入
          </button>
          <button onclick="setTradeType('sell')"
                  style="flex: 1; padding: 10px; border: 2px solid ${!isBuy ? '#ef4444' : '#e2e8f0'}; border-radius: 6px; background: ${!isBuy ? '#fef2f2' : 'white'}; color: ${!isBuy ? '#ef4444' : '#64748b'}; font-weight: 600; cursor: pointer;">
            卖出
          </button>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">股数 *</label>
            <input type="number" id="trade-shares" placeholder="0" min="0.01" step="0.01"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">价格 *</label>
            <input type="number" id="trade-price" placeholder="0.00" min="0.01" step="0.01"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">手续费</label>
            <input type="number" id="trade-commission" placeholder="0.00" min="0" step="0.01" value="0"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
          <div>
            <label style="display: block; margin-bottom: 6px; color: #64748b; font-size: 0.85rem;">交易时间</label>
            <input type="datetime-local" id="trade-date" value="${tradeDtNow}" max="${tradeDtNow}" step="60"
                   style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;" />
          </div>
        </div>
        
        <div id="trade-amount-preview" style="padding: 12px; background: #f8fafc; border-radius: 6px; margin-bottom: 16px; text-align: center;">
          <span style="color: #64748b; font-size: 0.85rem;">预计金额: </span>
          <span style="font-weight: 600; color: #334155;">—</span>
        </div>
        
        <button onclick="submitTrade()" 
                style="width: 100%; padding: 12px; border: none; border-radius: 6px; background: ${isBuy ? '#10b981' : '#ef4444'}; color: white; font-weight: 600; font-size: 1rem; cursor: pointer;">
          确认${isBuy ? '买入' : '卖出'}
        </button>
      </div>
    </div>
  `;
}

function renderHoldingsTableBody(): string {
  const totalAssets = state.totalValue + state.cash;
  const sorted = [...state.stocks].sort(compareStocksForTable);
  const groupMap = new Map<string, Stock[]>();
  for (const s of sorted) {
    const u = getUnderlyingForStock(s);
    if (!groupMap.has(u)) groupMap.set(u, []);
    groupMap.get(u)!.push(s);
  }
  let keys = [...groupMap.keys()];
  keys.sort((a, b) => {
    if (tableSortKey === 'symbol') {
      return a.localeCompare(b) * tableSortDir;
    }
    const wa = getGroupPortfolioPercent(a, groupMap, totalAssets);
    const wb = getGroupPortfolioPercent(b, groupMap, totalAssets);
    if (wa !== wb) return (wa - wb) * tableSortDir;
    return a.localeCompare(b) * tableSortDir;
  });

  const rows: string[] = [];
  const cashWeightPct = totalAssets > 0 ? (state.cash / totalAssets) * 100 : 0;

  let groupIndex = 0;
  for (const u of keys) {
    const items = groupMap.get(u)!;
    const isNotFirstGroup = groupIndex > 0;
    groupIndex += 1;

    for (let i = 0; i < items.length; i++) {
      const stock = items[i];
      const sepTop = isNotFirstGroup && i === 0;
      const pnl = computeLinePnL(stock);
      const sig = stock.signal ?? 'hold';
      const trStyles = [
        stock.type === 'option' ? 'background: rgba(102, 126, 234, 0.05);' : '',
        sepTop ? 'border-top: 2px solid #cbd5e1;' : ''
      ]
        .filter(Boolean)
        .join(' ');

      const typeInner =
        stock.type === 'option'
          ? '<span style="background: #667eea; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem;">期权</span>'
          : stock.instrumentType
            ? `<span style="background: #0ea5e9; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem;">${escapeHtml(stock.instrumentType)}</span>`
            : '<span style="background: #10b981; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem;">股票</span>';

      const sharesInner = `<div style="font-weight: 600;">${formatNumber(stock.shares)}</div>${
        stock.costLots && stock.costLots.length > 1
          ? `<div style="font-size: 0.65rem; color: #64748b; margin-top: 2px;">${stock.costLots.length} 笔合计</div>`
          : ''
      }`;

      const costInner = `<div style="font-weight: 600;">${
        stock.avgCost !== undefined && stock.avgCost !== null && !Number.isNaN(Number(stock.avgCost))
          ? `$${formatNumber(stock.avgCost)}`
          : '—'
      }</div>${
        stock.costLots && stock.costLots.length > 1
          ? `<div style="font-size: 0.65rem; color: #94a3b8; margin-top: 2px;">加权平均</div>`
          : ''
      }`;

      const optinfoInner =
        stock.type === 'option' && stock.optionStrike
          ? `${stock.optionType === 'C' ? 'Call' : 'Put'} $${stock.optionStrike}<br/><span style="color: #999;">${stock.optionExpiry || ''}</span>`
          : '-';

      const weightRowspanTd =
        i === 0
          ? `<td rowspan="${items.length}" class="${holdingsCellClass('weight')}" style="font-weight: 600; color: #4338ca; vertical-align: middle; text-align: center;" title="同标的合并持仓市值 ÷ 总资产（含现金）">${maskOr('weight', formatPercent(stock.weight))}</td>`
          : '';

      const symEsc = stock.symbol.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

      rows.push(`
        <tr${trStyles ? ` style="${trStyles}"` : ''}>
          <td class="${holdingsCellClass('type')}">${maskOr('type', typeInner)}</td>
          ${
            columnVisibility.symbol
              ? `<td class="${holdingsCellClass('symbol')}" style="font-weight: 600; color: #667eea; cursor: grab;"
              draggable="true"
              ondragstart="symbolDragStart(event, '${symEsc}')"
              ondragover="symbolDragOver(event)"
              ondrop="symbolDropOnRow(event, '${symEsc}')"
              ondragend="symbolDragEnd()"
              title="拖动代码到另一条持仓，合并为同一标的">
            <span style="display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap;">
              <span>${stock.symbol}</span>
              ${
                stock.groupWith
                  ? `<button type="button" onclick="clearGroupOverride('${symEsc}')" title="恢复自动分组" style="padding: 0 5px; font-size: 0.65rem; border: 1px solid #e5e7eb; border-radius: 4px; background: #fff; cursor: pointer; color: #64748b;">↺</button>`
                  : ''
              }
            </span>
          </td>`
              : `<td class="${holdingsCellClass('symbol')}" style="color: #94a3b8;">${HOLDINGS_DATA_MASK_HTML}</td>`
          }
          <td class="${holdingsCellClass('shares')}" style="text-align: center; vertical-align: middle;">${maskOr('shares', sharesInner)}</td>
          <td class="${holdingsCellClass('cost')}" style="text-align: center; vertical-align: middle;">${maskOr('cost', costInner)}</td>
          ${
            columnVisibility.price
              ? `<td class="${holdingsCellClass('price')}" style="font-weight: 600;">
            <span id="price-${stock.symbol}">$${formatNumber(stock.currentPrice)}</span>
            <button type="button" onclick="refreshSingleStock('${symEsc}')" 
                    style="margin-left: 4px; padding: 2px 6px; font-size: 0.7rem; background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 4px; cursor: pointer;">
              ↻
            </button>
          </td>`
              : `<td class="${holdingsCellClass('price')}" style="font-weight: 600;">${HOLDINGS_DATA_MASK_HTML}</td>`
          }
          <td class="${holdingsCellClass('pnl')}" style="font-size: 0.9rem;">${maskOr('pnl', formatPnLCell(pnl))}</td>
          <td class="${holdingsCellClass('pnlPct')}" style="font-size: 0.9rem;">${maskOr('pnlPct', formatPnLPercentCell(computeLinePnLPercent(stock)))}</td>
          <td class="${holdingsCellClass('dailyPnl')}" style="font-size: 0.9rem;">${maskOr('dailyPnl', formatPnLCell(computePositionDailyPnL(stock)))}</td>
          <td class="${holdingsCellClass('dailyPnlPct')}" style="font-size: 0.9rem;">${maskOr('dailyPnlPct', formatPnLPercentCell(computePositionDailyPnLPct(stock)))}</td>
          ${
            columnVisibility.position
              ? `<td class="${holdingsCellClass('position')}" style="font-weight: 600; color: #059669;" id="position-${stock.symbol}">$${formatNumber(stock.position)}</td>`
              : `<td class="${holdingsCellClass('position')}" style="font-weight: 600; color: #059669;">${HOLDINGS_DATA_MASK_HTML}</td>`
          }
          ${weightRowspanTd}
          ${
            columnVisibility.target
              ? `<td class="${holdingsCellClass('target')}">
            <input type="number" value="${formatTargetInputValue(stock.targetPrice)}" placeholder="—"
                   onchange="updateStock('${symEsc}', 'targetPrice', this.value)" 
                   style="width: 88px; padding: 6px; border: 1px solid #e5e7eb; border-radius: 6px; text-align: center;"
                   step="0.01" min="0" />
          </td>`
              : `<td class="${holdingsCellClass('target')}">${HOLDINGS_DATA_MASK_HTML}</td>`
          }
          <td class="${holdingsCellClass('optinfo')}" style="font-size: 0.8rem; color: #666;">${maskOr('optinfo', optinfoInner)}</td>
          ${
            columnVisibility.signal
              ? `<td class="${holdingsCellClass('signal')}">
            <select onchange="updateStock('${symEsc}', 'signal', this.value)"
                    style="padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 0.85rem; max-width: 88px;">
              <option value="buy" ${sig === 'buy' ? 'selected' : ''}>买入</option>
              <option value="hold" ${sig === 'hold' ? 'selected' : ''}>持有</option>
              <option value="sell" ${sig === 'sell' ? 'selected' : ''}>卖出</option>
            </select>
          </td>`
              : `<td class="${holdingsCellClass('signal')}">${HOLDINGS_DATA_MASK_HTML}</td>`
          }
          ${
            columnVisibility.actions
              ? `<td class="holdings-actions-cell ${holdingsCellClass('actions')}">
            <div class="holdings-actions-btns">
              <button type="button" class="btn btn-buy holdings-action-btn" title="记录买入" aria-label="记录买入" 
                      onclick="openTradeForm('${symEsc}', '${escapeHtml(stock.name).replace(/'/g, "\\'")}', 'buy')"
                      style="background: #10b981; color: white; border: none;">买</button>
              <button type="button" class="btn btn-sell holdings-action-btn" title="记录卖出" aria-label="记录卖出"
                      onclick="openTradeForm('${symEsc}', '${escapeHtml(stock.name).replace(/'/g, "\\'")}', 'sell')"
                      style="background: #ef4444; color: white; border: none;">卖</button>
              <button type="button" class="btn holdings-action-btn" title="查看该标的最近交易记录" aria-label="查看该标的交易记录"
                      onclick="openTradeHistoryModalForSymbol('${symEsc}')"
                      style="background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe;">记录</button>
            </div>
          </td>`
              : `<td class="holdings-actions-cell ${holdingsCellClass('actions')}">${HOLDINGS_DATA_MASK_HTML}</td>`
          }
        </tr>
      `);
    }
  }

  rows.push(`
    <tr style="background: rgba(234, 179, 8, 0.12);">
      <td class="${holdingsCellClass('type')}">${maskOr('type', '<span style="background: #eab308; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem;">现金</span>')}</td>
      <td class="${holdingsCellClass('symbol')}" style="font-weight: 600; color: #a16207;">${maskOr('symbol', 'CASH')}</td>
      <td class="${holdingsCellClass('shares')}" style="color: #94a3b8;">${maskOr('shares', '—')}</td>
      <td class="${holdingsCellClass('cost')}" style="color: #94a3b8;">${maskOr('cost', '—')}</td>
      <td class="${holdingsCellClass('price')}" style="color: #94a3b8;">${maskOr('price', '—')}</td>
      <td class="${holdingsCellClass('pnl')}" style="color: #94a3b8;">${maskOr('pnl', '—')}</td>
      <td class="${holdingsCellClass('pnlPct')}" style="color: #94a3b8;">${maskOr('pnlPct', '—')}</td>
      <td class="${holdingsCellClass('dailyPnl')}" style="color: #94a3b8;">${maskOr('dailyPnl', '—')}</td>
      <td class="${holdingsCellClass('dailyPnlPct')}" style="color: #94a3b8;">${maskOr('dailyPnlPct', '—')}</td>
      <td class="${holdingsCellClass('position')}" style="font-weight: 700; color: #0f766e;">${maskOr('position', `$${formatNumber(state.cash)}`)}</td>
      <td class="${holdingsCellClass('weight')}" style="font-weight: 700; color: #4338ca;">${maskOr('weight', formatPercent(cashWeightPct))}</td>
      <td class="${holdingsCellClass('target')}" style="color: #94a3b8;">${maskOr('target', '—')}</td>
      <td class="${holdingsCellClass('optinfo')}" style="color: #94a3b8;">${maskOr('optinfo', '—')}</td>
      <td class="${holdingsCellClass('signal')}" style="color: #94a3b8;">${maskOr('signal', '—')}</td>
      <td class="holdings-actions-cell ${holdingsCellClass('actions')}" style="color: #94a3b8;">${maskOr('actions', '—')}</td>
    </tr>
  `);

  return rows.join('');
}

// 函数：更新现金
function updateCash(value: number): void {
  state.cash = value;
  calculateTotals();
  saveToStorage();
  render();
}

// 函数：更新股票价格
async function updateStockPrices(): Promise<void> {
  if (state.stocks.length === 0) return;
  
  state.loading = true;
  render();
  
  try {
    const stockDataList = await fetchBatchStockData(state.stocks);
    
    state.stocks = state.stocks.map(stock => {
      const data = stockDataList.find((d: any) => d.symbol === stock.symbol);
      if (data && data.price > 0) {
        const ch =
          typeof data.change === 'number' && Number.isFinite(data.change) ? data.change : undefined;
        const chPct =
          typeof data.changePercent === 'number' && Number.isFinite(data.changePercent)
            ? data.changePercent
            : undefined;
        return {
          ...stock,
          currentPrice: data.price,
          quoteChangePerShare: ch,
          quoteChangePercent: chPct,
          ...(stock.type === 'option' ? { name: data.name } : {})
        };
      }
      return stock;
    });
    
    calculateTotals();
    renderSuccess('股票价格已更新');
  } catch (error) {
    renderError('更新股票价格失败，请稍后重试');
  } finally {
    state.loading = false;
    render();
  }
}

// 函数：添加股票
async function addStock(): Promise<void> {
  const symbolInput = document.getElementById('symbol') as HTMLInputElement;
  const sharesInput = document.getElementById('shares') as HTMLInputElement;
  const targetPriceInput = document.getElementById('targetPrice') as HTMLInputElement;
  
  const symbol = symbolInput.value.trim().toUpperCase();
  const shares = parseFloat(sharesInput.value) || 0;
  const targetRaw = targetPriceInput.value.trim();
  const targetPrice =
    targetRaw === ''
      ? undefined
      : (() => {
          const n = parseFloat(targetRaw);
          return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
        })();
  
  if (!symbol) {
    renderError('请输入股票代码或期权代码');
    return;
  }
  
  // 检查是否已存在
  if (state.stocks.find(s => s.symbol === symbol)) {
    pendingSearchPick = null;
    renderError('该标的已在持仓列表中');
    return;
  }
  
  state.loading = true;
  render();
  
  try {
    // 判断是否是期权
    const isOption = selectedOptionData.strike !== undefined;
    let stockData: StockData;
    
    if (isOption) {
      // 期权：使用 Polygon.io API 获取期权价格
      try {
        const response = await fetch(apiUrl(`api/option/${encodeURIComponent(symbol)}`));
        if (response.ok) {
          const optionData = await response.json();
          stockData = {
            symbol: optionData.symbol,
            name: optionData.name,
            price: optionData.price,
            change: optionData.change,
            changePercent: optionData.changePercent
          };
        } else {
          // 如果期权数据获取失败，使用标的股票价格作为参考
          const underlying = symbol.match(/^[A-Z]+/)?.[0] || symbol;
          stockData = await fetchStockDataFromAPI(underlying);
          stockData.name = `${getStockDisplayName(underlying)} 期权`;
        }
      } catch {
        // 获取期权数据失败，使用标的股票价格
        const underlying = symbol.match(/^[A-Z]+/)?.[0] || symbol;
        stockData = await fetchStockDataFromAPI(underlying);
        stockData.name = `${getStockDisplayName(underlying)} 期权`;
      }
    } else {
      stockData = await fetchStockDataFromAPI(symbol);
    }
    
    const underlying = symbol.match(/^[A-Z]+/)?.[0] || symbol;
    const pick =
      pendingSearchPick && pendingSearchPick.symbol === symbol ? pendingSearchPick : null;

    const newStock: Stock = {
      symbol,
      name: isOption
        ? `${getStockDisplayName(underlying)} 期权`
        : (pick?.name ?? stockData.name ?? symbol),
      shares,
      targetPrice,
      avgCost: undefined,
      signal: 'hold',
      currentPrice: stockData.price || 0,
      position: 0,
      weight: 0,
      type: isOption ? 'option' : 'stock',
      optionStrike: selectedOptionData.strike,
      optionExpiry: selectedOptionData.expiry,
      optionType: selectedOptionData.type,
      instrumentType: isOption ? undefined : pick?.instrumentType,
      quoteChangePerShare:
        typeof stockData.change === 'number' && Number.isFinite(stockData.change)
          ? stockData.change
          : undefined,
      quoteChangePercent:
        typeof stockData.changePercent === 'number' && Number.isFinite(stockData.changePercent)
          ? stockData.changePercent
          : undefined
    };

    pendingSearchPick = null;

    state.stocks.push(newStock);
    
    // 清空输入框
    symbolInput.value = '';
    sharesInput.value = '';
    targetPriceInput.value = '';
    selectedOptionData = {};
    clearOptionInfoDisplay();
    
    calculateTotals();
    renderSuccess(`已添加 ${symbol}`);
  } catch (error) {
    renderError('添加失败，请检查代码是否正确');
  } finally {
    state.loading = false;
    render();
    void refreshFinnhubCanonicalEquivalents();
  }
}

function setTableSort(key: TableSortKey): void {
  if (tableSortKey === key) {
    tableSortDir = tableSortDir === 1 ? -1 : 1;
  } else {
    tableSortKey = key;
    tableSortDir = 1;
  }
  render();
}

// 函数：更新持仓字段（数值、目标价、成本、评级等）
function updateStock(symbol: string, field: string, value: string | number): void {
  const stock = state.stocks.find(s => s.symbol === symbol);
  if (!stock) return;

  if (field === 'signal') {
    stock.signal = value as TradeSignal;
  } else if (field === 'targetPrice') {
    const t = String(value).trim();
    if (t === '') {
      stock.targetPrice = undefined;
    } else {
      const n = parseFloat(t);
      stock.targetPrice = Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
    }
  } else if (field === 'avgCost') {
    const t = String(value).trim();
    if (t === '') {
      stock.avgCost = undefined;
    } else {
      const n = parseFloat(t);
      stock.avgCost = Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
    }
  } else if (field === 'shares') {
    stock.shares = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
  } else {
    (stock as unknown as Record<string, string | number>)[field] = value;
  }
  calculateTotals();
  render();
}

// 函数：渲染应用
function render(): void {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="container">
      <div class="header" style="text-align: center; margin-bottom: 30px;">
          <h1>美股持仓管理</h1>
          <p>实时查询股票价格，计算持仓与仓位。数据保存在服务端，可通过 portal 统一访问。</p>
      </div>
      
      <div class="card">
        <div class="input-section">
          <div class="input-group" style="position: relative; flex: 2; min-width: 200px;">
            <label for="symbol">搜索代码（可选，预填「新增交易」）</label>
            <input type="text" id="symbol" placeholder="股票 / 期权代码…" autocomplete="off" ${state.loading ? 'disabled' : ''} />
            <div id="stock-suggestions" class="suggestions-dropdown"></div>
          </div>
          <div class="input-actions" style="align-self: flex-end;">
            <button class="btn btn-secondary" onclick="updateStockPrices()" ${state.loading || state.stocks.length === 0 ? 'disabled' : ''}>
              ${state.loading ? '<span class="loading"></span>' : '刷新价格'}
            </button>
          </div>
          <div id="option-info" style="display: none; margin-top: 10px;"></div>
        </div>
        
        <div class="export-toolbar">
          <button class="btn btn-secondary" onclick="exportToJSON()" style="padding: 8px 16px; font-size: 0.85rem;" ${state.stocks.length === 0 && state.cash === 0 ? 'disabled' : ''}>
            导出 JSON
          </button>
          <button class="btn btn-secondary" onclick="exportToCSV()" style="padding: 8px 16px; font-size: 0.85rem;" ${state.stocks.length === 0 && state.cash === 0 ? 'disabled' : ''}>
            导出 CSV
          </button>
          <label class="btn btn-secondary" style="padding: 8px 16px; font-size: 0.85rem; cursor: pointer;">
            导入 JSON
            <input type="file" accept=".json" onchange="importFromJSON(event)" style="display: none;" />
          </label>
          <label class="btn btn-secondary" style="padding: 8px 16px; font-size: 0.85rem; cursor: pointer;">
            导入 CSV
            <input type="file" accept=".csv" onchange="importFromCSV(event)" style="display: none;" />
          </label>
        </div>
        
        ${renderTradePanel()}
          
          ${state.stocks.length === 0 ? `
          <div class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <h3>暂无持仓</h3>
            <p>请点击上方「新增买入」记录首笔买入，持仓将按交易自动汇总（FIFO 成本）。</p>
            <p style="font-size: 0.85rem; color: #888; margin-top: 8px;">期权格式示例: AAPL250530C150</p>
          </div>
        ` : `
          <div class="holdings-section-head" style="margin-bottom: 16px;">
            <h3 style="margin: 0;">持仓明细</h3>
            <p class="holdings-hint" style="margin: 8px 0 0 0; font-size: 0.82rem; color: #64748b;">持仓数据来自交易记录；股数与成本随买卖自动更新。可拖动「代码」合并分组。</p>
          </div>
          ${renderHoldingsColumnTogglePanel()}
          <div class="dashboard-summary-toggle-row">
            <label class="holdings-col-toggle-label">
              <input type="checkbox" ${dashboardSummaryVisible ? 'checked' : ''}
                     onchange="setDashboardSummaryVisible(this.checked)" />
              <span>显示顶部看板数据（总资产、市值、盈亏、现金）</span>
            </label>
          </div>
          ${
            dashboardSummaryVisible
              ? `
          <div class="summary" style="margin-bottom: 20px;">
            <div class="summary-card" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
              <h3>总资产</h3>
              <div class="value">$${formatNumber(state.totalValue + state.cash)}</div>
            </div>
            <div class="summary-card" style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);">
              <h3>股票市值</h3>
              <div class="value">$${formatNumber(state.stockMarketValue)}</div>
            </div>
            <div class="summary-card" style="background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%);">
              <h3>期权市值</h3>
              <div class="value">$${formatNumber(state.optionMarketValue)}</div>
            </div>
            <div class="summary-card" style="background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%);">
              <h3>总盈亏</h3>
              <div class="value" style="font-size: 1.75rem;">${
                state.totalPnl === null
                  ? '<span style="opacity:0.85;">—</span>'
                  : formatTotalPnlSummaryHtml(state.totalPnl)
              }</div>
              <div style="font-size: 0.72rem; opacity: 0.92; margin-top: 6px;">${
                state.totalPnl === null
                  ? '填写「成本」后汇总'
                  : state.stocks.some(s => computeLinePnL(s) === null)
                    ? '未含未填成本行'
                    : '已填成本持仓合计'
              }</div>
            </div>
            <div class="summary-card">
              <h3>现金</h3>
              <div class="value" style="display: flex; align-items: center; gap: 4px;">
                <span style="font-size: 0.9rem;">$</span>
                <input type="number" value="${state.cash}" 
                       onchange="updateCash(parseFloat(this.value) || 0)" 
                       style="width: 140px; min-width: 120px; padding: 4px 10px; border: 1px solid rgba(255,255,255,0.3); border-radius: 6px; background: rgba(255,255,255,0.15); color: white; font-size: 1.1rem; font-weight: 600;"
                       step="0.01" min="0" />
              </div>
              <div style="font-size: 0.72rem; opacity: 0.95; margin-top: 6px;">
                占组合 ${formatPercent(state.totalValue + state.cash > 0 ? (state.cash / (state.totalValue + state.cash)) * 100 : 0)}
              </div>
            </div>
          </div>
          `
              : ''
          }
          
          <div class="table-container">
            <table class="holdings-table">
              <colgroup>
                <col class="holdings-col-type" />
                <col class="holdings-col-symbol" />
                <col class="holdings-col-shares" />
                <col class="holdings-col-cost" />
                <col class="holdings-col-price" />
                <col class="holdings-col-pnl" />
                <col class="holdings-col-pnl-pct" />
                <col class="holdings-col-daily-pnl" />
                <col class="holdings-col-daily-pnl-pct" />
                <col class="holdings-col-pos" />
                <col class="holdings-col-weight" />
                <col class="holdings-col-target" />
                <col class="holdings-col-optinfo" />
                <col class="holdings-col-signal" />
                <col class="holdings-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th class="${holdingsCellClass('type')}">类型</th>
                  <th class="${holdingsCellClass('symbol')}" style="cursor: pointer; user-select: none; white-space: nowrap;" onclick="setTableSort('symbol')" title="按标的代码排序">
                    代码${tableSortKey === 'symbol' ? (tableSortDir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                  <th class="${holdingsCellClass('shares')}" title="多笔买入合计股数/张数，见「编辑」">股数</th>
                  <th class="${holdingsCellClass('cost')}" title="多笔买入的加权平均成本">成本</th>
                  <th class="${holdingsCellClass('price')}">现价</th>
                  <th class="${holdingsCellClass('pnl')}">盈亏</th>
                  <th class="${holdingsCellClass('pnlPct')}" title="(现价 − 成本) ÷ 成本">盈亏比例</th>
                  <th class="${holdingsCellClass('dailyPnl')}" title="行情当日每股涨跌 × 持仓；未点击刷新或未拉取时为 —">当日盈亏</th>
                  <th class="${holdingsCellClass('dailyPnlPct')}" title="当日涨跌幅 %（Finnhub 股票为相对昨收；期权为接口返回口径）">当日盈亏比例</th>
                  <th class="${holdingsCellClass('position')}">持仓</th>
                  <th class="${holdingsCellClass('weight')}" style="cursor: pointer; user-select: none; white-space: nowrap;" onclick="setTableSort('weight')" title="按同标的合计占总资产比例排序">
                    仓位 / 占比${tableSortKey === 'weight' ? (tableSortDir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                  <th class="${holdingsCellClass('target')}">1y目标价</th>
                  <th class="${holdingsCellClass('optinfo')}">期权信息</th>
                  <th class="${holdingsCellClass('signal')}">打分</th>
                  <th class="${holdingsCellClass('actions')}">操作</th>
                </tr>
              </thead>
              <tbody>
                ${renderHoldingsTableBody()}
              </tbody>
            </table>
          </div>
        `}
        
        <!-- 交易历史记录弹窗 -->
        ${renderTradeHistoryModal()}
        
        ${renderOtherTradeModal()}
        
        <!-- 导入交易弹窗 -->
        ${renderImportTradeModal()}
        
        <!-- 编辑交易弹窗 -->
        ${renderEditTradeModal()}
        
        <!-- 交易表单弹窗 -->
        ${tradePanelOpen ? renderTradeForm() : ''}
      </div>
    </div>
  `;
  
  // 自动保存
  saveToStorage();
  
  // 每次渲染后重新设置下拉搜索事件
  setupStockSearchEvents();
  setupTradeFormSymbolSearchEvents();
  setupPnlLineChartInteractions();
}

// 初始化应用（服务端持久化）
async function init(): Promise<void> {
  await loadPersistedData();
  migratePortfolioStocksToTradesIfNeeded();
  syncStocksFromTrades();
  loadPnlStatsOnStartup();
  render();
  void refreshFinnhubCanonicalEquivalents();
}

void init();

// 暴露全局函数供 HTML 调用
(window as any).addStock = addStock;
(window as any).removeStock = removeStock;
(window as any).updateStock = updateStock;
(window as any).updateStockPrices = updateStockPrices;
(window as any).updateCash = updateCash;
(window as any).refreshSingleStock = refreshSingleStock;
(window as any).setTableSort = setTableSort;
(window as any).symbolDragStart = symbolDragStart;
(window as any).symbolDragOver = symbolDragOver;
(window as any).symbolDragEnd = symbolDragEnd;
(window as any).symbolDropOnRow = symbolDropOnRow;
(window as any).clearGroupOverride = clearGroupOverride;
(window as any).selectStock = selectStock;
(window as any).exportToJSON = exportToJSON;
(window as any).exportToCSV = exportToCSV;
(window as any).importFromJSON = importFromJSON;
(window as any).importFromCSV = importFromCSV;
(window as any).highlightSuggestion = highlightSuggestion;
(window as any).highlightTradeFormSuggestion = highlightTradeFormSuggestion;
(window as any).pickTradeFormSymbol = pickTradeFormSymbol;
(window as any).openCostLotsEditor = openCostLotsEditor;
(window as any).setHoldingsColumnVisible = setHoldingsColumnVisible;
(window as any).setDashboardSummaryVisible = setDashboardSummaryVisible;
(window as any).openTradeForm = openTradeForm;
(window as any).openNewTradeForm = openNewTradeForm;
(window as any).closeTradeForm = closeTradeForm;
(window as any).setTradeType = setTradeType;
(window as any).submitTrade = submitTrade;
(window as any).handleDeleteTrade = handleDeleteTrade;
(window as any).refreshPnlStats = refreshPnlStats;
(window as any).setPnlQueryStartDate = setPnlQueryStartDate;
(window as any).setPnlQueryEndDate = setPnlQueryEndDate;
(window as any).resetPnlQuery = resetPnlQuery;
(window as any).setPnlVizMode = setPnlVizMode;
(window as any).shiftPnlCalendarMonth = shiftPnlCalendarMonth;
(window as any).resetPnlCalendarMonth = resetPnlCalendarMonth;
(window as any).setPnlCalendarYmFromDom = setPnlCalendarYmFromDom;
(window as any).setPnlCalendarYearFocusOnlyFromDom = setPnlCalendarYearFocusOnlyFromDom;
(window as any).setPnlCalendarYmSelect = setPnlCalendarYmSelect;
(window as any).setPnlCalendarYearFocusSelect = setPnlCalendarYearFocusSelect;
(window as any).setPnlCalendarGranularity = setPnlCalendarGranularity;
(window as any).shiftPnlCalendarYearFocus = shiftPnlCalendarYearFocus;
(window as any).resetPnlLineChartViewport = resetPnlLineChartViewport;
(window as any).openTradeHistoryModal = openTradeHistoryModal;
(window as any).openTradeHistoryModalForSymbol = openTradeHistoryModalForSymbol;
(window as any).openTradeHistoryModalForCalendarDay = openTradeHistoryModalForCalendarDay;
(window as any).openTradeHistoryModalForCalendarMonth = openTradeHistoryModalForCalendarMonth;
(window as any).closeTradeHistoryModal = closeTradeHistoryModal;
(window as any).setTradeHistoryModalTab = setTradeHistoryModalTab;
(window as any).setTradeHistorySymbolPnlSort = setTradeHistorySymbolPnlSort;
(window as any).setTradeHistoryFilter = setTradeHistoryFilter;
(window as any).resetTradeHistoryFilter = resetTradeHistoryFilter;
(window as any).setTradeHistoryPage = setTradeHistoryPage;
(window as any).setTradeHistoryPageSize = setTradeHistoryPageSize;
(window as any).openEditTradeModal = openEditTradeModal;
(window as any).closeEditTradeModal = closeEditTradeModal;
(window as any).submitEditTrade = submitEditTrade;
(window as any).exportTradesToXlsx = exportTradesToXlsx;
(window as any).onModalBackdropMouseDown = onModalBackdropMouseDown;
(window as any).onModalBackdropMouseUp = onModalBackdropMouseUp;
(window as any).openOtherTradeModal = openOtherTradeModal;
(window as any).closeOtherTradeModal = closeOtherTradeModal;
(window as any).submitOtherTradeForm = submitOtherTradeForm;
(window as any).openImportTradeModal = openImportTradeModal;
(window as any).closeImportTradeModal = closeImportTradeModal;
(window as any).handleMoomooTradeImport = handleMoomooTradeImport;
(window as any).handleBbaeTradeImport = handleBbaeTradeImport;
(window as any).handleTradeBackupImport = handleTradeBackupImport;
(window as any).confirmImportTrades = confirmImportTrades;

// 下拉搜索相关变量
let selectedIndex = -1;
/** 与当前下拉内容一致，供键盘上下键/回车使用（含 Finnhub 合并结果） */
let lastSearchSuggestions: SuggestionItem[] = [];
let searchDebounceId: ReturnType<typeof setTimeout> | null = null;

/** 新建交易弹窗内标的代码搜索（与顶栏搜索同逻辑，独立下拉避免与 #symbol 冲突） */
let tradeFormSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
let lastTradeFormSearchSuggestions: SuggestionItem[] = [];
let tradeFormSuggestionSelectedIndex = -1;
/** 每次输入或选中一项后递增，用于丢弃已失效的异步搜索结果，避免选中后下拉又被打开 */
let tradeFormSymbolSearchSeq = 0;

// 函数：过滤股票
interface SuggestionItem {
  symbol: string;
  name: string;
  /** Symbol Search 返回的 type，如 ETP */
  instrumentType?: string;
  optionStrike?: number;
  optionExpiry?: string;
  optionType?: 'C' | 'P';
}

/** 仅当整段输入为完整期权码时返回一条建议；仅股票代码时返回空，不在此展示期权 */
function filterOptionPattern(query: string): SuggestionItem[] {
  if (!query.trim()) return [];

  const upperQuery = query.toUpperCase().trim();
  const results: SuggestionItem[] = [];

  const optionMatch = upperQuery.match(/^([A-Z]{1,5})(\d{6})([CP])(\d+(?:\.\d+)?)$/);
  if (optionMatch) {
    const [, symbol, expiry, type, strike] = optionMatch;
    const underlyingName = getStockDisplayName(symbol);
    const dateStr = `${expiry.slice(0, 2)}-${expiry.slice(2, 4)}-${expiry.slice(4, 6)}`;
    results.push({
      symbol: `${symbol}${expiry}${type}${strike}`,
      name: `${underlyingName} 期权 ${type === 'C' ? '看涨' : '看跌'} $${strike} ${dateStr}`,
      optionStrike: parseFloat(strike),
      optionExpiry: `20${dateStr}`,
      optionType: type as 'C' | 'P'
    });
  }

  return results;
}

async function fetchRemoteSymbolSearch(query: string): Promise<SuggestionItem[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const url = `${apiUrl('api/search')}?q=${encodeURIComponent(q)}&exchange=US`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = (await r.json()) as {
      result?: Array<{ description?: string; symbol?: string; type?: string }>;
    };
    const raw = data.result;
    if (!Array.isArray(raw)) return [];

    const out: SuggestionItem[] = [];
    const seen = new Set<string>();
    for (const row of raw) {
      const sym = (row.symbol || '').trim().toUpperCase();
      if (!sym || seen.has(sym)) continue;
      const rowType = (row.type || '').trim().toUpperCase();
      // 下拉中期权只来自用户手输的完整格式行；search 返回的期权合约/Option 类型不显示
      if (rowType === 'OPTION' || isOptionSymbol(sym) || sym.startsWith('O:')) {
        continue;
      }
      seen.add(sym);
      const name = (row.description || sym).trim();
      const instrumentType = (row.type || '').trim() || undefined;
      out.push({ symbol: sym, name, instrumentType });
      if (out.length >= 12) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function buildSearchSuggestions(query: string): Promise<SuggestionItem[]> {
  const optionExtras = filterOptionPattern(query);
  if (!query.trim()) return [];
  const remote = await fetchRemoteSymbolSearch(query);
  const seen = new Set<string>();
  const merged: SuggestionItem[] = [];

  // 仅使用 /api/search 返回的 description；另附完整期权码解析行（若有）
  for (const r of remote) {
    const k = r.symbol.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }

  for (const item of optionExtras) {
    const k = item.symbol.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(item);
  }

  return merged.slice(0, 15);
}

// 函数：显示下拉建议
function showSuggestions(suggestions: SuggestionItem[]): void {
  const dropdown = document.getElementById('stock-suggestions');
  if (!dropdown) return;

  lastSearchSuggestions = suggestions;

  if (suggestions.length === 0) {
    dropdown.innerHTML = '<div class="no-results">输入股票代码或期权代码搜索<br><small style="color:#999">期权格式: AAPL250530C150</small></div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = suggestions
    .map((item, index) => {
      const isOpt = item.optionStrike !== undefined;
      const handler = isOpt
        ? `selectStock(${JSON.stringify(item.symbol)}, ${String(item.optionStrike)}, ${JSON.stringify(item.optionExpiry ?? '')}, ${JSON.stringify(item.optionType ?? '')})`
        : `selectStock(${JSON.stringify(item.symbol)}, undefined, undefined, undefined, ${JSON.stringify(item.name)}, ${JSON.stringify(item.instrumentType ?? '')})`;
      return `
    <div class="suggestion-item ${index === selectedIndex ? 'selected' : ''} ${isOpt ? 'option-item' : ''}" 
         onclick="${escapeHtmlAttr(handler)}"
         onmouseenter="highlightSuggestion(${index})">
      <span class="suggestion-symbol">${escapeHtml(item.symbol)}</span>
      <span class="suggestion-name">${escapeHtml(item.name)}</span>
      ${isOpt ? '<span class="option-badge">期权</span>' : ''}
    </div>`;
    })
    .join('');

  dropdown.style.display = 'block';
  selectedIndex = -1;
}

// 函数：隐藏下拉建议
function hideSuggestions(): void {
  const dropdown = document.getElementById('stock-suggestions');
  if (dropdown) {
    dropdown.style.display = 'none';
  }
  selectedIndex = -1;
}

function hideTradeFormSuggestions(): void {
  const dropdown = document.getElementById('trade-stock-suggestions');
  if (dropdown) {
    dropdown.style.display = 'none';
  }
  tradeFormSuggestionSelectedIndex = -1;
}

function showTradeFormSuggestions(suggestions: SuggestionItem[]): void {
  const dropdown = document.getElementById('trade-stock-suggestions');
  if (!dropdown) return;

  lastTradeFormSearchSuggestions = suggestions;

  if (suggestions.length === 0) {
    dropdown.innerHTML =
      '<div class="no-results">输入股票代码或期权代码搜索<br><small style="color:#999">期权格式: AAPL250530C150</small></div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = suggestions
    .map((item, index) => {
      const isOpt = item.optionStrike !== undefined;
      const handler = `pickTradeFormSymbol(${JSON.stringify(item.symbol)})`;
      return `
    <div class="suggestion-item ${index === tradeFormSuggestionSelectedIndex ? 'selected' : ''} ${isOpt ? 'option-item' : ''}"
         onclick="${escapeHtmlAttr(handler)}"
         onmouseenter="highlightTradeFormSuggestion(${index})">
      <span class="suggestion-symbol">${escapeHtml(item.symbol)}</span>
      <span class="suggestion-name">${escapeHtml(item.name)}</span>
      ${isOpt ? '<span class="option-badge">期权</span>' : ''}
    </div>`;
    })
    .join('');

  dropdown.style.display = 'block';
  tradeFormSuggestionSelectedIndex = -1;
}

// 函数：高亮建议项
function highlightSuggestion(index: number): void {
  const dropdown = document.getElementById('stock-suggestions');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.suggestion-item');
  items.forEach((item, i) => {
    (item as HTMLElement).classList.toggle('selected', i === index);
  });
  selectedIndex = index;
}

function highlightTradeFormSuggestion(index: number): void {
  const dropdown = document.getElementById('trade-stock-suggestions');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.suggestion-item');
  items.forEach((item, i) => {
    (item as HTMLElement).classList.toggle('selected', i === index);
  });
  tradeFormSuggestionSelectedIndex = index;
}

// 函数：选择股票
// 存储选中的期权信息
let selectedOptionData: { strike?: number; expiry?: string; type?: 'C' | 'P' } = {};

/** 从下拉选中正股/ETF 时暂存 Symbol Search 的 description 与 type，添加持仓时写入表格 */
let pendingSearchPick: { symbol: string; name: string; instrumentType?: string } | null = null;

function selectStock(
  symbol: string,
  strike?: number,
  expiry?: string,
  optionCp?: string,
  searchDescription?: string,
  searchInstrumentType?: string
): void {
  const input = document.getElementById('symbol') as HTMLInputElement;
  const sym = symbol.trim().toUpperCase();
  if (input) {
    input.value = sym;
  }

  const isOptionPick =
    strike !== undefined &&
    expiry !== undefined &&
    expiry !== '' &&
    optionCp !== undefined &&
    optionCp !== '';

  if (isOptionPick) {
    pendingSearchPick = null;
    selectedOptionData = {
      strike,
      expiry,
      type: optionCp as 'C' | 'P'
    };
    updateOptionInfoDisplay(symbol, strike, expiry, optionCp);
  } else {
    selectedOptionData = {};
    clearOptionInfoDisplay();
    if (searchDescription !== undefined && searchDescription !== '') {
      pendingSearchPick = {
        symbol: sym,
        name: searchDescription,
        instrumentType: searchInstrumentType || undefined
      };
    } else {
      pendingSearchPick = null;
    }
  }

  hideSuggestions();
}

/** 新建交易：从下拉选中标的，仅写入代码；名称在保存时用代码填充 */
function pickTradeFormSymbol(symbol: string): void {
  if (tradeFormSearchDebounceId !== null) {
    clearTimeout(tradeFormSearchDebounceId);
    tradeFormSearchDebounceId = null;
  }
  tradeFormSymbolSearchSeq++;
  lastTradeFormSearchSuggestions = [];
  tradeFormSuggestionSelectedIndex = -1;

  const sym = symbol.trim().toUpperCase();
  tradeFormSymbol = sym;
  tradeFormName = '';
  const symIn = document.getElementById('trade-symbol-input') as HTMLInputElement | null;
  if (symIn) symIn.value = sym;
  hideTradeFormSuggestions();
}

// 更新期权信息显示
function updateOptionInfoDisplay(symbol: string, strike: number, expiry: string, type: string): void {
  const container = document.getElementById('option-info');
  if (container) {
    const underlying = symbol.match(/^[A-Z]+/)?.[0] || symbol;
    const name = getStockDisplayName(underlying);
    container.innerHTML = `
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 12px; border-radius: 8px; color: white;">
        <div style="font-weight: 600; margin-bottom: 8px;">期权信息</div>
        <div style="font-size: 0.9rem;">标的: ${name}</div>
        <div style="font-size: 0.9rem;">类型: ${type === 'C' ? '看涨 (Call)' : '看跌 (Put)'}</div>
        <div style="font-size: 0.9rem;">执行价: $${strike}</div>
        <div style="font-size: 0.9rem;">到期日: ${expiry}</div>
      </div>
    `;
    container.style.display = 'block';
  }
}

// 清除期权信息显示
function clearOptionInfoDisplay(): void {
  const container = document.getElementById('option-info');
  if (container) {
    container.style.display = 'none';
    container.innerHTML = '';
  }
}

// 函数：设置下拉搜索事件
function setupStockSearchEvents(): void {
  const input = document.getElementById('symbol') as HTMLInputElement;
  const dropdown = document.getElementById('stock-suggestions');

  if (!input || !dropdown) return;

  const scheduleMerge = (value: string): void => {
    if (searchDebounceId) clearTimeout(searchDebounceId);
    const localPreview = filterOptionPattern(value);
    if (localPreview.length === 0 && value.trim().length >= 2) {
      lastSearchSuggestions = [];
      const dd = document.getElementById('stock-suggestions');
      if (dd) {
        dd.innerHTML = '<div class="no-results" style="color:#666">正在搜索…</div>';
        dd.style.display = 'block';
      }
    } else {
      lastSearchSuggestions = localPreview;
      showSuggestions(localPreview);
    }
    searchDebounceId = setTimeout(() => {
      searchDebounceId = null;
      void (async () => {
        const suggestions = await buildSearchSuggestions(value);
        if ((document.getElementById('symbol') as HTMLInputElement)?.value !== value) return;
        lastSearchSuggestions = suggestions;
        showSuggestions(suggestions);
      })();
    }, 280);
  };

  input.addEventListener('input', e => {
    const value = (e.target as HTMLInputElement).value;
    scheduleMerge(value);
  });

  input.addEventListener('focus', () => {
    const value = input.value;
    if (value) scheduleMerge(value);
  });

  input.addEventListener('keydown', e => {
    const suggestions = lastSearchSuggestions;
    if (suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
      highlightSuggestion(selectedIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      highlightSuggestion(selectedIndex);
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      const item = suggestions[selectedIndex];
      if (item.optionStrike !== undefined) {
        selectStock(item.symbol, item.optionStrike, item.optionExpiry, item.optionType);
      } else {
        selectStock(item.symbol, undefined, undefined, undefined, item.name, item.instrumentType);
      }
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  document.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (!target.closest('.input-group')) {
      hideSuggestions();
      hideTradeFormSuggestions();
    }
  });
}

function setupTradeFormSymbolSearchEvents(): void {
  const input = document.getElementById('trade-symbol-input') as HTMLInputElement | null;
  const dropdown = document.getElementById('trade-stock-suggestions');
  if (!input || !dropdown) return;

  const scheduleMerge = (value: string): void => {
    if (tradeFormSearchDebounceId) clearTimeout(tradeFormSearchDebounceId);
    tradeFormSymbolSearchSeq++;
    const requestSeq = tradeFormSymbolSearchSeq;
    const localPreview = filterOptionPattern(value);
    if (localPreview.length === 0 && value.trim().length >= 2) {
      lastTradeFormSearchSuggestions = [];
      dropdown.innerHTML = '<div class="no-results" style="color:#666">正在搜索…</div>';
      dropdown.style.display = 'block';
    } else {
      lastTradeFormSearchSuggestions = localPreview;
      showTradeFormSuggestions(localPreview);
    }
    tradeFormSearchDebounceId = setTimeout(() => {
      tradeFormSearchDebounceId = null;
      void (async () => {
        const suggestions = await buildSearchSuggestions(value);
        if (requestSeq !== tradeFormSymbolSearchSeq) return;
        if (input.value !== value) return;
        lastTradeFormSearchSuggestions = suggestions;
        showTradeFormSuggestions(suggestions);
      })();
    }, 280);
  };

  input.addEventListener('input', (e) => {
    const value = (e.target as HTMLInputElement).value;
    scheduleMerge(value);
  });

  input.addEventListener('focus', () => {
    const value = input.value;
    if (value) scheduleMerge(value);
  });

  input.addEventListener('keydown', (e) => {
    const suggestions = lastTradeFormSearchSuggestions;
    if (e.key === 'Escape') {
      hideTradeFormSuggestions();
      return;
    }
    if (suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      tradeFormSuggestionSelectedIndex = Math.min(
        tradeFormSuggestionSelectedIndex + 1,
        suggestions.length - 1
      );
      highlightTradeFormSuggestion(tradeFormSuggestionSelectedIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      tradeFormSuggestionSelectedIndex = Math.max(tradeFormSuggestionSelectedIndex - 1, 0);
      highlightTradeFormSuggestion(tradeFormSuggestionSelectedIndex);
    } else if (e.key === 'Enter' && tradeFormSuggestionSelectedIndex >= 0) {
      e.preventDefault();
      const item = suggestions[tradeFormSuggestionSelectedIndex];
      pickTradeFormSymbol(item.symbol);
    }
  });
}
