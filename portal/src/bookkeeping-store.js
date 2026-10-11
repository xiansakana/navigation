import crypto from 'node:crypto';
import { createBookkeepingCatalog, categoryKind } from './bookkeeping-catalog.js';

export const ENTRY_TYPES = ['支出', '收入', '转账', '还款', '借出', '收回', '退款入账', '已报销', '报销入账', '余额调整'];
export const TRANSFER_TYPES = ['转账', '还款', '借出', '收回'];
export const CURRENCIES = ['CNY', 'USD', 'HKD', 'JPY', 'MYR', 'EUR', 'GBP', 'SGD'];
const id = () => crypto.randomBytes(16).toString('hex');
function fail(message) { throw new Error(message); }
function text(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
export function cents(value, signed = false) {
  if (value === '' || value == null || !Number.isFinite(Number(value))) fail('金额必须是有效数字');
  const n = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 1e14 || (!signed && n <= 0)) fail('金额超出范围或不大于零');
  return n;
}
export function entryDate(value) {
  const date = String(value ?? '').replaceAll('/', '-').replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(date)) fail('日期格式应为 YYYY-MM-DD HH:mm:ss');
  const full = date.length === 16 ? date + ':00' : date;
  const parsed = new Date(full + 'Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== full) fail('日期无效');
  return full;
}
function currency(value) {
  const c = text(value || 'CNY').toUpperCase();
  if (!CURRENCIES.includes(c)) fail('不支持该货币');
  return c;
}

