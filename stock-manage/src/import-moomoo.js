import XLSX from 'xlsx';
import { isOptionSymbol, optionMult, roundMoney } from './trades.js';

function normalizeCell(v) {
  if (v == null) return '';
  return String(v).replace(/\u00a0/g, ' ').trim();
}

function parseMoney(s) {
  const t = normalizeCell(s).replace(/,/g, '').replace(/^\$/, '');
  if (!t || t === '市价') return NaN;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}

function parseQty(s) {
  const n = parseFloat(normalizeCell(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

export function normalizeMoomooOptionSymbol(symbol) {
  const s = String(symbol).trim().toUpperCase();
  const m = s.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!m) return s;
  const strikeRaw = m[4];
  const len = strikeRaw.length;
  if (len <= 3) return s;
  const milli = parseInt(strikeRaw, 10);
  if (!Number.isFinite(milli)) return s;
  const shouldScale = len >= 5 || (len === 4 && milli >= 1000 && milli % 1000 === 0);
  if (!shouldScale) return s;
  const strike = milli / 1000;
  const rounded = Math.round(strike);
  const strikeOut = Math.abs(strike - rounded) < 1e-9
    ? String(rounded)
    : String(Math.round(strike * 1000) / 1000);
  return `${m[1]}${m[2]}${m[3]}${strikeOut}`;
}

function isoFromExcelSerial(serial) {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (whole < 20000 || whole > 10000000) return null;
  const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseTradeDate(raw) {
  const fallback = () => new Date().toISOString();
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
  const hasZone = /(?:[Zz]|[+-]\d{2}:?\d{2})/.test(trimmed);
  if (!hasZone) {
    const m = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? fallback() : d.toISOString();
}

function headerIndex(headers, name) {
  return headers.findIndex((c) => normalizeCell(c) === name);
}

function isMoomooHeaders(headers) {
  const h = headers.map(normalizeCell);
  return h.includes('方向') && h.includes('代码') && h.includes('交易状态') &&
    (h.includes('成交价格') || h.includes('成交价')) && h.includes('成交金额');
}

function sheetToRows(sheet) {
  const ref = sheet['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      row.push(cell ? cell.w ?? cell.v ?? '' : '');
    }
    rows.push(row);
  }
  return rows;
}

function parseMoomooRows(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0];
  if (!isMoomooHeaders(headers)) return [];
  const idx = (n) => headerIndex(headers, n);
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
  const out = [];
  const now = new Date().toISOString();

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const code = normalizeCell(cells[iCode] ?? '');
    if (!code || normalizeCell(cells[iStatus] ?? '') !== '全部成交') continue;
    const dir = normalizeCell(cells[iDir] ?? '');
    let type;
    if (dir === '买入') type = 'buy';
    else if (dir === '卖出') type = 'sell';
    else continue;
    const price = parseMoney(cells[iPx]);
    const amount = parseMoney(cells[iAmt]);
    if (!(price > 0) || !(amount > 0)) continue;
    const sym = normalizeMoomooOptionSymbol(code.toUpperCase());
    const isOpt = isOptionSymbol(sym);
    let shares = iQty >= 0 ? parseQty(cells[iQty]) : NaN;
    if (!(shares > 0)) {
      shares = isOpt
        ? Math.round((amount / (price * 100)) * 10000) / 10000
        : Math.round((amount / price) * 10000) / 10000;
    }
    if (!(shares > 0)) continue;
    let commission = 0;
    if (iFee >= 0) {
      const f = parseMoney(cells[iFee]);
      if (Number.isFinite(f) && f >= 0) commission = f;
    }
    const mult = optionMult(sym);
    out.push({
      id: `import-${r}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: sym,
      name: (iName >= 0 ? normalizeCell(cells[iName]) : '') || code,
      type,
      shares,
      price: roundMoney(price),
      total_amount: roundMoney(shares * price * mult),
      commission: roundMoney(commission),
      trade_date: iTime >= 0 ? parseTradeDate(cells[iTime]) : now,
      created_at: now
    });
  }
  return out;
}

export function parseMoomooBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const all = [];
  for (const name of wb.SheetNames) {
    all.push(...parseMoomooRows(sheetToRows(wb.Sheets[name])));
  }
  return all;
}

export function parseAppBackupBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames.includes('交易记录') ? '交易记录' : wb.SheetNames[0];
  const rows = sheetToRows(wb.Sheets[sheetName]);
  if (rows.length < 2) return [];
  const hdr = rows[0].map(normalizeCell);
  const ext = hdr.includes('其它类别');
  const out = [];
  const now = new Date().toISOString();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (ext) {
      const typeRaw = normalizeCell(cells[1]);
      const otherCat = normalizeCell(cells[2]);
      const symbol = normalizeCell(cells[3]).toUpperCase();
      if (!symbol) continue;
      if (typeRaw === '其它' || typeRaw.toLowerCase() === 'other') {
        const amt = parseMoney(cells[7]);
        if (!otherCat || !Number.isFinite(amt) || amt === 0) continue;
        out.push({
          id: `backup-${r}-${Date.now()}`,
          symbol: symbol || 'OTHER',
          name: normalizeCell(cells[4]) || otherCat,
          type: 'other',
          other_category: otherCat,
          shares: 1,
          price: 0,
          total_amount: roundMoney(amt),
          commission: roundMoney(parseMoney(cells[8]) || 0),
          trade_date: parseTradeDate(cells[0]),
          created_at: now
        });
        continue;
      }
      const type = typeRaw === '卖出' || typeRaw === 'sell' ? 'sell' : 'buy';
      const shares = parseQty(cells[5]);
      const price = parseMoney(cells[6]);
      if (!(shares > 0) || !(price > 0)) continue;
      const mult = optionMult(symbol);
      out.push({
        id: `backup-${r}-${Date.now()}`,
        symbol,
        name: normalizeCell(cells[4]) || symbol,
        type,
        shares,
        price: roundMoney(price),
        total_amount: roundMoney(shares * price * mult),
        commission: roundMoney(parseMoney(cells[8]) || 0),
        trade_date: parseTradeDate(cells[0]),
        created_at: now
      });
    } else {
      const typeRaw = normalizeCell(cells[1]);
      const symbol = normalizeCell(cells[2]).toUpperCase();
      const shares = parseQty(cells[4]);
      const price = parseMoney(cells[5]);
      if (!symbol || !(shares > 0) || !(price > 0)) continue;
      const type = typeRaw === '卖出' || typeRaw === 'sell' ? 'sell' : 'buy';
      const mult = optionMult(symbol);
      out.push({
        id: `backup-${r}-${Date.now()}`,
        symbol,
        name: normalizeCell(cells[3]) || symbol,
        type,
        shares,
        price: roundMoney(price),
        total_amount: roundMoney(shares * price * mult),
        commission: roundMoney(parseMoney(cells[7]) || 0),
        trade_date: parseTradeDate(cells[0]),
        created_at: now
      });
    }
  }
  return out;
}

export function parseImportBuffer(buffer) {
  const moomoo = parseMoomooBuffer(buffer);
  if (moomoo.length) return moomoo;
  return parseAppBackupBuffer(buffer);
}
