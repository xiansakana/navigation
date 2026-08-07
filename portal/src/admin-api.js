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
    resolveUserPermissions
} from './rbac.js';

function forbidden(res) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '无权限' }));
}

function requirePerm(res, userPerms, perm) {
    if (!hasPermission(userPerms, perm)) {
        forbidden(res);
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
    if (!hasPermission(userPerms, 'admin:access')) {
        return forbidden(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/rbac') {
        return json(res, 200, { ok: true, rbac: sanitizeRbac(rbac), me: { permissions: userPerms } });
    }

    if (url.pathname === '/api/admin/users') {
        if (req.method === 'GET') {
            return json(res, 200, { ok: true, users: sanitizeRbac(rbac).users });
        }
        if (req.method === 'POST') {
            if (!requirePerm(res, userPerms, 'admin:users')) return;
            try {
                var userBody = await readJson(req);
                var savedUser = upsertUser(rbac, userBody);
                saveRbac(rbac);
                return json(res, 200, { ok: true, user: savedUser.id ? sanitizeRbac(rbac).users.find(function(u) { return u.id === savedUser.id; }) : null });
            } catch (err) {
                return json(res, 400, { ok: false, error: err.message });
            }
        }
    }

    if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
        if (!requirePerm(res, userPerms, 'admin:users')) return;
        try {
            deleteUser(rbac, url.pathname.slice('/api/admin/users/'.length));
            saveRbac(rbac);
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
        }
    }

    if (url.pathname === '/api/admin/roles') {
        if (req.method === 'GET') {
            return json(res, 200, { ok: true, roles: sanitizeRbac(rbac).roles });
        }
        if (req.method === 'POST') {
            if (!requirePerm(res, userPerms, 'admin:roles')) return;
            try {
                var roleBody = await readJson(req);
                upsertRole(rbac, roleBody);
                saveRbac(rbac);
                return json(res, 200, { ok: true, roles: sanitizeRbac(rbac).roles });
            } catch (err) {
                return json(res, 400, { ok: false, error: err.message });
            }
        }
    }

    if (url.pathname.startsWith('/api/admin/roles/') && req.method === 'DELETE') {
        if (!requirePerm(res, userPerms, 'admin:roles')) return;
        try {
            deleteRole(rbac, url.pathname.slice('/api/admin/roles/'.length));
            saveRbac(rbac);
            return json(res, 200, { ok: true, roles: sanitizeRbac(rbac).roles });
        } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
        }
    }

    if (url.pathname === '/api/admin/menus' && req.method === 'PUT') {
        if (!requirePerm(res, userPerms, 'admin:menus')) return;
        try {
            var menuBody = await readJson(req);
            updateMenus(rbac, menuBody.menus || []);
            saveRbac(rbac);
            return json(res, 200, { ok: true, menus: sanitizeRbac(rbac).menus });
        } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
        }
    }

    return json(res, 404, { ok: false, error: 'Not Found' });
}
