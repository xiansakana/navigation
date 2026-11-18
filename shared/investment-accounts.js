import crypto from 'node:crypto';
import { requirePortfolioUserId } from './portfolio-user.js';
import { fundCode, fundHoldings, fundTradeOrder, fundValuation, openingFundTrades } from './fund-holdings.js';
import { Decimal, roundDecimal, tradeCashAmount } from './portfolio-decimal.js';

const round = (n) => roundDecimal(n, 2);
const cents = (n) => {
  if (n === '' || n == null || !Number.isFinite(Number(n))) throw new Error('请填写有效的可用现金');
  const value = roundDecimal(new Decimal(Number(n)).times(100), 0);
  if (!Number.isSafeInteger(value)) throw new Error('请填写有效的可用现金');
  return value;
};
const isHk = symbol => /^(?:HK\.?)?\d{1,5}(?:\.HK)?$/i.test(String(symbol || ''));
const currency = (t) => isHk(t.symbol) ? 'HKD' : fundCode(t.symbol) ? 'CNY' : t.currency ? String(t.currency).toUpperCase() : (/\d{6}/.test(String(t.symbol)) && !/[CP]\d/.test(String(t.symbol)) ? 'CNY' : 'USD');
const time = (s) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(String(s)) ? s : String(s).replace(' ', 'T') + '+08:00');
export { time as investmentRecordTime };
const compareTrades = (a, b) => time(a.trade_date) - time(b.trade_date) || fundTradeOrder(a) - fundTradeOrder(b) || String(a.id).localeCompare(String(b.id));
const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export const investmentCashDelta = (t) => tradeCashAmount(t).toNumber();

export function tradeCashBaseline(account) {
  return {
    at: Math.floor(time(account.baseline_at) / 1000) * 1000,
    ids: new Set(JSON.parse(account.baseline_trade_ids || '[]'))
  };
}

export function tradeAfterCashBaseline(trade, baseline) {
  return baseline && !baseline.ids.has(trade.id) && time(trade.cash_effective_at || trade.trade_date) >= baseline.at;
}

export function applyHistoricalTradeCashCorrections(db, userId, previousTrades, nextTrades, accounts, at) {
  const previous = new Map(previousTrades.map(trade => [trade.id, trade]));
  const baselines = new Map(accounts.map(account => [account.id, tradeCashBaseline(account)]));
  const corrections = [];
  for (const trade of nextTrades) {
    const old = previous.get(trade.id);
    const baseline = baselines.get(trade.account_id);
    if (!old || !baseline || old.account_id !== trade.account_id
      || tradeAfterCashBaseline(old, baseline) || tradeAfterCashBaseline(trade, baseline)) continue;
    const adjustment = roundDecimal(tradeCashAmount(trade).minus(tradeCashAmount(old)).times(100), 0);
    if (adjustment) corrections.push({ tradeId: trade.id, accountId: trade.account_id, adjustment, strategy: !!old.dip_fund_account });
  }
  if (!corrections.length) return corrections;
  const update = db.prepare('UPDATE investment_accounts SET baseline_cash=baseline_cash+? WHERE user_id=? AND id=?');
  const audit = db.prepare("INSERT INTO investment_account_audit(user_id,account_id,action,data,at) VALUES(?,?,'trade-cash-correction',?,?)");
  for (const correction of corrections) {
    update.run(correction.adjustment, userId, correction.accountId);
    audit.run(userId, correction.accountId, JSON.stringify(correction), at);
  }
  return corrections;
}

