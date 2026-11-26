import fs from 'node:fs/promises';
import path from 'node:path';
import { createKnowledgeStore } from '../portal/src/knowledge-store.js';
import { createPostgresKnowledgeStore } from '../portal/src/knowledge-postgres-store.js';
import { checkKnowledgeDatabase, getKnowledgeDatabase } from '../portal/src/knowledge-runtime.js';
import { knowledgeDirectory } from '../portal/src/knowledge.js';
import { storageConfig, sourcePath, OpenListStorage, archiveSource } from '../portal/src/knowledge-storage.js';

await checkKnowledgeDatabase();
const db = getKnowledgeDatabase(), store = db.query ? createPostgresKnowledgeStore(db) : createKnowledgeStore(db), sources = store.sources;
if (process.argv.includes('--migrate')) {
  const rows = db.query ? (await db.query("SELECT id,user_id,mime_type FROM navigation.knowledge_documents WHERE status IN ('ready','failed','queued')")).rows
    : db.prepare("SELECT id,user_id,mime_type FROM knowledge_documents WHERE status IN ('ready','failed','queued')").all();
  for (const row of rows) {
    const config = storageConfig(row.user_id);
    if (!config || await sources.get(row.user_id, row.id)) continue;
    await fs.access(path.join(knowledgeDirectory(row.id), 'source'));
    await sources.add(row.user_id, row.id, sourcePath(config, row.user_id, { id: row.id, mimeType: row.mime_type }), 'pending');
    console.log('已加入115归档队列', row.id);
  }
  process.exit(0);
}
let stopped = false;
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { stopped = true; });
while (!stopped) {
  const s = await sources.claim();
  if (!s) { await new Promise(resolve => setTimeout(resolve, 3000)); continue; }
  let checking = false;
  const heartbeat = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await sources.update(s, {}); }
    catch (error) { console.error('115任务心跳保存失败', error.code || error.name); }
    finally { checking = false; }
  }, 15000);
  try {
    const storage = new OpenListStorage(storageConfig(s.user_id));
    if (s.state === 'deleting') {
      // The object path always points inside this document's dedicated directory.
      await storage.mkdir(s.object_path);
      await storage.remove(s.object_path);
      if (!await sources.update(s, {})) throw new Error('删除任务已过期');
      await fs.rm(knowledgeDirectory(s.document_id), { recursive: true, force: true });
      if (!await store.remove(s.user_id, s.document_id, s.lease)) throw new Error('删除任务已过期');
      console.log('已删除视频及笔记', s.document_id);
    } else {
      await archiveSource(storage, sources, s, path.join(knowledgeDirectory(s.document_id), 'source'));
      console.log('115归档校验完成，本地原片已清理', s.document_id);
    }
  } catch (e) {
    await sources.update(s, { state: s.state === 'deleting' ? 'deleting' : 'failed',
      error: '115保存失败，临时原片已保留；系统会自动重试，也可手动重试', next_retry: Date.now() + Math.min(3600000, 30000 * 2 ** s.attempts) });
    console.error('115任务失败，已保留恢复状态', s.document_id, e.message);
  } finally { clearInterval(heartbeat); await sources.release(s); }
}
