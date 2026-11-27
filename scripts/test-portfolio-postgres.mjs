import { withTestDatabase, assert, assertEqual } from './postgres-test-harness.mjs';
import { createPostgresPool } from '../shared/db/postgres/pool.js';
import { createPortfolioBackend } from '../shared/db/portfolio-runtime.js';

await withTestDatabase(async ({ url, client, pg }) => {
  const pool = createPostgresPool(pg.Pool, url, 'navigation-test-portfolio');
  try {
    await client.query(`INSERT INTO navigation.portfolio_users(user_id,data,updated_at) VALUES('u',$1,$2)`,
      [JSON.stringify({ cashUsd: 1000, cashCny: 0, usdCnyRate: 7, trades: [], quotes: {}, holdingsMeta: {} }), new Date().toISOString()]);
    const backend = await createPortfolioBackend({ database: pool, sqlite: null });
    const store = backend.storeFor('u');
    let data = await store.read();
    assertEqual([data.cashUsd, data.cashCny, data.usdCnyRate], [1000, 0, 7], '初始现金读取');
    data.trades.push({ id: 't1', type: 'buy', symbol: 'AAPL', name: 'Apple', currency: 'USD', shares: 1, price: 100,
      total_amount: -100, commission: 0, trade_date: '2026-01-02T00:00:00Z', account_id: null });
    data.cashUsd = 900;
    await store.write(data);
    data = await store.read();
    assertEqual([data.cashUsd, data.trades.length], [900, 1], '组合写入');

    const accountId = await backend.saveInvestmentAccount('u', { name: '券商', currency: 'USD', baselineCash: 500 });
    data = await store.read();
    assert(data.accountCashEnabled === true, '启用证券账户后现金按账户汇总');
    assertEqual(data.cashUsd, 500, '账户现金基线');
    const rows = await backend.investmentRows('u');
    assertEqual(rows.length, 1, '投资账户数量');

    const funds = await backend.setDipReserve('u', accountId, 100);
    const fund = funds.find(f => f.accountId === accountId);
    assertEqual([fund.reserved, fund.ordinaryAvailable], [100, 400], '抄底资金预留');

    const inserted = await backend.saveFundHolding('u', accountId, '000001',
      { name: '华夏成长', shares: 100, cost: 150, nav: 1.2, navDate: '2026-01-02' });
    assert(inserted === true, '期初基金写入');
    const duplicate = await backend.saveFundHolding('u', accountId, '000001',
      { name: '华夏成长', shares: 100, cost: 150, nav: 1.2, navDate: '2026-01-02' });
    assert(duplicate === false, '重复期初基金被忽略');
    assertEqual((await backend.fundHoldings('u')).length, 1, '基金持仓读取');
    assertEqual(await backend.orderedAccountIds('u'), null, '默认无账户顺序');
    assertEqual(await backend.saveAccountOrder('u', [accountId]), true, '账户顺序保存');
    assertEqual(await backend.orderedAccountIds('u'), [accountId], '账户顺序读取');

    const { rows: [saved] } = await client.query("SELECT data FROM navigation.portfolio_users WHERE user_id='u'");
    assert(JSON.parse(saved.data).trades.length === 1, '组合 JSON 持久化');
    const { rows: [audit] } = await client.query("SELECT count(*)::int AS n FROM navigation.investment_account_audit WHERE user_id='u'");
    assert(audit.n >= 1, '投资账户审计写入');
    const { rows: [reserve] } = await client.query("SELECT reserved FROM navigation.dip_cash_funds WHERE user_id='u'");
    assertEqual(Number(reserve.reserved), 100, '抄底预留持久化');
    console.log('portfolio postgres ok');
  } finally {
    await pool.close();
  }
});
