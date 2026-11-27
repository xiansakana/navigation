import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { postgresUrlFor } from '../../shared/db/postgres/config.js';
import { portalPostgresDatabase } from './postgres.js';
import { loadConfig } from './config.js';
import { startMediaCleanup } from './blog-media-cleanup.js';
import { getBookkeepingBackend } from './bookkeeping-runtime.js';
import { startThumbnailWorker, activeMediaJobs } from './blog-media-process.js';
import { resumeVideoJobs, activeVideoJobs } from './blog.js';
import { getBlogPostgresRepository } from './blog-postgres-runtime.js';

process.env.NAVIGATION_PROCESS_ROLE = 'background';
const identityUrl = postgresUrlFor('identity');
const config = loadConfig(), db = identityUrl ? null : getDatabase();
const heartbeatDb = identityUrl ? portalPostgresDatabase(identityUrl) : null;
const blogDb = (await getBlogPostgresRepository())?.db || db;
if (!blogDb) throw new Error('博客存储未配置');
const cleanup = startMediaCleanup(blogDb);
const bookkeeping = await getBookkeepingBackend();
const history = bookkeeping.startAssetHistory({});
const thumbnails = startThumbnailWorker(blogDb);
const resumeBlog = () => resumeVideoJobs(blogDb, config).catch(error => console.error('[blog video worker]', error.code || error.name));
void resumeBlog();
const videos = setInterval(resumeBlog, 10000);
const heartbeat = setInterval(async () => {
  try {
    if (heartbeatDb) {
      await heartbeatDb.query(`INSERT INTO navigation.meta(key,value) VALUES('portal_background_heartbeat',$1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(Date.now())]);
    } else {
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('portal_background_heartbeat',?)").run(String(Date.now()));
    }
  } catch (error) { console.error('[heartbeat]', error.code || error.name); }
}, 10000);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanup); clearInterval(thumbnails); clearInterval(videos); clearInterval(heartbeat); history.stop();
  // PM2's kill_timeout is configured to allow graceful draining of media subprocesses.
  const drain = setInterval(() => {
    if (!activeVideoJobs() && !activeMediaJobs()) { clearInterval(drain); if (db) closeDatabase(); process.exit(0); }
  }, 500);
});
