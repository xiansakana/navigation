import { withTestDatabase, assert, assertEqual } from './postgres-test-harness.mjs';
import { createPostgresPool } from '../shared/db/postgres/pool.js';
import { createPortfolioBackend } from '../shared/db/portfolio-runtime.js';
import { createPostgresBookkeepingStore } from '../portal/src/bookkeeping-postgres.js';
import { createPostgresHistoricalFx, createPostgresAssetHistory, postgresSecurityHistory } from '../portal/src/bookkeeping-history-postgres.js';
import { reviewIcostImportPostgres } from '../portal/src/bookkeeping-import-review-postgres.js';
import { SOCIAL_ACCOUNT_GROUP } from '../portal/src/bookkeeping-scope.js';

await withTestDatabase(async ({ url, client, pg }) => {
  const pool = createPostgresPool(pg.Pool, url, 'navigation-test-bookkeeping');
  try {
    const portfolio = await createPortfolioBackend({ database: pool, sqlite: null, bookkeepingDatabase: pool });
    const store = createPostgresBookkeepingStore(pool, { portfolio });

    const cashId = await store.saveAccount('u', { name: '现金', balance: 100 });
    let accounts = await store.accounts('u');
    assertEqual([accounts.length, accounts[0].balance], [1, 100], '账户创建与余额');

    const expenseId = await store.saveEntry('u', { type: '支出', amount: 30, currency: 'CNY', category: '餐饮', accountId: cashId, date: '2026-01-02T12:00:00' });
    assert(!!expenseId, '账单创建');
    await store.saveEntry('u', { type: '支出', amount: 20, currency: 'CNY', category: '购物', accountId: cashId,
      date: '2026-01-03T12:00:00', refund: 5, refundDate: '2026-01-04T12:00:00' });
    let entries = await store.entries('u');
    assertEqual(entries.length, 3, '退款联动生成账单');
    accounts = await store.accounts('u');
    assertEqual(accounts[0].balance, 55, '退款后账户余额');

    const categories = await store.catalog.list('u');
    assert(categories.length > 0, '分类初始化');
    const categoryId = await store.catalog.save('u', { kind: 'expense', name: '测试分类' });
    assert(!!categoryId, '分类创建');
    const groupId = await store.catalog.saveGroup('u', { name: '测试分组' });
    assert(!!groupId, '分组创建');
    await store.catalog.reorder('u', 'categories', categories.map(c => c.id).concat(categoryId));
    const group = await store.catalog.saveGroup('u', { name: '测试分组二' }, groupId);
    assertEqual(group, groupId, '分组重命名');

    await store.saveSettings('u', { rates: { USD: 7.1 }, budgets: { '2026-01': 500 } });
    const settings = await store.settings('u');
    assertEqual([settings.rates.USD, settings.budgets['2026-01']], [7.1, 500], '设置保存');
    await store.savePeriodPreferences('u', { kind: 'month', anchor: '2026-01-15' });
    assertEqual((await store.settings('u')).period.kind, 'month', '日期范围偏好');

    const socialId = await store.saveAccount('u', { name: '公积金', group: SOCIAL_ACCOUNT_GROUP, balance: 20 });
    await store.saveAnalysisScope('u', { enabled: true, accountIds: [socialId] });
    assertEqual((await store.settings('u')).analysisScope.accountIds, [socialId], '分析排除范围');

    const imported = await store.importRows('u', [
      { sourceKey: 'row-1', type: '支出', amount: 12, currency: 'CNY', category: '餐饮', accountName: '现金', date: '2026-01-05T12:00:00' },
      { sourceKey: 'row-1', type: '支出', amount: 12, currency: 'CNY', category: '餐饮', accountName: '现金', date: '2026-01-05T12:00:00' }
    ], [], ['post', 'post']);
    assertEqual([imported.inserted, imported.duplicates], [1, 1], '导入去重');

    const preview = await store.importBalanceAdjustments('u', [
      { accountName: '现金', currency: 'CNY', beforeBalance: 100, afterBalance: 88, date: '2026-01-01T00:00:00', source: 'test' }
    ]);
    assertEqual([preview.inserted, preview.duplicates], [1, 0], '截图余额预览');
    const applied = await store.importBalanceAdjustments('u', [
      { accountName: '现金', currency: 'CNY', beforeBalance: 100, afterBalance: 88, date: '2026-01-01T00:00:00', source: 'test' }
    ], { apply: true });
    assertEqual(applied.applied, true, '截图余额写入');
    const backup = await store.backup('u');
    assert(backup.tables.bookkeeping_entries.length >= 1, '账本备份');

    await client.query(`INSERT INTO navigation.bookkeeping_fx_history(currency,date,rate,source) VALUES
      ('USD','2026-01-02',7.1,'test'),('USD','2026-01-10',7.2,'test')`);
    const fx = createPostgresHistoricalFx(pool);
    await fx.ensure([]);
    assertEqual(fx.quote('USD', '2026-01-10').rate, 7.2, '历史汇率查询');
    assertEqual(fx.enrich({ amount: 10, fee: 1, currency: 'USD', date: '2026-01-10T12:00:00' }).cnyAmount, 72, '历史汇率折算');

    const linkedLedger = await store.saveAccount('u', { name: '证券', currency: 'CNY', balance: 50 });
    await portfolio.saveInvestmentAccount('u', { name: '证券账户', currency: 'CNY', bookkeepingId: linkedLedger, baselineCash: 50 });
    const asset = createPostgresAssetHistory(pool, { portfolio });
    accounts = await store.accounts('u');
    entries = await store.entries('u');
    await asset.capture('u', accounts, entries, { CNY: 1 }, Date.parse('2026-01-10T20:00:00Z'));
    const curve = await asset.read('u', {}, '2026-01-10');
    assert(curve && curve.points.length > 0, '资产历史读取');
    const returns = await asset.returns('u', {}, '2026-01-10', accounts, entries, { CNY: 1 });
    assert(returns === null || typeof returns === 'object', '投资回报');

    await client.query(`INSERT INTO navigation.bookkeeping_security_prices(user_id,symbol,date,close,source)
      VALUES('u','QQQ','2026-01-05',400,'verified-backfill:test')`);
    const security = postgresSecurityHistory(pool);
    const prices = await security.read('u');
    assertEqual(prices.quote('QQQ', '2026-01-06').close, 400, '证券历史价格');

    const reviewUser = 'v';
    await store.saveAccount(reviewUser, { name: '现金', balance: 100 });
    const review = await reviewIcostImportPostgres(pool, portfolio, reviewUser, [
      { sourceKey: 'review-1', type: '支出', amount: 9, currency: 'CNY', category: '餐饮', accountName: '现金', date: '2026-12-01T12:00:00' }
    ], [], ['post'], { visible: () => true, canPost: true, quote: fx.quote });
    assert(typeof review.revision === 'string', '导入预览 revision');
    const confirmed = await reviewIcostImportPostgres(pool, portfolio, reviewUser, [
      { sourceKey: 'review-1', type: '支出', amount: 9, currency: 'CNY', category: '餐饮', accountName: '现金', date: '2026-12-01T12:00:00' }
    ], [], ['post'], { visible: () => true, canPost: true, quote: fx.quote, expected: review.revision });
    assertEqual(confirmed.inserted, 1, '导入确认写入');
    console.log('bookkeeping postgres ok');
  } finally {
    await pool.close();
  }
});
