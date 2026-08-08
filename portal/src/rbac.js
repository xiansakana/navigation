import crypto from 'node:crypto';
import { getDatabase } from '../../shared/db/index.js';
import { loadRbacBlob, saveRbacBlob } from '../../shared/db/rbac-store.js';

var rbacCache = null;
var rbacCacheConfigKey = null;

function configServicesKey(config) {
    return JSON.stringify((config.services || []).map(function(s) { return s.id; }));
}

var STOCK_MANAGE_SERVICE_ID = 'stock-manage';

var STOCK_MANAGE_HOLDINGS_COLUMNS = [
    { key: 'type', name: '类型' },
    { key: 'symbol', name: '代码' },
    { key: 'shares', name: '股数' },
    { key: 'cost', name: '成本' },
    { key: 'price', name: '现价' },
    { key: 'pnl', name: '盈亏' },
    { key: 'pnlPct', name: '盈亏比例' },
    { key: 'dailyPnl', name: '当日盈亏' },
    { key: 'dailyPnlPct', name: '当日盈亏比例' },
    { key: 'position', name: '持仓' },
    { key: 'weight', name: '仓位 / 占比' },
    { key: 'target', name: '1y目标价' },
    { key: 'optinfo', name: '期权信息' },
    { key: 'signal', name: '打分' },
    { key: 'actions', name: '操作' }
];

var STOCK_MANAGE_FEATURES = [
    { feature: 'dashboard', name: '显示看板', action: 'view' },
    { feature: 'pnl', name: '查询盈亏', action: 'view' },
    { feature: 'pnl-toggle', name: '盈亏显隐', action: 'view' },
    { feature: 'trades', name: '交易记录', action: 'view' },
    { feature: 'columns', name: '列数据显隐控制', action: 'view' },
    { feature: 'export', name: '导出交易', action: 'view' },
    { feature: 'import', name: '导入交易', action: 'edit' },
    { feature: 'trade', name: '记一笔', action: 'edit' },
    { feature: 'refresh', name: '刷新价格', action: 'edit' },
    { feature: 'cash', name: '编辑现金', action: 'edit' },
    { feature: 'meta', name: '编辑目标价/打分', action: 'edit' },
    { feature: 'row-trade', name: '行内买卖/记录', action: 'edit' }
].concat(STOCK_MANAGE_HOLDINGS_COLUMNS.map(function(col) {
    return {
        feature: 'col-' + col.key,
        name: col.name,
        action: 'view',
        featureGroup: 'holdings-field',
        columnKey: col.key
    };
}));

function stockManageFeaturePermissionId(feature, action) {
    return 'service:' + STOCK_MANAGE_SERVICE_ID + ':' + feature + ':' + action;
}

function buildStockManagePermissions() {
    return STOCK_MANAGE_FEATURES.map(function(item) {
        return {
            id: stockManageFeaturePermissionId(item.feature, item.action),
            name: item.featureGroup === 'holdings-field' ? ('字段·' + item.name) : item.name,
            group: '股票管理',
            serviceId: STOCK_MANAGE_SERVICE_ID,
            feature: item.feature,
            action: item.action,
            featureGroup: item.featureGroup || null,
            columnKey: item.columnKey || null
        };
    });
}

