const serviceViewPermissionId = id => 'service:' + id + ':view';
const serviceEditPermissionId = id => 'service:' + id + ':edit';

export function resolveUserPermissions(data, user) {
    if (!user) return [];
    var perms = new Set();
    (user.roleIds || []).forEach(function(roleId) {
        var role = (data.roles || []).find(function(r) { return r.id === roleId; });
        if (!role) return;
        (role.permissions || []).forEach(function(p) { perms.add(p); });
    });
    if (perms.has('*')) {
        (data.permissions || []).forEach(function(p) { perms.add(p.id); });
    }
    if (data.guestUserId ? user.id !== data.guestUserId : user.id !== 'usr_guest' && user.username !== 'guest') {
        (data.accessPolicy?.memberPermissions || []).forEach(function(p) { perms.add(p); });
    }
    return Array.from(perms);
}

export function hasPermission(userPerms, permission) {
    if (!permission) return true;
    if (userPerms.includes('*')) return true;
    if (userPerms.includes(permission)) return true;

    var legacyService = /^service:([^:]+)$/.exec(permission);
    if (legacyService) {
        var serviceId = legacyService[1];
        if (userPerms.includes(serviceViewPermissionId(serviceId))
            || userPerms.includes(serviceEditPermissionId(serviceId))) {
            return true;
        }
    }
    if (permission === 'admin:access') {
        if (userPerms.includes('admin:access:view') || userPerms.includes('admin:access:edit')) {
            return true;
        }
    }

    if (permission.endsWith(':view')) {
        var editPerm = permission.slice(0, -5) + ':edit';
        if (userPerms.includes(editPerm)) return true;
        var legacy = permission.replace(/:view$/, '');
        if (legacy !== permission && userPerms.includes(legacy)) return true;
    }

    if (permission.endsWith(':edit')) {
        var legacyEdit = permission.replace(/:edit$/, '');
        if (legacyEdit !== permission && userPerms.includes(legacyEdit)) return true;
    }

    var parts = permission.split(':');
    while (parts.length > 1) {
        parts.pop();
        if (userPerms.includes(parts.join(':') + ':*')) return true;
    }
    return false;
}

