import crypto from 'node:crypto';
import { createSourceStore } from './knowledge-source-store.js';
import { createKnowledgeCaseStore } from './mingli-knowledge-store.js';
import { createKnowledgeDeviceStore } from './knowledge-devices.js';

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export const ACTIVE_STATES = ['processing'];
export const backendName = value => {
  if (!['codex', 'openai'].includes(value)) throw new Error('请选择 Codex CLI 或兼容 API');
  return value;
};
const id = () => crypto.randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
export const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
export function metadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('笔记格式无效');
  const title = String(raw.title || '').trim(), topic = String(raw.topic || '').trim();
  if (!title || title.length > 160 || topic.length > 60) throw new Error('标题需为1—160字，分类不超过60字');
  const tags = raw.tags || [];
  if (!Array.isArray(tags) || tags.length > 20 || tags.some(t => typeof t !== 'string' || t.length > 30)) throw new Error('最多20个标签，每个不超过30字');
  const sourceUrl = String(raw.sourceUrl || '').trim();
  if (sourceUrl && (sourceUrl.length > 1000 || !/^https?:\/\//i.test(sourceUrl))) throw new Error('来源链接需为 HTTP(S) 地址');
  return { title, topic, tags: [...new Set(tags.map(t => t.trim()).filter(Boolean))], sourceUrl };
}

export function createKnowledgeStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,topic TEXT NOT NULL DEFAULT '',tags_json TEXT NOT NULL DEFAULT '[]',
    source_url TEXT NOT NULL DEFAULT '',original_name TEXT NOT NULL,byte_size INTEGER NOT NULL,mime_type TEXT NOT NULL,fingerprint TEXT NOT NULL DEFAULT '',
    backend TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uploading',stage TEXT NOT NULL DEFAULT '等待上传',progress INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',duration REAL NOT NULL DEFAULT 0,language TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',
    transcript_json TEXT NOT NULL DEFAULT '[]',frames_json TEXT NOT NULL DEFAULT '[]',provenance_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 0,attempt INTEGER NOT NULL DEFAULT 0,lease TEXT,heartbeat TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_owner ON knowledge_documents(user_id,updated_at DESC);
    CREATE INDEX IF NOT EXISTS knowledge_queue ON knowledge_documents(user_id,status,created_at);
    CREATE TABLE IF NOT EXISTS knowledge_parts(document_id TEXT NOT NULL,part INTEGER NOT NULL,bytes INTEGER NOT NULL,
      PRIMARY KEY(document_id,part));
    CREATE TABLE IF NOT EXISTS knowledge_settings(user_id TEXT PRIMARY KEY,backend TEXT NOT NULL DEFAULT 'codex');
    CREATE TABLE IF NOT EXISTS knowledge_workers(user_id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,last_seen TEXT,
      label TEXT NOT NULL DEFAULT '',capabilities_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS knowledge_worker_instances(user_id TEXT NOT NULL,worker_id TEXT NOT NULL,
      last_seen TEXT NOT NULL,label TEXT NOT NULL,capabilities_json TEXT NOT NULL,PRIMARY KEY(user_id,worker_id));`);
  if (!db.prepare('PRAGMA table_info(knowledge_documents)').all().some(c => c.name === 'fingerprint')) db.exec("ALTER TABLE knowledge_documents ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(knowledge_documents)').all().some(c => c.name === 'worker_id')) db.exec("ALTER TABLE knowledge_documents ADD COLUMN worker_id TEXT NOT NULL DEFAULT ''");
  const devices = createKnowledgeDeviceStore(db);
  const sources = createSourceStore(db);
  const getRow = (uid, key) => db.prepare('SELECT * FROM knowledge_documents WHERE user_id=? AND id=?').get(uid, key);
  const read = row => row && ({ id: row.id, title: row.title, topic: row.topic, tags: JSON.parse(row.tags_json), sourceUrl: row.source_url,
    originalName: row.original_name, bytes: row.byte_size, mimeType: row.mime_type, fingerprint: row.fingerprint, backend: row.backend, status: row.status,
    stage: row.stage, progress: row.progress, error: row.error, duration: row.duration, language: row.language, notes: row.notes,
    transcript: JSON.parse(row.transcript_json), frames: JSON.parse(row.frames_json), provenance: JSON.parse(row.provenance_json),
    storage: sources.public(row.user_id, row.id), revision: row.revision, attempt: row.attempt, createdAt: row.created_at, updatedAt: row.updated_at });
  const get = (uid, key) => { const row = getRow(uid, key); return row && row.status !== 'deleting' ? read(row) : null; };
  const expire = uid => db.prepare("UPDATE knowledge_documents SET status='failed',stage='处理已中断',error='工作器超过15分钟未响应，请检查本机工作器后重试',lease=NULL,updated_at=? WHERE user_id=? AND status='processing' AND heartbeat<?")
    .run(now(), uid, new Date(Date.now() - 15 * 60000).toISOString());
  const onlineWorkers = uid => db.prepare('SELECT worker_id,label,last_seen,capabilities_json FROM knowledge_worker_instances WHERE user_id=? AND last_seen>?')
    .all(uid, new Date(Date.now() - 90000).toISOString())
    .map(r => ({ id: r.worker_id, label: r.label, lastSeen: r.last_seen, capabilities: JSON.parse(r.capabilities_json) }));
  return {
    get, getRow, expire, sources, devices,
    settings(uid) { return { backend: db.prepare('SELECT backend FROM knowledge_settings WHERE user_id=?').get(uid)?.backend || 'codex' }; },
    saveSettings(uid, backend) {
      backendName(backend);
      db.prepare('INSERT INTO knowledge_settings(user_id,backend) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET backend=excluded.backend').run(uid, backend);
      return { backend };
    },
    worker(uid) {
      const row = db.prepare('SELECT last_seen,label,capabilities_json FROM knowledge_workers WHERE user_id=?').get(uid);
      const workers = onlineWorkers(uid);
      const preferred = workers.find(w => w.capabilities.media?.ready && w.capabilities.media.detail === 'cuda' && w.capabilities[this.settings(uid).backend]?.ready) || workers[0];
      return row ? { configured: true, online: workers.length > 0 || !!row.last_seen && Date.now() - Date.parse(row.last_seen) < 90000,
        lastSeen: preferred?.lastSeen || row.last_seen, label: preferred?.label || row.label,
        capabilities: preferred?.capabilities || JSON.parse(row.capabilities_json), workers, scheduling: 'gpu-first' } : { configured: false, online: false, capabilities: {} };
    },
    rotateToken(uid) {
      const token = 'nkw_' + crypto.randomBytes(32).toString('hex');
      db.prepare("INSERT INTO knowledge_workers(user_id,token_hash) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,last_seen=NULL,capabilities_json='{}'").run(uid, hashToken(token));
      db.prepare('DELETE FROM knowledge_worker_instances WHERE user_id=? AND worker_id NOT IN (SELECT id FROM knowledge_worker_devices WHERE user_id=?)').run(uid, uid);
      db.prepare("UPDATE knowledge_documents SET status='failed',stage='工作器凭据已更换',error='请使用新凭据连接工作器后重试',lease=NULL,updated_at=? WHERE user_id=? AND status='processing' AND worker_id NOT IN (SELECT id FROM knowledge_worker_devices WHERE user_id=?)").run(now(), uid, uid);
      return token;
    },
    workerUser(token) { return devices.authenticate(token)?.user_id || db.prepare('SELECT user_id FROM knowledge_workers WHERE token_hash=?').get(hashToken(token))?.user_id || null; },
    heartbeatWorker(uid, raw = {}) {
      const capabilities = {};
      for (const key of ['codex', 'openai', 'media']) {
        const c = raw.capabilities?.[key] || {};
        capabilities[key] = { ready: c.ready === true, model: String(c.model || '').slice(0, 120), detail: String(c.detail || '').slice(0, 160) };
      }
      db.prepare('UPDATE knowledge_workers SET last_seen=?,label=?,capabilities_json=? WHERE user_id=?').run(now(), String(raw.label || '').slice(0, 80), JSON.stringify(capabilities), uid);
      const workerId = /^[\w-]{1,80}$/.test(raw.workerId || '') ? raw.workerId : 'legacy-' + hashToken(String(raw.label || '')).slice(0, 24);
      db.prepare('INSERT INTO knowledge_worker_instances(user_id,worker_id,last_seen,label,capabilities_json) VALUES (?,?,?,?,?) ON CONFLICT(user_id,worker_id) DO UPDATE SET last_seen=excluded.last_seen,label=excluded.label,capabilities_json=excluded.capabilities_json')
        .run(uid, workerId, now(), String(raw.label || '').slice(0, 80), JSON.stringify(capabilities));
      db.prepare('DELETE FROM knowledge_worker_instances WHERE user_id=? AND last_seen<?').run(uid, new Date(Date.now() - 7 * 86400000).toISOString());
    },
    list(uid, { search = '', topic = '', status = '', offset = 0, limit = 30, includeTranscript = true } = {}) {
      expire(uid);
      const pattern = '%' + String(search).slice(0, 120).replace(/[!%_]/g, '!$&') + '%';
      let where = "user_id=? AND status<>'deleting' AND (title LIKE ? ESCAPE '!' OR notes LIKE ? ESCAPE '!' OR tags_json LIKE ? ESCAPE '!'" + (includeTranscript ? " OR transcript_json LIKE ? ESCAPE '!'" : '') + ')';
      const args = [uid, pattern, pattern, pattern, ...(includeTranscript ? [pattern] : [])];
      if (topic) { where += ' AND topic=?'; args.push(String(topic).slice(0, 60)); }
      if (status) { where += ' AND status=?'; args.push(status); }
      const total = db.prepare('SELECT count(*) AS n FROM knowledge_documents WHERE ' + where).get(...args).n;
      const documents = db.prepare(`SELECT id,user_id,title,topic,tags_json,source_url,original_name,byte_size,mime_type,fingerprint,backend,status,stage,progress,error,duration,language,
        substr(notes,1,240) AS notes,'[]' AS transcript_json,'[]' AS frames_json,provenance_json,revision,attempt,created_at,updated_at,
        json_array_length(frames_json) AS frame_count,json_array_length(transcript_json) AS segment_count
        FROM knowledge_documents WHERE ` + where + ' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(...args, limit, offset)
        .map(row => { const { notes, transcript, frames, ...d } = read(row); return { ...d, preview: notes.replace(/[#*`>]/g, '').slice(0, 180), frameCount: row.frame_count, segmentCount: row.segment_count }; });
      const topics = db.prepare("SELECT topic,count(*) AS count FROM knowledge_documents WHERE user_id=? AND topic<>'' GROUP BY topic ORDER BY topic").all(uid);
      return { documents, total, offset, limit, topics };
    },
    create(uid, raw) {
      const m = metadata(raw), size = raw.bytes, mime = raw.mimeType;
      if (!Number.isSafeInteger(size) || size < 12 || size > MAX_VIDEO_BYTES) throw new Error('视频需在1GB以内');
      if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(mime)) throw new Error('支持 MP4、WebM、MOV 视频');
      const name = String(raw.originalName || '').slice(0, 240);
      if (!name) throw new Error('缺少文件名');
      const backend = backendName(raw.backend || this.settings(uid).backend);
      const fingerprint = String(raw.fingerprint || '');
      if (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('文件指纹无效');
      const quota = db.prepare("SELECT count(*) AS n,coalesce(sum(byte_size),0) AS bytes FROM knowledge_documents WHERE user_id=?").get(uid);
      const pending = db.prepare("SELECT count(*) AS n FROM knowledge_documents WHERE user_id=? AND status IN ('uploading','queued','processing')").get(uid).n;
      if (pending >= 5 || quota.bytes + size > 20 * MAX_VIDEO_BYTES || quota.n >= 2000) throw new Error('最多5个待处理任务、20GB视频或2000篇笔记，请先清理或完成已有任务');
      const key = id(), time = now();
      db.prepare('INSERT INTO knowledge_documents(id,user_id,title,topic,tags_json,source_url,original_name,byte_size,mime_type,fingerprint,backend,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(key, uid, m.title, m.topic, JSON.stringify(m.tags), m.sourceUrl, name, size, mime, fingerprint, backend, time, time);
      return get(uid, key);
    },
    parts(uid, key) {
      if (!getRow(uid, key)) return null;
      return db.prepare('SELECT part,bytes FROM knowledge_parts WHERE document_id=? ORDER BY part').all(key);
    },
    part(uid, key, number, bytes) {
      if (getRow(uid, key)?.status !== 'uploading') throw new Error('上传任务已结束');
      db.prepare('INSERT INTO knowledge_parts(document_id,part,bytes) VALUES (?,?,?) ON CONFLICT(document_id,part) DO UPDATE SET bytes=excluded.bytes').run(key, number, bytes);
      const uploaded = db.prepare('SELECT sum(bytes) AS n FROM knowledge_parts WHERE document_id=?').get(key).n;
      db.prepare('UPDATE knowledge_documents SET progress=?,updated_at=? WHERE id=? AND user_id=?').run(Math.floor(uploaded / getRow(uid, key).byte_size * 100), now(), key, uid);
    },
    enqueue(uid, key) {
      return db.transaction(() => {
        const changed = db.prepare("UPDATE knowledge_documents SET status='queued',stage='等待工作器',progress=0,error='',updated_at=? WHERE user_id=? AND id=? AND status='uploading'").run(now(), uid, key).changes > 0;
        if (changed) sources.enqueue(uid, key);
        return changed;
      })();
    },
    claim(uid, backends, workerId = '') {
      expire(uid);
      return db.transaction(() => {
        if (db.prepare("SELECT 1 FROM knowledge_documents WHERE user_id=? AND status='processing'").get(uid)) return null;
        const candidates = db.prepare("SELECT * FROM knowledge_documents WHERE user_id=? AND status='queued' AND NOT EXISTS (SELECT 1 FROM knowledge_sources s WHERE s.document_id=knowledge_documents.id AND s.state<>'ready') ORDER BY created_at,id").all(uid);
        const workers = onlineWorkers(uid);
        const gpuWorkers = workers.filter(w => w.capabilities.media?.ready && w.capabilities.media.detail === 'cuda');
        const row = candidates.find(r => backends.includes(r.backend) &&
          (!gpuWorkers.some(w => w.capabilities[r.backend]?.ready) || gpuWorkers.some(w => w.id === workerId && w.capabilities[r.backend]?.ready)));
        if (!row) return null;
        const lease = crypto.randomBytes(24).toString('hex'), time = now();
        db.prepare("UPDATE knowledge_documents SET status='processing',stage='读取视频',progress=1,lease=?,heartbeat=?,updated_at=?,worker_id=?,attempt=attempt+1 WHERE id=? AND status='queued'").run(lease, time, time, workerId, row.id);
        return { ...get(uid, row.id), sourceSha256: sources.get(uid, row.id)?.sha256 || '', lease };
      }).immediate();
    },
    leased(uid, key, lease) {
      expire(uid);
      const row = getRow(uid, key);
      return !!row && row.status === 'processing' && !!lease && row.lease === lease;
    },
    progress(uid, key, lease, stage, progress) {
      if (!this.leased(uid, key, lease)) return false;
      db.prepare('UPDATE knowledge_documents SET stage=?,progress=?,heartbeat=?,updated_at=? WHERE user_id=? AND id=? AND lease=?')
        .run(String(stage || '处理中').slice(0, 100), Math.max(1, Math.min(99, Math.floor(Number(progress) || 1))), now(), now(), uid, key, lease);
      return true;
    },
    finish(uid, key, lease, result) {
      if (!this.leased(uid, key, lease)) return false;
      return db.transaction(() => {
        db.prepare("UPDATE knowledge_documents SET status='ready',stage='笔记已生成',progress=100,error='',duration=?,language=?,notes=?,transcript_json=?,frames_json=?,provenance_json=?,revision=revision+1,lease=NULL,updated_at=? WHERE user_id=? AND id=? AND lease=?")
          .run(result.duration, result.language, result.notes, JSON.stringify(result.transcript), JSON.stringify(result.frames), JSON.stringify(result.provenance), now(), uid, key, lease);
        createKnowledgeCaseStore(db).syncDocument(getRow(uid, key));
        return true;
      })();
    },
    fail(uid, key, lease, error) {
      if (!this.leased(uid, key, lease)) return false;
      return db.prepare("UPDATE knowledge_documents SET status='failed',stage='处理失败',error=?,lease=NULL,updated_at=? WHERE user_id=? AND id=?").run(String(error).slice(0, 500), now(), uid, key).changes > 0;
    },
    retry(uid, key, backend) {
      backendName(backend);
      return db.prepare("UPDATE knowledge_documents SET status='queued',stage='等待工作器',backend=?,progress=0,error='',lease=NULL,updated_at=? WHERE user_id=? AND id=? AND status='failed'").run(backend, now(), uid, key).changes > 0;
    },
    edit(uid, key, raw) {
      const previous = get(uid, key);
      if (!previous) return null;
      const m = metadata(raw), notes = String(raw.notes ?? previous.notes);
      if (notes.length > 500000) throw new Error('笔记不超过50万字');
      return db.transaction(() => {
        const result = db.prepare('UPDATE knowledge_documents SET title=?,topic=?,tags_json=?,source_url=?,notes=?,revision=revision+1,updated_at=? WHERE user_id=? AND id=? AND revision=?')
          .run(m.title, m.topic, JSON.stringify(m.tags), m.sourceUrl, notes, now(), uid, key, Number(raw.revision));
        if (!result.changes) { const e = new Error('笔记已更新，请重新打开后再保存'); e.status = 409; throw e; }
        createKnowledgeCaseStore(db).syncDocument(getRow(uid, key));
        return get(uid, key);
      })();
    },
    remove(uid, key) {
      return db.transaction(() => {
        if (!getRow(uid, key)) return false;
        createKnowledgeCaseStore(db).removeDocument(uid, key);
        sources.remove(uid, key);
        db.prepare('DELETE FROM knowledge_parts WHERE document_id=?').run(key);
        return db.prepare('DELETE FROM knowledge_documents WHERE user_id=? AND id=?').run(uid, key).changes > 0;
      })();
    }
  };
}
