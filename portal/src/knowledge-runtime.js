import { getDatabase } from '../../shared/db/index.js';
import { postgresUrlFor } from '../../shared/db/postgres/config.js';
import { verifyConfiguredPostgres } from '../../shared/db/postgres/readiness.js';
import { portalPostgresDatabase } from './postgres.js';

export function knowledgePostgresDatabase() {
  const url = postgresUrlFor('knowledge');
  return url ? portalPostgresDatabase(url) : null;
}

export function getKnowledgeDatabase() {
  return knowledgePostgresDatabase() || getDatabase();
}

export async function checkKnowledgeDatabase() {
  const db = knowledgePostgresDatabase();
  if (db) await verifyConfiguredPostgres(db);
}
