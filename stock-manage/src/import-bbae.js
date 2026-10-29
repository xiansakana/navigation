import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { isOptionSymbol, roundMoney } from './trades.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => String(value ?? '').trim();
const number = value => {
  const s = text(value).replace(/[$,]/g, '');
  return s && /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN;
};
function date(value) {
  const m = text(value).match(/^(\d{4})[/-](\d{2})[/-](\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error('BBAE 成交/下单时间无效，需保留导出中的北京时间');
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  if (!Number.isFinite(Date.parse(iso))) throw new Error('BBAE 时间无效');
  return new Date(iso).toISOString();
}

export function parseBbaeBuffer(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer' });
  let recognized = false;
  const trades = [], keys = new Set();
  for (const sheet of book.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(book.Sheets[sheet], { header: 1, raw: false, defval: '' });
    const header = rows.findIndex(r => r.includes('订单状态') && r.includes('总计') && (r.includes('股票代码') || r.includes('期权代码')));
    if (header < 0) continue;
    recognized = true;
    const columns = rows[header];
    const option = columns.includes('期权代码');
    for (let index = header + 1; index < rows.length; index++) {
      const get = key => rows[index][columns.indexOf(key)];
      const shares = number(get('成交数量'));
      if (!(shares > 0)) continue; // Unfilled and cancelled orders have no cash movement.
      const symbol = text(get(option ? '期权代码' : '股票代码')).toUpperCase();
      const type = get('方向') === '买入' ? 'buy' : get('方向') === '卖出' ? 'sell' : null;
      const price = number(get('成交价')), net = number(get('总计'));
      if (!type || !(price > 0) || !(net >= 0) || !symbol || (option ? !isOptionSymbol(symbol) : !/^[A-Z][A-Z0-9.-]*$/.test(symbol))) throw new Error(`BBAE 第${index + 1}行成交数据无效`);
      const amount = roundMoney(shares * price * (option ? 100 : 1));
      const fee = roundMoney(type === 'buy' ? net - amount : amount - net);
      if (fee < 0) throw new Error(`BBAE 第${index + 1}行总计与成交本金矛盾，请核对原始文件`);
      const orderedAt = date(get('下单时间')), tradedAt = date(get('成交时间'));
      const key = hash([symbol, type, orderedAt]);
      if (keys.has(key)) throw new Error('BBAE 存在同秒同代码同方向的多笔订单，缺少订单编号，无法安全区分');
      keys.add(key);
      trades.push({ id: `bbae-${key}`, broker: 'bbae', broker_order_key: key, broker_net: net,
        symbol, type, shares, price, total_amount: amount, commission: fee, currency: 'USD',
        name: text(get('名称')) || symbol, trade_date: tradedAt, created_at: new Date().toISOString() });
    }
  }
  return recognized ? trades : null;
}

export function mergeBbaeTrades(existing, incoming, accountId) {
  if (!accountId || accountId === 'unassigned') throw new Error('导入券商文件前请选择实际所属证券账户');
  const next = [...existing], preview = [], used = new Set();
  const summary = { added: 0, updated: 0, skipped: 0 };
  const financial = t => JSON.stringify([t.symbol, t.type, Number(t.shares), Number(t.price), Number(t.total_amount), Number(t.commission), t.trade_date, t.other_category || '']);
  for (const t of incoming) {
    const owned = next.filter(x => x.account_id === accountId);
    let matches = owned.filter(x => x.broker_order_key === t.broker_order_key);
    const nearTime = x => x.symbol === t.symbol && x.type === t.type && (t.type !== 'other' || (x.other_category || '') === (t.other_category || '') || Number(x.total_amount) === Number(t.total_amount)) && Math.abs(Date.parse(x.trade_date) - Date.parse(t.trade_date)) <= 60000;
    if (!matches.length) matches = owned.filter(x => !x.broker_order_key && nearTime(x));
    if (matches.length > 1 || (matches.length && used.has(matches[0].id))) throw new Error('有多条历史记录可能对应同一订单，请先人工核对，未导入');
    const old = matches[0];
    if (!old && existing.some(x => !x.account_id && nearTime(x))) {
      summary.unassigned = (summary.unassigned || 0) + 1;
      preview.push({ ...t, importAction: 'needsAssignment' });
      continue;
    }
    const trade = { ...old, ...t, account_id: accountId, id: old?.id || `${t.broker || 'bbae'}-${hash([accountId, t.broker_order_key])}`, name: old?.name && old.name !== old.symbol ? old.name : t.name, created_at: old?.created_at || t.created_at };
    const action = !old ? 'added' : financial(old) === financial(trade) ? 'skipped' : 'updated';
    summary[action]++;
    if (old) { used.add(old.id); next[next.indexOf(old)] = trade; }
    else next.push(trade);
    preview.push({ ...trade, importAction: action });
  }
  return { trades: next, summary, preview };
}