export function createBookkeepingStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookkeeping_accounts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, group_name TEXT NOT NULL,
      currency TEXT NOT NULL, opening INTEGER NOT NULL DEFAULT 0, included INTEGER NOT NULL DEFAULT 1,
      credit_limit INTEGER NOT NULL DEFAULT 0, bill_day INTEGER NOT NULL DEFAULT 0,
      due_day INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', snapshot_at TEXT NOT NULL DEFAULT '',
      UNIQUE(user_id, name)
    );
    CREATE TABLE IF NOT EXISTS bookkeeping_entries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL,
      amount INTEGER NOT NULL, currency TEXT NOT NULL, category TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT '',
      account_id TEXT, to_account_id TEXT, to_amount INTEGER, note TEXT NOT NULL DEFAULT '',
      book TEXT NOT NULL DEFAULT '个人账本', tags TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
      refund INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 0, fee INTEGER NOT NULL DEFAULT 0,
      affects_balance INTEGER NOT NULL DEFAULT 1, source_key TEXT, raw TEXT,
      created_at TEXT NOT NULL, UNIQUE(user_id, source_key)
    );
    CREATE INDEX IF NOT EXISTS bookkeeping_user_date ON bookkeeping_entries(user_id, date);
    CREATE TABLE IF NOT EXISTS bookkeeping_settings (user_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(bookkeeping_accounts)').all().map(c => c.name));
  for (const [column, definition] of [['archived', 'INTEGER NOT NULL DEFAULT 0'], ['sort_order', 'INTEGER NOT NULL DEFAULT 0'], ['icon', "TEXT NOT NULL DEFAULT '◈'"], ['account_type', "TEXT NOT NULL DEFAULT '其他资产'"]]) {
    if (!columns.has(column)) db.exec('ALTER TABLE bookkeeping_accounts ADD COLUMN ' + column + ' ' + definition);
  }
  if (!columns.has('account_type')) db.prepare("UPDATE bookkeeping_accounts SET account_type='信用卡' WHERE group_name LIKE '%信用%'").run();
  const catalog = createBookkeepingCatalog(db);
  function accounts(userId) {
    catalog.seed(userId);
    const list = db.prepare(`SELECT a.* FROM bookkeeping_accounts a LEFT JOIN bookkeeping_groups g ON g.user_id=a.user_id AND g.name=a.group_name
      WHERE a.user_id = ? ORDER BY g.sort_order,a.sort_order,a.rowid`).all(userId);
    const delta = new Map();
    for (const e of db.prepare('SELECT * FROM bookkeeping_entries WHERE user_id = ? AND affects_balance = 1').all(userId)) {
      const add = (accountId, amount) => { if (accountId) delta.set(accountId, (delta.get(accountId) || 0) + amount); };
      if (TRANSFER_TYPES.includes(e.type)) { add(e.account_id, -e.amount - e.fee); add(e.to_account_id, e.to_amount ?? e.amount); }
      else if (['支出', '已报销'].includes(e.type)) add(e.account_id, -e.amount - e.fee);
      else add(e.account_id, e.amount - e.fee);
    }
    return list.map(a => ({ id: a.id, name: a.name, group: a.group_name, currency: a.currency,
      opening: a.opening / 100, balance: (a.opening + (delta.get(a.id) || 0)) / 100,
      included: !!a.included, creditLimit: a.credit_limit / 100, billDay: a.bill_day, dueDay: a.due_day,
      note: a.note, snapshotAt: a.snapshot_at, archived: !!a.archived, sortOrder:a.sort_order, icon:a.icon, accountType:a.account_type }));
  }
  function saveAccount(userId, input, accountId) {
    return db.transaction(() => saveAccountData(userId,input,accountId))();
  }
  function saveAccountData(userId, input, accountId) {
    const existing = accountId && accounts(userId).find(a => a.id === accountId);
    if (accountId && !existing) fail('账户不存在');
    input = { ...existing, ...input };
    const name = text(input.name, 100); if (!name) fail('账户名称不能为空');
    const c = currency(input.currency);
    if (existing && existing.currency !== c && db.prepare('SELECT 1 FROM bookkeeping_entries WHERE user_id=? AND (account_id=? OR to_account_id=?)').get(userId, accountId, accountId)) fail('有账单的账户不能更改货币');
    const day = value => { const n = Number(value || 0); if (!Number.isInteger(n) || n < 0 || n > 31) fail('账单日或还款日应为 0 至 31'); return n; };
    const opening = existing ? cents(existing.opening, true) : cents(input.balance ?? 0, true);
    const credit = cents(input.creditLimit ?? 0, true); if (credit < 0) fail('信用额度不能为负数');
    const aid = existing?.id || id();
    catalog.ensureGroup(userId, input.group || '资金账户');
    try {
      db.prepare(`INSERT INTO bookkeeping_accounts (id,user_id,name,group_name,currency,opening,included,credit_limit,bill_day,due_day,note,snapshot_at,archived,sort_order,icon,account_type)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,group_name=excluded.group_name,currency=excluded.currency,
        included=excluded.included,credit_limit=excluded.credit_limit,bill_day=excluded.bill_day,due_day=excluded.due_day,note=excluded.note,
        archived=excluded.archived,icon=excluded.icon,account_type=excluded.account_type`).run(
        aid, userId, name, text(input.group || '资金账户', 100), c, opening, input.included === false ? 0 : 1,
        credit, day(input.billDay), day(input.dueDay), text(input.note, 1000), existing?.snapshotAt || text(input.snapshotAt, 100),
        input.archived === true ? 1 : 0, existing?.sortOrder ?? db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM bookkeeping_accounts WHERE user_id=?').get(userId).n,
        text(input.icon || '◈',20), text(input.accountType || (input.group?.includes('信用') ? '信用卡' : '其他资产'),100));
    } catch (error) { if (error.code?.startsWith('SQLITE_CONSTRAINT')) fail('账户名称已存在'); throw error; }
    return aid;
  }
  function normalizeEntry(userId, input, historical = false, allowedArchived = []) {
    const type = text(input.type); if (!ENTRY_TYPES.includes(type)) fail('账单类型无效');
    const amount = cents(input.amount, type === '余额调整' || historical);
    if (amount < 0 && type !== '余额调整') fail('收支与转账金额不能为负数');
    const c = currency(input.currency);
    const find = aid => { if (!aid) return null; const a = db.prepare('SELECT id,currency,archived FROM bookkeeping_accounts WHERE user_id=? AND id=?').get(userId, aid); if (!a) fail('账户不存在或不属于当前用户'); if (a.archived && !allowedArchived.includes(aid)) fail('账户已归档，请先恢复账户'); return a; };
    const from = find(input.accountId), to = find(input.toAccountId);
    const transfer = TRANSFER_TYPES.includes(type);
    if (!transfer && input.toAccountId) fail('只有转账类账单可填写到账账户');
    if (from && from.currency !== c && !historical) fail('账单货币须与付款/收款账户一致');
    if (from && to && from.id === to.id) fail('转出和转入账户不能相同');
    if (transfer && !historical && (!from || !to)) fail('请选择转出和转入账户');
    let toAmount = null;
    if (transfer && to) {
      if (to.currency === c) toAmount = amount;
      else if (input.toAmount != null && input.toAmount !== '') toAmount = cents(input.toAmount);
      else if (!historical) fail('跨币种转账须填写到账金额');
    }
    const nonnegative = v => { const n = cents(v ?? 0, true); if (n < 0) fail('退款、优惠和手续费不能为负数'); return n; };
    return { date: entryDate(input.date), type, amount, currency: c, category: text(input.category || (transfer ? type : '其他')),
      subcategory: text(input.subcategory), accountId: from?.id || null, toAccountId: to?.id || null, toAmount,
      note: text(input.note, 5000), book: text(input.book || '个人账本'), tags: text(input.tags, 1000), location: text(input.location, 1000),
      refund: nonnegative(input.refund), discount: nonnegative(input.discount), fee: nonnegative(input.fee) };
  }
  function insertEntry(userId, e, opts = {}) {
    const eid = opts.id || id();
    db.prepare(`INSERT INTO bookkeeping_entries (id,user_id,date,type,amount,currency,category,subcategory,account_id,to_account_id,to_amount,
      note,book,tags,location,refund,discount,fee,affects_balance,source_key,raw,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      eid, userId, e.date, e.type, e.amount, e.currency, e.category, e.subcategory, e.accountId, e.toAccountId, e.toAmount,
      e.note, e.book, e.tags, e.location, e.refund, e.discount, e.fee, opts.historical ? 0 : 1, opts.sourceKey || null,
      opts.raw ? JSON.stringify(opts.raw) : null, new Date().toISOString());
    catalog.ensureCategory(userId, categoryKind(e.type), e.category, e.subcategory);
    return eid;
  }
  function saveEntry(userId, input, eid) {
    return db.transaction(() => {
      const old = eid && db.prepare('SELECT * FROM bookkeeping_entries WHERE user_id=? AND id=?').get(userId, eid);
      if (eid && !old) fail('账单不存在');
      const normalized = normalizeEntry(userId, input, old?.affects_balance === 0, old ? [old.account_id,old.to_account_id] : []);
      catalog.validateEntry(userId, normalized, old);
      if (old) db.prepare('DELETE FROM bookkeeping_entries WHERE user_id=? AND id=?').run(userId, eid);
      return insertEntry(userId, normalized, { id: eid, historical: old?.affects_balance === 0, sourceKey: old?.source_key, raw: old?.raw ? JSON.parse(old.raw) : null });
    })();
  }
  function entries(userId, filter = {}) {
    const clauses = ['e.user_id = ?'], args = [userId];
    if (filter.month) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) fail('月份无效'); clauses.push('substr(e.date,1,7)=?'); args.push(filter.month); }
    for (const [key, column] of [['type', 'e.type'], ['currency', 'e.currency'], ['book', 'e.book'], ['category', 'e.category'], ['subcategory', 'e.subcategory']]) {
      if (filter[key]) { clauses.push(column + '=?'); args.push(filter[key]); }
    }
    if (filter.accountId) { clauses.push('(e.account_id=? OR e.to_account_id=?)'); args.push(filter.accountId, filter.accountId); }
    if (filter.q) { clauses.push('(e.note LIKE ? OR e.category LIKE ? OR e.subcategory LIKE ? OR e.tags LIKE ? OR e.location LIKE ? OR a.name LIKE ? OR b.name LIKE ?)'); for (let i = 0; i < 7; i++) args.push('%' + text(filter.q) + '%'); }
    return db.prepare(`SELECT e.*,a.name AS account_name,b.name AS to_account_name FROM bookkeeping_entries e
      LEFT JOIN bookkeeping_accounts a ON a.id=e.account_id AND a.user_id=e.user_id
      LEFT JOIN bookkeeping_accounts b ON b.id=e.to_account_id AND b.user_id=e.user_id
      WHERE ${clauses.join(' AND ')} ORDER BY e.date DESC,e.rowid DESC`).all(...args).map(e => ({
      id: e.id, date: e.date, type: e.type, amount: e.amount / 100, currency: e.currency, category: e.category, subcategory: e.subcategory,
      accountId: e.account_id, toAccountId: e.to_account_id, toAmount: e.to_amount == null ? null : e.to_amount / 100,
      accountName: e.account_name, toAccountName: e.to_account_name, note: e.note, book: e.book, tags: e.tags, location: e.location,
      refund: e.refund / 100, discount: e.discount / 100, fee: e.fee / 100, historical: !e.affects_balance
    }));
  }
  function settings(userId) {
    const row = db.prepare('SELECT data FROM bookkeeping_settings WHERE user_id=?').get(userId);
    return row ? JSON.parse(row.data) : { rates: { CNY: 1 }, budgets: {} };
  }
  function saveSettings(userId, input) {
    const next = settings(userId);
    if (input.rates) {
      next.rates = { CNY: 1 };
      for (const [c, v] of Object.entries(input.rates)) {
        currency(c); if (!Number.isFinite(Number(v)) || Number(v) <= 0 || Number(v) > 1e6) fail('汇率必须大于零');
        if (c !== 'CNY') next.rates[c] = Number(v);
      }
    }
    if (input.budgets) {
      next.budgets = {};
      for (const [m, v] of Object.entries(input.budgets)) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) fail('预算月份无效'); const n = cents(v, true); if (n < 0) fail('预算不能为负数'); next.budgets[m] = n / 100; }
    }
    db.prepare('INSERT INTO bookkeeping_settings VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').run(userId, JSON.stringify(next));
    return next;
  }
  function saveAutoRates(userId, quotes) {
    const next = settings(userId); next.autoRates ||= {};
    for (const [c, quote] of Object.entries(quotes)) {
      currency(c);
      if (c === 'CNY' || !Number.isFinite(quote.rate) || quote.rate <= 0 || !Number.isFinite(Date.parse(quote.fetchedAt))) continue;
      next.autoRates[c] = { rate: quote.rate, source: text(quote.source, 40), asOf: text(quote.asOf, 40) || null,
        fetchedAt: quote.fetchedAt, stale: quote.stale === true };
    }
    db.prepare('INSERT INTO bookkeeping_settings VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').run(userId, JSON.stringify(next));
  }
  function removeEntry(userId, eid) { if (!db.prepare('DELETE FROM bookkeeping_entries WHERE user_id=? AND id=?').run(userId, eid).changes) fail('账单不存在'); }
  function removeAccount(userId, aid) {
    if (db.prepare('SELECT 1 FROM bookkeeping_entries WHERE user_id=? AND (account_id=? OR to_account_id=?)').get(userId, aid, aid)) fail('账户存在账单，请先处理关联账单');
    if (!db.prepare('DELETE FROM bookkeeping_accounts WHERE user_id=? AND id=?').run(userId, aid).changes) fail('账户不存在');
  }
  function reorderAccounts(userId, ids) {
    const actual = accounts(userId).map(a => a.id);
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== actual.length || ids.some(aid => !actual.includes(aid))) fail('排序列表与当前用户账户不一致，请刷新');
    db.transaction(() => ids.forEach((aid,i) => db.prepare('UPDATE bookkeeping_accounts SET sort_order=? WHERE user_id=? AND id=?').run(i,userId,aid)))();
  }
  function archiveAccount(userId, aid, archived) {
    if (typeof archived !== 'boolean') fail('归档状态无效');
    if (!db.prepare('UPDATE bookkeeping_accounts SET archived=? WHERE user_id=? AND id=?').run(archived?1:0,userId,aid).changes) fail('账户不存在');
  }
  function adjust(userId, aid, input) {
    return db.transaction(() => {
      const a = accounts(userId).find(a => a.id === aid); if (!a) fail('账户不存在');
      const delta = cents(input.balance, true) - cents(a.balance, true);
      return saveEntry(userId, { type: '余额调整', amount: delta / 100, currency: a.currency, accountId: aid,
        date: input.date, category: '余额调整', note: input.note || '手动核对余额' });
    })();
  }
  function importRows(userId, rows, accountSnapshots = []) {
    if (!Array.isArray(rows) || rows.length > 50000) fail('导入记录超出限制');
    if (!Array.isArray(accountSnapshots) || accountSnapshots.length > 500) fail('账户快照无效');
    return db.transaction(() => {
      let createdAccounts = 0, inserted = 0, duplicates = 0;
      const accountMap = new Map(accounts(userId).map(a => [a.name, a]));
      for (const a of accountSnapshots) {
        if (!accountMap.has(a.name)) { const aid = saveAccount(userId, a); accountMap.set(a.name, { id: aid, currency: a.currency }); createdAccounts++; }
      }
      const resolve = (name, c) => {
        if (!name) return null;
        let a = accountMap.get(name);
        if (!a) { const aid = saveAccount(userId, { name, currency: c, group: '待核对账户', balance: 0 }); a = { id: aid }; accountMap.set(name, a); createdAccounts++; }
        return a.id;
      };
      for (const row of rows) {
        if (!row.sourceKey) fail('导入记录缺少来源标识');
        if (db.prepare('SELECT 1 FROM bookkeeping_entries WHERE user_id=? AND source_key=?').get(userId, row.sourceKey)) { duplicates++; continue; }
        const accountId = resolve(row.accountName, row.currency), toAccountId = resolve(row.toAccountName, row.currency);
        // iCost exports specify transaction currency, which can differ from account currency.
        // Historical imports do not alter the snapshot balance and retain the original currency.
        const e = normalizeEntry(userId, { ...row, accountId, toAccountId }, true, [accountId,toAccountId]);
        if (TRANSFER_TYPES.includes(e.type)) e.toAmount = null;
        insertEntry(userId, e, { historical: true, sourceKey: row.sourceKey, raw: row.raw }); inserted++;
      }
      return { inserted, duplicates, createdAccounts };
    })();
  }
  return { accounts, saveAccount, entries, saveEntry, removeEntry, removeAccount, reorderAccounts, archiveAccount, adjust, settings, saveSettings, saveAutoRates, importRows, catalog };
}

export function summarize(entries) {
  const totals = {}, categories = {}, days = {};
  for (const e of entries) {
    const t = totals[e.currency] ||= { income: 0, expense: 0, refund: 0, reimbursement: 0, fees: 0, transfers: 0 };
    const amount = cents(e.amount, true), fee = cents(e.fee || 0, true);
    let expense = 0, income = 0;
    if (['支出', '已报销'].includes(e.type)) expense = amount;
    if (e.type === '收入') income = amount;
    if (e.type === '退款入账') { t.refund += amount; expense = -amount; }
    if (e.type === '报销入账') { t.reimbursement += amount; expense = -amount; }
    if (TRANSFER_TYPES.includes(e.type)) t.transfers += amount;
    if (e.type !== '余额调整') expense += fee;
    t.income += income; t.expense += expense; t.fees += fee;
    const categoryKey = JSON.stringify([e.currency, e.category]);
    categories[categoryKey] = (categories[categoryKey] || 0) + expense;
    const dayKey = JSON.stringify([e.currency, e.date.slice(0, 10)]);
    const d = days[dayKey] ||= { expense: 0, income: 0 }; d.expense += expense; d.income += income;
  }
  return {
    totals: Object.fromEntries(Object.entries(totals).map(([c, t]) => [c, Object.fromEntries(Object.entries({ ...t, net: t.income - t.expense }).map(([k, v]) => [k, v / 100]))])),
    categories: Object.entries(categories).map(([k, v]) => { const [currency, category] = JSON.parse(k); return { currency, category, amount: v / 100 }; }).sort((a, b) => b.amount - a.amount),
    days: Object.entries(days).map(([k, v]) => { const [currency, date] = JSON.parse(k); return { currency, date, income: v.income / 100, expense: v.expense / 100 }; }).sort((a, b) => a.date.localeCompare(b.date))
  };
}
