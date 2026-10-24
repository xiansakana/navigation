import { parseCookies } from './auth.js';
import { loadRbac } from './rbac.js';
import { resolveDataAccess, listDataAccess, dataRequestAction } from './access-policy.js';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from '../../shared/auth/permissions.js';

const auditReady = new WeakSet();
export function auditDataAccess(req, res, access) {
  if (access.action !== 'write') return;
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.once('finish', () => {
    try {
      const db = getDatabase();
      if (!auditReady.has(db)) {
        db.exec('CREATE TABLE IF NOT EXISTS data_access_audit(id INTEGER PRIMARY KEY,actor_id TEXT NOT NULL,owner_id TEXT NOT NULL,module_id TEXT NOT NULL,scope TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,status INTEGER NOT NULL,created_at TEXT NOT NULL)');
        auditReady.add(db);
      }
      db.prepare('INSERT INTO data_access_audit(actor_id,owner_id,module_id,scope,method,path,status,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(access.actorId, access.ownerId, access.moduleId, access.scope, req.method, pathname.slice(0, 512), res.statusCode, new Date().toISOString());
    } catch (error) { console.error('[data-access-audit]', error.code || 'write failed'); }
  });
}

export const scopeCookie = moduleId => 'portal_scope_' + moduleId;
export function stripPortalIdentity(req) {
  for (const name of ['x-portal-user-id', 'x-portal-username', 'x-portal-permissions', 'x-navigation-data-scope']) delete req.headers[name];
}
export function requestDataAccess(req, session, moduleId, config, action) {
  const url = new URL(req.url, 'http://localhost');
  const scope = req.headers['x-navigation-data-scope'] || parseCookies(req)[scopeCookie(moduleId)];
  if (scope && (typeof scope !== 'string' || scope.length > 256)) throw Object.assign(new Error('数据范围无效'), { status: 400 });
  const rbac = loadRbac(config);
  const access = resolveDataAccess(rbac, session, moduleId, scope, action || dataRequestAction(req, url.pathname), config.services);
  access.writable = false;
  try { resolveDataAccess(rbac, session, moduleId, access.scope, 'write', config.services); access.writable = true; } catch { /* Keep the API and UI read-only. */ }
  access.permissions = permissionsForDataAccess(rbac, session.permissions || [], access);
  return access;
}
export function permissionsForDataAccess(rbac, permissions, access) {
  if (access.writable) return permissions;
  const isModule = p => p.serviceId === access.moduleId || p.id.startsWith(access.moduleId + ':') || p.id.startsWith('service:' + access.moduleId + ':');
  const writable = p => p.action && p.action !== 'view' || /:(edit|create|execute|run|stop|manage|order|restore|send|calculate)$/.test(p.id);
  const allowed = (rbac.permissions || []).filter(p => hasPermission(permissions, p.id)
    || isModule(p) && permissions.includes('service:' + access.moduleId + ':edit'));
  const result = allowed.filter(p => !isModule(p) || !writable(p)).map(p => p.id);
  if (access.moduleId === 'blog' && hasPermission(permissions, 'blog:post:edit')) result.push('blog:feed:view');
  return [...new Set(result)];
}
export function scopedSession(session, access) {
  return { ...session, actorUserId: session.userId, userId: access.ownerId, dataAccess: access };
}
export function availableDataAccess(session, moduleId, config) {
  return listDataAccess(loadRbac(config), session, moduleId, config.services);
}
