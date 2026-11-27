import crypto from 'node:crypto';
import { decorateInvestmentBalancesFrom } from '../../shared/investment-accounts.js';
import { SOCIAL_ACCOUNT_GROUP } from './bookkeeping-scope.js';
import { createPostgresBookkeepingCatalog, categoryKind } from './bookkeeping-catalog-postgres.js';

export const ENTRY_TYPES = ['支出', '收入', '转账', '还款', '借出', '收回', '退款入账', '已报销', '报销入账', '余额调整'];
export const TRANSFER_TYPES = ['转账', '还款', '借出', '收回'];
export const CURRENCIES = ['CNY', 'USD', 'HKD', 'JPY', 'MYR', 'EUR', 'GBP', 'SGD'];
const id = () => crypto.randomBytes(16).toString('hex');
const fail = message => { throw new Error(message); };
const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);
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
function screenshotCheckpoint(raw) {
  if (!raw) return {};
  const data = JSON.parse(raw);
  return data.kind === 'icost-screenshot-adjustment-v1' && data.checkpoint ? { balanceCheckpoint: data.checkpoint } : {};
}

const accountRow = row => ({
  ...row,
  opening: Number(row.opening), included: Number(row.included), credit_limit: Number(row.credit_limit),
  bill_day: Number(row.bill_day), due_day: Number(row.due_day), archived: Number(row.archived), sort_order: Number(row.sort_order)
});
const entryRow = row => ({
  ...row,
  amount: Number(row.amount),
  to_amount: row.to_amount == null ? null : Number(row.to_amount),
  refund: Number(row.refund), discount: Number(row.discount), fee: Number(row.fee),
  affects_balance: Number(row.affects_balance)
});

