import { sameOriginWrite } from '../../shared/http.js';
import { createKnowledgeStore } from './knowledge-store.js';

const fields = 'id,title,topic,tags_json,notes,created_at,updated_at';
const project = row => row && ({ id: row.id, title: row.title, topic: row.topic, tags: JSON.parse(row.tags_json),
  notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at });

// Public readers receive only the author-published text, never a private record projection.
export function publicKnowledgeStore(db) {
  createKnowledgeStore(db);
  return {
    get(id) {
      return project(db.prepare(`SELECT ${fields} FROM knowledge_documents WHERE id=? AND visibility='public' AND status='ready'`).get(id));
    },
    list(search = '', offset = 0) {
      const pattern = '%' + search.slice(0, 120).replace(/[!%_]/g, '!$&') + '%';
      const where = "visibility='public' AND status='ready' AND (title LIKE ? ESCAPE '!' OR notes LIKE ? ESCAPE '!' OR topic LIKE ? ESCAPE '!' OR tags_json LIKE ? ESCAPE '!')";
      const args = [pattern, pattern, pattern, pattern];
      const total = db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents WHERE ' + where).get(...args).n;
      const documents = db.prepare(`SELECT ${fields.replace('notes,', 'substr(notes,1,240) AS notes,')} FROM knowledge_documents WHERE ${where} ORDER BY updated_at DESC,id LIMIT 30 OFFSET ?`)
        .all(...args, offset).map(row => { const { notes, ...item } = project(row); return { ...item, preview: notes }; });
      return { documents, total, offset, limit: 30 };
    }
  };
}

export function handlePublicKnowledge(req, res, url, json, db) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { ok: false, error: '公开知识库仅支持浏览' });
  }
  const path = url.pathname.slice('/api/knowledge/public'.length);
  const match = /^\/documents\/([a-f0-9]{32})$/.exec(path);
  if (path !== '/documents' && !match) return json(res, 404, { ok: false, error: '公开笔记不存在' });
  const store = publicKnowledgeStore(db);
  if (match) {
    const document = store.get(match[1]);
    return json(res, document ? 200 : 404, document ? { ok: true, document } : { ok: false, error: '公开笔记不存在' });
  }
  const offset = Math.min(100000, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0)));
  return json(res, 200, { ok: true, ...store.list(url.searchParams.get('search') || '', offset) });
}

export async function handleKnowledgeVisibility(req, res, url, session, json, db, id) {
  if (req.method !== 'PUT') return json(res, 405, { ok: false, error: '请使用 PUT 更新可见范围' });
  if (!sameOriginWrite(req)) return json(res, 403, { ok: false, error: '不允许跨站写入' });
  const store = createKnowledgeStore(db), item = store.get(session.userId, id);
  if (!item) return json(res, 404, { ok: false, error: '笔记不存在' });
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 1024) throw new Error('请求过长'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || !['private', 'public'].includes(input.visibility) || !Number.isSafeInteger(input.revision)) throw new Error('可见范围或版本无效');
    if (input.visibility === 'public' && item.status !== 'ready') throw new Error('仅可公开已生成的笔记');
    const changed = db.prepare('UPDATE knowledge_documents SET visibility=?,revision=revision+1,updated_at=? WHERE user_id=? AND id=? AND revision=?')
      .run(input.visibility, new Date().toISOString(), session.userId, id, input.revision);
    if (!changed.changes) return json(res, 409, { ok: false, error: '笔记已更新，请刷新后重试' });
    return json(res, 200, { ok: true, visibility: input.visibility, revision: input.revision + 1 });
  } catch { return json(res, 400, { ok: false, error: '请检查可见范围和版本；仅可公开已生成的笔记' }); }
}

export async function handleKnowledgeBatchVisibility(req, res, session, json, db) {
  if (req.method !== 'PUT') return json(res, 405, { ok: false, error: '请使用 PUT 更新可见范围' });
  if (!sameOriginWrite(req)) return json(res, 403, { ok: false, error: '不允许跨站写入' });
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 24000) throw new Error('请求过长'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || !['private', 'public'].includes(input.visibility) || !Array.isArray(input.documents)
      || !input.documents.length || input.documents.length > 100
      || input.documents.some(d => !d || !/^[a-f0-9]{32}$/.test(d.id) || !Number.isSafeInteger(d.revision))
      || new Set(input.documents.map(d => d.id)).size !== input.documents.length) throw new Error('请选择1至100篇笔记，并检查可见范围和版本');
    const store = createKnowledgeStore(db);
    db.transaction(() => {
      for (const d of input.documents) {
        const item = store.get(session.userId, d.id);
        if (!item) throw Object.assign(new Error('部分笔记不存在，请刷新列表'), { status: 404 });
        if (item.revision !== d.revision || input.visibility === 'public' && item.status !== 'ready')
          throw Object.assign(new Error('部分笔记已更新或尚未生成，整批未修改，请刷新后重试'), { status: 409 });
      }
      const update = db.prepare('UPDATE knowledge_documents SET visibility=?,revision=revision+1,updated_at=? WHERE user_id=? AND id=?');
      const time = new Date().toISOString();
      for (const d of input.documents) update.run(input.visibility, time, session.userId, d.id);
    }).immediate();
    return json(res, 200, { ok: true, count: input.documents.length, visibility: input.visibility });
  } catch (e) { return json(res, e.status || 400, { ok: false, error: e.code?.startsWith('SQLITE_') ? '知识库存储失败' : e.message }); }
}
