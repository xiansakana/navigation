import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RBAC_PATH = path.resolve(__dirname, '../data/rbac.json');

var SYSTEM_PERMISSIONS = [
    { id: 'admin:access', name: '访问管理后台', group: '系统' },
    { id: 'admin:users', name: '管理用户', group: '系统' },
    { id: 'admin:roles', name: '管理角色', group: '系统' },
    { id: 'admin:menus', name: '管理菜单', group: '系统' }
];

function newId(prefix) {
    return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

export function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function createPasswordRecord(password) {
    var salt = crypto.randomBytes(16).toString('hex');
    return { salt: salt, passwordHash: hashPassword(password, salt) };
}

export function verifyPassword(password, record) {
    if (!record?.salt || !record?.passwordHash) return false;
    var hash = hashPassword(password, record.salt);
    try {
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(record.passwordHash, 'hex'));
    } catch (e) {
        return false;
    }
}

function servicePermissionId(serviceId) {
    return 'service:' + serviceId;
}

function buildServicePermissions(services) {
    return (services || []).map(function(service) {
        return {
            id: servicePermissionId(service.id),
            name: '访问「' + (service.title || service.id) + '」',
            group: '服务',
            serviceId: service.id
        };
    });
}

function defaultAdminRole(servicePerms) {
    return {
        id: 'role_admin',
        name: '管理员',
        description: '拥有全部权限',
        permissions: ['*'].concat(servicePerms.map(function(p) { return p.id; }))
    };
}

function defaultUserRole() {
    return {
        id: 'role_user',
        name: '普通用户',
        description: '由管理员分配可见服务',
        permissions: []
    };
}

function buildMenusFromServices(services, overrides) {
    var overrideMap = {};
    (overrides || []).forEach(function(item) {
        overrideMap[item.id] = item;
    });
    var menus = (services || [])
        .filter(function(service) { return !service.hidden; })
        .map(function(service, index) {
            var id = 'menu_' + service.id;
            var base = {
                id: id,
                title: service.title || service.id,
                description: service.description || '',
                icon: service.icon || '📦',
                type: service.type,
                serviceId: service.id,
                permission: servicePermissionId(service.id),
                sort: (index + 1) * 10,
                enabled: true
            };
            if (service.type === 'external') base.url = service.url;
            else base.path = service.path;
            return Object.assign(base, overrideMap[id] || {});
        });
    var adminMenu = Object.assign({
        id: 'menu_admin',
        title: '权限管理',
        description: '用户、角色、菜单与权限配置',
        icon: '🔐',
        path: '/admin.html',
        permission: 'admin:access',
        sort: 9990,
        enabled: true
    }, overrideMap.menu_admin || {});
    menus.push(adminMenu);
    return menus.sort(function(a, b) { return (a.sort || 0) - (b.sort || 0); });
}

function createDefaultRbac(config) {
    var servicePerms = buildServicePermissions(config.services);
    var adminUser = config.auth || {};
    var pwd = createPasswordRecord(adminUser.password || 'change-me');
    return {
        users: [{
            id: 'usr_admin',
            username: adminUser.username || 'admin',
            salt: pwd.salt,
            passwordHash: pwd.passwordHash,
            roleIds: ['role_admin'],
            enabled: true,
            createdAt: new Date().toISOString()
        }],
        roles: [defaultAdminRole(servicePerms), defaultUserRole()],
        menus: buildMenusFromServices(config.services, []),
        permissions: SYSTEM_PERMISSIONS.concat(servicePerms)
    };
}

export function loadRbac(config) {
    if (!fs.existsSync(RBAC_PATH)) {
        var created = createDefaultRbac(config);
        saveRbac(created);
        return created;
    }
    var data = JSON.parse(fs.readFileSync(RBAC_PATH, 'utf8'));
    return syncRbacPermissions(data, config);
}

