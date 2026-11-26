import pg from 'pg';
import { createPostgresPool } from '../../shared/db/postgres/pool.js';
import { verifyConfiguredPostgres } from '../../shared/db/postgres/readiness.js';
import { postgresUrlFor } from '../../shared/db/postgres/config.js';
import { createPostgresRbacStore } from '../../shared/db/postgres/rbac-store.js';

const connections = new Map();

async function getPostgresDatabase(url) {
  if (!connections.has(url)) {
    const pool = createPostgresPool(pg.Pool, url, 'navigation-qq');
    const pending = verifyConfiguredPostgres(pool).then(() => pool).catch(async error => {
      connections.delete(url);
      await pool.close();
      throw error;
    });
    connections.set(url, pending);
  }
  return connections.get(url);
}

export function getPostgresMonitoring() {
  const url = postgresUrlFor('qqMonitoring');
  return url ? getPostgresDatabase(url) : null;
}

export async function getPostgresCodexIdentity() {
  const url = postgresUrlFor('identity');
  if (!url) return undefined;
  const store = createPostgresRbacStore(await getPostgresDatabase(url));
  return async () => {
    const snapshot = await store.load();
    if (!snapshot) throw new Error('PostgreSQL 权限数据库未初始化');
    return snapshot;
  };
}
