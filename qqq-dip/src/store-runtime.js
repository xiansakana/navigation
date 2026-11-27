import pg from 'pg';
import { createPostgresPool } from '../../shared/db/postgres/pool.js';
import { verifyConfiguredPostgres } from '../../shared/db/postgres/readiness.js';
import { postgresUrlFor } from '../../shared/db/postgres/config.js';
import { createStore } from './store.js';
import { createPostgresStore } from './postgres-store.js';

export async function openStore(config) {
  const url = postgresUrlFor('qqqDip');
  if (!url) return { store: await createStore(config) };
  const db = createPostgresPool(pg.Pool, url, 'navigation-qqq-dip');
  const verifyReady = () => verifyConfiguredPostgres(db);
  await verifyReady();
  return { store: await createPostgresStore(config, db), verifyReady };
}
