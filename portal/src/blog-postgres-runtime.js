import { verifyPostgresSchema } from '../../shared/db/postgres/readiness.js';
import { portalPostgresDatabase } from './postgres.js';
import { createPostgresBlogRepository } from './blog-postgres.js';

let db, initialization;

export function getBlogPostgresRepository() {
  const url = process.env.NAVIGATION_BLOG_POSTGRES_URL;
  if (!url) return null;
  db ||= portalPostgresDatabase(url);
  return initialization ||= verifyPostgresSchema(db).then(() => createPostgresBlogRepository(db)).catch(error => {
    initialization = undefined;
    throw error;
  });
}

export async function checkBlogPostgres() {
  if (!await getBlogPostgresRepository()) return;
  await verifyPostgresSchema(db);
}
