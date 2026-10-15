import { TRANSFER_TYPES } from './bookkeeping-store.js';

// entries must retain the store's date DESC, rowid DESC order, before filtering/pagination.
export function accountLedger(entries, account, quote) {
  const result = new Map();
  if (!account) return result;
  if (account.balanceSource === 'portfolio') {
    for (const e of entries) if (e.accountId === account.id || e.toAccountId === account.id) result.set(e.id, { balanceAfter: null, balanceCurrency: account.currency, balanceEstimated: true });
    return result;
  }
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
    if (incoming && e.toAmount != null) delta = Math.round(e.toAmount * 100);
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
