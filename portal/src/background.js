import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { loadConfig } from './config.js';
import { startMediaCleanup } from './blog-media-cleanup.js';
import { startAssetHistory } from './bookkeeping-asset-history.js';
import { startThumbnailWorker, activeMediaJobs } from './blog-media-process.js';
import { resumeVideoJobs, activeVideoJobs } from './blog.js';

process.env.NAVIGATION_PROCESS_ROLE = 'background';
const config = loadConfig(), db = getDatabase();
const cleanup = startMediaCleanup(db);
const history = startAssetHistory(db);
const thumbnails = startThumbnailWorker(db);
resumeVideoJobs(db, config);
const videos = setInterval(() => resumeVideoJobs(db, config), 10000);
const heartbeat = setInterval(() => {
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('portal_background_heartbeat',?)").run(String(Date.now()));
}, 10000);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanup); clearInterval(thumbnails); clearInterval(videos); clearInterval(heartbeat); history.stop();
  // PM2's kill_timeout is configured to allow graceful draining of media subprocesses.
  const drain = setInterval(() => {
    if (!activeVideoJobs() && !activeMediaJobs()) { clearInterval(drain); closeDatabase(); process.exit(0); }
  }, 500);
});