export function saveRbac(data) {
    fs.mkdirSync(path.dirname(RBAC_PATH), { recursive: true });
    fs.writeFileSync(RBAC_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export function syncRbacPermissions(data, config) {
    var servicePerms = buildServicePermissions(config.services);
    var known = {};
    SYSTEM_PERMISSIONS.concat(servicePerms).forEach(function(p) { known[p.id] = p; });
    (data.permissions || []).forEach(function(p) {
        if (!known[p.id] && !p.id.startsWith('service:')) known[p.id] = p;
    });
    data.permissions = Object.keys(known).map(function(id) { return known[id]; });

    var overrideMap = {};
    (data.menus || []).forEach(function(menu) { overrideMap[menu.id] = menu; });
    data.menus = buildMenusFromServices(config.services, Object.values(overrideMap));

    var adminRole = (data.roles || []).find(function(r) { return r.id === 'role_admin'; });
    if (adminRole && adminRole.permissions.includes('*')) {
        servicePerms.forEach(function(p) {
            if (!adminRole.permissions.includes(p.id)) adminRole.permissions.push(p.id);
        });
    }
    saveRbac(data);
    return data;
}

export function findUserByUsername(data, username) {
    return (data.users || []).find(function(u) {
        return u.username === username && u.enabled !== false;
    }) || null;
}

export function findUserById(data, userId) {
    return (data.users || []).find(function(u) { return u.id === userId; }) || null;
}

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
    return Array.from(perms);
}

export function hasPermission(userPerms, permission) {
    if (!permission) return true;
    if (userPerms.includes('*')) return true;
    if (userPerms.includes(permission)) return true;
    var parts = permission.split(':');
    while (parts.length > 1) {
        parts.pop();
        if (userPerms.includes(parts.join(':') + ':*')) return true;
    }
    return false;
}

export function authenticateUser(data, username, password) {
    var user = findUserByUsername(data, username);
    if (!user) return null;
    if (!verifyPassword(password, user)) return null;
    return user;
}

export function getVisibleMenus(data, userPerms) {
    return (data.menus || [])
        .filter(function(menu) { return menu.enabled !== false; })
        .filter(function(menu) { return hasPermission(userPerms, menu.permission); })
        .sort(function(a, b) { return (a.sort || 0) - (b.sort || 0); });
}

export function canAccessService(userPerms, serviceId) {
    return hasPermission(userPerms, servicePermissionId(serviceId));
}

export function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        roleIds: user.roleIds || [],
        enabled: user.enabled !== false,
        createdAt: user.createdAt || null
    };
}

export function sanitizeRbac(data) {
    return {
        users: (data.users || []).map(publicUser),
        roles: (data.roles || []).map(function(role) {
            return {
                id: role.id,
                name: role.name,
                description: role.description || '',
                permissions: role.permissions || []
            };
        }),
        menus: (data.menus || []).map(function(menu) {
            return Object.assign({}, menu);
        }),
        permissions: data.permissions || []
    };
}

export function upsertUser(data, payload) {
    if (!payload.username) throw new Error('用户名不能为空');
    var existing = (data.users || []).find(function(u) {
        return u.username === payload.username && u.id !== payload.id;
    });
    if (existing) throw new Error('用户名已存在');

    if (payload.id) {
        var user = findUserById(data, payload.id);
        if (!user) throw new Error('用户不存在');
        user.username = payload.username;
        user.roleIds = payload.roleIds || [];
        user.enabled = payload.enabled !== false;
        if (payload.password) {
            var pwd = createPasswordRecord(payload.password);
            user.salt = pwd.salt;
            user.passwordHash = pwd.passwordHash;
        }
        return user;
    }

    if (!payload.password) throw new Error('新建用户需要密码');
    var created = Object.assign({
        id: newId('usr'),
        createdAt: new Date().toISOString(),
        enabled: true,
        roleIds: ['role_user']
    }, payload);
    var record = createPasswordRecord(payload.password);
    created.salt = record.salt;
    created.passwordHash = record.passwordHash;
    delete created.password;
    data.users.push(created);
    return created;
}

export function deleteUser(data, userId) {
    if (userId === 'usr_admin') throw new Error('不能删除内置管理员');
    var idx = (data.users || []).findIndex(function(u) { return u.id === userId; });
    if (idx < 0) throw new Error('用户不存在');
    data.users.splice(idx, 1);
}

export function upsertRole(data, payload) {
    if (!payload.name) throw new Error('角色名不能为空');
    if (payload.id) {
        var role = (data.roles || []).find(function(r) { return r.id === payload.id; });
        if (!role) throw new Error('角色不存在');
        if (role.id === 'role_admin' && !(payload.permissions || []).includes('*')) {
            throw new Error('管理员角色必须保留全部权限');
        }
        role.name = payload.name;
        role.description = payload.description || '';
        role.permissions = payload.permissions || [];
        return role;
    }
    var created = {
        id: newId('role'),
        name: payload.name,
        description: payload.description || '',
        permissions: payload.permissions || []
    };
    data.roles.push(created);
    return created;
}

export function deleteRole(data, roleId) {
    if (roleId === 'role_admin' || roleId === 'role_user') {
        throw new Error('不能删除内置角色');
    }
    if ((data.users || []).some(function(u) { return (u.roleIds || []).includes(roleId); })) {
        throw new Error('仍有用户使用该角色');
    }
    data.roles = (data.roles || []).filter(function(r) { return r.id !== roleId; });
}

export function updateMenus(data, menus) {
    data.menus = (menus || []).map(function(menu, index) {
        return Object.assign({}, menu, { sort: menu.sort != null ? menu.sort : (index + 1) * 10 });
    });
}

export { SYSTEM_PERMISSIONS, servicePermissionId, newId };
