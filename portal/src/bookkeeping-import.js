import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { ENTRY_TYPES, entryDate, cents, CURRENCIES } from './bookkeeping-store.js';

export const ICOST_HEADERS = ['日期', '类型', '金额', '一级分类', '二级分类', '账户1', '账户2', '备注', '货币', '标签', '账本', '位置', '退款', '优惠', '手续费', '图片链接1', '图片链接2', '图片链接3', '图片附件1', '图片附件2', '图片附件3'];
function validateArchive(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0) throw new Error('文件不是合法 XLSX ZIP');
  const count = buffer.readUInt16LE(end + 10); let at = buffer.readUInt32LE(end + 16), total = 0;
  if (count > 2000 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error('不支持过大或分卷文件');
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('压缩目录无效');
    const compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24), method = buffer.readUInt16LE(at + 10);
    total += size;
    if (total > 80 * 1024 * 1024 || size > 40 * 1024 * 1024) throw new Error('解压内容超过限制');
    const local = buffer.readUInt32LE(at + 42);
    if (local + 30 > at || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('压缩条目无效');
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (dataAt + compressed > at) throw new Error('压缩长度无效');
    // Bound actual inflation too: attacker-controlled central-directory sizes alone are insufficient.
    const data = buffer.subarray(dataAt, dataAt + compressed);
    if (method === 8) { if (inflateRawSync(data, { maxOutputLength: Math.max(1, size) }).length !== size) throw new Error('解压大小不匹配'); }
    else if (method !== 0 || compressed !== size) throw new Error('不支持该压缩格式');
    at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
}
function value(cell) {
  const v = cell.value;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 19);
  if (typeof v === 'object') {
    if (v.formula || v.sharedFormula) throw new Error('不支持公式单元格，请导入原始 iCost 导出文件');
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v.text != null) return v.text;
    throw new Error('存在无法识别的单元格');
  }
  return v;
}
export async function parseIcost(buffer) {
  if (buffer.length > 15 * 1024 * 1024) throw new Error('文件超过 15 MB');
  validateArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets.find(s => String(value(s.getCell(1, 1))) === '日期' && String(value(s.getCell(1, 2))) === '类型');
  if (!sheet) throw new Error('未找到 iCost 收支账单表头');
  if (sheet.rowCount > 50001) throw new Error('最多导入 50,000 条账单');
  const headers = sheet.getRow(1).values.slice(1).map(String);
  for (const h of ICOST_HEADERS.slice(0, 11)) if (!headers.includes(h)) throw new Error('缺少字段：' + h);
  const rows = [], errors = [], occurrences = new Map(), warnings = new Set();
  sheet.eachRow((r, line) => {
    if (line === 1) return;
    try {
      const raw = Object.fromEntries(headers.map((h, i) => [h, value(r.getCell(i + 1))]));
      if (!raw.日期 && !raw.类型 && !raw.金额) return;
      const type = String(raw.类型); if (!ENTRY_TYPES.includes(type) || type === '余额调整') throw new Error('未知导出类型：' + type);
      const signed = cents(raw.金额, true), amount = Math.abs(signed) / 100;
      if (!amount) warnings.add('零金额账单按原记录保留，不影响收支');
      if (!raw.货币) warnings.add('存在空货币，按 CNY 处理');
      const currency = String(raw.货币 || 'CNY'); if (!CURRENCIES.includes(currency)) throw new Error('未知货币：' + currency);
      const nullableNumber = v => { if (v === '' || v == null) return 0; const n = cents(v, true); if (n < 0) throw new Error('附加金额为负数'); return n / 100; };
      const row = { date: entryDate(raw.日期), type, amount, currency, category: String(raw.一级分类 || '其他'), subcategory: String(raw.二级分类 || ''),
        accountName: String(raw.账户1 || ''), toAccountName: String(raw.账户2 || ''), note: String(raw.备注 || ''), tags: String(raw.标签 || ''),
        book: String(raw.账本 || '个人账本'), location: String(raw.位置 || ''), refund: nullableNumber(raw.退款), discount: nullableNumber(raw.优惠), fee: nullableNumber(raw.手续费), raw };
      // Ignore expiring attachment URLs for deduplication, keep them in raw export metadata.
      const canonical = JSON.stringify(ICOST_HEADERS.slice(0, 15).map(h => raw[h] ?? ''));
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const occurrence = (occurrences.get(hash) || 0) + 1; occurrences.set(hash, occurrence);
      row.sourceKey = hash + ':' + occurrence; rows.push(row);
    } catch (e) { errors.push({ line, error: e.message }); }
  });
  warnings.add('历史账单不改变账户快照余额；跨币种转账的到账金额无法从导出文件还原');
  warnings.add('退款/报销入账冲减支出；原账单退款与优惠字段仅保留，不重复冲减；图片链接保留为来源信息');
  return { rows, errors, warnings: [...warnings] };
}

export async function exportIcost(entries) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('收支账单');
  sheet.addRow(ICOST_HEADERS);
  for (const e of entries) {
    const amount = ['支出', '已报销'].includes(e.type) ? -e.amount : e.amount;
    const raw = { 日期: e.date.replace('T', ' ').replaceAll('-', '/'), 类型: e.type, 金额: amount,
      一级分类: e.category, 二级分类: e.subcategory, 账户1: e.accountName || '', 账户2: e.toAccountName || '',
      备注: e.note, 货币: e.currency, 标签: e.tags, 账本: e.book, 位置: e.location, 退款: e.refund || '', 优惠: e.discount || '', 手续费: e.fee || '' };
    sheet.addRow(ICOST_HEADERS.map(h => raw[h] ?? ''));
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.columns.forEach((c, i) => { c.width = [0, 7, 11].includes(i) ? 25 : 16; });
  sheet.getRow(1).font = { bold: true }; sheet.getColumn(3).numFmt = '0.00';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
