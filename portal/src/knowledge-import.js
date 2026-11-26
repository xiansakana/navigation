import fsp from 'node:fs/promises';
import path from 'node:path';
import { createKnowledgeStore, MAX_VIDEO_BYTES } from './knowledge-store.js';
import { downloadBilibili, inspectBilibili, inspectBilibiliQuality } from './knowledge-bilibili.js';
import { hashFile, storageConfig } from './knowledge-storage.js';
import { bilibiliAccount } from './knowledge-bilibili-account.js';
import { runUploadQueue } from './knowledge-upload-queue.js';
import { createPostgresKnowledgeStore } from './knowledge-postgres-store.js';

export async function runKnowledgeImport(db, directoryFor, authorize, { download = downloadBilibili } = {}) {
  const store = db.query ? createPostgresKnowledgeStore(db) : createKnowledgeStore(db), job = await store.imports.claim();
  if (!job) return false;
  const uid = job.user_id, id = job.document_id, directory = directoryFor(id);
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45 * 60000)]);
  const allowed = async () => await authorize(uid) && (await store.imports.get(uid, id))?.lease === job.lease;
  let checking = false;
  const heartbeat = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { if (!await allowed() || !await store.imports.touch(job)) controller.abort(); }
    catch (e) { if (!/^SQLITE_(BUSY|LOCKED)/.test(e.code || '')) controller.abort(); }
    finally { checking = false; }
  }, 10000);
  let result;
  try {
    if (!await allowed()) throw new Error('账号或链接导入权限已撤销');
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const disk = await fsp.statfs(directory);
    if (disk.bavail * disk.bsize < 3 * MAX_VIDEO_BYTES + 5 * 1024 ** 3) throw new Error('服务器可用空间不足');
    let last = 0;
    const cookie = await bilibiliAccount(db).credentials(uid), settings = JSON.parse(job.settings_json);
    result = await download(job.url, directory, { signal, cookie, ...settings, progress(bytes) {
      if (Date.now() - last < 1500) return;
      last = Date.now();
      if (db.query) {
        void store.imports.progress(job, bytes).catch(() => controller.abort());
        return;
      }
      try {
        db.prepare("UPDATE knowledge_documents SET stage=?,updated_at=? WHERE user_id=? AND id=? AND status='importing'")
          .run('下载B站视频 · ' + (bytes / 1024 ** 2).toFixed(1) + ' MB', new Date().toISOString(), uid, id);
      } catch (e) { if (!/^SQLITE_(BUSY|LOCKED)/.test(e.code || '')) throw e; }
    } });
    const hashes = await hashFile(result.file);
    if (!await allowed()) throw new Error('账号、权限或导入任务已变化');
    const publish = () => fsp.rename(result.file, path.join(directory, 'source'));
    if (db.query) {
      if (!await store.imports.complete(job, hashes, result.media, publish)) throw new Error('导入任务已过期');
    } else {
      await publish();
      db.transaction(() => {
      if (!store.imports.done(job, result.media)) throw new Error('导入任务已过期');
      db.prepare("UPDATE knowledge_documents SET byte_size=?,status='uploading',stage='下载完成',updated_at=? WHERE user_id=? AND id=? AND status='importing'")
        .run(hashes.bytes, new Date().toISOString(), uid, id);
      store.enqueue(uid, id, hashes.sha256);
      })();
    }
  } catch (e) {
    const message = signal.aborted ? '链接导入超时或权限变化，请检查后重试' : String(e.message).slice(0, 400);
    if (db.query) await store.imports.fail(job, message);
    else if (store.imports.fail(job)) {
      db.prepare("UPDATE knowledge_documents SET status='failed',stage='链接导入失败',error=?,updated_at=? WHERE user_id=? AND id=? AND status='importing'")
        .run(message, new Date().toISOString(), uid, id);
    }
  } finally { clearInterval(heartbeat); await result?.cleanup(); }
  return true;
}

export async function runPostgresUploadQueue(db, directoryFor, authorize, { inspect = inspectBilibili, quality = inspectBilibiliQuality } = {}) {
  const queue = createPostgresKnowledgeStore(db).queue;
  const job = await queue.claim();
  if (!job) return false;
  try {
    if (!await authorize(job.user_id)) throw new Error('账号或批量导入权限已撤销');
    const cookie = await bilibiliAccount(db).credentials(job.user_id);
    const info = await inspect(job.url, { cookie }), selection = JSON.parse(job.settings_json);
    const playback = await quality(info, selection, { cookie });
    if (!playback.canImport) throw new Error(playback.reason);
    const directory = path.dirname(directoryFor('0'.repeat(32)));
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const disk = await fsp.statfs(directory);
    if (!await authorize(job.user_id)) throw new Error('账号或批量导入权限已撤销');
    await queue.submit(job, info, selection, storageConfig(job.user_id), disk.bavail * disk.bsize);
  } catch (error) {
    if (/^(?:[0-9A-Z]{5}$|ECONN|ETIMEDOUT)/.test(error?.code || '')) throw error;
    await queue.fail(job, error.message);
  }
  return true;
}

export function startKnowledgeImports(db, directoryFor, authorize) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await (db.query ? runPostgresUploadQueue : runUploadQueue)(db, directoryFor, uid => authorize(uid, true));
      await runKnowledgeImport(db, directoryFor, authorize);
    }
    catch (e) { console.error('知识库链接导入队列异常', e.code || 'IMPORT_ERROR'); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 3000); timer.unref(); tick();
  return () => clearInterval(timer);
}
