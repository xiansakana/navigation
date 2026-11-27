import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { withTestDatabase, assert, assertEqual } from './postgres-test-harness.mjs';
import { createPostgresPool } from '../shared/db/postgres/pool.js';
import { createPortfolioBackend } from '../shared/db/portfolio-runtime.js';
import { configurePortfolioBackend } from '../shared/db/portfolio-bridge.js';
import { createPostgresStore } from '../qqq-dip/src/postgres-store.js';

await withTestDatabase(async ({ url, client, pg }) => {
  const pool = createPostgresPool(pg.Pool, url, 'navigation-test-qqq-dip');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqq-dip-pg-'));
  try {
    await client.query("INSERT INTO navigation.meta(key,value) VALUES('portfolio_legacy_owner','u')");
    await client.query('INSERT INTO navigation.portfolio_users(user_id,data,updated_at) VALUES($1,$2,$3)',
      ['u', JSON.stringify({ cashUsd: 1000, cashCny: 0, usdCnyRate: 7, trades: [], quotes: {}, holdingsMeta: {} }), new Date().toISOString()]);
    const portfolio = await createPortfolioBackend({ database: pool, sqlite: null, bookkeepingDatabase: pool });
    configurePortfolioBackend(portfolio);
    const config = { dbPath: path.join(dir, 'qqq-dip.db'), notify: { qq: { token: 'fixture-token' } } };
    const store = await createPostgresStore(config, pool);
    assertEqual(store.getSettings().intervalSeconds, 30, '默认设置');
    await store.setSettings({ intervalSeconds: 45 });
    assertEqual(store.getSettings().intervalSeconds, 45, '设置持久化');
    await store.setRound({ startedAt: '2026-01-01T00:00:00Z', executed: {} });
    assertEqual(store.getRound().startedAt, '2026-01-01T00:00:00Z', '轮次写入');
    await store.addAction({ type: 'note', source: 'user', message: 'fixture' });
    assertEqual(store.listActionRows({ limit: 5 }).items[0].message, 'fixture', '操作记录');
    const cash = await store.getCash();
    assertEqual(cash.cashUsd, 1000, '组合现金读取');
    await store.setCash({ cashUsd: 1200 });
    assertEqual((await store.getCash()).cashUsd, 1200, '组合现金写入');
    const lot = await store.saveLot({ symbol: 'QQQ', type: 'call', contracts: 1 });
    assertEqual((await store.getLots()).some(row => row.id === lot.id), true, '仓位保存');
    await store.markExecuted('T1', { usd: 12, cashUsd: 12, cashCny: 0, complete: false });
    assertEqual(store.getRound().executed.T1.usd, 12, '执行记录');

    const { rows: [row] } = await client.query("SELECT data FROM navigation.qqq_dip_state WHERE id='default'");
    assert(JSON.parse(row.data).settings.intervalSeconds === 45, '状态行持久化');

    const restored = await createPostgresStore(config, pool);
    assertEqual(restored.getSettings().intervalSeconds, 45, '重启后设置');
    assertEqual(restored.listActionRows({ limit: 5 }).items.length, 1, '重启后操作记录');
    assertEqual(restored.getRound().executed.T1.usd, 12, '重启后执行记录');
    console.log('qqq-dip postgres ok');
  } finally {
    await pool.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
