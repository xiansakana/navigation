import fsp from 'node:fs/promises';
import path from 'node:path';
import { createKnowledgeStore, MAX_VIDEO_BYTES } from './knowledge-store.js';
import { downloadBilibili } from './knowledge-bilibili.js';
import { hashFile } from './knowledge-storage.js';
import { bilibiliAccount } from './knowledge-bilibili-account.js';

export async function runKnowledgeImport(db, directoryFor, authorize, { download = downloadBilibili } = {}) {
  const store = createKnowledgeStore(db), job = store.imports.claim();
  if (!job) return false;
  const uid = job.user_id, id = job.document_id, directory = directoryFor(id);
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45 * 60000)]);
  const allowed = () => authorize(uid) && store.imports.get(uid, id)?.lease === job.lease;
  const heartbeat = setInterval(() => { if (!allowed() || !store.imports.touch(job)) controller.abort(); }, 10000);
  let result;
  try {
    if (!allowed()) throw new Error('账号或链接导入权限已撤销');
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const disk = await fsp.statfs(directory);
    if (disk.bavail * disk.bsize < 3 * MAX_VIDEO_BYTES + 5 * 1024 ** 3) throw new Error('服务器可用空间不足');
    let last = 0;
    const cookie = await bilibiliAccount(db).credentials(uid), settings = JSON.parse(job.settings_json);
    result = await download(job.url, directory, { signal, cookie, ...settings, progress(bytes) {
      if (Date.now() - last < 1500) return;
      last = Date.now();
      db.prepare("UPDATE knowledge_documents SET stage=?,updated_at=? WHERE user_id=? AND id=? AND status='importing'")
        .run('下载B站视频 · ' + (bytes / 1024 ** 2).toFixed(1) + ' MB', new Date().toISOString(), uid, id);
    } });
    const hashes = await hashFile(result.file);
    if (!allowed()) throw new Error('账号、权限或导入任务已变化');
    await fsp.rename(result.file, path.join(directory, 'source'));
    db.transaction(() => {
      if (!store.imports.done(job, result.media)) throw new Error('导入任务已过期');
      db.prepare("UPDATE knowledge_documents SET byte_size=?,status='uploading',stage='下载完成',updated_at=? WHERE user_id=? AND id=? AND status='importing'")
        .run(hashes.bytes, new Date().toISOString(), uid, id);
      store.enqueue(uid, id, hashes.sha256);
    })();
  } catch (e) {
    if (store.imports.fail(job)) {
      db.prepare("UPDATE knowledge_documents SET status='failed',stage='链接导入失败',error=?,updated_at=? WHERE user_id=? AND id=? AND status='importing'")
        .run(signal.aborted ? '链接导入超时或权限变化，请检查后重试' : String(e.message).slice(0, 400), new Date().toISOString(), uid, id);
    }
  } finally { clearInterval(heartbeat); await result?.cleanup(); }
  return true;
}
export function startKnowledgeImports(db, directoryFor, authorize) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runKnowledgeImport(db, directoryFor, authorize); }
    catch (e) { console.error('知识库链接导入队列异常', e.code || 'IMPORT_ERROR'); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 3000); timer.unref(); tick();
  return () => clearInterval(timer);
}
