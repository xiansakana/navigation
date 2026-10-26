import { readJson, sameOriginWrite } from '../../shared/http.js';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { resolveSessionUser } from './auth.js';
import { resolveDataAccess } from './access-policy.js';
import { portalTornRequest } from './torn-chain-monitor.js';
import { factionConfig } from './torn-faction-analysis.js';
import { createFactionStore, FactionScanner } from './torn-faction-scan.js';

export function canFactionScan(session, action = 'view') {
  const permissions = session?.dataAccess?.permissions || session?.permissions || [];
  return !!session?.userId && (!session.isGuest || action === 'view') && hasPermission(permissions, 'torn-chain:view') && hasPermission(permissions, 'torn-factions:view') && hasPermission(permissions, 'torn-factions:' + action);
}

export function createFactionService({ store, request = portalTornRequest, authorize = () => true, scannerOptions = {} }) {
  const scanners = new Map();
  const scanner = uid => { if (!scanners.has(uid)) scanners.set(uid, new FactionScanner({ uid, store, request, authorize: () => authorize(uid), ...scannerOptions })); return scanners.get(uid); };
  return { scanners, async handle(req, res, url, session, json) {
    res.setHeader('Cache-Control', 'no-store');
    if (!canFactionScan(session)) return json(res, 403, { ok: false, error: '无权查看帮派筛选' });
    const route = url.pathname.slice('/api/torn-factions'.length), uid = session.userId;
    const action = route === '/config' ? 'config:edit' : ['/start', '/stop', '/reset'].includes(route) ? 'control:edit' : null;
    if (req.method !== 'GET' && (!action || !canFactionScan(session, action))) return json(res, 403, { ok: false, error: '无权修改帮派筛选' });
    if (!sameOriginWrite(req)) return json(res, 403, { ok: false, error: '不允许跨站操作' });
    try {
      const monitor = scanner(uid);
      if (route === '/state' && req.method === 'GET') {
        const { apiKey, apiKeys, ...config } = store.get(uid).config, { rows = [], ...state } = monitor.status();
        const filter = url.searchParams.get('filter') || 'all';
        if (!['all', 'match', 'excluded', 'unknown', 'waiting', 'scanning'].includes(filter)) throw new Error('结果筛选无效');
        const visible = filter === 'all' ? rows : rows.filter(row => row.status === filter);
        const offset = Number(url.searchParams.get('offset') || 0), limit = 50;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('分页位置无效');
        const counts = Object.fromEntries(['match', 'excluded', 'unknown', 'waiting', 'scanning'].map(status => [status, rows.filter(row => row.status === status).length]));
        return json(res, 200, { ok: true, config: { ...config, hasKey: !!apiKey, keyCount: apiKeys.length }, state, counts, rows: visible.slice(offset, offset + limit), total: visible.length, offset, limit, permissions: { configure: canFactionScan(session, 'config:edit'), control: canFactionScan(session, 'control:edit') } });
      }
      if (route === '/config' && req.method === 'POST') {
        const input = await readJson(req, 4096); factionConfig(input, store.get(uid).config);
        monitor.stop(); await monitor.promise; store.save(uid, input); monitor.run = store.get(uid).run; return json(res, 200, { ok: true });
      }
      if (route === '/start' && req.method === 'POST') { monitor.start(); return json(res, 200, { ok: true }); }
      if (route === '/stop' && req.method === 'POST') { monitor.stop(); return json(res, 200, { ok: true }); }
      if (route === '/reset' && req.method === 'POST') {
        monitor.stop(); await monitor.promise; monitor.run = {}; store.saveRun(uid, {}); return json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false, error: 'Not Found' });
    } catch (error) { return json(res, error.status || 400, { ok: false, error: error.message }); }
  } };
}

let service;
export async function handleFactionApi(req, res, url, session, json, config) {
  if (!canFactionScan(session)) return json(res, 403, { ok: false, error: '无权查看帮派筛选' });
  service ||= createFactionService({ store: createFactionStore(getDatabase()), authorize: uid => {
    const current = resolveSessionUser({ userId: uid }, config);
    if (!current || current.rbac?.accessPolicy?.modules?.['torn-factions']?.enabled === false || current.rbac?.accessPolicy?.modules?.['torn-chain']?.enabled === false) return false;
    try { resolveDataAccess(current.rbac, { userId: uid }, 'torn-factions', 'self', 'write', config.services); resolveDataAccess(current.rbac, { userId: uid }, 'torn-chain', 'self', 'read', config.services); } catch { return false; }
    return canFactionScan({ userId: uid, permissions: current.permissions, isGuest: current.user.username === (config.auth?.guestUsername || 'guest') }, 'control:edit');
  } });
  return service.handle(req, res, url, session, json);
}
