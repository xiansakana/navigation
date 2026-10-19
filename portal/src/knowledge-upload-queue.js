import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { bilibiliUrl, inspectBilibili, inspectBilibiliQuality } from './knowledge-bilibili.js';
import { bilibiliAccount, qualitySettings } from './knowledge-bilibili-account.js';
import { createKnowledgeStore, metadata, backendName, MAX_VIDEO_BYTES } from './knowledge-store.js';
import { storageConfig, sourcePath } from './knowledge-storage.js';

export function createUploadQueue(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_upload_queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,url TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',settings_json TEXT NOT NULL,document_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',lease TEXT,expires INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_upload_queue_owner ON knowledge_upload_queue(user_id,state,seq);`);
  const get = (uid, id) => db.prepare('SELECT * FROM knowledge_upload_queue WHERE user_id=? AND id=?').get(uid, id);
  const duplicate = (uid, url, except = '') => db.prepare(`SELECT q.document_id FROM knowledge_upload_queue q
    WHERE q.user_id=? AND q.url=? AND q.id<>? AND (q.state IN ('pending','resolving') OR q.state='submitted' AND EXISTS(SELECT 1 FROM knowledge_documents d WHERE d.id=q.document_id AND d.user_id=q.user_id)) LIMIT 1`).get(uid, url, except)
    || db.prepare("SELECT id AS document_id FROM knowledge_documents WHERE user_id=? AND source_url=? AND status<>'deleting' LIMIT 1").get(uid, url)
    || db.prepare("SELECT d.id AS document_id FROM knowledge_imports i JOIN knowledge_documents d ON d.id=i.document_id AND d.user_id=i.user_id WHERE i.user_id=? AND i.url=? AND d.status<>'deleting' LIMIT 1").get(uid, url);
  return {
    get, duplicate,
    add(uid, raw, defaults) {
      if (!Array.isArray(raw.urls) || !raw.urls.length || raw.urls.length > 100 || raw.urls.some(u => typeof u !== 'string' || u.length > 1500)) throw new Error('每批支持1至100条B站链接，每条不超过1500字');
      const common = metadata({ title: '批量导入', topic: raw.topic || '', tags: raw.tags || [] });
      const settings = { ...qualitySettings(raw, defaults.quality), backend: backendName(raw.backend || defaults.backend), modelSettings: defaults.modelSettings, topic: common.topic, tags: common.tags };
      if (raw.urls.length === 1 && (raw.title !== undefined || raw.sourceUrl !== undefined)) {
        const override = metadata({ title: raw.title || '自动填写标题', topic: common.topic, tags: common.tags, sourceUrl: raw.sourceUrl || '' });
        settings.overrides = { topic: common.topic, tags: common.tags, ...(raw.title ? { title: override.title } : {}), ...(raw.sourceUrl !== undefined ? { sourceUrl: override.sourceUrl } : {}) };
      }
      return db.transaction(() => {
        const count = db.prepare("SELECT count(*) n FROM knowledge_upload_queue WHERE user_id=? AND state IN ('pending','resolving','failed')").get(uid).n;
        const results = [], time = Date.now(); let accepted = 0;
        for (const [index, input] of raw.urls.entries()) {
          let url;
          try { url = bilibiliUrl(input.trim().replace(/[，。；、）)\]}]+$/, '')); }
          catch (e) { results.push({ index, status: 'invalid', error: e.message }); continue; }
          if (duplicate(uid, url)) { results.push({ index, status: 'duplicate', url }); continue; }
          if (count + accepted >= 500) throw new Error('等待和失败队列最多500条，请先处理或取消部分任务');
          const id = crypto.randomBytes(16).toString('hex');
          db.prepare('INSERT INTO knowledge_upload_queue(id,user_id,url,settings_json,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, uid, url, JSON.stringify(settings), time, time);
          accepted++; results.push({ index, status: 'accepted', id, url });
        }
        return { accepted, results };
      }).immediate();
    },
    list(uid, offset = 0) {
      const counts = db.prepare('SELECT state,count(*) count FROM knowledge_upload_queue WHERE user_id=? GROUP BY state').all(uid);
      const entries = db.prepare(`SELECT q.id,q.url,q.state,q.title,q.error,q.document_id AS documentId,q.created_at AS createdAt,
        d.status AS documentStatus,d.stage AS documentStage,d.title AS documentTitle FROM knowledge_upload_queue q
        LEFT JOIN knowledge_documents d ON d.id=q.document_id AND d.user_id=q.user_id WHERE q.user_id=?
        ORDER BY CASE q.state WHEN 'resolving' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
        CASE WHEN q.state IN ('pending','resolving','failed') THEN q.seq ELSE -q.seq END LIMIT 50 OFFSET ?`).all(uid, offset);
      const active = db.prepare("SELECT count(*) n FROM knowledge_documents WHERE user_id=? AND status IN ('uploading','importing','queued','processing')").get(uid).n;
      return { entries, counts: Object.fromEntries(counts.map(r => [r.state, r.count])), total: counts.reduce((n, r) => n + r.count, 0), active, capacity: 5, offset };
    },
    change(uid, id, action) {
      const states = action === 'retry' ? ['failed'] : ['pending', 'resolving', 'failed'];
      return db.prepare(`UPDATE knowledge_upload_queue SET state=?,error='',lease=NULL,expires=0,updated_at=? WHERE user_id=? AND id=? AND state IN (${states.map(() => '?').join(',')})`)
        .run(action === 'retry' ? 'pending' : 'cancelled', Date.now(), uid, id, ...states).changes > 0;
    },
    claim() {
      // Idle/full queues must remain read-only. Acquiring SQLite's writer lock
      // every polling tick can otherwise stall unrelated uploads and heartbeats.
      if (!db.prepare(`SELECT 1 FROM knowledge_upload_queue q
        WHERE (q.state='pending' OR q.state='resolving' AND q.expires<?)
          AND (SELECT count(*) FROM knowledge_documents d WHERE d.user_id=q.user_id AND d.status IN ('uploading','importing','queued','processing'))
            + (SELECT count(*) FROM knowledge_upload_queue r WHERE r.user_id=q.user_id AND r.state='resolving' AND r.expires>=?) < 5 LIMIT 1`).get(Date.now(), Date.now())) return null;
      return db.transaction(() => {
        db.prepare("UPDATE knowledge_upload_queue SET state='pending',lease=NULL WHERE state='resolving' AND expires<?").run(Date.now());
        const row = db.prepare(`SELECT q.* FROM knowledge_upload_queue q WHERE q.state='pending'
          AND (SELECT count(*) FROM knowledge_documents d WHERE d.user_id=q.user_id AND d.status IN ('uploading','importing','queued','processing'))
            + (SELECT count(*) FROM knowledge_upload_queue r WHERE r.user_id=q.user_id AND r.state='resolving') < 5
          ORDER BY q.seq LIMIT 1`).get();
        if (!row) return null;
        const lease = crypto.randomBytes(24).toString('hex');
        db.prepare("UPDATE knowledge_upload_queue SET state='resolving',lease=?,expires=?,updated_at=? WHERE id=?").run(lease, Date.now() + 120000, Date.now(), row.id);
        return { ...row, lease };
      }).immediate();
    },
    settle(row, state, error = '', documentId = '', title = '') {
      return db.prepare('UPDATE knowledge_upload_queue SET state=?,error=?,document_id=?,title=?,lease=NULL,expires=0,updated_at=? WHERE user_id=? AND id=? AND lease=? AND state=\'resolving\'')
        .run(state, String(error).slice(0, 400), documentId, title, Date.now(), row.user_id, row.id, row.lease).changes > 0;
    }
  };
}

export async function runUploadQueue(db, directoryFor, authorize, { inspect = inspectBilibili, quality = inspectBilibiliQuality } = {}) {
  const store = createKnowledgeStore(db), queue = createUploadQueue(db), job = queue.claim();
  if (!job) return false;
  const uid = job.user_id;
  try {
    if (!authorize(uid)) throw new Error('账号或批量导入权限已撤销');
    const info = await inspect(job.url), selection = JSON.parse(job.settings_json);
    if (queue.get(uid, job.id)?.lease !== job.lease) return true;
    // Short URL aliases are deduplicated again after resolving to their video page.
    if (queue.duplicate(uid, info.sourceUrl, job.id)) { queue.settle(job, 'duplicate', '', '', info.title); return true; }
    const cookie = await bilibiliAccount(db).credentials(uid);
    const playback = await quality(info, selection, { cookie });
    if (!playback.canImport) throw new Error(playback.reason);
    const base = path.dirname(directoryFor('0'.repeat(32)));
    await fsp.mkdir(base, { recursive: true, mode: 0o700 });
    const disk = await fsp.statfs(base);
    if (disk.bavail * disk.bsize < 3 * MAX_VIDEO_BYTES + 5 * 1024 ** 3) throw new Error('服务器可用空间不足，请清理后重试');
    const config = storageConfig(uid);
    db.transaction(() => {
      if (!authorize(uid)) throw new Error('账号或批量导入权限已撤销');
      if (queue.get(uid, job.id)?.lease !== job.lease) return;
      if (queue.duplicate(uid, info.sourceUrl, job.id)) { queue.settle(job, 'duplicate', '', '', info.title); return; }
      const active = db.prepare("SELECT count(*) n FROM knowledge_documents WHERE user_id=? AND status IN ('uploading','importing','queued','processing')").get(uid).n;
      if (active >= 5) { queue.settle(job, 'pending'); return; }
      const doc = store.create(uid, { title: selection.overrides?.title || info.title, topic: selection.overrides?.topic ?? (selection.topic || info.topic), tags: selection.overrides?.tags ?? [...new Set([...selection.tags, ...info.tags])].slice(0, 20),
        sourceUrl: selection.overrides?.sourceUrl ?? info.sourceUrl, bytes: MAX_VIDEO_BYTES, mimeType: 'video/mp4', originalName: info.title.replace(/[\\/:*?"<>|]/g, '-') + '.mp4', backend: selection.backend });
      db.prepare('UPDATE knowledge_documents SET model_settings_json=? WHERE user_id=? AND id=?').run(JSON.stringify(selection.modelSettings), uid, doc.id);
      store.imports.add(uid, doc.id, info.sourceUrl, selection);
      if (config) store.sources.add(uid, doc.id, sourcePath(config, uid, doc));
      db.prepare("UPDATE knowledge_documents SET status='importing',stage='等待下载B站视频' WHERE user_id=? AND id=?").run(uid, doc.id);
      queue.settle(job, 'submitted', '', doc.id, info.title);
    }).immediate();
  } catch (e) {
    if (/^SQLITE_(BUSY|LOCKED)/.test(e.code || '')) throw e; // Persisted lease expires and recovers automatically.
    queue.settle(job, 'failed', e.message);
  }
  return true;
}
