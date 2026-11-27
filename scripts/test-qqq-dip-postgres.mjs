import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
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
    await verifyHttpReadiness({ url, client, dir });
    console.log('qqq-dip postgres ok');
  } finally {
    await pool.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function verifyHttpReadiness({ url, client, dir }) {
  const migration = new URL('../shared/db/postgres/003-runtime-state.sql', import.meta.url);
  await client.query(fs.readFileSync(migration, 'utf8'));
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ server: { port }, dbPath: path.join(dir, 'dip.db') }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.endsWith('_POSTGRES_URL')));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../qqq-dip/src/server.js', import.meta.url))], {
    env: { ...env, QQQ_DIP_CONFIG_PATH: config, NAVIGATION_DATABASE_ENGINE: 'postgres',
      NAVIGATION_POSTGRES_URL: url, NAVIGATION_POSTGRES_DATABASE: new URL(url).pathname.slice(1) },
    stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (route, options) => fetch(base + route, { signal: AbortSignal.timeout(4000), ...options });
  const write = () => request('/api/actions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-portal-user-id': 'u',
      'x-portal-permissions': Buffer.from('["*"]').toString('base64url') },
    body: JSON.stringify({ message: 'fixture HTTP write' }) });
  try {
    const deadline = Date.now() + 8000;
    while (true) {
      try { if ((await request('/readyz', { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Wait for listening. */ }
      assert(Date.now() < deadline && child.exitCode === null, '抄底监控未能启动');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    await client.query("DELETE FROM navigation.navigation_schema_migrations WHERE version='003-runtime-state'");
    assertEqual((await request('/readyz')).status, 503, 'schema 不符时未就绪');
    assertEqual((await request('/api/health')).status, 200, '数据库异常时进程存活');
    assertEqual((await write()).status, 503, 'schema 不符时拒绝写入');
    const blocked = await client.query("SELECT data FROM navigation.qqq_dip_state WHERE id='default'");
    assert(!JSON.parse(blocked.rows[0].data).actions.some(row => row.message === 'fixture HTTP write'), '被拒绝的操作没有落库');
    await client.query(fs.readFileSync(migration, 'utf8'));
    assertEqual((await request('/readyz')).status, 200, 'schema 恢复后重新就绪');
    assertEqual((await write()).status, 200, 'schema 恢复后允许写入');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
}
