import pg from 'pg';
import { createPostgresPool } from '../../shared/db/postgres/pool.js';
import { verifyPostgresSchema } from '../../shared/db/postgres/readiness.js';

let pool, ready;

export async function getPostgresMonitoring() {
  const url = process.env.NAVIGATION_QQ_MONITOR_POSTGRES_URL;
  if (!url) return null;
  pool ||= createPostgresPool(pg.Pool, url, 'navigation-qq-monitor');
  ready ||= verifyPostgresSchema(pool).catch(error => { ready = undefined; throw error; });
  await ready;
  return pool;
}
