var state = { rbac: null, me: null };

async function api(path, options) {
    var resp = await fetch('/api/' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
    if (resp.status === 401) {
        location.href = '/login.html';
        throw new Error('未登录');
    }
    var data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
    return data;
}

function esc(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function roleName(roleId) {
    var role = (state.rbac.roles || []).find(function(r) { return r.id === roleId; });
    return role ? role.name : roleId;
}

function permName(permId) {
    var perm = (state.rbac.permissions || []).find(function(p) { return p.id === permId; });
    return perm ? perm.name : permId;
}

function canEdit(resource) {
    return !!(state.me && state.me.canEdit && state.me.canEdit[resource]);
}

function permResourceTitle(perm) {
    if (!perm) return '';
    return String(perm.name || '')
        .replace(/^查看[「"]?/, '')
        .replace(/^编辑[「"]?/, '')
        .replace(/[」"]?$/, '')
        .trim() || perm.name;
}

function buildPermissionTree() {
    var menus = (state.rbac.menus || []).filter(function(m) { return m.id !== 'menu_admin'; });
    var systemMap = {};
    var serviceMap = {};

    (state.rbac.permissions || []).forEach(function(perm) {
        if (perm.feature && perm.serviceId) {
            if (!serviceMap[perm.serviceId]) {
                serviceMap[perm.serviceId] = { serviceId: perm.serviceId, view: null, edit: null, features: [] };
            }
            serviceMap[perm.serviceId].features.push(perm);
            return;
        }
        if (perm.serviceId) {
            if (!serviceMap[perm.serviceId]) {
                serviceMap[perm.serviceId] = { serviceId: perm.serviceId, view: null, edit: null, features: [] };
            }
            if (perm.action === 'view') serviceMap[perm.serviceId].view = perm;
            if (perm.action === 'edit') serviceMap[perm.serviceId].edit = perm;
            return;
        }
        var key = perm.resource || perm.id.replace(/:(view|edit)$/, '');
        if (!systemMap[key]) {
            systemMap[key] = { kind: 'resource', title: permResourceTitle(perm), view: null, edit: null };
        }
        if (perm.action === 'view') {
            systemMap[key].view = perm;
            systemMap[key].title = permResourceTitle(perm);
        }
        if (perm.action === 'edit') {
            systemMap[key].edit = perm;
            if (!systemMap[key].title) systemMap[key].title = permResourceTitle(perm);
        }
    });

    var systemNodes = Object.keys(systemMap).map(function(k) { return systemMap[k]; });
    var serviceNodes = [];
    var seen = {};

    menus.slice().sort(function(a, b) { return (a.sort || 0) - (b.sort || 0); }).forEach(function(menu) {
        if (!menu.serviceId || !serviceMap[menu.serviceId]) return;
        seen[menu.serviceId] = true;
        var s = serviceMap[menu.serviceId];
        serviceNodes.push({
            kind: 'service',
            serviceId: menu.serviceId,
            menu: menu,
            title: menu.title || permResourceTitle(s.view || { name: menu.serviceId }),
            icon: menu.icon || '📦',
            path: menu.path || menu.url || '',
            enabled: menu.enabled !== false,
            view: s.view,
            edit: s.edit,
            features: sortFeaturePerms(s.features || [])
        });
    });

    Object.keys(serviceMap).forEach(function(serviceId) {
        if (seen[serviceId]) return;
        var s = serviceMap[serviceId];
        serviceNodes.push({
            kind: 'service',
            serviceId: serviceId,
            menu: null,
            title: permResourceTitle(s.view || { name: serviceId }),
            icon: '📦',
            path: '',
            enabled: true,
            view: s.view,
            edit: s.edit,
            features: sortFeaturePerms(s.features || [])
        });
    });

    return [
        { kind: 'group', title: '系统', children: systemNodes },
        { kind: 'group', title: '服务菜单与功能', children: serviceNodes }
    ];
}

function sortFeaturePerms(features) {
    return features.slice().sort(function(a, b) {
        var actionOrder = { view: 0, edit: 1 };
        var diff = (actionOrder[a.action] || 0) - (actionOrder[b.action] || 0);
        if (diff) return diff;
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
}

function renderPermActionCell(perm, mode, rolePerms, isAdminRole) {
    if (!perm) return '<span class="sm-muted">—</span>';
    if (mode === 'readonly') {
        return '<code class="admin-perm-code">' + esc(perm.id) + '</code>';
    }
    var checked = isAdminRole || rolePerms.includes('*') || rolePerms.includes(perm.id);
    return '<label class="admin-check admin-check--inline">'
        + '<input type="checkbox" name="perm" value="' + esc(perm.id) + '" ' + (checked ? 'checked' : '') + (isAdminRole ? ' disabled' : '') + '>'
        + '<span>允许</span></label>';
}

function renderResourceRow(node, mode, rolePerms, isAdminRole) {
    if (mode === 'readonly') {
        return '<div class="admin-perm-tree-row admin-perm-tree-row--resource">'
            + '<span class="admin-perm-tree-label">' + esc(node.title) + '</span>'
            + '<span class="admin-perm-tree-cols">'
            + '<span class="admin-perm-tree-col">' + renderPermActionCell(node.view, mode, rolePerms, isAdminRole) + '</span>'
            + '<span class="admin-perm-tree-col">' + renderPermActionCell(node.edit, mode, rolePerms, isAdminRole) + '</span>'
            + '</span></div>';
    }
    return '<div class="admin-perm-tree-row admin-perm-tree-row--resource">'
        + '<span class="admin-perm-tree-label">' + esc(node.title) + '</span>'
        + '<span class="admin-perm-tree-cols">'
        + (node.view ? '<label class="admin-check admin-check--inline"><input type="checkbox" name="perm" value="' + esc(node.view.id) + '" '
            + ((isAdminRole || rolePerms.includes('*') || rolePerms.includes(node.view.id)) ? 'checked' : '') + (isAdminRole ? ' disabled' : '') + '><span>查看</span></label>' : '<span class="sm-muted">—</span>')
        + (node.edit ? '<label class="admin-check admin-check--inline"><input type="checkbox" name="perm" value="' + esc(node.edit.id) + '" '
            + ((isAdminRole || rolePerms.includes('*') || rolePerms.includes(node.edit.id)) ? 'checked' : '') + (isAdminRole ? ' disabled' : '') + '><span>编辑</span></label>' : '<span class="sm-muted">—</span>')
        + '</span></div>';
}

function renderFeatureRow(perm, mode, rolePerms, isAdminRole) {
    var badge = perm.action === 'edit' ? '编辑' : '查看';
    return '<div class="admin-perm-tree-row admin-perm-tree-row--feature">'
        + '<span class="admin-perm-tree-label">' + esc(perm.name) + '<span class="admin-perm-badge">' + badge + '</span></span>'
        + '<span class="admin-perm-tree-cols">'
        + renderPermActionCell(perm, mode, rolePerms, isAdminRole)
        + '</span></div>';
}

function renderServiceNode(node, mode, rolePerms, isAdminRole) {
    var hasChildren = !!(node.view || node.edit || (node.features && node.features.length));
    var meta = [];
    if (node.path) meta.push(esc(node.path));
    if (node.menu && node.enabled === false) meta.push('已禁用');
    var html = '<li class="admin-perm-tree-item admin-perm-tree-item--service">'
        + '<div class="admin-perm-tree-node">'
        + (hasChildren
            ? '<button type="button" class="admin-perm-tree-toggle" aria-expanded="true" aria-label="展开/收起">▾</button>'
            : '<span class="admin-perm-tree-toggle admin-perm-tree-toggle--spacer"></span>')
        + '<span class="admin-perm-tree-icon">' + esc(node.icon) + '</span>'
        + '<span class="admin-perm-tree-label admin-perm-tree-label--strong">' + esc(node.title) + '</span>'
        + (meta.length ? '<span class="admin-perm-tree-meta">' + meta.join(' · ') + '</span>' : '')
        + '</div>';
    if (!hasChildren) return html + '</li>';

    html += '<div class="admin-perm-tree-children">';
    if (node.view || node.edit) {
        html += '<div class="admin-perm-tree-section-label">菜单访问</div>';
        html += renderResourceRow({
            title: '进入服务 / 首页卡片',
            view: node.view,
            edit: node.edit
        }, mode, rolePerms, isAdminRole);
    }
    if (node.features && node.features.length) {
        html += '<div class="admin-perm-tree-section-label">页面按钮与功能</div>';
        node.features.forEach(function(perm) {
            html += renderFeatureRow(perm, mode, rolePerms, isAdminRole);
        });
    }
    html += '</div></li>';
    return html;
}

function renderPermissionTreeHtml(mode, role) {
    var rolePerms = role ? (role.permissions || []) : [];
    var isAdminRole = !!(role && role.id === 'role_admin');
    var tree = buildPermissionTree();
    var html = '';

    tree.forEach(function(group) {
        html += '<section class="admin-perm-tree-group">'
            + '<h3 class="admin-perm-tree-group-title">' + esc(group.title) + '</h3>';
        if (group.title === '系统') {
            html += '<div class="admin-perm-tree-head">'
                + '<span class="admin-perm-tree-label">权限项</span>'
                + '<span class="admin-perm-tree-cols">'
                + '<span class="admin-perm-tree-col">查看</span>'
                + '<span class="admin-perm-tree-col">编辑</span>'
                + '</span></div>';
            html += '<ul class="admin-perm-tree">';
            group.children.forEach(function(node) {
                html += '<li class="admin-perm-tree-item">' + renderResourceRow(node, mode, rolePerms, isAdminRole) + '</li>';
            });
            html += '</ul>';
        } else {
            html += '<div class="admin-perm-tree-head admin-perm-tree-head--service">'
                + '<span class="admin-perm-tree-label">服务 / 功能</span>'
                + '<span class="admin-perm-tree-cols">'
                + '<span class="admin-perm-tree-col">' + (mode === 'readonly' ? '权限 ID' : '授权') + '</span>'
                + '</span></div>';
            html += '<ul class="admin-perm-tree">';
            group.children.forEach(function(node) {
                html += renderServiceNode(node, mode, rolePerms, isAdminRole);
            });
            html += '</ul>';
        }
        html += '</section>';
    });
    return html;
}

function bindPermissionTree(root) {
    root.querySelectorAll('.admin-perm-tree-toggle').forEach(function(btn) {
        if (btn.classList.contains('admin-perm-tree-toggle--spacer')) return;
        btn.addEventListener('click', function() {
            var item = btn.closest('.admin-perm-tree-item--service');
            var children = item && item.querySelector('.admin-perm-tree-children');
            if (!children) return;
            var open = children.classList.toggle('collapsed');
            btn.setAttribute('aria-expanded', open ? 'false' : 'true');
            btn.textContent = open ? '▸' : '▾';
        });
    });
}

function applyEditMode() {
    document.getElementById('btn-add-user').hidden = !canEdit('users');
    document.getElementById('btn-add-role').hidden = !canEdit('roles');
    document.getElementById('btn-save-menus').hidden = !canEdit('menus');
    document.querySelectorAll('.menu-sort, .menu-icon, .menu-title, .menu-enabled').forEach(function(el) {
        el.disabled = !canEdit('menus');
    });
}

function switchTab(name) {
    document.querySelectorAll('.admin-tab').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.tab === name);
    });
    document.querySelectorAll('.admin-panel').forEach(function(panel) {
        panel.classList.toggle('active', panel.id === 'panel-' + name);
    });
}

function renderUsers() {
    var tbody = document.querySelector('#users-table tbody');
    tbody.innerHTML = '';
    (state.rbac.users || []).forEach(function(user) {
        var tr = document.createElement('tr');
        var roles = (user.roleIds || []).map(roleName).join('、') || '—';
        var actions = canEdit('users')
            ? '<button type="button" class="btn ghost sm-btn" data-edit-user="' + esc(user.id) + '">编辑</button>'
                + (user.id === 'usr_admin' ? '' : '<button type="button" class="btn ghost sm-btn danger" data-del-user="' + esc(user.id) + '">删除</button>')
            : '<span class="sm-muted">只读</span>';
        tr.innerHTML = '<td>' + esc(user.username) + '</td>'
            + '<td>' + esc(roles) + '</td>'
            + '<td><span class="admin-badge ' + (user.enabled ? 'on' : 'off') + '">' + (user.enabled ? '启用' : '禁用') + '</span></td>'
            + '<td class="admin-actions">' + actions + '</td>';
        tbody.appendChild(tr);
    });
}

function renderRoles() {
    var root = document.getElementById('roles-list');
    root.innerHTML = '';
    (state.rbac.roles || []).forEach(function(role) {
        var card = document.createElement('article');
        card.className = 'admin-role-card';
        var perms = (role.permissions || []).slice(0, 10).map(function(id) {
            return id === '*' ? '全部权限' : permName(id);
        }).join(' · ');
        if ((role.permissions || []).length > 10) perms += ' …';
        var actions = canEdit('roles')
            ? '<button type="button" class="btn ghost sm-btn" data-edit-role="' + esc(role.id) + '">编辑</button>'
                + ((role.id === 'role_admin' || role.id === 'role_user') ? '' : '<button type="button" class="btn ghost sm-btn danger" data-del-role="' + esc(role.id) + '">删除</button>')
            : '<span class="sm-muted">只读</span>';
        card.innerHTML = '<div class="admin-role-head">'
            + '<h3>' + esc(role.name) + '</h3>'
            + '<div class="admin-actions">' + actions + '</div></div>'
            + '<p>' + esc(role.description || '') + '</p>'
            + '<div class="admin-role-perms">' + esc(perms || '无权限') + '</div>';
        root.appendChild(card);
    });
}

function renderMenus() {
    var tbody = document.querySelector('#menus-table tbody');
    tbody.innerHTML = '';
    (state.rbac.menus || []).forEach(function(menu, index) {
        var tr = document.createElement('tr');
        var disabled = canEdit('menus') ? '' : ' disabled';
        tr.innerHTML = '<td><input type="number" class="admin-input-sm menu-sort" data-id="' + esc(menu.id) + '" value="' + esc(menu.sort != null ? menu.sort : (index + 1) * 10) + '"' + disabled + '></td>'
            + '<td><input type="text" class="admin-input-sm menu-icon" data-id="' + esc(menu.id) + '" value="' + esc(menu.icon || '') + '"' + disabled + '></td>'
            + '<td><input type="text" class="admin-input-md menu-title" data-id="' + esc(menu.id) + '" value="' + esc(menu.title || '') + '"' + disabled + '></td>'
            + '<td><code>' + esc(menu.permission || '') + '</code></td>'
            + '<td><input type="checkbox" class="menu-enabled" data-id="' + esc(menu.id) + '" ' + (menu.enabled !== false ? 'checked' : '') + disabled + '></td>';
        tbody.appendChild(tr);
    });
}

function renderPermissions() {
    var root = document.getElementById('permissions-list');
    root.innerHTML = renderPermissionTreeHtml('readonly');
    bindPermissionTree(root);
}

function openUserDialog(user) {
    if (!canEdit('users')) return;
    document.getElementById('user-dialog-title').textContent = user ? '编辑用户' : '新建用户';
    document.getElementById('user-id').value = user ? user.id : '';
    document.getElementById('user-username').value = user ? user.username : '';
    document.getElementById('user-password').value = '';
    document.getElementById('user-password').required = !user;
    document.getElementById('user-enabled').checked = user ? user.enabled !== false : true;
    var rolesBox = document.getElementById('user-roles');
    rolesBox.innerHTML = '<legend>角色</legend>';
    (state.rbac.roles || []).forEach(function(role) {
        var label = document.createElement('label');
        label.className = 'admin-check';
        label.innerHTML = '<input type="checkbox" name="role" value="' + esc(role.id) + '" '
            + ((user && (user.roleIds || []).includes(role.id)) || (!user && role.id === 'role_user') ? 'checked' : '') + '> '
            + esc(role.name);
        rolesBox.appendChild(label);
    });
    document.getElementById('user-dialog').showModal();
}

function openRoleDialog(role) {
    if (!canEdit('roles')) return;
    document.getElementById('role-dialog-title').textContent = role ? '编辑角色' : '新建角色';
    document.getElementById('role-id').value = role ? role.id : '';
    document.getElementById('role-name').value = role ? role.name : '';
    document.getElementById('role-desc').value = role ? (role.description || '') : '';
    var box = document.getElementById('role-permissions');
    box.innerHTML = '<legend>权限树（菜单访问 + 页面功能）</legend>'
        + renderPermissionTreeHtml('edit', role);
    bindPermissionTree(box);
    document.getElementById('role-dialog').showModal();
}

function collectMenusFromTable() {
    return (state.rbac.menus || []).map(function(menu) {
        var sortEl = document.querySelector('.menu-sort[data-id="' + menu.id + '"]');
        var iconEl = document.querySelector('.menu-icon[data-id="' + menu.id + '"]');
        var titleEl = document.querySelector('.menu-title[data-id="' + menu.id + '"]');
        var enabledEl = document.querySelector('.menu-enabled[data-id="' + menu.id + '"]');
        return Object.assign({}, menu, {
            sort: sortEl ? Number(sortEl.value) : menu.sort,
            icon: iconEl ? iconEl.value.trim() : menu.icon,
            title: titleEl ? titleEl.value.trim() : menu.title,
            enabled: enabledEl ? enabledEl.checked : menu.enabled
        });
    });
}

async function reload() {
    var data = await api('admin/rbac');
    state.rbac = data.rbac;
    state.me = data.me;
    renderUsers();
    renderRoles();
    renderMenus();
    renderPermissions();
    applyEditMode();
}

document.querySelectorAll('.admin-dialog').forEach(function(dialog) {
    dialog.addEventListener('click', function(e) {
        if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('cancel', function(e) {
        e.preventDefault();
        dialog.close();
    });
});

document.querySelectorAll('.admin-tab').forEach(function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
});

document.getElementById('btn-add-user').addEventListener('click', function() { openUserDialog(null); });
document.getElementById('btn-add-role').addEventListener('click', function() { openRoleDialog(null); });
document.getElementById('user-cancel').addEventListener('click', function() { document.getElementById('user-dialog').close(); });
document.getElementById('role-cancel').addEventListener('click', function() { document.getElementById('role-dialog').close(); });

document.getElementById('user-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var roleIds = Array.from(document.querySelectorAll('#user-roles input[name="role"]:checked')).map(function(el) { return el.value; });
    var payload = {
        id: document.getElementById('user-id').value || undefined,
        username: document.getElementById('user-username').value.trim(),
        password: document.getElementById('user-password').value,
        roleIds: roleIds,
        enabled: document.getElementById('user-enabled').checked
    };
    if (!payload.id && !payload.password) {
        window.portalToast?.error('请填写密码');
        return;
    }
    if (payload.id && !payload.password) delete payload.password;
    try {
        await api('admin/users', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('user-dialog').close();
        window.portalToast?.success('用户已保存');
        await reload();
    } catch (err) {
        window.portalToast?.error(err.message);
    }
});

document.getElementById('role-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var permissions = Array.from(document.querySelectorAll('#role-permissions input[name="perm"]:checked')).map(function(el) { return el.value; });
    var payload = {
        id: document.getElementById('role-id').value || undefined,
        name: document.getElementById('role-name').value.trim(),
        description: document.getElementById('role-desc').value.trim(),
        permissions: permissions
    };
    if (payload.id === 'role_admin') payload.permissions = ['*'];
    try {
        await api('admin/roles', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('role-dialog').close();
        window.portalToast?.success('角色已保存');
        await reload();
    } catch (err) {
        window.portalToast?.error(err.message);
    }
});

document.getElementById('btn-save-menus').addEventListener('click', async function() {
    try {
        var menus = collectMenusFromTable();
        await api('admin/menus', { method: 'PUT', body: JSON.stringify({ menus: menus }) });
        window.portalToast?.success('菜单已保存');
        await reload();
    } catch (err) {
        window.portalToast?.error(err.message);
    }
});

document.body.addEventListener('click', async function(e) {
    var editUser = e.target.closest('[data-edit-user]');
    if (editUser) {
        var user = state.rbac.users.find(function(u) { return u.id === editUser.dataset.editUser; });
        openUserDialog(user);
        return;
    }
    var delUser = e.target.closest('[data-del-user]');
    if (delUser) {
        if (!await window.portalDialog.confirm('删除用户', '确定删除该用户？')) return;
        try {
            await api('admin/users/' + delUser.dataset.delUser, { method: 'DELETE' });
            window.portalToast?.success('用户已删除');
            await reload();
        } catch (err) {
            window.portalToast?.error(err.message);
        }
        return;
    }
    var editRole = e.target.closest('[data-edit-role]');
    if (editRole) {
        var role = state.rbac.roles.find(function(r) { return r.id === editRole.dataset.editRole; });
        openRoleDialog(role);
        return;
    }
    var delRole = e.target.closest('[data-del-role]');
    if (delRole) {
        if (!await window.portalDialog.confirm('删除角色', '确定删除该角色？')) return;
        try {
            await api('admin/roles/' + delRole.dataset.delRole, { method: 'DELETE' });
            window.portalToast?.success('角色已删除');
            await reload();
        } catch (err) {
            window.portalToast?.error(err.message);
        }
    }
});

api('me').then(function(data) {
    document.getElementById('welcome').textContent = '欢迎，' + data.username;
    if (!data.canAdmin) {
        location.href = '/';
        return;
    }
    return reload();
}).catch(function(err) {
    window.portalToast?.error(err.message);
});
