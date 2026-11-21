import { TRANSFER_TYPES } from './bookkeeping-store.js';
import { investmentCashDelta, investmentRecordTime } from '../../shared/investment-accounts.js';
import { inferCurrency } from '../../stock-manage/src/markets.js';

const cashCategory = value => {
  const label = String(value || '');
  if (/股息税|预扣税/.test(label)) return 'dividend-tax';
  if (/股息|分红/.test(label)) return 'dividend';
  if (/利息/.test(label)) return 'interest';
  if (/托管费/.test(label)) return 'custody-fee';
  return '';
};

function securitiesCashLedger(entries, account, quote, trades, now) {
  const result = new Map(), movements = [];
  let cash = Number.isFinite(account.investment?.cash) ? Math.round(account.investment.cash * 100) : null;
  let issue = Array.isArray(trades) ? cash === null ? '缺少当前证券现金' : '' : '无证券现金流水查看权限';
  if (issue) cash = null;
  const labels = new Map();
  function add(movement, category, side) {
    movements.push(movement);
    if (!category || !movement.delta || !Number.isFinite(movement.at)) return;
    const date = new Date(movement.at + 8 * 3600000).toISOString().slice(0, 10);
    const key = JSON.stringify([date, category, movement.delta]);
    if (!labels.has(key)) labels.set(key, { entries: [], trades: [] });
    labels.get(key)[side].push(movement);
  }
  for (const e of entries) {
    if (e.accountId !== account.id && e.toAccountId !== account.id) continue;
    const incoming = TRANSFER_TYPES.includes(e.type) && e.toAccountId === account.id;
    const debit = TRANSFER_TYPES.includes(e.type) || ['支出', '已报销'].includes(e.type);
    const needsReceipt = incoming && e.toAmount == null && e.currency !== account.currency;
    let delta = e.type === '余额调整' ? 0 : incoming && e.toAmount != null ? e.toAmount :
      e.currency !== account.currency ? null : incoming ? e.amount : (debit ? -e.amount : e.amount) - (e.fee || 0);
    if (needsReceipt) {
      const date = e.date.slice(0, 10), from = quote(e.currency, date)?.rate, to = quote(account.currency, date)?.rate;
      if (from > 0 && to > 0) delta = e.amount * from / to;
    }
    add({ entry: e, at: investmentRecordTime(e.date), delta: delta == null ? null : Math.round(delta * 100),
      estimatedReceipt: needsReceipt && delta !== null,
      issue: needsReceipt ? '缺实际到账金额及历史汇率' : '缺账户币种实扣金额' },
      ['收入', '支出'].includes(e.type) ? cashCategory(e.category + ' ' + e.note) : '', 'entries');
  }
  for (const trade of trades || []) {
    if (trade.account_id !== account.investment?.id || trade.reinvestedDividend) continue;
    const settlement = trade.settlement_date && trade.settlement_date.slice(0, 10);
    const at = investmentRecordTime(trade.cash_effective_at || (settlement ? settlement + 'T23:59:59' : trade.trade_date));
    if (!Number.isFinite(at)) {
      cash = null;
      issue = '缺交收时间';
      continue;
    }
    const valid = inferCurrency(trade.symbol, trade.currency) === account.currency &&
      Number.isFinite(Number(trade.total_amount)) && trade.total_amount != null && trade.total_amount !== '' &&
      Number.isFinite(Number(trade.commission || 0));
    const delta = valid ? Math.round(investmentCashDelta({ ...trade, historicalBackfill: false }) * 100) : null;
    add({ at, delta, issue: '缺交收金额或交收币种不一致' }, trade.type === 'other' ? cashCategory(trade.other_category) : '', 'trades');
  }
  // Match one-to-one cash events. Do not guess which of several matching records is a duplicate.
  for (const { entries, trades } of labels.values()) {
    const eligible = trades.filter(m => m.at <= now);
    const booked = entries.filter(m => m.at <= now);
    if (!booked.length || !eligible.length) continue;
    if (booked.length === 1 && eligible.length === 1) eligible[0].duplicate = true;
    else for (const m of eligible) { m.delta = null; m.issue = '现金流水疑似重复，需确认'; }
  }
  movements.sort((a, b) => b.at - a.at || Number(!!a.entry) - Number(!!b.entry));
  let estimatedReceipt = false;
  for (const m of movements) {
    const future = m.at > now;
    if (m.entry) result.set(m.entry.id, {
      balanceKind: 'cash', balanceAfter: cash === null || future ? null : cash / 100,
      balanceCurrency: account.currency, balanceEstimated: true,
      ...(cash !== null && !future && (estimatedReceipt || m.estimatedReceipt) ? { balanceNote: '到账额按历史汇率估算' } : {}),
      ...(future || issue ? { balanceIssue: future ? '尚未发生' : issue } : {})
    });
    if (future || m.duplicate || cash === null) continue;
    if (m.delta === null) { cash = null; issue = m.issue; }
    else { cash -= m.delta; estimatedReceipt ||= m.estimatedReceipt; }
  }
  return result;
}

