import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { mergeBbaeTrades } from './import-bbae.js';
import { roundMoney } from './trades.js';

const text = v => String(v ?? '').trim();
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const present = v => text(v) && text(v) !== '--';
function number(v) {
  const s = text(v).replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) throw new Error('金额或数量无效');
  if (!Number.isFinite(Number(s))) throw new Error('金额或数量超出范围');
  return Number(s);
}
function date(day, clock) {
  const s = `${text(day)}T${text(clock)}+08:00`;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\+08:00$/.test(s) || !Number.isFinite(Date.parse(s))) throw new Error('交收日期或发生时间无效');
  // Validate calendar date independently of timezone rollover.
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) !== day) throw new Error('交收日期无效');
  return new Date(s).toISOString();
}

/** Recognize only the richer settlement export; funding statements are reconciliation inputs. */
export function parseEastmoneyBuffer(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const source = [];
  let recognized = false;
  for (const sheet of book.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(book.Sheets[sheet], { header: 1, raw: false, defval: '' });
    const at = rows.findIndex(r => ['交收日期','交易类别','发生金额','佣金','流水号'].every(h => r.includes(h)));
    if (at < 0) {
      if (rows.some(r => r.includes('操作') && r.includes('资金余额') && r.includes('成交均价'))) throw new Error('东方财富资金流水仅用于对账，请选择交割单文件导入');
      continue;
    }
    recognized = true;
    const h = rows[at];
    for (let i = at + 1; i < rows.length; i++) {
      if (!rows[i].some(present)) continue;
      source.push({ ...Object.fromEntries(h.map((k,j) => [k,text(rows[i][j])])), row: i + 1 });
    }
  }
  if (!recognized) return null;
  const trades = [], keys = new Set(), excluded = new Map();
  const skip = (r, reason = '本次不支持此业务，仅提示、不导入') => {
    const k = `${r['交易类别']}：${reason}`;
    excluded.set(k, (excluded.get(k) || 0) + 1);
  };
  const link = r => present(r['流水号']) ? JSON.stringify([r['股东账号'], r['流水号']]) : null;
  const receipts = source.filter(r => r['交易类别'] === '新股入账');
  for (const r of source) {
    const cat = r['交易类别'];
    if (cat === '新股入账') {
      const linked = source.filter(x => x['交易类别'] === '配售缴款' && link(r) && link(x) === link(r)).length === 1;
      skip(r, linked ? '与配售缴款关联合并为一笔买入，不重复增加持仓' : '缺少唯一缴款记录，无法确定成本');
      continue;
    }
    if (!['证券买入','证券卖出','红利入账','利息归本','配售缴款'].includes(cat)) { skip(r); continue; }
    try {
      if (r['币种'] !== '人民币') throw new Error('仅支持人民币交割单');
      const net = roundMoney(number(r['发生金额']));
      const tradeDate = date(r['交收日期'], r['发生时间']);
      const fees = ['佣金','其他费用','印花税','过户费'].map(k => number(r[k]));
      if (fees.some(x => x < 0)) throw new Error('费用不能为负');
      const fee = roundMoney(fees.reduce((s,n) => s + n, 0));
      const type = cat === '证券卖出' ? 'sell' : ['证券买入','配售缴款'].includes(cat) ? 'buy' : 'other';
      let symbol = r['证券代码'], name = r['证券名称'], shares = 1, price = 0, amount = net;
      if (type !== 'other') {
        shares = number(r['成交数量']); price = number(r['成交均价']); amount = roundMoney(number(r['成交金额']));
        if (cat === '配售缴款') {
          const matches = receipts.filter(x => link(r) && link(x) === link(r));
          if (matches.length !== 1) { skip(r, '缺少唯一的新债入账关联，请提供包含缴款及入账的完整交割单'); continue; }
          const receipt = matches[0];
          if (number(receipt['成交数量']) !== shares || number(receipt['发生金额']) !== 0 || net >= 0) throw new Error('新债缴款与入账数量或金额矛盾');
          symbol = receipt['证券代码']; name = receipt['证券名称'];
        }
        if (!/^\d{6}$/.test(symbol) || !(shares > 0) || !(price > 0) || !(amount > 0)) throw new Error('证券代码、成交数量或价格无效');
        const expected = type === 'buy' ? -amount - fee : amount - fee;
        if (Math.abs(expected - net) > 0.011) throw new Error('成交金额、费用与资金发生金额不一致');
      } else {
        if (!(net > 0) || fee !== 0) throw new Error('分红或利息金额无效');
        if (!/^\d{6}$/.test(symbol)) symbol = 'OTHER';
        if (!present(name)) name = cat === '利息归本' ? '现金利息' : cat;
      }
      const key = hash([r['股东账号'], r['交收日期'], cat, r['证券代码'], r['发生时间'], r['成交编号'], r['流水号']]);
      if (keys.has(key)) throw new Error('记录标识重复，无法安全区分');
      keys.add(key);
      trades.push({ id: `eastmoney-${key}`, broker: 'eastmoney', broker_order_key: key, broker_net: net,
        broker_category: cat, source_trade_date: r['发生日期'], settlement_date: r['交收日期'],
        ...(cat === '配售缴款' ? { security_received_at: receipts.find(x => link(x) === link(r))['交收日期'] } : {}),
        symbol, name, shares, price, type, total_amount: amount, commission: fee, currency: 'CNY',
        ...(type === 'other' ? { other_category: cat === '红利入账' ? '股息' : '利息' } : {}),
        trade_date: tradeDate, created_at: new Date().toISOString() });
    } catch (e) { throw new Error(`东方财富第${r.row}行：${e.message}`); }
  }
  // A receipt without its cost cannot safely become a zero-cost position.
  const unmatched = receipts.filter(r => !source.some(x => x['交易类别'] === '配售缴款' && link(r) && link(x) === link(r)));
  trades.importInfo = { sourceCount: source.length, excluded: [...excluded].map(([reason,count]) => ({ reason,count })),
    warnings: [unmatched.length ? `${unmatched.length}笔新债入账缺少缴款，未生成持仓，请补充完整交割单。` : '',
      '仅导入交易与收益，不包含理财本金和出入金；不会用文件中的资金余额覆盖现金基准。',
      '新债按缴款日生成有成本的买入，证券入账日期保留在来源信息中。'].filter(Boolean) };
  return trades;
}

export function mergeEastmoneyTrades(existing, incoming, accountId) {
  for (const t of incoming.filter(x => x.broker_category === '配售缴款')) {
    if (existing.some(x => !x.broker_order_key && x.symbol === t.symbol && x.type === 'buy' &&
      (!x.account_id || x.account_id === accountId) && Math.abs(Date.parse(x.trade_date) - Date.parse(t.trade_date)) > 60000 &&
      Math.abs(Date.parse(x.trade_date) - Date.parse(t.trade_date)) < 40 * 86400000)) {
      throw new Error(`新债 ${t.symbol} 已有可能对应的手工买入，请先核对历史记录，避免重复成本和持仓`);
    }
  }
  const plan = mergeBbaeTrades(existing, incoming, accountId);
  return { ...plan, summary: { ...plan.summary, ...incoming.importInfo } };
}
