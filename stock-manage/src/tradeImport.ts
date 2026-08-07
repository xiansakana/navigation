/**
 * 交易导入：
 *
 * - **Moomoo 导入**（xlsx）：富途「历史 / 现金账户」类表头 — 方向、代码、交易状态=全部成交、
 *   成交价格（或成交价）、成交金额、成交时间、合计费用等；有「成交数量」则优先，否则 金额÷价格。
 *
 * - **BBAE 导入**（xlsx）：多工作表 — 股票表（股票代码、已成、成交价…）；期权表（期权代码、费用组合列等）。
 *
/**
 * - **本应用 xlsx**：`交易记录` 工作表或与 CSV 同款表头的首个工作表（见 `parseAppTradeBackupXlsxArrayBuffer`）。
 *
 * - **本应用 CSV/JSON（旧备份）**：`parseTradeImportLegacyCsv`、`parseJSON`（main）仍可读。
 */

export interface TradeImportRecord {
  id: string;
  symbol: string;
  name: string;
  type: 'buy' | 'sell' | 'other';
  /** 仅 type=other */
  other_category?: string;
  shares: number;
  price: number;
  total_amount: number;
  commission: number;
  trade_date: string;
  created_at: string;
}

/** 期权费用组合列（部分导出为单列） */
const OPTION_FEE_COMPOSITE_COL = '套餐外费用加期权监管费减去套餐抵扣';

/** 标准美股期权：1 张合约对应 100 股标的；成交金额 = 张数 × 权利金(每股) × 100 */
const OPTION_CONTRACT_MULTIPLIER = 100;

function isCompactOptionSymbol(sym: string): boolean {
  return /^[A-Z]+\d{6}[CP]\d+(?:\.\d+)?$/i.test(sym.trim());
}

function optionNotionalUsd(contracts: number, premiumPerShare: number): number {
  return Math.round(contracts * premiumPerShare * OPTION_CONTRACT_MULTIPLIER * 100) / 100;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function normalizeCell(s: string): string {
  return s.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim();
}

/**
 * Moomoo 历史里的期权码往往在行权价上使用「实际价格×1000」的整数（如 …C40000→$40、…C5000→$5），
 * 与本应用及 /api/option 使用的紧凑码（…C40、…C5）不一致，此处做归一。
 * - 行权价数字 ≥5 位：÷1000。
 * - 恰为 4 位且为 1000 的整数倍（2000…9000、1000）：÷1000（覆盖 $1～$9 的整美元档）。
 * - 其余更短或无法判为 ×1000 的（如 C40、C150、C1500、C2500）：不改动。
 */
export function normalizeMoomooOptionSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const m = s.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!m) return s;
  const strikeRaw = m[4];
  const len = strikeRaw.length;
  if (len <= 3) return s;
  const milli = parseInt(strikeRaw, 10);
  if (!Number.isFinite(milli)) return s;

  const shouldScaleFromMillis =
    len >= 5 || (len === 4 && milli >= 1000 && milli % 1000 === 0);
  if (!shouldScaleFromMillis) return s;

  const strike = milli / 1000;
  const roundedInt = Math.round(strike);
  let strikeOut: string;
  if (Math.abs(strike - roundedInt) < 1e-9) {
    strikeOut = String(roundedInt);
  } else {
    strikeOut = String(Math.round(strike * 1000) / 1000);
  }
  return `${m[1]}${m[2]}${m[3]}${strikeOut}`;
}

function parseMoneyNumber(s: string): number {
  const t = normalizeCell(s).replace(/,/g, '').replace(/^\$/, '').trim();
  if (t === '' || t === '市价') return NaN;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}