export function ensureInvestmentSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS investment_accounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL,
    bookkeeping_id TEXT, baseline_cash INTEGER NOT NULL, baseline_at TEXT NOT NULL,
    old_ledger_balance INTEGER, created_at TEXT NOT NULL, baseline_entry_ids TEXT NOT NULL DEFAULT '[]', baseline_trade_ids TEXT NOT NULL DEFAULT '[]',
    UNIQUE(user_id,bookkeeping_id)
  ); CREATE TABLE IF NOT EXISTS investment_account_audit (
    id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
    action TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL
  );`);
  if (!db.prepare('PRAGMA table_info(investment_accounts)').all().some((c) => c.name === 'baseline_entry_ids')) db.exec("ALTER TABLE investment_accounts ADD COLUMN baseline_entry_ids TEXT NOT NULL DEFAULT '[]'");
  if (!db.prepare('PRAGMA table_info(investment_accounts)').all().some((c) => c.name === 'baseline_trade_ids')) db.exec("ALTER TABLE investment_accounts ADD COLUMN baseline_trade_ids TEXT NOT NULL DEFAULT '[]'");
}

export function investmentRows(db, userId) {
  requirePortfolioUserId(userId);
  ensureInvestmentSchema(db);
  return db.prepare('SELECT * FROM investment_accounts WHERE user_id=? ORDER BY created_at,id').all(userId);
}

export function ledgerCashDelta(e, accountId) {
  const transfers = ['转账', '还款', '借出', '收回'];
  let result = 0;
  if (e.account_id === accountId) result += (transfers.includes(e.type) || ['支出', '已报销'].includes(e.type) ? -e.amount : e.amount) - e.fee;
  if (transfers.includes(e.type) && e.to_account_id === accountId) result += e.to_amount ?? e.amount;
  return result;
}

export function projectInvestments(db, userId, input) {
  const rows = investmentRows(db, userId);
  if (!rows.length) return [];
  const raw = input || (tableExists(db, 'portfolio_users') ? JSON.parse(db.prepare('SELECT data FROM portfolio_users WHERE user_id=?').get(userId)?.data || '{}') : {});
  const funds = fundHoldings(db, userId);
  const entries = tableExists(db, 'bookkeeping_entries') ? db.prepare('SELECT * FROM bookkeeping_entries WHERE user_id=? AND affects_balance=1').all(userId) : [];
  return rows.map((account) => {
    const trades = (raw.trades || []).filter((t) => t.account_id === account.id).sort(compareTrades);
    const baseline = time(account.baseline_at);
    const baselineEntryIds = new Set(JSON.parse(account.baseline_entry_ids || '[]'));
    const tradeBaseline = tradeCashBaseline(account);
    let cash = new Decimal(account.baseline_cash).div(100);
    const movements = [];
    for (const t of trades) if (tradeAfterCashBaseline(t, tradeBaseline)) {
      const delta = tradeCashAmount(t);
      cash = cash.plus(delta);
      movements.push({ id: t.id, date: t.trade_date, kind: 'stock', type: t.type, symbol: t.symbol, name: t.name, delta: round(delta) });
    }
    for (const e of entries) if (account.bookkeeping_id && !baselineEntryIds.has(e.id) && time(e.date) >= Math.floor(baseline / 1000) * 1000) {
      const delta = new Decimal(ledgerCashDelta(e, account.bookkeeping_id)).div(100);
      if (!delta.isZero()) {
        cash = cash.plus(delta);
        movements.push({ id: e.id, date: e.date, kind: 'bookkeeping', type: e.type, delta: round(delta) });
      }
    }
    const openingFunds = new Map(funds.filter(f => f.account_id === account.id).map(f => [`${f.code}.OF`, f]));
    const quantities = new Map([...openingFunds].map(([symbol, f]) => [symbol, { shares: new Decimal(f.shares), name: f.name }]));
    for (const t of trades) {
      if (!['buy', 'sell'].includes(t.type)) continue;
      const q = quantities.get(t.symbol) || { shares: new Decimal(0), name: t.name || t.symbol };
      q.shares = t.type === 'buy' ? q.shares.plus(Number(t.shares)) : Decimal.max(0, q.shares.minus(Number(t.shares)));
      if (fundCode(t.symbol) && t.name) q.name = t.name;
      quantities.set(t.symbol, q);
    }
    const missing = [], positions = [];
    let marketValue = new Decimal(0);
    for (const [symbol, q] of quantities) {
      if (!q.shares.gt(0)) continue;
      const code = fundCode(symbol);
      const quote = code ? fundValuation(raw.quotes?.[symbol], openingFunds.get(symbol)) : raw.quotes?.[symbol];
      const price = quote?.price == null || quote.price === '' ? NaN : Number(quote.price);
      if (!Number.isFinite(price) || price < 0) missing.push(symbol);
      const value = Number.isFinite(price) && price >= 0 ? round(q.shares.times(price).times(/^[A-Z]+\d{6}[CP]/.test(symbol) ? 100 : 1)) : null;
      if (value != null) marketValue = marketValue.plus(value);
      positions.push({ symbol, ...(code ? { type: 'fund' } : {}), name: q.name, shares: q.shares.toNumber(), price: Number.isFinite(price) ? price : null, marketValue: value, quoteAsOf: quote?.asOf || quote?.updatedAt || quote?.timestamp || quote?.date || null, delayed: !!quote?.delayed });
    }
    const ledger = account.bookkeeping_id && tableExists(db, 'bookkeeping_accounts') ? db.prepare('SELECT name,archived FROM bookkeeping_accounts WHERE user_id=? AND id=?').get(userId, account.bookkeeping_id) : null;
    return { id: account.id, name: account.name, currency: account.currency, bookkeepingId: account.bookkeeping_id,
      bookkeepingName: ledger?.name || null, baselineCash: account.baseline_cash / 100, baselineAt: account.baseline_at,
      oldLedgerBalance: account.old_ledger_balance == null ? null : account.old_ledger_balance / 100,
      cash: round(cash), marketValue: missing.length ? null : round(marketValue), equity: missing.length ? null : round(cash.plus(marketValue)),
      missingQuotes: missing, positions, movements: movements.sort((a, b) => time(b.date) - time(a.date)),
      latestLedgerSnapshot: ledger ? true : false, linkedAccountArchived: !!ledger?.archived };
  });
}

export function saveInvestmentAccount(db, userId, input, id) {
  requirePortfolioUserId(userId); ensureInvestmentSchema(db);
  return db.transaction(() => {
    const old = id ? investmentRows(db, userId).find((a) => a.id === id) : null;
    if (id && !old) throw new Error('证券账户不存在');
    const name = String(input.name ?? old?.name ?? '').trim();
    if (!name || name.length > 100) throw new Error('请填写100字以内的账户名称');
    const cur = input.currency || old?.currency;
    if (!['USD', 'CNY', 'HKD'].includes(cur) || (old && old.currency !== cur)) throw new Error('证券账户币种只能为 USD、CNY 或 HKD，创建后不可更改');
    if (db.prepare('SELECT 1 FROM investment_accounts WHERE user_id=? AND currency=? AND name=? AND id!=?').get(userId, cur, name, id || '')) throw new Error('同币种账户名称已存在，请使用可区分的名称');
    const reconcile = Object.hasOwn(input, 'baselineCash');
    if (!old && !reconcile) throw new Error('首次启用必须确认可用现金，不能使用券商总资产代替');
    const baselineCash = reconcile ? cents(input.baselineCash) : old.baseline_cash;
    const baselineAt = reconcile ? new Date().toISOString() : old.baseline_at;
    const bookkeepingId = Object.hasOwn(input, 'bookkeepingId') ? input.bookkeepingId || null : old?.bookkeeping_id || null;
    let snapshot = old?.old_ledger_balance ?? null;
    if (old && old.bookkeeping_id && bookkeepingId !== old.bookkeeping_id) throw new Error('已绑定账户不可直接换绑，请先核对现金后解除绑定');
    if (bookkeepingId) {
      if (!tableExists(db, 'bookkeeping_accounts')) throw new Error('请先在记账模块创建理财账户');
      const ledger = db.prepare('SELECT * FROM bookkeeping_accounts WHERE user_id=? AND id=?').get(userId, bookkeepingId);
      if (!ledger || ledger.archived || ledger.currency !== cur || ledger.account_type === '信用卡') throw new Error('请选择本人名下、同币种、未归档的非信用卡账户');
      if (db.prepare('SELECT 1 FROM investment_accounts WHERE user_id=? AND bookkeeping_id=? AND id!=?').get(userId, bookkeepingId, id || '')) throw new Error('该记账账户已绑定其他证券账户');
      if (!old?.bookkeeping_id) {
        if (!reconcile) throw new Error('首次绑定需重新确认当前现金');
        const entries = db.prepare('SELECT * FROM bookkeeping_entries WHERE user_id=? AND affects_balance=1').all(userId);
        snapshot = ledger.opening + entries.reduce((s, e) => s + ledgerCashDelta(e, bookkeepingId), 0);
      }
    }
    const accountId = old?.id || crypto.randomUUID();
    db.prepare(`INSERT INTO investment_accounts(id,user_id,name,currency,bookkeeping_id,baseline_cash,baseline_at,old_ledger_balance,created_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,bookkeeping_id=excluded.bookkeeping_id,baseline_cash=excluded.baseline_cash,baseline_at=excluded.baseline_at,old_ledger_balance=excluded.old_ledger_balance`).run(accountId, userId, name, cur, bookkeepingId, baselineCash, baselineAt, snapshot, old?.created_at || baselineAt);
    if (reconcile) {
      const ids = tableExists(db, 'bookkeeping_entries') ? db.prepare('SELECT id FROM bookkeeping_entries WHERE user_id=?').all(userId).map((e) => e.id) : [];
      db.prepare('UPDATE investment_accounts SET baseline_entry_ids=? WHERE user_id=? AND id=?').run(JSON.stringify(ids), userId, accountId);
      const trades = tableExists(db, 'portfolio_users') ? JSON.parse(db.prepare('SELECT data FROM portfolio_users WHERE user_id=?').get(userId)?.data || '{}').trades || [] : [];
      db.prepare('UPDATE investment_accounts SET baseline_trade_ids=? WHERE user_id=? AND id=?').run(JSON.stringify(trades.map((t) => t.id)), userId, accountId);
    }
    db.prepare('INSERT INTO investment_account_audit(user_id,account_id,action,data,at) VALUES(?,?,?,?,?)').run(userId, accountId, reconcile ? 'cash-baseline' : 'rename', JSON.stringify({ before: old, input: { name, currency: cur, bookkeepingId, baselineCash: baselineCash / 100 } }), new Date().toISOString());
    return accountId;
  }).immediate();
}

export function prepareInvestmentTrades(db, userId, next, before) {
  const accounts = investmentRows(db, userId);
  if (!accounts.length) {
    if (next.some(t => currency(t) === 'HKD')) throw new Error('请先创建港币证券账户');
    if (next.some(t => t.type !== 'other' && fundCode(t.symbol))) throw new Error('请先创建人民币证券账户');
    return next;
  }
  const old = new Map((before.trades || []).map((t) => [t.id, t]));
  const financial = (t) => JSON.stringify([t.type, t.symbol, t.shares, t.price, t.total_amount, t.commission, t.currency, t.trade_date, t.account_id]);
  const ids = new Set();
  const prepared = next.map((trade) => {
    if (ids.has(trade.id)) throw new Error('同一用户交易ID重复，导入已取消');
    ids.add(trade.id);
    const previous = old.get(trade.id);
    if (!trade.account_id && previous && financial(previous) === financial(trade)) return trade;
    if (!Number.isFinite(time(trade.trade_date))) throw new Error('交易时间无效，无法确定现金基准');
    const cur = currency(trade);
    if (cur === 'HKD' && trade.type !== 'other' && !isHk(trade.symbol)) throw new Error('港股代码请填写 00700 或 00700.HK');
    const candidates = accounts.filter((a) => a.currency === cur);
    const accountId = trade.account_id || (candidates.length === 1 ? candidates[0].id : '');
    const account = accounts.find((a) => a.id === accountId);
    if (!account || account.currency !== cur) throw new Error('请选择本人名下、同币种的证券账户');
    return { ...trade, account_id: accountId, ...(cur === 'HKD' || fundCode(trade.symbol) ? { currency: cur } : {}) };
  });
  const fundTrades = prepared.filter(t => ['buy', 'sell'].includes(t.type) && fundCode(t.symbol));
  if (fundTrades.length) {
    const balances = new Map();
    const ordered = fundTrades.sort(compareTrades);
    for (const t of [...openingFundTrades(fundHoldings(db, userId)), ...ordered]) {
      const key = JSON.stringify([t.account_id, t.symbol]);
      const before = balances.get(key) || new Decimal(0);
      const shares = t.type === 'buy' ? before.plus(Number(t.shares)) : before.minus(Number(t.shares));
      if (shares.lt(-1e-8)) throw new Error(`${t.symbol} 卖出份额超过该账户当时的可用份额`);
      balances.set(key, Decimal.max(0, shares));
    }
  }
  return prepared;
}

export function decorateInvestmentBalances(db, userId, accounts) {
  const investments = projectInvestments(db, userId);
  return accounts.map((a) => {
    const linked = investments.find((i) => i.bookkeepingId === a.id);
    return linked ? { ...a, ledgerBalance: a.balance, balance: linked.equity, balanceSource: 'portfolio', investment: linked } : a;
  });
}

export function assertUnboundLedgerAccount(db, userId, accountId) {
  if (investmentRows(db, userId).some((a) => a.bookkeeping_id === accountId)) throw new Error('此账户已绑定证券账户，请在股票管理中核对现金；账户归档、删除或变更币种前需先解除绑定');
}

export function unlinkInvestmentAccount(db, userId, accountId) {
  return db.transaction(() => {
    const account = projectInvestments(db, userId).find((a) => a.id === accountId);
    if (!account?.bookkeepingId) throw new Error('账户未绑定记账账户');
    if (account.equity == null) throw new Error('请先补齐行情，核对当前总资产后再解除绑定');
    const ledger = db.prepare('SELECT * FROM bookkeeping_accounts WHERE user_id=? AND id=?').get(userId, account.bookkeepingId);
    const entries = db.prepare('SELECT * FROM bookkeeping_entries WHERE user_id=? AND affects_balance=1').all(userId);
    const oldBalance = ledger.opening + entries.reduce((s, e) => s + ledgerCashDelta(e, ledger.id), 0);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO bookkeeping_entries(id,user_id,date,type,amount,currency,category,account_id,note,affects_balance,raw,created_at)
      VALUES(?,?,?,'余额调整',?,?,'证券解绑估值',?,'解除证券绑定，保存当时总资产',1,?,?)`).run(crypto.randomBytes(16).toString('hex'), userId, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19), cents(account.equity) - oldBalance, account.currency, ledger.id, JSON.stringify({ kind: 'investment-unlink', accountId }), now);
    db.prepare('UPDATE investment_accounts SET bookkeeping_id=NULL,baseline_cash=?,baseline_at=? WHERE user_id=? AND id=?').run(cents(account.cash), now, userId, accountId);
    const raw = JSON.parse(db.prepare('SELECT data FROM portfolio_users WHERE user_id=?').get(userId)?.data || '{}');
    db.prepare('UPDATE investment_accounts SET baseline_trade_ids=? WHERE user_id=? AND id=?').run(JSON.stringify((raw.trades || []).map((t) => t.id)), userId, accountId);
    db.prepare('INSERT INTO investment_account_audit(user_id,account_id,action,data,at) VALUES(?,?,?,?,?)').run(userId, accountId, 'unlink', JSON.stringify(account), now);
  }).immediate();
}
