import {
    loadRbac,
    saveRbac,
    sanitizeRbac,
    upsertUser,
    deleteUser,
    upsertRole,
    deleteRole,
    updateMenus,
    hasPermission,
    resolveUserPermissions,
    canViewAdmin,
    canViewAdminResource,
    canEditAdminResource
} from './rbac.js';
import { accessModules, validateAccessPolicy } from './access-policy.js';

function forbidden(res, message) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: message || '无权限' }));
}

function requireView(res, userPerms, resource) {
    if (!canViewAdminResource(userPerms, resource)) {
        forbidden(res);
        return false;
    }
    return true;
}

function requireEdit(res, userPerms, resource) {
    if (!canEditAdminResource(userPerms, resource)) {
        forbidden(res, '需要编辑权限');
        return false;
    }
    return true;
}

export async function handleAdminApi(req, res, url, session, config, json, readJson) {
    var rbac = loadRbac(config);
    var user = rbac.users.find(function(u) { return u.id === session.userId; });
    if (!user) {
        return json(res, 401, { ok: false, error: '用户不存在' });
    }
    var userPerms = resolveUserPermissions(rbac, user);
    if (!canViewAdmin(userPerms)) {
        return forbidden(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/rbac') {
        return json(res, 200, {
            ok: true,
            rbac: sanitizeRbac(rbac),
            me: {
                permissions: userPerms,
                canEdit: {
                    users: canEditAdminResource(userPerms, 'admin:users'),
                    roles: canEditAdminResource(userPerms, 'admin:roles'),
                    menus: canEditAdminResource(userPerms, 'admin:menus')
                }
            }
        });
    }

    if (url.pathname === '/api/admin/data-policy') {
        if (!requireView(res, userPerms, 'admin:data-policy')) return;
        if (req.method === 'GET') return json(res, 200, { ok: true, policy: rbac.accessPolicy,
            modules: accessModules(config.services), users: sanitizeRbac(rbac).users, roles: sanitizeRbac(rbac).roles,
            permissions: rbac.permissions, services: (config.services || []).filter(s => s.type === 'proxy').map(s => ({ id: s.id, title: s.title || s.id })),
            canEdit: canEditAdminResource(userPerms, 'admin:data-policy') });
        if (req.method !== 'PUT') return json(res, 405, { ok: false, error: '不支持此方法' });
        if (!requireEdit(res, userPerms, 'admin:data-policy')) return;
        try {
            const input = await readJson(req);
            if (input.revision !== rbac.accessPolicy.revision) return json(res, 409, { ok: false, error: '访问策略已更新，请刷新后重试' });
            const policy = validateAccessPolicy(input, rbac, config.services);
            rbac.accessPolicy = policy; saveRbac(rbac);
            return json(res, 200, { ok: true, policy });
        } catch (err) { return json(res, err.status || 400, { ok: false, error: err.message }); }
    }

    if (url.pathname === '/api/admin/users') {
        if (req.method === 'GET') {
            if (!requireView(res, userPerms, 'admin:users')) return;
            return json(res, 200, { ok: true, users: sanitizeRbac(rbac).users });
        }
        if (req.method === 'POST') {
            if (!requireEdit(res, userPerms, 'admin:users')) return;
            try {
                upsertUser(rbac, await readJson(req));
                saveRbac(rbac);
                return json(res, 200, { ok: true, users: sanitizeRbac(rbac).users });
            } catch (err) {
                return json(res, err.status || 400, { ok: false, error: err.message });
            }
        }
    }

    if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
        if (!requireEdit(res, userPerms, 'admin:users')) return;
        try {
            deleteUser(rbac, url.pathname.slice('/api/admin/users/'.length));
            saveRbac(rbac);
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, err.status || 400, { ok: false, error: err.message });
        }
    }

    if (url.pathname === '/api/admin/roles') {
        if (req.method === 'GET') {
            if (!requireView(res, userPerms, 'admin:roles')) return;
            return json(res, 200, { ok: true, roles: sanitizeRbac(rbac).roles });
        }
        if (req.method === 'POST') {
            if (!requireEdit(res, userPerms, 'admin:roles')) return;
            try {
                upsertRole(rbac, await readJson(req));
                saveRbac(rbac);
                return json(res, 200, { ok: true, roles: sanitizeRbac(rbac).roles });
            } catch (err) {
                return json(res, err.status || 400, { ok: false, error: err.message });
            }
        }
    }

    if (url.pathname.startsWith('/api/admin/roles/') && req.method === 'DELETE') {
        if (!requireEdit(res, userPerms, 'admin:roles')) return;
        try {
            deleteRole(rbac, url.pathname.slice('/api/admin/roles/'.length));
            saveRbac(rbac);
            return json(res, 200, { ok: true, roles: sanitizeRbac(rbac).roles });
        } catch (err) {
            return json(res, err.status || 400, { ok: false, error: err.message });
        }
    }

    if (url.pathname === '/api/admin/menus' && req.method === 'PUT') {
        if (!requireEdit(res, userPerms, 'admin:menus')) return;
        try {
            var menuBody = await readJson(req);
            updateMenus(rbac, menuBody.menus || []);
            saveRbac(rbac);
            return json(res, 200, { ok: true, menus: sanitizeRbac(rbac).menus });
        } catch (err) {
            return json(res, err.status || 400, { ok: false, error: err.message });
        }
    }

    return json(res, 404, { ok: false, error: 'Not Found' });
}
