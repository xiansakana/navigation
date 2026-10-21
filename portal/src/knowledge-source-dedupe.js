// Compare video identity without changing the source URL displayed in a note.
export function sourceKey(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text.match(/https?:\/\/[^\s<>"“”]+/i)?.[0] || ''); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
    const id = /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,19})\/?$/i.exec(url.pathname)?.[1];
    const part = url.searchParams.get('p') || '1';
    if (id && /^\d{1,4}$/.test(part) && Number(part) > 0) return 'bilibili:' + (id.slice(0, 2).toLowerCase() === 'bv' ? 'BV' + id.slice(2) : id.toLowerCase()) + ':p' + Number(part);
  }
  url.hash = '';
  if (url.hostname === 'b23.tv') { url.protocol = 'https:'; url.pathname = url.pathname.replace(/\/$/, ''); url.search = ''; }
  url.searchParams.sort();
  return url.href;
}

export function findSourceDuplicate(db, uid, input, { exceptDocument = '', exceptQueue = '', includeQueue = true } = {}) {
  const key = sourceKey(input);
  if (!key) return null;
  const rows = db.prepare(`SELECT d.id AS document_id,d.title,d.status,d.source_url,i.url AS import_url
    FROM knowledge_documents d LEFT JOIN knowledge_imports i ON i.document_id=d.id AND i.user_id=d.user_id
    WHERE d.user_id=? AND d.id<>? AND d.status<>'deleting'
    ORDER BY CASE d.status WHEN 'ready' THEN 0 ELSE 1 END,d.created_at,d.id`).all(uid, exceptDocument);
  for (const row of rows) if (sourceKey(row.source_url) === key || sourceKey(row.import_url) === key) return row;
  if (!includeQueue || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_upload_queue'").get()) return null;
  const queued = db.prepare(`SELECT q.id AS queue_id,q.document_id,q.title,q.url,q.state AS status
    FROM knowledge_upload_queue q LEFT JOIN knowledge_documents d ON d.id=q.document_id AND d.user_id=q.user_id
    WHERE q.user_id=? AND q.id<>? AND (?='' OR q.document_id<>?) AND
      (q.state IN ('pending','resolving') OR q.state='submitted' AND d.id IS NOT NULL AND d.status<>'deleting') ORDER BY q.seq`)
    .all(uid, exceptQueue, exceptDocument, exceptDocument);
  return queued.find(row => sourceKey(row.url) === key) || null;
}

export function duplicateSourceError(row) {
  return Object.assign(new Error(row.document_id ? '该视频链接已存在，不能重复导入。请查看已有笔记；处理失败时请重试原任务。' : '该视频链接已在导入队列中，请勿重复提交。'), {
    status: 409, code: 'KNOWLEDGE_DUPLICATE_SOURCE', duplicate: { documentId: row.document_id || '', queueId: row.queue_id || '', title: row.title || '', status: row.status }
  });
}
