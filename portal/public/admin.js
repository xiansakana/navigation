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
        tr.innerHTML = '<td>' + esc(user.username) + '</td>'
            + '<td>' + esc(roles) + '</td>'
            + '<td><span class="admin-badge ' + (user.enabled ? 'on' : 'off') + '">' + (user.enabled ? '启用' : '禁用') + '</span></td>'
            + '<td class="admin-actions">'
            + '<button type="button" class="btn ghost sm-btn" data-edit-user="' + esc(user.id) + '">编辑</button>'
            + (user.id === 'usr_admin' ? '' : '<button type="button" class="btn ghost sm-btn danger" data-del-user="' + esc(user.id) + '">删除</button>')
            + '</td>';
        tbody.appendChild(tr);
    });
}

function renderRoles() {
    var root = document.getElementById('roles-list');
    root.innerHTML = '';
    (state.rbac.roles || []).forEach(function(role) {
        var card = document.createElement('article');
        card.className = 'admin-role-card';
        var perms = (role.permissions || []).slice(0, 8).map(function(id) {
            return id === '*' ? '全部权限' : permName(id);
        }).join(' · ');
        if ((role.permissions || []).length > 8) perms += ' …';
        card.innerHTML = '<div class="admin-role-head">'
            + '<h3>' + esc(role.name) + '</h3>'
            + '<div class="admin-actions">'
            + '<button type="button" class="btn ghost sm-btn" data-edit-role="' + esc(role.id) + '">编辑</button>'
            + ((role.id === 'role_admin' || role.id === 'role_user') ? '' : '<button type="button" class="btn ghost sm-btn danger" data-del-role="' + esc(role.id) + '">删除</button>')
            + '</div></div>'
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
        tr.innerHTML = '<td><input type="number" class="admin-input-sm menu-sort" data-id="' + esc(menu.id) + '" value="' + esc(menu.sort != null ? menu.sort : (index + 1) * 10) + '"></td>'
            + '<td><input type="text" class="admin-input-sm menu-icon" data-id="' + esc(menu.id) + '" value="' + esc(menu.icon || '') + '"></td>'
            + '<td><input type="text" class="admin-input-md menu-title" data-id="' + esc(menu.id) + '" value="' + esc(menu.title || '') + '"></td>'
            + '<td><code>' + esc(menu.permission || '') + '</code></td>'
            + '<td><input type="checkbox" class="menu-enabled" data-id="' + esc(menu.id) + '" ' + (menu.enabled !== false ? 'checked' : '') + '></td>';
        tbody.appendChild(tr);
    });
}

function renderPermissions() {
    var root = document.getElementById('permissions-list');
    root.innerHTML = '';
    var groups = {};
    (state.rbac.permissions || []).forEach(function(perm) {
        var group = perm.group || '其他';
        if (!groups[group]) groups[group] = [];
        groups[group].push(perm);
    });
    Object.keys(groups).forEach(function(group) {
        var section = document.createElement('section');
        section.className = 'admin-perm-group';
        section.innerHTML = '<h3>' + esc(group) + '</h3>';
        var list = document.createElement('ul');
        groups[group].forEach(function(perm) {
            var li = document.createElement('li');
            li.innerHTML = '<code>' + esc(perm.id) + '</code><span>' + esc(perm.name) + '</span>';
            list.appendChild(li);
        });
        section.appendChild(list);
        root.appendChild(section);
    });
}

function openUserDialog(user) {
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
    document.getElementById('role-dialog-title').textContent = role ? '编辑角色' : '新建角色';
    document.getElementById('role-id').value = role ? role.id : '';
    document.getElementById('role-name').value = role ? role.name : '';
    document.getElementById('role-desc').value = role ? (role.description || '') : '';
    var box = document.getElementById('role-permissions');
    box.innerHTML = '<legend>权限</legend>';
    (state.rbac.permissions || []).forEach(function(perm) {
        var label = document.createElement('label');
        label.className = 'admin-check';
        var checked = role && ((role.permissions || []).includes(perm.id) || (role.permissions || []).includes('*'));
        label.innerHTML = '<input type="checkbox" name="perm" value="' + esc(perm.id) + '" ' + (checked ? 'checked' : '') + '> '
            + esc(perm.name) + ' <code>' + esc(perm.id) + '</code>';
        box.appendChild(label);
    });
    if (role && role.id === 'role_admin') {
        box.querySelectorAll('input').forEach(function(input) {
            input.checked = true;
            input.disabled = true;
        });
    }
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
}

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