var SYSTEM_PERMISSIONS = [
    { id: 'admin:access:view', name: '查看管理后台', group: '系统', action: 'view', resource: 'admin:access' },
    { id: 'admin:access:edit', name: '编辑管理后台', group: '系统', action: 'edit', resource: 'admin:access' },
    { id: 'admin:users:view', name: '查看用户', group: '系统', action: 'view', resource: 'admin:users' },
    { id: 'admin:users:edit', name: '编辑用户', group: '系统', action: 'edit', resource: 'admin:users' },
    { id: 'admin:roles:view', name: '查看角色', group: '系统', action: 'view', resource: 'admin:roles' },
    { id: 'admin:roles:edit', name: '编辑角色', group: '系统', action: 'edit', resource: 'admin:roles' },
    { id: 'admin:menus:view', name: '查看菜单', group: '系统', action: 'view', resource: 'admin:menus' },
    { id: 'admin:menus:edit', name: '编辑菜单', group: '系统', action: 'edit', resource: 'admin:menus' }
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

function serviceViewPermissionId(serviceId) {
    return 'service:' + serviceId + ':view';
}

function serviceEditPermissionId(serviceId) {
    return 'service:' + serviceId + ':edit';
}

function buildServicePermissions(services) {
    return (services || []).flatMap(function(service) {
        var title = service.title || service.id;
        return [
            {
                id: serviceViewPermissionId(service.id),
                name: '查看「' + title + '」',
                group: '服务',
                serviceId: service.id,
                action: 'view'
            },
            {
                id: serviceEditPermissionId(service.id),
                name: '编辑「' + title + '」',
                group: '服务',
                serviceId: service.id,
                action: 'edit'
            }
        ];
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

function buildDefaultGuestPermissions(services) {
    var perms = new Set([
        'service:torn-toolbox:view',
        'service:torn-undercut:view',
        'service:torn-company:view',
        'service:stock-manage:view',
        'service:notes:view'
    ]);
    (services || []).forEach(function(service) {
        if (!service.hidden && service.id && service.id !== 'siyuan-share') {
            perms.add(serviceViewPermissionId(service.id));
        }
    });
    buildStockManagePermissions().forEach(function(item) {
        if (item.action === 'view') perms.add(item.id);
    });
    return Array.from(perms);
}

function ensureGuestAccess(data, config) {
    if (!data.roles) data.roles = [];
    if (!data.users) data.users = [];
    var guestUsername = config?.auth?.guestUsername || 'guest';
    var denyGuest = ['service:napcat:view', 'service:napcat:edit'];

    var guestRole = data.roles.find(function(r) { return r.id === 'role_guest'; });
    if (!guestRole) {
        var guestPerms = buildDefaultGuestPermissions(config?.services);
        var initial = new Set(guestPerms);
        denyGuest.forEach(function(p) { initial.delete(p); });
        guestRole = {
            id: 'role_guest',
            name: '游客',
            description: '未登录访客的默认权限',
            permissions: Array.from(initial)
        };
        data.roles.push(guestRole);
    }

    var guestUser = data.users.find(function(u) { return u.username === guestUsername; });
    if (!guestUser) {
        data.users.push({
            id: 'usr_guest',
            username: guestUsername,
            roleIds: ['role_guest'],
            enabled: true,
            createdAt: new Date().toISOString()
        });
    } else {
        guestUser.enabled = true;
        if (!(guestUser.roleIds || []).includes('role_guest')) {
            guestUser.roleIds = ['role_guest'];
        }
    }
}

function normalizeMenuPermission(menu) {
    if (!menu) return menu;
    if (menu.serviceId) {
        menu.permission = serviceViewPermissionId(menu.serviceId);
        return menu;
    }
    if (menu.id === 'menu_admin' || menu.path === '/admin.html') {
        menu.permission = 'admin:access:view';
        return menu;
    }
    if (menu.permission === 'admin:access') {
        menu.permission = 'admin:access:view';
        return menu;
    }
    var legacyService = /^service:([^:]+)$/.exec(menu.permission || '');
    if (legacyService) {
        menu.permission = serviceViewPermissionId(legacyService[1]);
    }
    return menu;
}

function mergeServiceMenu(base, override) {
    var menu = Object.assign({}, base, override || {});
    menu.title = base.title;
    menu.description = base.description;
    menu.icon = base.icon;
    menu.type = base.type;
    menu.serviceId = base.serviceId;
    menu.permission = base.permission;
    if (base.path) {
        menu.path = base.path;
        delete menu.url;
    } else if (base.url) {
        menu.url = base.url;
        delete menu.path;
    }
    if (override) {
        if (override.sort != null) menu.sort = override.sort;
        if (override.enabled != null) menu.enabled = override.enabled;
    }
    return normalizeMenuPermission(menu);
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
                permission: serviceViewPermissionId(service.id),
                sort: (index + 1) * 10,
                enabled: true
            };
            if (service.type === 'external') base.url = service.url;
            else base.path = service.path;
            return mergeServiceMenu(base, overrideMap[id]);
        });
    var adminMenu = normalizeMenuPermission(Object.assign({
        id: 'menu_admin',
        title: '权限管理',
        description: '用户、角色、菜单与权限配置',
        icon: '🔐',
        path: '/admin.html',
        permission: 'admin:access:view',
        sort: 9990,
        enabled: true
    }, overrideMap.menu_admin || {}));
    menus.push(adminMenu);
    return menus.sort(function(a, b) { return (a.sort || 0) - (b.sort || 0); });
}

function createDefaultRbac(config) {
    var servicePerms = buildServicePermissions(config.services);
    var stockManagePerms = buildStockManagePermissions();
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
        permissions: SYSTEM_PERMISSIONS.concat(servicePerms).concat(stockManagePerms),
        userPrefs: {}
    };
    ensureGuestAccess(created, config);
    return created;
}

