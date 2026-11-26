import pg from 'pg';
import { createPostgresPool } from '../../shared/db/postgres/pool.js';

const { Pool } = pg;
const configured = new Map();

export function portalPostgresDatabase(connectionString) {
  if (!configured.has(connectionString)) configured.set(connectionString, createPostgresDatabase(connectionString));
  return configured.get(connectionString);
}

export function createPostgresDatabase(connectionString) {
  return createPostgresPool(Pool, connectionString, 'navigation-portal');
}