// entries must retain the store's date DESC, rowid DESC order, before filtering/pagination.
export function accountLedger(entries, account, quote, { trades, now = Date.now() } = {}) {
  const result = new Map();
  if (!account) return result;
  if (account.balanceSource === 'portfolio') return securitiesCashLedger(entries, account, quote, trades, now);
  let balance = Math.round(account.balance * 100), estimated = false;
  const movements = [];
  for (const e of entries) {
    if (e.accountId !== account.id && e.toAccountId !== account.id) continue;
    const incoming = TRANSFER_TYPES.includes(e.type) && e.toAccountId === account.id;
    let movementEstimated = !!e.historical;
    const convert = amount => {
      if (e.currency === account.currency) return Math.round(amount * 100);
      const date = e.date.slice(0, 10), from = quote(e.currency, date), to = quote(account.currency, date);
      estimated = true;
      movementEstimated = true;
      return from?.rate > 0 && to?.rate > 0 ? Math.round(amount * from.rate / to.rate * 100) : null;
    };
    let delta;
    if (e.historical && e.reviewedHistory && account.snapshotAt && e.date.slice(0,10)>=account.snapshotAt.slice(0,10)) delta = 0;
    else if (incoming && e.toAmount != null) delta = Math.round(e.toAmount * 100);
    else if (incoming) { estimated = true; movementEstimated = true; delta = convert(e.amount); }
    else {
      const debit = TRANSFER_TYPES.includes(e.type) || ['支出', '已报销'].includes(e.type);
      delta = convert((debit ? -e.amount : e.amount) - (e.fee || 0));
    }
    estimated ||= !!e.historical;
    const checkpoint=e.type==='余额调整'?e.balanceCheckpoint:null;
    movements.push({ e, delta, checkpoint, estimated: movementEstimated });
    if(checkpoint)balance=Math.round(checkpoint.after*100);
    result.set(e.id, { balanceAfter: balance == null ? null : balance / 100,
      balanceCurrency: account.currency, balanceEstimated: checkpoint?false:estimated });
    balance = checkpoint?Math.round(checkpoint.before*100):balance == null || delta == null ? null : balance - delta;
  }
  // A screenshot is an observed balance. Carry it forward through later bills,
  // rather than splicing its single row into a curve reversed from today's snapshot.
  let anchored = false;
  for (const { e, delta, checkpoint, estimated: movementEstimated } of movements.reverse()) {
    if (checkpoint) {
      balance = Math.round(checkpoint.after * 100);
      estimated = false;
      anchored = true;
    } else if (anchored) {
      balance = balance == null || delta == null ? null : balance + delta;
      estimated ||= movementEstimated;
    }
    if (anchored) result.set(e.id, {
      balanceAfter: balance == null ? null : balance / 100,
      balanceCurrency: account.currency, balanceEstimated: estimated
    });
  }
  return result;
}