export function createPostgresBookkeepingStore(db, { portfolio } = {}) {
  if (!portfolio) throw new Error('记账需要组合数据适配器');
  const catalog = createPostgresBookkeepingCatalog(db);
  const one = async (run, sql, args = []) => (await run.query(sql, args)).rows[0];
  const many = async (run, sql, args = []) => (await run.query(sql, args)).rows;

  async function accounts(uid, run = db) {
    await catalog.seed(uid, run);
    const list = (await many(run, `SELECT a.* FROM navigation.bookkeeping_accounts a
      LEFT JOIN navigation.bookkeeping_groups g ON g.user_id=a.user_id AND g.name=a.group_name
      WHERE a.user_id=$1 ORDER BY g.sort_order,a.sort_order,a._sqlite_rowid`, [uid])).map(accountRow);
    const delta = new Map();
    for (const e of await many(run, `SELECT type,account_id,to_account_id,amount,to_amount,fee
      FROM navigation.bookkeeping_entries WHERE user_id=$1 AND affects_balance=1`, [uid])) {
      const add = (accountId, amount) => { if (accountId) delta.set(accountId, (delta.get(accountId) || 0) + Number(amount)); };
      const amount = Number(e.amount), fee = Number(e.fee);
      if (TRANSFER_TYPES.includes(e.type)) { add(e.account_id, -amount - fee); add(e.to_account_id, e.to_amount == null ? amount : Number(e.to_amount)); }
      else if (['支出', '已报销'].includes(e.type)) add(e.account_id, -amount - fee);
      else add(e.account_id, amount - fee);
    }
    const investments = await portfolio.project(uid);
    return decorateInvestmentBalancesFrom(list.map(a => ({
      id: a.id, name: a.name, group: a.group_name, currency: a.currency,
      opening: a.opening / 100, balance: (a.opening + (delta.get(a.id) || 0)) / 100,
      included: !!a.included, creditLimit: a.credit_limit / 100, billDay: a.bill_day, dueDay: a.due_day,
      note: a.note, snapshotAt: a.snapshot_at, archived: !!a.archived, sortOrder: a.sort_order, icon: a.icon, accountType: a.account_type
    })), investments);
  }

  async function assertUnbound(uid, accountId, run = db) {
    if ((await portfolio.investmentRows(uid)).some(a => a.bookkeeping_id === accountId)) {
      fail('此账户已绑定证券账户，请在股票管理中核对现金；账户归档、删除或变更币种前需先解除绑定');
    }
  }

  async function saveAccountData(uid, input, accountId, run) {
    const existing = accountId ? (await accounts(uid, run)).find(a => a.id === accountId) : null;
    if (accountId && !existing) fail('账户不存在');
    input = { ...existing, ...input };
    const name = text(input.name, 100); if (!name) fail('账户名称不能为空');
    const c = currency(input.currency);
    if (existing && existing.currency !== c) await assertUnbound(uid, accountId, run);
    if (existing && existing.currency !== c
      && await one(run, 'SELECT 1 FROM navigation.bookkeeping_entries WHERE user_id=$1 AND (account_id=$2 OR to_account_id=$2)', [uid, accountId])) {
      fail('有账单的账户不能更改货币');
    }
    const day = value => { const n = Number(value || 0); if (!Number.isInteger(n) || n < 0 || n > 31) fail('账单日或还款日应为 0 至 31'); return n; };
    const opening = existing ? cents(existing.opening, true) : cents(input.balance ?? 0, true);
    const credit = cents(input.creditLimit ?? 0, true); if (credit < 0) fail('信用额度不能为负数');
    const aid = existing?.id || id();
    await catalog.ensureGroup(uid, input.group || '资金账户', run);
    const sortOrder = existing?.sortOrder ?? Number((await one(run, 'SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM navigation.bookkeeping_accounts WHERE user_id=$1', [uid])).n);
    try {
      await run.query(`INSERT INTO navigation.bookkeeping_accounts
        (id,user_id,name,group_name,currency,opening,included,credit_limit,bill_day,due_day,note,snapshot_at,archived,sort_order,icon,account_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,group_name=excluded.group_name,currency=excluded.currency,
        included=excluded.included,credit_limit=excluded.credit_limit,bill_day=excluded.bill_day,due_day=excluded.due_day,note=excluded.note,
        archived=excluded.archived,icon=excluded.icon,account_type=excluded.account_type`,
      [aid, uid, name, text(input.group || '资金账户', 100), c, opening, input.included === false ? 0 : 1,
        credit, day(input.billDay), day(input.dueDay), text(input.note, 1000),
        existing ? existing.snapshotAt : text(input.snapshotAt || new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19), 100),
        input.archived === true ? 1 : 0, sortOrder, text(input.icon || '◈', 20),
        text(input.accountType || (input.group?.includes('信用') ? '信用卡' : '其他资产'), 100)]);
    } catch (error) {
      if (error.code === '23505') fail('账户名称已存在');
      throw error;
    }
    return aid;
  }

  async function saveAccount(uid, input, accountId) {
    return db.transaction(client => saveAccountData(uid, input, accountId, client));
  }

  async function normalizeEntry(uid, input, historical = false, allowedArchived = [], previous = null, run = db) {
    const type = text(input.type); if (!ENTRY_TYPES.includes(type)) fail('账单类型无效');
    let amount = cents(input.amount, type === '余额调整' || historical);
    if (amount < 0 && type !== '余额调整') fail('收支与转账金额不能为负数');
    const c = currency(input.currency);
    const find = async (aid) => {
      if (!aid) return null;
      const a = await one(run, 'SELECT id,currency,archived FROM navigation.bookkeeping_accounts WHERE user_id=$1 AND id=$2', [uid, aid]);
      if (!a) fail('账户不存在或不属于当前用户');
      if (Number(a.archived) && !allowedArchived.includes(aid)) fail('账户已归档，请先恢复账户');
      return a;
    };
    const from = await find(input.accountId), to = await find(input.toAccountId);
    const linkedIds = new Set((await portfolio.investmentRows(uid)).map(a => a.bookkeeping_id));
    if (type === '余额调整' && linkedIds.has(input.accountId)) throw new Error('已绑定证券账户，请在股票管理中核对可用现金');
    const transfer = TRANSFER_TYPES.includes(type);
    if (!transfer && input.toAccountId) fail('只有转账类账单可填写到账账户');
    if (from && from.currency !== c && !historical) fail('账单货币须与付款/收款账户一致');
    if (from && to && from.id === to.id) fail('转出和转入账户不能相同');
    if (transfer && !historical && (!from || !to)) fail('请选择转出和转入账户');
    const nonnegative = v => { const n = cents(v ?? 0, true); if (n < 0) fail('退款、优惠和手续费不能为负数'); return n; };
    const fee = nonnegative(input.fee);
    let toAmount = null;
    if (transfer && to) {
      const receipt = input.toAmount != null && input.toAmount !== '' ? cents(input.toAmount) : null;
      if (to.currency === c) {
        const feeOnly = previous && previous.type === type && previous.currency === c &&
          previous.account_id === from?.id && previous.to_account_id === to.id &&
          (previous.to_amount ?? previous.amount) === previous.amount &&
          amount === Number(previous.amount) && (receipt ?? Number(previous.amount)) === Number(previous.amount) &&
          fee !== Number(previous.fee);
        const onlyPrincipalChanged = previous && receipt === Number(previous.to_amount) && amount !== Number(previous.amount);
        if (feeOnly) {
          amount = Number(previous.amount) + Number(previous.fee) - fee;
          if (amount <= 0) fail('手续费必须小于原转出总额');
        } else if (receipt !== null && !onlyPrincipalChanged) amount = receipt;
        toAmount = amount;
      } else if (receipt !== null) toAmount = receipt;
      else if (!historical) fail('跨币种转账须填写到账金额');
    }
    return { date: entryDate(input.date), type, amount, currency: c, category: text(input.category || (transfer ? type : '其他')),
      subcategory: text(input.subcategory), accountId: from?.id || null, toAccountId: to?.id || null, toAmount,
      note: text(input.note, 5000), book: text(input.book || '个人账本'), tags: text(input.tags, 1000), location: text(input.location, 1000),
      refund: nonnegative(input.refund), discount: nonnegative(input.discount), fee };
  }

  async function insertEntry(uid, e, opts = {}, run = db) {
    const eid = opts.id || id();
    await run.query(`INSERT INTO navigation.bookkeeping_entries
      (id,user_id,date,type,amount,currency,category,subcategory,account_id,to_account_id,to_amount,
      note,book,tags,location,refund,discount,fee,affects_balance,source_key,raw,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [eid, uid, e.date, e.type, e.amount, e.currency, e.category, e.subcategory, e.accountId, e.toAccountId, e.toAmount,
      e.note, e.book, e.tags, e.location, e.refund, e.discount, e.fee, opts.historical ? 0 : 1, opts.sourceKey || null,
      opts.raw ? JSON.stringify(opts.raw) : null, new Date().toISOString()]);
    await catalog.ensureCategory(uid, categoryKind(e.type), e.category, e.subcategory, run);
    return eid;
  }

  const refundSource = eid => 'linked-refund:v1:' + eid;
  async function saveEntry(uid, input, eid) {
    return db.transaction(async client => {
      const old = eid ? entryRow(await one(client, 'SELECT * FROM navigation.bookkeeping_entries WHERE user_id=$1 AND id=$2', [uid, eid])) : null;
      if (eid && !old) fail('账单不存在');
      const normalized = await normalizeEntry(uid, input, old?.affects_balance === 0,
        old ? [old.account_id, old.to_account_id] : [], old, client);
      await catalog.validateEntry(uid, normalized, old, client);
      if (old?.source_key?.startsWith('linked-refund:v1:') &&
        (normalized.type !== old.type || normalized.amount !== old.amount || normalized.date !== old.date ||
          normalized.accountId !== old.account_id || normalized.currency !== old.currency)) fail('请在原支出中修改已关联的退款');
      const linked = old && await one(client, 'SELECT * FROM navigation.bookkeeping_entries WHERE user_id=$1 AND source_key=$2', [uid, refundSource(eid)]);
      if (linked && (!['支出', '已报销'].includes(normalized.type) || !input.refundDate &&
        (normalized.amount < Number(linked.amount) || normalized.refund !== Number(linked.amount)))) {
        fail('请先核对这笔账单关联的退款');
      }
      let refund;
      if (input.refundDate) {
        if (!old || !['支出', '已报销'].includes(normalized.type) || !normalized.accountId) fail('请为原支出选择账户后再记录退款');
        if (normalized.refund <= 0 || normalized.refund > normalized.amount) fail('退款金额必须大于零且不超过原支出');
        const date = entryDate(input.refundDate);
        if (date < normalized.date) fail('退款到账时间不能早于原支出');
        refund = await normalizeEntry(uid, {
          type: '退款入账', date, amount: normalized.refund / 100, currency: normalized.currency,
          accountId: normalized.accountId, category: normalized.category, subcategory: normalized.subcategory,
          book: normalized.book, note: text('退款 · ' + (normalized.note || normalized.category), 5000)
        }, false, [normalized.accountId], null, client);
      }
      let raw = old?.raw ? JSON.parse(old.raw) : null;
      if (raw?.kind === 'icost-screenshot-adjustment-v1' && (normalized.type !== old.type || normalized.date !== old.date
        || normalized.amount !== old.amount || normalized.currency !== old.currency
        || normalized.accountId !== old.account_id || normalized.fee !== old.fee)) raw = { ...raw, checkpoint: null };
      if (old) await client.query('DELETE FROM navigation.bookkeeping_entries WHERE user_id=$1 AND id=$2', [uid, eid]);
      const saved = await insertEntry(uid, normalized, { id: eid, historical: old?.affects_balance === 0, sourceKey: old?.source_key, raw }, client);
      if (refund) {
        if (linked) await client.query('DELETE FROM navigation.bookkeeping_entries WHERE user_id=$1 AND id=$2', [uid, linked.id]);
        await insertEntry(uid, refund, { id: linked?.id, sourceKey: refundSource(saved) }, client);
      }
      return saved;
    });
  }

  async function entries(uid, filter = {}) {
    const clauses = ['e.user_id = $1'], args = [uid];
    const add = value => { args.push(value); return '$' + args.length; };
    if (filter.month) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) fail('月份无效'); clauses.push('substr(e.date,1,7)=' + add(filter.month)); }
    for (const [key, column] of [['type', 'e.type'], ['currency', 'e.currency'], ['book', 'e.book'], ['category', 'e.category'], ['subcategory', 'e.subcategory']]) {
      if (filter[key]) clauses.push(column + '=' + add(filter[key]));
    }
    for (const [key, op] of [['start', '>='], ['end', '<=']]) if (filter[key]) { entryDate(filter[key] + 'T00:00:00'); clauses.push('substr(e.date,1,10)' + op + add(filter[key])); }
    if (filter.start && filter.end && filter.start > filter.end) fail('开始日期不能晚于结束日期');
    if (filter.through) { if (!/^\d{4}-\d{2}-\d{2}$/.test(filter.through)) fail('截止日期无效'); clauses.push('substr(e.date,1,10)<=' + add(filter.through)); }
    if (filter.day) { if (!/^\d{4}-\d{2}-\d{2}$/.test(filter.day)) fail('日期无效'); clauses.push('substr(e.date,1,10)=' + add(filter.day)); }
    if (filter.flow) {
      const expense = "(e.type IN ('支出','已报销','退款入账','报销入账') OR (e.type!='余额调整' AND e.fee!=0))";
      if (!['expense', 'income', 'net'].includes(filter.flow)) fail('收支范围无效');
      clauses.push(filter.flow === 'expense' ? expense : filter.flow === 'income' ? "e.type='收入'" : "(e.type='收入' OR " + expense + ')');
    }
    if (filter.accountId) { const p = add(filter.accountId); clauses.push(`(e.account_id=${p} OR e.to_account_id=${p})`); args.push(filter.accountId); }
    if (filter.q) {
      const fields = ['e.note', 'e.category', 'e.subcategory', 'e.tags', 'e.location'];
      if (!filter.hideAccountSearch) fields.push('a.name', 'b.name');
      clauses.push('(' + fields.map(field => field + ' LIKE ' + add('%' + text(filter.q) + '%')).join(' OR ') + ')');
    }
    const rows = await many(db, `SELECT e.*,a.name AS account_name,b.name AS to_account_name,r.date AS refund_posted_at FROM navigation.bookkeeping_entries e
      LEFT JOIN navigation.bookkeeping_accounts a ON a.id=e.account_id AND a.user_id=e.user_id
      LEFT JOIN navigation.bookkeeping_accounts b ON b.id=e.to_account_id AND b.user_id=e.user_id
      LEFT JOIN navigation.bookkeeping_entries r ON r.user_id=e.user_id AND r.source_key=('linked-refund:v1:' || e.id) AND r.type='退款入账'
      WHERE ${clauses.join(' AND ')} ORDER BY e.date DESC,e._sqlite_rowid DESC`, args);
    return rows.map(e => entryRow(e)).map(e => ({
      id: e.id, date: e.date, type: e.type, amount: e.amount / 100, currency: e.currency, category: e.category, subcategory: e.subcategory,
      accountId: e.account_id, toAccountId: e.to_account_id, toAmount: e.to_amount == null ? null : e.to_amount / 100,
      accountName: e.account_name, toAccountName: e.to_account_name, note: e.note, book: e.book, tags: e.tags, location: e.location,
      refund: e.refund / 100, discount: e.discount / 100, fee: e.fee / 100, historical: !e.affects_balance,
      ...(e.refund_posted_at ? { refundPostedAt: e.refund_posted_at } : {}),
      ...(e.source_key && e.raw && JSON.parse(e.raw).reviewedBalance === 'history' ? { reviewedHistory: true } : {}),
      ...(e.type === '余额调整' ? screenshotCheckpoint(e.raw) : {})
    }));
  }

  async function settings(uid, run = db) {
    const row = await one(run, 'SELECT data FROM navigation.bookkeeping_settings WHERE user_id=$1', [uid]);
    return row ? JSON.parse(row.data) : { rates: { CNY: 1 }, budgets: {} };
  }
  async function writeSettings(uid, next, run = db) {
    await run.query(`INSERT INTO navigation.bookkeeping_settings(user_id,data) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`, [uid, JSON.stringify(next)]);
  }
  async function saveSettings(uid, input) {
    const next = await settings(uid);
    if (input.rates) {
      next.rates = { CNY: 1 };
      for (const [c, v] of Object.entries(input.rates)) {
        currency(c); if (!Number.isFinite(Number(v)) || Number(v) <= 0 || Number(v) > 1e6) fail('汇率必须大于零');
        if (c !== 'CNY') next.rates[c] = Number(v);
      }
    }
    if (input.budgets) {
      next.budgets = {};
      for (const [m, v] of Object.entries(input.budgets)) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) fail('预算月份无效');
        const n = cents(v, true); if (n < 0) fail('预算不能为负数'); next.budgets[m] = n / 100;
      }
    }
    await writeSettings(uid, next);
    return next;
  }
  async function savePeriodPreferences(uid, input) {
    if (!['week', 'month', 'year', 'all', 'range'].includes(input.kind)) fail('日期范围模式无效');
    const date = value => value ? entryDate(value + 'T12:00:00').slice(0, 10) : '';
    const period = { kind: input.kind, anchor: date(input.anchor), rangeStart: date(input.rangeStart), rangeEnd: date(input.rangeEnd) };
    if (period.rangeStart && period.rangeEnd && period.rangeStart > period.rangeEnd) fail('开始日期不能晚于结束日期');
    const next = await settings(uid); next.period = period;
    await writeSettings(uid, next);
    return period;
  }
  async function saveAnalysisScope(uid, input) {
    if (typeof input.enabled !== 'boolean') fail('排除开关必须为布尔值');
    if (input.accountIds != null && (!Array.isArray(input.accountIds) || input.accountIds.length > 200)) fail('排除账户列表无效');
    const allowed = new Set((await accounts(uid)).filter(a => a.group === SOCIAL_ACCOUNT_GROUP).map(a => a.id));
    if (input.accountIds?.some(id => !allowed.has(id))) fail('只能选择当前用户社保公积金等分组的账户');
    const value = { enabled: input.enabled, accountIds: input.accountIds == null ? null : [...new Set(input.accountIds)] };
    const next = await settings(uid); next.analysisScope = value;
    await writeSettings(uid, next);
    return value;
  }
  async function saveAutoRates(uid, quotes) {
    const next = await settings(uid); next.autoRates ||= {};
    for (const [c, quote] of Object.entries(quotes)) {
      currency(c);
      if (c === 'CNY' || !Number.isFinite(quote.rate) || quote.rate <= 0 || !Number.isFinite(Date.parse(quote.fetchedAt))) continue;
      next.autoRates[c] = { rate: quote.rate, source: text(quote.source, 40), asOf: text(quote.asOf, 40) || null,
        fetchedAt: quote.fetchedAt, stale: quote.stale === true };
    }
    await writeSettings(uid, next);
  }
  async function removeEntry(uid, eid) {
    const result = await db.query('DELETE FROM navigation.bookkeeping_entries WHERE user_id=$1 AND id=$2', [uid, eid]);
    if (!result.rowCount) fail('账单不存在');
  }
  async function removeAccount(uid, aid) {
    await assertUnbound(uid, aid);
    if (await one(db, 'SELECT 1 FROM navigation.bookkeeping_entries WHERE user_id=$1 AND (account_id=$2 OR to_account_id=$2)', [uid, aid, aid])) fail('账户存在账单，请先处理关联账单');
    const result = await db.query('DELETE FROM navigation.bookkeeping_accounts WHERE user_id=$1 AND id=$2', [uid, aid]);
    if (!result.rowCount) fail('账户不存在');
  }
  async function reorderAccounts(uid, ids) {
    const actual = (await accounts(uid)).map(a => a.id);
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== actual.length || ids.some(aid => !actual.includes(aid))) fail('排序列表与当前用户账户不一致，请刷新');
    await db.transaction(async client => {
      for (const [i, aid] of ids.entries()) {
        await client.query('UPDATE navigation.bookkeeping_accounts SET sort_order=$1 WHERE user_id=$2 AND id=$3', [i, uid, aid]);
      }
    });
  }
  async function archiveAccount(uid, aid, archived) {
    if (archived) await assertUnbound(uid, aid);
    if (typeof archived !== 'boolean') fail('归档状态无效');
    const result = await db.query('UPDATE navigation.bookkeeping_accounts SET archived=$1 WHERE user_id=$2 AND id=$3', [archived ? 1 : 0, uid, aid]);
    if (!result.rowCount) fail('账户不存在');
  }
  async function adjust(uid, aid, input) {
    await assertUnbound(uid, aid);
    return db.transaction(async client => {
      const a = (await accounts(uid, client)).find(a => a.id === aid); if (!a) fail('账户不存在');
      const delta = cents(input.balance, true) - cents(a.balance, true);
      return saveEntryData(uid, { type: '余额调整', amount: delta / 100, currency: a.currency, accountId: aid,
        date: input.date, category: '余额调整', note: input.note || '手动核对余额' }, null, client);
    });
  }
  // saveEntry wrapper usable inside an existing transaction.
  async function saveEntryData(uid, input, eid, run) {
    const old = eid ? entryRow(await one(run, 'SELECT * FROM navigation.bookkeeping_entries WHERE user_id=$1 AND id=$2', [uid, eid])) : null;
    if (eid && !old) fail('账单不存在');
    const normalized = await normalizeEntry(uid, input, old?.affects_balance === 0,
      old ? [old.account_id, old.to_account_id] : [], old, run);
    await catalog.validateEntry(uid, normalized, old, run);
    if (old?.source_key?.startsWith('linked-refund:v1:')) fail('请在原支出中修改已关联的退款');
    if (old) await run.query('DELETE FROM navigation.bookkeeping_entries WHERE user_id=$1 AND id=$2', [uid, eid]);
    return insertEntry(uid, normalized, { id: eid }, run);
  }

  async function importRows(uid, rows, accountSnapshots = [], decisions = null) {
    if (!Array.isArray(rows) || rows.length > 50000) fail('导入记录超出限制');
    if (!Array.isArray(accountSnapshots) || accountSnapshots.length > 500) fail('账户快照无效');
    return db.transaction(async client => {
      let createdAccounts = 0, inserted = 0, duplicates = 0;
      const accountMap = new Map((await accounts(uid, client)).map(a => [a.name, a]));
      for (const a of accountSnapshots) {
        if (!accountMap.has(a.name)) {
          const aid = await saveAccountData(uid, a, null, client);
          accountMap.set(a.name, { id: aid, currency: a.currency }); createdAccounts++;
        }
      }
      const resolve = async (name, c) => {
        if (!name) return null;
        let a = accountMap.get(name);
        if (!a) {
          const aid = await saveAccountData(uid, { name, currency: c, group: '待核对账户', balance: 0 }, null, client);
          a = { id: aid }; accountMap.set(name, a); createdAccounts++;
        }
        return a.id;
      };
      for (const [index, row] of rows.entries()) {
        if (!row.sourceKey) fail('导入记录缺少来源标识');
        if (await one(client, 'SELECT 1 FROM navigation.bookkeeping_entries WHERE user_id=$1 AND source_key=$2', [uid, row.sourceKey])) { duplicates++; continue; }
        const decision = decisions?.[index];
        if (decision === 'skip') continue;
        const accountId = await resolve(row.accountName, row.currency), toAccountId = await resolve(row.toAccountName, row.currency);
        const historical = decision !== 'post';
        const e = await normalizeEntry(uid, { ...row, accountId, toAccountId }, historical, historical ? [accountId, toAccountId] : [], null, client);
        if (historical && TRANSFER_TYPES.includes(e.type)) e.toAmount = null;
        const raw = decisions ? { ...row.raw, reviewedBalance: historical ? 'history' : 'posted' } : row.raw;
        await insertEntry(uid, e, { historical, sourceKey: row.sourceKey, raw }, client); inserted++;
      }
      return { inserted, duplicates, createdAccounts };
    });
  }
  async function importBalanceAdjustments(uid, rows, { apply = false } = {}) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 2000) fail('余额调整数据须为非空数组且不超过 2000 条');
    return db.transaction(async client => {
      const accountMap = new Map((await accounts(uid, client)).map(a => [a.name, a])), seen = new Map();
      let inserted = 0, duplicates = 0;
      for (const row of rows) {
        const a = accountMap.get(row.accountName); if (!a || a.currency !== row.currency) fail('截图账户不存在或货币不匹配');
        const before = cents(row.beforeBalance, true), after = cents(row.afterBalance, true), date = entryDate(row.date);
        cents((after - before) / 100, true);
        if (a.snapshotAt && date.slice(0, 10) > a.snapshotAt.slice(0, 10)) fail('历史调整时间不能晚于账户快照');
        const source = text(row.source, 500); if (!source) fail('截图记录缺少来源');
        const key = 'icost-screenshot-adjustment:v1:' + crypto.createHash('sha256').update(a.id + '|' + date).digest('hex');
        const raw = { kind: 'icost-screenshot-adjustment-v1', source, datePrecision: 'minute', checkpoint: { before: before / 100, after: after / 100 } };
        const old = await one(client, 'SELECT raw FROM navigation.bookkeeping_entries WHERE user_id=$1 AND source_key=$2', [uid, key]);
        const prior = old?.raw ? JSON.parse(old.raw) : seen.get(key);
        if (prior) {
          if (JSON.stringify(prior.checkpoint) !== JSON.stringify(raw.checkpoint)) fail('重复截图的调整余额不一致，请核对');
          duplicates++; continue;
        }
        seen.set(key, raw);
        if (apply) {
          const e = await normalizeEntry(uid, { date, type: '余额调整', amount: (after - before) / 100, currency: a.currency,
            accountId: a.id, category: '余额调整', note: '截图补录：' + source + '（金额为调整差额，不计入收支）' }, true, [a.id], null, client);
          await insertEntry(uid, e, { historical: true, sourceKey: key, raw }, client);
        }
        inserted++;
      }
      return { inserted, duplicates, accounts: new Set(rows.map(r => r.accountName)).size, applied: apply };
    });
  }
  async function backup(uid) {
    return db.transaction(async client => {
      const tables = {};
      for (const name of ['accounts', 'entries', 'settings', 'categories', 'groups']) {
        tables['bookkeeping_' + name] = await many(client, `SELECT * FROM navigation.bookkeeping_${name} WHERE user_id=$1`, [uid]);
      }
      return { version: 1, userId: uid, createdAt: new Date().toISOString(), tables };
    });
  }

  return { accounts, saveAccount, entries, saveEntry, removeEntry, removeAccount, reorderAccounts, archiveAccount, adjust,
    settings, saveSettings, savePeriodPreferences, saveAnalysisScope, saveAutoRates, importRows, importBalanceAdjustments,
    backup, catalog };
}