export function loadRbac(config) {
    var key = configServicesKey(config);
    if (rbacCache && rbacCacheConfigKey === key) {
        return rbacCache;
    }
    var db = getDatabase();
    var data = loadRbacBlob(db);
    if (!data) {
        data = createDefaultRbac(config);
        saveRbac(data);
        rbacCache = data;
        rbacCacheConfigKey = key;
        return data;
    }
    data = syncRbacPermissions(data, config);
    rbacCache = data;
    rbacCacheConfigKey = key;
    return data;
}

export function saveRbac(data) {
    var db = getDatabase();
    saveRbacBlob(db, data);
    rbacCache = data;
}

function migrateRolePermissions(permissions) {
    if ((permissions || []).includes('*')) return ['*'];
    var out = new Set(permissions || []);
    var legacyMap = {
        'admin:access': ['admin:access:view', 'admin:access:edit'],
        'admin:users': ['admin:users:view', 'admin:users:edit'],
        'admin:roles': ['admin:roles:view', 'admin:roles:edit'],
        'admin:menus': ['admin:menus:view', 'admin:menus:edit']
    };
    (permissions || []).forEach(function(p) {
        if (legacyMap[p]) legacyMap[p].forEach(function(id) { out.add(id); });
        var serviceMatch = /^service:([^:]+)$/.exec(p);
        if (serviceMatch && !p.endsWith(':view') && !p.endsWith(':edit')) {
            out.add('service:' + serviceMatch[1] + ':view');
            out.add('service:' + serviceMatch[1] + ':edit');
        }
    });
    return Array.from(out);
}

