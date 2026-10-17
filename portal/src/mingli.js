import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { calculateChart } from './mingli-chart.js';
import { createMingliStore } from './mingli-store.js';
import { parseCaseFilters } from './mingli-filters.js';
import { createKnowledgeCaseStore } from './mingli-knowledge-store.js';
import { canKnowledge } from './knowledge.js';

export function canMingli(session, action = 'view') {
  return !!session?.userId && !session.isGuest && hasPermission(session.permissions || [], 'mingli:' + action);
}

async function body(req, maxSize = 128 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) throw new Error('请求超过大小限制');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

export async function handleMingliApi(req, res, url, session, json) {
  res.setHeader('Cache-Control', 'no-store');
  if (!canMingli(session)) return json(res, 403, { ok: false, error: '请登录并获取命理模块权限' });
  const route = url.pathname.slice('/api/mingli'.length), method = req.method;
  const match = /^\/cases\/([a-f0-9]{32})$/.exec(route);
  const category = /^\/categories\/([a-f0-9]{32})$/.exec(route);
  const knowledgeCase = /^\/knowledge-cases\/([a-f0-9]{32})$/.exec(route);
  const action = (route === '/knowledge-cases' || knowledgeCase) && method === 'GET' ? 'knowledge:view'
    : route === '/cases/category' && method === 'POST' ? 'cases:classify'
    : route === '/categories' && method === 'GET' ? 'categories:view'
      : (route === '/categories' && method === 'POST' || category && ['PUT', 'DELETE'].includes(method)) ? 'categories:edit'
    : ['/import/preview', '/import/confirm'].includes(route) && method === 'POST' ? 'cases:import'
    : route === '/chart' && method === 'POST' ? 'chart:calculate'
    : (route === '/cases' || match) && method === 'GET' ? 'cases:view'
      : (route === '/cases' && method === 'POST' || match && method === 'PUT') ? 'cases:edit'
        : match && method === 'DELETE' ? 'cases:delete' : null;
  if (!action) return json(res, 404, { ok: false, error: '命理接口不存在' });
  if (!canMingli(session, action)) return json(res, 403, { ok: false, error: '无权执行此命理操作' });
  if (action === 'knowledge:view' && (!canKnowledge(session) || !canKnowledge(session, 'notes:view'))) return json(res, 403, { ok: false, error: '知识库案例还需要知识库及笔记查看权限' });
  if (method !== 'GET' && (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && !['http://' + req.headers.host, 'https://' + req.headers.host].includes(req.headers.origin))) {
    return json(res, 403, { ok: false, error: '不允许跨站写入' });
  }
  try {
    if (action === 'knowledge:view') {
      const store = createKnowledgeCaseStore(getDatabase()), uid = session.userId;
      if (knowledgeCase) { const item = store.get(uid, knowledgeCase[1]); return json(res, item ? 200 : 404, item ? { ok: true, case: item } : { ok: false, error: '知识库案例不存在' }); }
      const filters = parseCaseFilters(url.searchParams.get('filters'));
      if (Object.keys(filters).length && !canMingli(session, 'knowledge:filter')) return json(res, 403, { ok: false, error: '无权使用知识库案例高级筛选' });
      return json(res, 200, { ok: true, ...store.list(uid, { search: url.searchParams.get('search') || '', documentId: url.searchParams.get('documentId') || '', filters,
        offset: Math.min(100000, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0))), limit: Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get('limit')) || 30))) }) });
    }
    if (route === '/chart') return json(res, 200, { ok: true, chart: calculateChart(await body(req)) });
    const store = createMingliStore(getDatabase()), uid = session.userId;
    if (route === '/categories' && method === 'GET') return json(res, 200, { ok: true, ...store.categories.list(uid) });
    if (action === 'categories:edit') {
      const item = method === 'DELETE' ? store.categories.remove(uid, category[1]) : store.categories.save(uid, await body(req), category?.[1]);
      return json(res, !item ? 404 : method === 'POST' ? 201 : 200, item ? { ok: true, ...(method === 'DELETE' ? item : { category: item }) } : { ok: false, error: '分类不存在' });
    }
    if (route === '/cases/category') {
      const input = await body(req), result = store.categories.assign(uid, input?.ids, input?.categoryId);
      return json(res, result ? 200 : 404, result ? { ok: true, ...result } : { ok: false, error: '案例不存在' });
    }
    if (action === 'cases:import') {
      if (route === '/import/confirm' && !canMingli(session, 'cases:edit')) return json(res, 403, { ok: false, error: '保存导入案例需要案例编辑权限' });
      return json(res, 200, { ok: true, ...store.importWenZhen(uid, await body(req, 2 * 1024 * 1024), route === '/import/confirm') });
    }
    if (route === '/cases' && method === 'GET') {
      const filters = parseCaseFilters(url.searchParams.get('filters'));
      if (Object.keys(filters).length && !canMingli(session, 'cases:filter')) return json(res, 403, { ok: false, error: '无权使用案例高级筛选' });
      const page = key => Math.max(0, Math.floor(Number(url.searchParams.get(key)) || 0));
      return json(res, 200, { ok: true, ...store.list(uid, { search: url.searchParams.get('search') || '', categoryId: url.searchParams.get('categoryId') || '', filters, offset: Math.min(100000, page('offset')), limit: Math.max(1, Math.min(100, page('limit') || 30)) }) });
    }
    let item;
    if (route === '/cases' && method === 'POST' || match && method === 'PUT') {
      const input = await body(req);
      if (input && Object.hasOwn(input, 'categoryId') && !canMingli(session, 'cases:classify')) return json(res, 403, { ok: false, error: '无权设置案例分类' });
      item = store.save(uid, input, match?.[1]);
    }
    else if (method === 'GET') item = store.get(uid, match[1]);
    else item = store.remove(uid, match[1]);
    if (!item) return json(res, 404, { ok: false, error: '案例不存在' });
    return json(res, method === 'POST' ? 201 : 200, { ok: true, ...(method === 'DELETE' ? {} : { case: item }) });
  } catch (e) {
    if (e.code?.startsWith('SQLITE_')) {
      console.error('[mingli]', e.code);
      return json(res, 500, { ok: false, error: '案例保存失败，请稍后重试' });
    }
    return json(res, 400, { ok: false, error: e.message });
  }
}
