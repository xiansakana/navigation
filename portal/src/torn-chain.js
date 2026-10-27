import { readJson, sameOriginWrite } from '../../shared/http.js';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { resolveSessionUser } from './auth.js';
import { integrationConfig } from '../../shared/runtime-config.js';
import { createChainNotifier } from './torn-chain-notifications.js';
import { BONUS_HITS } from './torn-chain-bonuses.js';
import { ChainMonitor, portalTornRequest, createChainStore, chainConfig } from './torn-chain-monitor.js';

export function canTornChain(session, action = 'view') {
  const permissions = session?.dataAccess?.permissions || session?.permissions || [];
  return !!session?.userId && (!session.isGuest || action === 'view') && hasPermission(permissions, 'torn-chain:view')
    && hasPermission(permissions, 'torn-chain:' + action);
}

export function createTornChainService({ store, request = portalTornRequest, authorize = () => true, authorizeNotify = () => false, sendNotification = async () => { throw new Error('通知管理连接未配置'); }, monitorOptions = {} }) {
  const monitors = new Map();
  const monitor = uid => {
    if (!monitors.has(uid)) monitors.set(uid, new ChainMonitor({ uid, store, request, authorize: () => authorize(uid), notify: async row => {
      if (!authorizeNotify(uid)) return;
      await sendNotification(store.getNotify(uid), row);
    }, ...monitorOptions }));
    return monitors.get(uid);
  };
  return {
    monitors,
    async handle(req, res, url, session, json) {
      res.setHeader('Cache-Control', 'no-store');
      if (!canTornChain(session)) return json(res, 403, { ok: false, error: '请登录并获取 Chain 监控权限' });
      const route = url.pathname.slice('/api/torn-chain'.length), uid = session.userId;
      const action = route === '/notifications' ? 'notify:edit' : route === '/notifications/test' ? 'notify:test:edit' : route === '/config' ? 'config:edit' : ['/start', '/stop'].includes(route) ? 'control:edit' : route === '/history' ? 'history:edit' : null;
      if (req.method !== 'GET' && (!action || !canTornChain(session, action))) return json(res, 403, { ok: false, error: '无权执行此操作' });
      if (!sameOriginWrite(req)) return json(res, 403, { ok: false, error: '不允许跨站操作' });
      try {
        if (route.startsWith('/notifications') && !canTornChain(session, 'notify:view')) return json(res, 403, { ok: false, error: '无权访问 Chain 通知配置' });
        if (route === '/notifications' && req.method === 'GET') return json(res, 200, { ok: true, settings: store.getNotify(uid), permissions: { save: canTornChain(session, 'notify:edit'), test: canTornChain(session, 'notify:test:edit') } });
        if (route === '/notifications' && req.method === 'PUT') { store.saveNotify(uid, await readJson(req, 16384)); return json(res, 200, { ok: true, settings: store.getNotify(uid) }); }
        if (route === '/notifications/test' && req.method === 'POST') {
          const settings = store.getNotify(uid);
          if (!settings.qq.enabled && !settings.slack.enabled) throw new Error('请先保存并启用至少一个通知渠道');
          const result = await sendNotification(settings, null);
          return json(res, 200, { ok: true, result });
        }
        if (route === '/state' && req.method === 'GET') {
          const { config: { apiKey, apiKeys, ...config }, history } = store.get(uid);
          return json(res, 200, { ok: true, config: { ...config, hasKey: !!apiKey, keyCount: apiKeys.length }, bonusHitOptions: BONUS_HITS, state: monitor(uid).status(), history: [...history].reverse(), permissions: { configure: canTornChain(session, 'config:edit'), control: canTornChain(session, 'control:edit'), clear: canTornChain(session, 'history:edit') } });
        }
        if (route === '/config' && req.method === 'POST') {
          const input = await readJson(req, 8192); chainConfig(input, store.get(uid).config);
          const current = monitor(uid); current.stop(); await current.promise; store.save(uid, input);
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
  const authorized = (uid, action) => {
    const current = resolveSessionUser({ userId: uid }, config);
    if (current?.rbac?.accessPolicy?.modules?.['torn-chain']?.enabled === false) return false;
    const ctx = current && { userId: uid, permissions: current.permissions, isGuest: current.user.username === (config.auth?.guestUsername || 'guest') };
    return !!ctx && canTornChain(ctx, action) && (action !== 'notify:edit' || canTornChain(ctx, 'notify:view'));
  };
  service ||= createTornChainService({ store: createChainStore(getDatabase()), authorize: uid => authorized(uid, 'control:edit'), authorizeNotify: uid => authorized(uid, 'notify:edit'), sendNotification: async (settings, row) => {
    const endpoint = config.services?.find(item => item.id === 'notifications')?.internalUrl || 'http://127.0.0.1:8787';
    return createChainNotifier({ endpoint, token: integrationConfig().notifyToken })(settings, row);
  } });
  return service.handle(req, res, url, session, json);
}