export function syncRbacPermissions(data, config) {
    var before = JSON.stringify(data);
    var servicePerms = buildServicePermissions(config.services);
    var stockManagePerms = buildStockManagePermissions();
    var known = {};
    SYSTEM_PERMISSIONS.concat(servicePerms).concat(stockManagePerms).forEach(function(p) { known[p.id] = p; });
    (data.permissions || []).forEach(function(p) {
        if (!known[p.id]) known[p.id] = p;
    });
    data.permissions = Object.keys(known).map(function(id) { return known[id]; });
    data.permissions = data.permissions.filter(function(p) {
        if (p.id === 'admin:access' || p.id === 'admin:users' || p.id === 'admin:roles' || p.id === 'admin:menus') {
            return false;
        }
        return !/^service:[^:]+$/.test(p.id);
    });

    (data.roles || []).forEach(function(role) {
        role.permissions = migrateRolePermissions(role.permissions || []);
    });

    var overrideMap = {};
    (data.menus || []).forEach(function(menu) { overrideMap[menu.id] = menu; });
    data.menus = buildMenusFromServices(config.services, Object.values(overrideMap));

    var adminRole = (data.roles || []).find(function(r) { return r.id === 'role_admin'; });
    if (adminRole && adminRole.permissions.includes('*')) {
        data.permissions.forEach(function(p) {
            if (!adminRole.permissions.includes(p.id)) adminRole.permissions.push(p.id);
        });
    }
    if (!data.userPrefs) data.userPrefs = {};
    ensureGuestAccess(data, config);
    if (JSON.stringify(data) !== before) {
        saveRbac(data);
    }
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

export function canViewAdmin(userPerms) {
    return hasPermission(userPerms, 'admin:access:view');
}

export function canEditAdminResource(userPerms, resource) {
    return hasPermission(userPerms, resource + ':edit');
}

export function canViewAdminResource(userPerms, resource) {
    return hasPermission(userPerms, resource + ':view') || canEditAdminResource(userPerms, resource);
}

export function authenticateUser(data, username, password) {
    var user = findUserByUsername(data, username);
    if (!user) return null;
    if (!user.passwordHash || !user.salt) return null;
    if (!verifyPassword(password, user)) return null;
    return user;
}

export function getVisibleMenus(data, userPerms) {
    return (data.menus || [])
        .filter(function(menu) { return menu.enabled !== false; })
        .filter(function(menu) { return hasPermission(userPerms, menu.permission); })
        .sort(function(a, b) { return (a.sort || 0) - (b.sort || 0); });
}

export function canViewService(userPerms, serviceId) {
    return hasPermission(userPerms, serviceViewPermissionId(serviceId));
}

export function canEditService(userPerms, serviceId) {
    return hasPermission(userPerms, serviceEditPermissionId(serviceId));
}

export function hasStockManageFeature(userPerms, feature, action) {
    if (!feature) return true;
    if ((userPerms || []).includes('*')) return true;
    var fid = stockManageFeaturePermissionId(feature, action);
    if (userPerms.includes(fid)) return true;
    if (action === 'view') {
        if (userPerms.includes(stockManageFeaturePermissionId(feature, 'edit'))) return true;
    }
    return false;
}

export function getStockManagePrefs(data, userId) {
    var raw = ((data.userPrefs || {})[userId] || {}).stockManage || {};
    return {
        dashboardVisible: raw.dashboardVisible !== false,
        colVis: raw.colVis && typeof raw.colVis === 'object' ? raw.colVis : null,
        pnlVisible: raw.pnlVisible !== false
    };
}

export function updateUserPrefs(data, userId, patch) {
    if (!userId) throw new Error('无效用户');
    if (!data.userPrefs) data.userPrefs = {};
    var current = data.userPrefs[userId] || {};
    var next = Object.assign({}, current);
    Object.keys(patch || {}).forEach(function(key) {
        if (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key])) {
            next[key] = Object.assign({}, current[key] || {}, patch[key]);
        } else {
            next[key] = patch[key];
        }
    });
    data.userPrefs[userId] = next;
    saveRbac(data);
    return next;
}

/** @deprecated use canViewService */
export function canAccessService(userPerms, serviceId) {
    return canViewService(userPerms, serviceId);
}

export function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        roleIds: user.roleIds || [],
        enabled: user.enabled !== false,
        createdAt: user.createdAt || null,
        oauthProviders: Object.keys(user.oauth || {})
    };
}

export function findUserByOAuth(data, provider, providerId) {
    return (data.users || []).find(function(user) {
        var link = (user.oauth || {})[provider];
        return link && String(link.id) === String(providerId);
    }) || null;
}

export function upsertOAuthUser(data, payload) {
    var provider = payload.provider;
    var providerId = String(payload.providerId || '');
    if (!provider || !providerId) throw new Error('OAuth 用户信息不完整');

    var existing = findUserByOAuth(data, provider, providerId);
    if (existing) {
        existing.oauth = existing.oauth || {};
        existing.oauth[provider] = {
            id: providerId,
            login: payload.login || null,
            email: payload.email || null,
            name: payload.name || null
        };
        if (payload.email) existing.email = payload.email;
        existing.enabled = true;
        return existing;
    }

    var username = payload.username || (provider + ':' + providerId);
    if (findUserByUsername(data, username)) {
        username = provider + ':' + providerId;
    }

    var user = {
        id: newId('usr'),
        username: username,
        roleIds: [payload.defaultRoleId || 'role_guest'],
        enabled: true,
        createdAt: new Date().toISOString(),
        oauth: {}
    };
    user.oauth[provider] = {
        id: providerId,
        login: payload.login || null,
        email: payload.email || null,
        name: payload.name || null
    };
    if (payload.email) user.email = payload.email;
    if (!data.users) data.users = [];
    data.users.push(user);
    return user;
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

export {
    SYSTEM_PERMISSIONS,
    STOCK_MANAGE_FEATURES,
    serviceViewPermissionId,
    serviceEditPermissionId,
    stockManageFeaturePermissionId,
    newId
};