function parseQtyNumber(s: string): number {
  const t = normalizeCell(s).replace(/,/g, '').trim();
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Excel 序列日（可含小数表示时刻），转 ISO；范围外返回 null */
function isoFromExcelSerial(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (whole < 20000 || whole > 10000000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + serial * 86400000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseTradeDateLoose(raw: string): string {
  const fallback = (): string => new Date().toISOString();
  const str = normalizeCell(raw)
    .replace(/\s*\(美东\)\s*$/i, '')
    .replace(/\s*\(北京时间\)\s*$/i, '')
    .trim();
  if (!str) return fallback();

  if (/^-?\d+(?:\.\d+)?$/.test(str)) {
    const n = parseFloat(str);
    const ex = isoFromExcelSerial(n);
    if (ex) return ex;
    if (n > 1e12 && n < 1e14) return new Date(n).toISOString();
  }

  const trimmed = str.trim();

  /** 无前缀时区的日历串：必须用本地年月日时分解析，早于 `Date.parse`。否则形如 `2026/2/2 5:35:00` 在多数环境下会被当成 UTC，东八区会显示成 13:35。 */
  const hasExplicitZone = /(?:[Zz]|[+-]\d{2}:?\d{2}(?::\d{2})?)\s*$/.test(trimmed);

  if (!hasExplicitZone) {
    /** `[\sT]+` 必须至少吞下「空格或 T」，避免 `T?` 在 T 前卫宽度匹配而把 `T` 留给 `\d`，导致整条失效后落到 UTC 语义。 */
    const localCal = trimmed.match(
      /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
    );
    if (localCal) {
      const y = parseInt(localCal[1], 10);
      const mo = parseInt(localCal[2], 10) - 1;
      const day = parseInt(localCal[3], 10);
      const hh = localCal[4] !== undefined ? parseInt(localCal[4], 10) : 0;
      const mm = localCal[5] !== undefined ? parseInt(localCal[5], 10) : 0;
      const ss = localCal[6] !== undefined ? parseInt(localCal[6], 10) : 0;
      const dl = new Date(y, mo, day, hh, mm, ss);
      if (!Number.isNaN(dl.getTime())) return dl.toISOString();
    }
  }

  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) return d.toISOString();

  return fallback();
}

/** 导入用：兼容 ISO、本地化字符串、Excel 序列数、毫秒时间戳；无效则退回当前时刻 */
export function parseImportedTradeDatetime(raw: unknown): string {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString();
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ex = isoFromExcelSerial(raw);
    if (ex) return ex;
    if (raw > 1e12 && raw < 1e14) return new Date(raw).toISOString();
    return parseTradeDateLoose(String(raw));
  }
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!s) return new Date().toISOString();
  return parseTradeDateLoose(s);
}

