import { readJson, sameOriginWrite } from '../../shared/http.js';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { resolveSessionUser } from './auth.js';
import { ChainMonitor, createChainApiClient, createChainStore, chainConfig } from './torn-chain-monitor.js';

export function canTornChain(session, action = 'view') {
  return !!session?.userId && !session.isGuest && hasPermission(session.permissions || [], 'torn-chain:view')
    && hasPermission(session.permissions || [], 'torn-chain:' + action);
}

export function createTornChainService({ store, request = createChainApiClient(), authorize = () => true, monitorOptions = {} }) {
  const monitors = new Map();
  const monitor = uid => {
    if (!monitors.has(uid)) monitors.set(uid, new ChainMonitor({ uid, store, request, authorize: () => authorize(uid), ...monitorOptions }));
    return monitors.get(uid);
  };
  return {
    monitors,
    async handle(req, res, url, session, json) {
      res.setHeader('Cache-Control', 'no-store');
      if (!canTornChain(session)) return json(res, 403, { ok: false, error: '请登录并获取 Chain 监控权限' });
      const route = url.pathname.slice('/api/torn-chain'.length), uid = session.userId;
      const action = route === '/config' ? 'config:edit' : ['/start', '/stop'].includes(route) ? 'control:edit' : route === '/history' ? 'history:edit' : null;
      if (req.method !== 'GET' && (!action || !canTornChain(session, action))) return json(res, 403, { ok: false, error: '无权执行此操作' });
      if (!sameOriginWrite(req)) return json(res, 403, { ok: false, error: '不允许跨站操作' });
      try {
        if (route === '/state' && req.method === 'GET') {
          const { config: { apiKey, ...config }, history } = store.get(uid);
          return json(res, 200, { ok: true, config: { ...config, hasKey: !!apiKey }, state: monitor(uid).status(), history: [...history].reverse(), permissions: { configure: canTornChain(session, 'config:edit'), control: canTornChain(session, 'control:edit'), clear: canTornChain(session, 'history:edit') } });
        }
        if (route === '/config' && req.method === 'POST') {
          const input = await readJson(req, 4096); chainConfig(input, store.get(uid).config);
          monitor(uid).stop(); store.save(uid, input);
          return json(res, 200, { ok: true });
        }
        if (route === '/start' && req.method === 'POST') { monitor(uid).start(); return json(res, 200, { ok: true }); }
        if (route === '/stop' && req.method === 'POST') { monitor(uid).stop(); return json(res, 200, { ok: true }); }
        if (route === '/history' && req.method === 'DELETE') { store.clear(uid); return json(res, 200, { ok: true }); }
        return json(res, 404, { ok: false, error: 'Not Found' });
      } catch (error) { return json(res, error.status || 400, { ok: false, error: error.message }); }
    }
  };
}

let service;
export async function handleTornChainApi(req, res, url, session, json, config) {
  if (!canTornChain(session)) return json(res, 403, { ok: false, error: '请登录并获取 Chain 监控权限' });
  service ||= createTornChainService({ store: createChainStore(getDatabase()), authorize: uid => {
    const current = resolveSessionUser({ userId: uid }, config);
    return !!current && canTornChain({ userId: uid, permissions: current.permissions, isGuest: current.user.username === (config.auth?.guestUsername || 'guest') }, 'control:edit');
  } });
  return service.handle(req, res, url, session, json);
}
