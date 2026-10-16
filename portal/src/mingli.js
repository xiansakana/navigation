import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { calculateChart } from './mingli-chart.js';
import { createMingliStore } from './mingli-store.js';

export function canMingli(session, action = 'view') {
  return !!session?.userId && !session.isGuest && hasPermission(session.permissions || [], 'mingli:' + action);
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('请求超过 128KB');
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
  const action = route === '/chart' && method === 'POST' ? 'chart:calculate'
    : (route === '/cases' || match) && method === 'GET' ? 'cases:view'
      : (route === '/cases' && method === 'POST' || match && method === 'PUT') ? 'cases:edit'
        : match && method === 'DELETE' ? 'cases:delete' : null;
  if (!action) return json(res, 404, { ok: false, error: '命理接口不存在' });
  if (!canMingli(session, action)) return json(res, 403, { ok: false, error: '无权执行此命理操作' });
  if (method !== 'GET' && (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && !['http://' + req.headers.host, 'https://' + req.headers.host].includes(req.headers.origin))) {
    return json(res, 403, { ok: false, error: '不允许跨站写入' });
  }
  try {
    if (route === '/chart') return json(res, 200, { ok: true, chart: calculateChart(await body(req)) });
    const store = createMingliStore(getDatabase()), uid = session.userId;
    if (route === '/cases' && method === 'GET') {
      const page = key => Math.max(0, Math.floor(Number(url.searchParams.get(key)) || 0));
      return json(res, 200, { ok: true, ...store.list(uid, { search: url.searchParams.get('search') || '', offset: Math.min(100000, page('offset')), limit: Math.max(1, Math.min(100, page('limit') || 30)) }) });
    }
    let item;
    if (route === '/cases' && method === 'POST') item = store.save(uid, await body(req));
    else if (method === 'GET') item = store.get(uid, match[1]);
    else if (method === 'PUT') item = store.save(uid, await body(req), match[1]);
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
