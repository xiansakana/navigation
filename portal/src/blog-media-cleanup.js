import crypto from 'node:crypto';
import { deleteStoredMedia, abortStoredUpload } from './blog-media-storage.js';
import { removeUploadFiles } from './blog-media-process.js';

export function enqueueMediaCleanup(db, items, userId, kind = 'object') {
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT OR IGNORE INTO blog_media_cleanup (id, user_id, kind, storage_key, multipart_id, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const item of items) {
    if (!item.storageKey || item.storageKey.startsWith('/') || item.storageKey.split('/').includes('..')) throw new Error('媒体存储路径无效');
    const multipartId = item.multipartId || '';
    const id = crypto.createHash('sha256').update(JSON.stringify([kind, item.storageKey, multipartId])).digest('hex');
    insert.run(id, userId, kind, item.storageKey, multipartId, now, now);
  }
}

const busy = new WeakSet();
export async function drainMediaCleanup(db, operations = {}, now = new Date()) {
  if (busy.has(db)) return;
  busy.add(db);
  const remove = operations.remove || deleteStoredMedia;
  const abort = operations.abort || abortStoredUpload;
  try {
    const jobs = db.prepare('SELECT * FROM blog_media_cleanup WHERE next_at <= ? ORDER BY created_at LIMIT 8').all(now.toISOString());
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        const canDelete = () => !db.prepare('SELECT 1 FROM blog_media WHERE storage_key = ? LIMIT 1').get(job.storage_key);
        try {
          if (job.kind === 'local') await removeUploadFiles(job.multipart_id);
          else if (job.kind === 'multipart') await abort({ storageKey: job.storage_key, multipartId: job.multipart_id });
          else if (canDelete()) await remove([{ storageKey: job.storage_key }], { canDelete });
          db.prepare('DELETE FROM blog_media_cleanup WHERE id = ?').run(job.id);
        } catch (error) {
          const delay = Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7));
          db.prepare('UPDATE blog_media_cleanup SET attempts = attempts + 1, last_error = ?, next_at = ? WHERE id = ?')
            .run(String(error.message || '清理失败').slice(0, 500), new Date(Math.max(Date.now(), now.getTime()) + delay).toISOString(), job.id);
        }
      }
    }));
  } finally { busy.delete(db); }
}

export function kickMediaCleanup(db) {
  setImmediate(() => drainMediaCleanup(db).catch(error => console.error('博客媒体清理任务失败:', error.message))).unref();
}

export function startMediaCleanup(db) {
  kickMediaCleanup(db);
  return setInterval(() => kickMediaCleanup(db), 15000).unref();
}
