import { verifyConfiguredPostgres } from '../../shared/db/postgres/readiness.js';
import { postgresUrlFor } from '../../shared/db/postgres/config.js';
import { portalPostgresDatabase } from './postgres.js';
import { createPostgresBlogRepository } from './blog-postgres.js';

let db, initialization;

export function getBlogPostgresRepository() {
  const url = postgresUrlFor('blog');
  if (!url) return null;
  db ||= portalPostgresDatabase(url);
  return initialization ||= verifyConfiguredPostgres(db).then(() => createPostgresBlogRepository(db)).catch(error => {
    initialization = undefined;
    throw error;
  });
}

export async function checkBlogPostgres() {
  if (!await getBlogPostgresRepository()) return;
  await verifyConfiguredPostgres(db);
}
