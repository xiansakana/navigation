import { readJson, sameOriginWrite } from '../../shared/http.js';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { resolveSessionUser } from './auth.js';
import { integrationConfig } from '../../shared/runtime-config.js';
import { createChainNotifier } from './torn-chain-notifications.js';
import { UsersMonitor, createUsersStore, usersConfig } from './torn-users-monitor.js';
import { portalTornRequest } from './torn-chain-monitor.js';

export function canTornUsers(session, action = 'view') {
  const permissions = session?.dataAccess?.permissions || session?.permissions || [];
  return !!session?.userId && (!session.isGuest || action === 'view') && hasPermission(permissions, 'torn-users:view')
    && hasPermission(permissions, 'torn-users:' + action);
}

export function createTornUsersService({ store, request = portalTornRequest, authorize = () => true, authorizeNotify = () => false, sendNotification = async () => { throw new Error('通知管理连接未配置'); }, monitorOptions = {}, Monitor = UsersMonitor, validateConfig = usersConfig }) {
  const monitors = new Map();
  const monitor = uid => {
    if (!monitors.has(uid)) monitors.set(uid, new Monitor({ uid, store, request, authorize: () => authorize(uid), notify: async row => {
      if (!authorizeNotify(uid)) return { skipped: true };
      return await sendNotification(store.getNotify(uid), row);
    }, ...monitorOptions }));
    return monitors.get(uid);
  };
  return {
    monitors,
    async handle(req, res, url, session, json) {
      res.setHeader('Cache-Control', 'no-store');
      if (!canTornUsers(session)) return json(res, 403, { ok: false, error: '请登录并获取用户监控权限' });
      const route = url.pathname.slice('/api/torn-users'.length), uid = session.userId;
      const action = route === '/notifications' ? 'notify:edit' : route === '/notifications/test' ? 'notify:test:edit' : route === '/config' ? 'config:edit' : ['/start', '/stop'].includes(route) ? 'control:edit' : route === '/history' ? 'history:edit' : null;
      if (req.method !== 'GET' && (!action || !canTornUsers(session, action))) return json(res, 403, { ok: false, error: '无权执行此操作' });
      if (!sameOriginWrite(req)) return json(res, 403, { ok: false, error: '不允许跨站操作' });
      try {
        if (route.startsWith('/notifications') && !canTornUsers(session, 'notify:view')) return json(res, 403, { ok: false, error: '无权访问用户出院通知配置' });
        if (route === '/notifications' && req.method === 'GET') return json(res, 200, { ok: true, settings: store.getNotify(uid), permissions: { save: canTornUsers(session, 'notify:edit'), test: canTornUsers(session, 'notify:test:edit') } });
        if (route === '/notifications' && req.method === 'PUT') { store.saveNotify(uid, await readJson(req, 16384)); return json(res, 200, { ok: true, settings: store.getNotify(uid) }); }
        if (route === '/notifications/test' && req.method === 'POST') {
          const settings = store.getNotify(uid);
          if (!settings.qq.enabled && !settings.slack.enabled) throw new Error('请先保存并启用至少一个通知渠道');
          const result = await sendNotification(settings, null);
          return json(res, 200, { ok: true, result });
        }
        if (route === '/state' && req.method === 'GET') {
          const { config: { apiKey, apiKeys, ...config }, history } = store.get(uid);
          const state = monitor(uid).status();
          return json(res, 200, { ok: true, config: { ...config, hasKey: !!apiKey, keyCount: apiKeys.length }, state, history: [...history].reverse(), permissions: { configure: canTornUsers(session, 'config:edit'), control: canTornUsers(session, 'control:edit'), clear: canTornUsers(session, 'history:edit') } });
        }
        if (route === '/config' && req.method === 'POST') {
          const input = await readJson(req, 65536); validateConfig(input, store.get(uid).config);
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
export const userJobs = () => service?.monitors || new Map();
export async function handleTornUsersApi(req, res, url, session, json, config) {
  if (!canTornUsers(session)) return json(res, 403, { ok: false, error: '请登录并获取用户监控权限' });
  const authorized = (uid, action) => {
    const current = resolveSessionUser({ userId: uid }, config);
    if (current?.rbac?.accessPolicy?.modules?.['torn-users']?.enabled === false) return false;
    const ctx = current && { userId: uid, permissions: current.permissions, isGuest: current.user.username === (config.auth?.guestUsername || 'guest') };
    return !!ctx && canTornUsers(ctx, action) && (action !== 'notify:edit' || canTornUsers(ctx, 'notify:view'));
  };
  service ||= createTornUsersService({ store: createUsersStore(getDatabase()), authorize: uid => authorized(uid, 'control:edit'), authorizeNotify: uid => authorized(uid, 'notify:edit'), sendNotification: async (settings, row) => {
    const endpoint = config.services?.find(item => item.id === 'notifications')?.internalUrl || 'http://127.0.0.1:8787';
    return createChainNotifier({ endpoint, testMessage: '[Torn 用户监控] 出院提醒测试 · 配置正常', token: integrationConfig().notifyToken })(settings, row);
  } });
  return service.handle(req, res, url, session, json);
}