function makeId(row: number): string {
  return `import-${row}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((c) => normalizeCell(c) === name);
}

/** 期权费用（BBAE）：套餐外费用 + 期权监管费；不扣减套餐抵扣。无分列时回退读取单列「套餐外费用加期权监管费减去套餐抵扣」单元格值。 */
function parseOptionOrderFee(headers: string[], cells: string[]): number {
  const h = headers.map(normalizeCell);
  const ia = headerIndex(headers, '套餐外费用');
  const ib = headerIndex(headers, '期权监管费');
  const part = (i: number) =>
    i >= 0 ? (() => { const v = parseMoneyNumber(cells[i] ?? ''); return Number.isFinite(v) ? v : 0; })() : 0;

  if (ia >= 0 || ib >= 0) {
    const fee = part(ia) + part(ib);
    return fee >= 0 && Number.isFinite(fee) ? fee : 0;
  }

  const iComposite = h.findIndex((x) => x === OPTION_FEE_COMPOSITE_COL);
  if (iComposite >= 0) {
    const v = parseMoneyNumber(cells[iComposite] ?? '');
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

function isMoomooHistorySheetHeaders(headers: string[]): boolean {
  const h = headers.map(normalizeCell);
  const hasPrice =
    h.includes('成交价格') || h.includes('成交价');
  return (
    h.includes('方向') &&
    h.includes('代码') &&
    h.includes('交易状态') &&
    hasPrice &&
    h.includes('成交金额')
  );
}

function rowCellsFromCsvLine(line: string): string[] {
  return parseCSVLine(line).map(normalizeCell);
}

/** Moomoo 历史（xlsx 或表结构相同的表格）：全部成交 + 成交金额/价格/可选数量 + 合计费用 */
function parseMoomooHistoryRows(rows: string[][]): TradeImportRecord[] {
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idx = (name: string) => headerIndex(headers, name);
  const iDir = idx('方向');
  const iCode = idx('代码');
  const iName = idx('名称');
  const iStatus = idx('交易状态');
  let iPx = idx('成交价格');
  if (iPx < 0) iPx = idx('成交价');
  const iAmt = idx('成交金额');
  const iTime = idx('成交时间');
  const iFee = idx('合计费用');
  const iQty = idx('成交数量');
  if (iDir < 0 || iCode < 0 || iStatus < 0 || iPx < 0 || iAmt < 0) return [];

  const out: TradeImportRecord[] = [];
  const now = new Date().toISOString();

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const need = Math.max(iDir, iCode, iStatus, iPx, iAmt, iTime >= 0 ? iTime : iAmt);
    if (cells.length <= need) continue;

    const code = normalizeCell(cells[iCode] ?? '');
    if (!code) continue;
    if (normalizeCell(cells[iStatus] ?? '') !== '全部成交') continue;

    const dir = normalizeCell(cells[iDir] ?? '');
    let type: 'buy' | 'sell';
    if (dir === '买入') type = 'buy';
    else if (dir === '卖出') type = 'sell';
    else continue;

    const price = parseMoneyNumber(cells[iPx] ?? '');
    const amount = parseMoneyNumber(cells[iAmt] ?? '');
    if (!(price > 0) || !(amount > 0)) continue;

    const symNorm = normalizeMoomooOptionSymbol(code.toUpperCase());
    const isOpt = isCompactOptionSymbol(symNorm);

    let shares =
      iQty >= 0 ? parseQtyNumber(cells[iQty] ?? '') : NaN;
    if (!(shares > 0)) {
      shares = isOpt
        ? Math.round((amount / (price * OPTION_CONTRACT_MULTIPLIER)) * 10000) / 10000
        : Math.round((amount / price) * 10000) / 10000;
    }
    if (!(shares > 0)) continue;

    let commission = 0;
    if (iFee >= 0) {
      const f = parseMoneyNumber(cells[iFee] ?? '');
      if (Number.isFinite(f) && f >= 0) commission = f;
    }
    const name =
      iName >= 0 ? normalizeCell(cells[iName] ?? '') || code : code;
    const trade_date =
      iTime >= 0 ? parseTradeDateLoose(cells[iTime] ?? '') : new Date().toISOString();

    const total_amount = isOpt ? optionNotionalUsd(shares, price) : amount;

    out.push({
      id: makeId(r),
      symbol: symNorm,
      name,
      type,
      shares,
      price,
      total_amount,
      commission,
      trade_date,
      created_at: now
    });
  }
  return out;
}

/** 与本应用导出 xlsx/csv 表头一致的表格（通常为首个工作表；含扩展列「其它类别」或旧版 8 列） */
export function parseAppTradeBackupSheetRows(rows: string[][]): TradeImportRecord[] {
  if (rows.length < 2) return [];
  const out: TradeImportRecord[] = [];
  const now = new Date().toISOString();
  const hdr = rows[0].map(normalizeCell);
  const extFormat = hdr.includes('其它类别');

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length < 6) continue;

    if (extFormat) {
      if (cells.length < 8) continue;
      const typeRaw = normalizeCell(cells[1] ?? '');
      const otherCat = normalizeCell(cells[2] ?? '');
      const symbol = normalizeCell(cells[3] ?? '');
      if (!symbol) continue;

      if (typeRaw === '其它' || typeRaw.toLowerCase() === 'other') {
        const cat = otherCat || symbol;
        const total = parseMoneyNumber(cells[7] ?? '');
        if (!cat || !Number.isFinite(total) || total === 0) continue;
        let commission = 0;
        if (cells.length > 8) {
          const c = parseMoneyNumber(cells[8] ?? '');
          if (Number.isFinite(c) && c >= 0) commission = c;
        }
        const trade_date = parseTradeDateLoose(cells[0] ?? '');
        const symU = symbol.toUpperCase() || 'OTHER';
        const nm = normalizeCell(cells[4] ?? '') || cat;
        out.push({
          id: makeId(r),
          symbol: symU,
          name: nm,
          type: 'other',
          other_category: cat,
          shares: 1,
          price: 0,
          total_amount: total,
          commission,
          trade_date,
          created_at: now
        });
        continue;
      }

      const symU = symbol.toUpperCase();
      const isOpt = isCompactOptionSymbol(symU);
      const type =
        typeRaw === '买入' || typeRaw.toLowerCase() === 'buy' ? ('buy' as const) : ('sell' as const);
      const shares = parseQtyNumber(cells[5] ?? '');
      const price = parseMoneyNumber(cells[6] ?? '');
      if (!(shares > 0) || !(price > 0)) continue;
      const name = normalizeCell(cells[4] ?? '') || symbol;
      let total = cells.length > 7 ? parseMoneyNumber(cells[7] ?? '') : NaN;
      if (!Number.isFinite(total) || total <= 0) {
        total = isOpt ? optionNotionalUsd(shares, price) : shares * price;
      }
      let commission = 0;
      if (cells.length > 8) {
        const c = parseMoneyNumber(cells[8] ?? '');
        if (Number.isFinite(c) && c >= 0) commission = c;
      }
      const trade_date = parseTradeDateLoose(cells[0] ?? '');
      out.push({
        id: makeId(r),
        symbol: symU,
        name,
        type,
        shares,
        price,
        total_amount: total,
        commission,
        trade_date,
        created_at: now
      });
      continue;
    }

    const symbol = normalizeCell(cells[2] ?? '');
    if (!symbol) continue;
    const typeRaw = normalizeCell(cells[1] ?? '');
    const symU = symbol.toUpperCase();
    const isOpt = isCompactOptionSymbol(symU);
    const type =
      typeRaw === '买入' || typeRaw.toLowerCase() === 'buy' ? ('buy' as const) : ('sell' as const);
    const shares = parseQtyNumber(cells[4] ?? '');
    const price = parseMoneyNumber(cells[5] ?? '');
    if (!(shares > 0) || !(price > 0)) continue;
    const name = normalizeCell(cells[3] ?? '') || symbol;
    let total = cells.length > 6 ? parseMoneyNumber(cells[6] ?? '') : NaN;
    if (!Number.isFinite(total) || total <= 0) {
      total = isOpt ? optionNotionalUsd(shares, price) : shares * price;
    }
    let commission = 0;
    if (cells.length > 7) {
      const c = parseMoneyNumber(cells[7] ?? '');
      if (Number.isFinite(c) && c >= 0) commission = c;
    }
    const trade_date = parseTradeDateLoose(cells[0] ?? '');
    out.push({
      id: makeId(r),
      symbol: symU,
      name,
      type,
      shares,
      price,
      total_amount: total,
      commission,
      trade_date,
      created_at: now
    });
  }
  return out;
}

function parseLegacyCsvRows(rows: string[][]): TradeImportRecord[] {
  return parseAppTradeBackupSheetRows(rows);
}

/** 股票订单表（xlsx 股票 sheet 或另存 CSV 时的备用） */
function parseStockOrderSheetRows(rows: string[][]): TradeImportRecord[] {
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idx = (name: string) => headerIndex(headers, name);
  const iStatus = idx('订单状态');
  const iDir = idx('方向');
  const iSym = idx('股票代码');
  const iQty = idx('成交数量');
  const iPx = idx('成交价');
  const iComm = idx('佣金');
  const iTime = idx('成交时间');
  if (iStatus < 0 || iDir < 0 || iSym < 0 || iQty < 0 || iPx < 0) return [];

  const out: TradeImportRecord[] = [];
  const now = new Date().toISOString();

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const maxI = Math.max(iStatus, iDir, iSym, iQty, iPx);
    if (cells.length <= maxI) continue;
    if (normalizeCell(cells[iStatus] ?? '') !== '已成') continue;

    const sym = normalizeCell(cells[iSym] ?? '');
    if (!sym) continue;

    const dir = normalizeCell(cells[iDir] ?? '');
    let type: 'buy' | 'sell';
    if (dir === '买入') type = 'buy';
    else if (dir === '卖出') type = 'sell';
    else continue;

    const shares = parseQtyNumber(cells[iQty] ?? '');
    const price = parseMoneyNumber(cells[iPx] ?? '');
    if (!(shares > 0) || !(price > 0)) continue;

    let commission = 0;
    if (iComm >= 0) {
      const f = parseMoneyNumber(cells[iComm] ?? '');
      if (Number.isFinite(f) && f >= 0) commission = f;
    }
    const trade_date =
      iTime >= 0 ? parseTradeDateLoose(cells[iTime] ?? '') : new Date().toISOString();
    const u = sym.toUpperCase();

    out.push({
      id: makeId(r),
      symbol: u,
      name: u,
      type,
      shares,
      price,
      total_amount: shares * price,
      commission,
      trade_date,
      created_at: now
    });
  }
  return out;
}

/** 期权订单表 */
function parseOptionOrderSheetRows(rows: string[][]): TradeImportRecord[] {
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idx = (name: string) => headerIndex(headers, name);
  const iStatus = idx('订单状态');
  const iDir = idx('方向');
  const iCode = idx('期权代码');
  const iQty = idx('成交数量');
  const iPx = idx('成交价');
  const iTime = idx('成交时间');
  if (iStatus < 0 || iDir < 0 || iCode < 0 || iQty < 0 || iPx < 0) return [];

  const out: TradeImportRecord[] = [];
  const now = new Date().toISOString();

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const maxI = Math.max(iStatus, iDir, iCode, iQty, iPx);
    if (cells.length <= maxI) continue;
    if (normalizeCell(cells[iStatus] ?? '') !== '已成') continue;

    const code = normalizeCell(cells[iCode] ?? '');
    if (!code) continue;

    const dir = normalizeCell(cells[iDir] ?? '');
    let type: 'buy' | 'sell';
    if (dir === '买入') type = 'buy';
    else if (dir === '卖出') type = 'sell';
    else continue;

    const shares = parseQtyNumber(cells[iQty] ?? '');
    const price = parseMoneyNumber(cells[iPx] ?? '');
    if (!(shares > 0) || !(price > 0)) continue;

    const commission = parseOptionOrderFee(headers, cells);
    const trade_date =
      iTime >= 0 ? parseTradeDateLoose(cells[iTime] ?? '') : new Date().toISOString();
    const u = code.toUpperCase();

    out.push({
      id: makeId(r),
      symbol: u,
      name: u,
      type,
      shares,
      price,
      total_amount: optionNotionalUsd(shares, price),
      commission,
      trade_date,
      created_at: now
    });
  }
  return out;
}

/** 本应用导出的 CSV（时间、类型、代码…）及 BBAE 表另存为 CSV 时的兜底 */
export function parseTradeImportLegacyCsv(content: string): TradeImportRecord[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headerCells = rowCellsFromCsvLine(lines[0]);
  const rows: string[][] = [headerCells];
  for (let i = 1; i < lines.length; i++) {
    rows.push(rowCellsFromCsvLine(lines[i]));
  }

  let legacy = parseLegacyCsvRows(rows);
  if (legacy.length === 0) {
    const norm = headerCells.map(normalizeCell);
    if (norm.includes('股票代码') && norm.includes('订单状态')) {
      legacy = parseStockOrderSheetRows(rows);
    }
  }
  return legacy;
}

/** 与本应用「导出交易」xlsx 内工作表名一致 */
export const TRADE_RECORD_EXPORT_SHEET_NAME = '交易记录';

function sheetToRows(sheet: import('xlsx').WorkSheet, XLSX: typeof import('xlsx')): string[][] {
  const rowsUnknown = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false
  }) as unknown[];
  if (!Array.isArray(rowsUnknown) || rowsUnknown.length < 2) return [];
  return rowsUnknown.map((row) =>
    (Array.isArray(row) ? row : []).map((c) =>
      c === null || c === undefined ? '' : String(c).trim()
    )
  ) as string[][];
}

/** 本应用导出的交易备份 xlsx（优先读「交易记录」表，否则首张表） */
export async function parseAppTradeBackupXlsxArrayBuffer(
  buf: ArrayBuffer
): Promise<TradeImportRecord[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array' });
  if (wb.SheetNames.length === 0) return [];
  const name = wb.SheetNames.includes(TRADE_RECORD_EXPORT_SHEET_NAME)
    ? TRADE_RECORD_EXPORT_SHEET_NAME
    : wb.SheetNames[0];
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  const rows = sheetToRows(sheet, XLSX);
  return parseAppTradeBackupSheetRows(rows);
}

/** Moomoo：历史/现金账户 xlsx（可含多表，凡表头符合则解析合并） */
export async function parseMoomooXlsxArrayBuffer(
  buf: ArrayBuffer
): Promise<TradeImportRecord[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array' });
  const all: TradeImportRecord[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const rows = sheetToRows(sheet, XLSX);
    if (rows.length < 2) continue;
    if (!isMoomooHistorySheetHeaders(rows[0])) continue;
    all.push(...parseMoomooHistoryRows(rows));
  }

  return all;
}

/** BBAE：股票 / 期权 订单 xlsx */
export async function parseBbaeXlsxArrayBuffer(buf: ArrayBuffer): Promise<TradeImportRecord[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array' });
  const all: TradeImportRecord[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const rows = sheetToRows(sheet, XLSX);
    if (rows.length < 2) continue;
    const norm = rows[0].map(normalizeCell);

    if (norm.includes('期权代码')) {
      all.push(...parseOptionOrderSheetRows(rows));
    } else if (norm.includes('股票代码')) {
      all.push(...parseStockOrderSheetRows(rows));
    }
  }

  return all;
}
