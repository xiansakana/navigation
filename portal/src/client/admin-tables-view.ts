import { createApp, h, shallowRef } from 'vue';

export interface AdminUser {
  id: string;
  username: string;
  roleIds?: string[];
  enabled?: boolean;
}

export interface AdminRole {
  id: string;
  name: string;
  description?: string;
  permissions?: string[];
}

export interface AdminMenu {
  id: string;
  sort?: number;
  icon?: string;
  title?: string;
  permission?: string;
  enabled?: boolean;
}

interface AdminActions {
  roleName(id: string): string;
  permName(id: string): string;
  canEdit(resource: string): boolean;
}

export function mountAdminTables(
  hosts: { users: HTMLElement; roles: HTMLElement; menus: HTMLElement },
  actions: AdminActions
) {
  const users = shallowRef<AdminUser[]>([]);
  const roles = shallowRef<AdminRole[]>([]);
  const menus = shallowRef<AdminMenu[]>([]);

  const userApp = createApp(() => users.value.map(user => h('tr', { key: user.id }, [
    h('td', user.username),
    h('td', (user.roleIds || []).map(actions.roleName).join('、') || '—'),
    h('td', [h('span', { class: ['admin-badge', user.enabled ? 'on' : 'off'] }, user.enabled ? '启用' : '禁用')]),
    h('td', { class: 'admin-actions' }, actions.canEdit('users') ? [
      h('button', { type: 'button', class: 'btn ghost sm-btn', 'data-edit-user': user.id }, '编辑'),
      user.id === 'usr_admin' ? null : h('button', { type: 'button', class: 'btn ghost sm-btn danger', 'data-del-user': user.id }, '删除')
    ] : [h('span', { class: 'sm-muted' }, '只读')])
  ])));
  userApp.mount(hosts.users);

  const roleApp = createApp(() => roles.value.map(role => {
    const names = (role.permissions || []).slice(0, 10).map(id => id === '*' ? '全部权限' : actions.permName(id)).join(' · ')
      + ((role.permissions || []).length > 10 ? ' …' : '');
    return h('article', { key: role.id, class: 'admin-role-card' }, [
      h('div', { class: 'admin-role-head' }, [
        h('h3', role.name),
        h('div', { class: 'admin-actions' }, actions.canEdit('roles') ? [
          h('button', { type: 'button', class: 'btn ghost sm-btn', 'data-edit-role': role.id }, '编辑'),
          ['role_admin', 'role_user'].includes(role.id) ? null
            : h('button', { type: 'button', class: 'btn ghost sm-btn danger', 'data-del-role': role.id }, '删除')
        ] : [h('span', { class: 'sm-muted' }, '只读')])
      ]),
      h('p', role.description || ''),
      h('div', { class: 'admin-role-perms' }, names || '无权限')
    ]);
  }));
  roleApp.mount(hosts.roles);

  const menuApp = createApp(() => {
    const disabled = !actions.canEdit('menus');
    return menus.value.map((menu, index) => h('tr', { key: menu.id }, [
      h('td', [h('input', { type: 'number', class: 'admin-input-sm menu-sort', 'data-id': menu.id,
        value: menu.sort != null ? menu.sort : (index + 1) * 10, disabled })]),
      h('td', [h('input', { type: 'text', class: 'admin-input-sm menu-icon', 'data-id': menu.id, value: menu.icon || '', disabled })]),
      h('td', [h('input', { type: 'text', class: 'admin-input-md menu-title', 'data-id': menu.id, value: menu.title || '', disabled })]),
      h('td', [h('code', menu.permission || '')]),
      h('td', [h('input', { type: 'checkbox', class: 'menu-enabled', 'data-id': menu.id, checked: menu.enabled !== false, disabled })])
    ]));
  });
  menuApp.mount(hosts.menus);

  return {
    update(next: { users: AdminUser[]; roles: AdminRole[]; menus: AdminMenu[] }) {
      users.value = next.users;
      roles.value = next.roles;
      menus.value = next.menus;
    },
    dispose() { userApp.unmount(); roleApp.unmount(); menuApp.unmount(); }
  };
}
