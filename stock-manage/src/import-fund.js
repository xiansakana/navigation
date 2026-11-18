import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { roundMoney } from './trades.js';

const text = value => String(value ?? '').trim();
const numeric = value => {
  const raw = text(value).replace(/,/g, '');
  return /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
};

export function parseFundBuffer(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const trades = [], keys = new Set(), excluded = new Map();
  let recognized = false, sourceCount = 0;
  for (const sheet of book.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(book.Sheets[sheet], { header: 1, raw: false, defval: '' });
    const index = rows.findIndex(row => ['成交日期','基金代码','基金名称','操作','成交数量','成交金额','基金账号','合同编号'].every(key => row.includes(key)));
    if (index < 0) continue;
    recognized = true;
    const columns = rows[index];
    for (let i = index + 1; i < rows.length; i++) {
      if (!rows[i].some(value => text(value))) continue;
      sourceCount++;
      const get = key => text(rows[i][columns.indexOf(key)]);
      const operation = get('操作');
      if (!['申购','认购','赎回'].includes(operation)) {
        excluded.set(operation || '空业务类型', (excluded.get(operation || '空业务类型') || 0) + 1);
        continue;
      }
      const code = get('基金代码'), day = get('成交日期');
      const shares = numeric(get('成交数量')), amount = numeric(get('成交金额'));
      const contract = get('合同编号'), fundAccount = get('基金账号');
      if (!/^\d{6}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(day)
        || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day
        || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(amount) || amount <= 0
        || !contract || !fundAccount) throw new Error(`基金交割单第${i + 1}行代码、日期、确认份额、金额或合同编号无效`);
      const key = crypto.createHash('sha256').update(JSON.stringify([fundAccount, contract, code, operation])).digest('hex');
      if (keys.has(key)) throw new Error('基金交割单合同记录重复，无法安全区分');
      keys.add(key);
      const type = operation === '赎回' ? 'sell' : 'buy';
      trades.push({ id: `fund-settlement-${key}`, broker: 'fund-settlement', broker_order_key: key,
        symbol: `${code}.OF`, name: get('基金名称') || code, type, shares,
        price: amount / shares, total_amount: roundMoney(amount), commission: 0, currency: 'CNY',
        broker_net: type === 'buy' ? -roundMoney(amount) : roundMoney(amount),
        broker_category: operation, trade_date: `${day}T15:00:00+08:00`,
        created_at: new Date().toISOString() });
    }
  }
  if (!recognized) return null;
  trades.fundImportInfo = { sourceCount, excluded: [...excluded].map(([reason, count]) => ({ reason: `${reason}：暂不支持此基金业务`, count })),
    warnings: ['按成交日期北京时间15:00入账，成交数量作为确认份额。', '文件未单列净值与费用，成交单价按金额÷份额计算，费用记0；买入成本及现金以原始成交金额为准。赎回按文件成交金额作为到账金额。'] };
  return trades;
}
