var state = { rbac: null, me: null };
var tableView;
var tableViewReady = import('./generated/admin-tables-view.js?v=1').then(function(mod) {
    tableView = mod.mountAdminTables({
        users: document.querySelector('#users-table tbody'),
        roles: document.getElementById('roles-list'),
        menus: document.querySelector('#menus-table tbody')
    }, { roleName: roleName, permName: permName, canEdit: canEdit });
});
var permissionTree, rolePermissionTree;
var permissionTreeReady = import('./generated/admin-permission-tree-view.js?v=1').then(function(mod) {
    permissionTree = mod.mountPermissionTree(document.getElementById('permissions-list'));
    rolePermissionTree = mod.mountPermissionTree(document.getElementById('role-permissions'), { legend: '权限树（菜单访问 + 页面功能）' });
});

async function api(path, options) {
    var resp = await fetch('/api/' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
    if (resp.status === 401) {
        location.href = '/login/';
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

async function renderTables() {
    await tableViewReady;
    tableView.update({
        users: state.rbac.users || [],
        roles: state.rbac.roles || [],
        menus: state.rbac.menus || []
    });
}

function renderPermissions() {
    permissionTreeReady.then(function() { permissionTree.render('readonly', null, state.rbac); });
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
    permissionTreeReady.then(function() { rolePermissionTree.render('edit', role, state.rbac); });
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
    await renderTables();
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
}).finally(function() { window.navigationSkeleton?.finish(); });
