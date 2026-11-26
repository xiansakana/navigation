import pg from 'pg';
import { createPostgresPool } from '../../shared/db/postgres/pool.js';
import { verifyPostgresSchema } from '../../shared/db/postgres/readiness.js';
import { createPostgresRbacStore } from '../../shared/db/postgres/rbac-store.js';

const connections = new Map();

async function getPostgresDatabase(url) {
  if (!connections.has(url)) {
    const pool = createPostgresPool(pg.Pool, url, 'navigation-qq');
    const pending = verifyPostgresSchema(pool).then(() => pool).catch(async error => {
      connections.delete(url);
      await pool.close();
      throw error;
    });
    connections.set(url, pending);
  }
  return connections.get(url);
}

export function getPostgresMonitoring() {
  const url = process.env.NAVIGATION_QQ_MONITOR_POSTGRES_URL;
  return url ? getPostgresDatabase(url) : null;
}

export async function getPostgresCodexIdentity() {
  const url = process.env.NAVIGATION_RBAC_POSTGRES_URL;
  if (!url) return undefined;
  const store = createPostgresRbacStore(await getPostgresDatabase(url));
  return async () => {
    const snapshot = await store.load();
    if (!snapshot) throw new Error('PostgreSQL 权限数据库未初始化');
    return snapshot;
  };
}
