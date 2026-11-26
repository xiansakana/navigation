import { createApp, h, shallowRef, type VNode } from 'vue';

interface Permission {
  id: string;
  name: string;
  action?: string;
  resource?: string;
  serviceId?: string;
  feature?: string;
  featureGroup?: string;
  columnKey?: string;
  permissionPath?: string[];
}

interface Menu {
  id: string;
  title?: string;
  icon?: string;
  path?: string;
  url?: string;
  sort?: number;
  enabled?: boolean;
  serviceId?: string;
}

export interface AdminRole {
  id: string;
  name: string;
  description?: string;
  permissions?: string[];
}

export interface Rbac {
  menus?: Menu[];
  permissions?: Permission[];
  roles?: AdminRole[];
  users?: any[];
}

interface ResourceNode {
  kind: 'resource';
  title: string;
  view: Permission | null;
  edit: Permission | null;
}

interface ServiceNode {
  kind: 'service';
  serviceId: string;
  menu: Menu | null;
  title: string;
  icon: string;
  path: string;
  enabled: boolean;
  view: Permission | null;
  edit: Permission | null;
  features: Permission[];
}

interface FeatureBranch {
  title: string;
  permissions: Permission[];
  children: FeatureBranch[];
}

const title = (permission: Permission | null) => {
  if (!permission) return '';
  return String(permission.name || '')
    .replace(/^查看[「"]?/, '')
    .replace(/^编辑[「"]?/, '')
    .replace(/[」"]?$/, '')
    .trim() || permission.name;
};

function buildPermissionTree(rbac: Rbac): { title: string; children: (ResourceNode | ServiceNode)[] }[] {
  const menus = (rbac.menus || []).filter(menu => menu.id !== 'menu_admin');
  const system = new Map<string, ResourceNode>();
  const services = new Map<string, { serviceId: string; view: Permission | null; edit: Permission | null; features: Permission[] }>();

  (rbac.permissions || []).forEach(permission => {
    if (permission.feature && permission.serviceId) {
      if (!services.has(permission.serviceId)) services.set(permission.serviceId, { serviceId: permission.serviceId, view: null, edit: null, features: [] });
      services.get(permission.serviceId)!.features.push(permission);
      return;
    }
    if (permission.serviceId) {
      if (!services.has(permission.serviceId)) services.set(permission.serviceId, { serviceId: permission.serviceId, view: null, edit: null, features: [] });
      if (permission.action === 'view') services.get(permission.serviceId)!.view = permission;
      if (permission.action === 'edit') services.get(permission.serviceId)!.edit = permission;
      return;
    }
    const key = permission.resource || permission.id.replace(/:(view|edit)$/, '');
    if (!system.has(key)) system.set(key, { kind: 'resource', title: title(permission), view: null, edit: null });
    const node = system.get(key)!;
    if (permission.action === 'view') { node.view = permission; node.title = title(permission); }
    if (permission.action === 'edit') { node.edit = permission; if (!node.title) node.title = title(permission); }
  });

  const serviceNodes: ServiceNode[] = [];
  const seen = new Set<string>();
  menus.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).forEach(menu => {
    if (!menu.serviceId || !services.has(menu.serviceId)) return;
    seen.add(menu.serviceId);
    const service = services.get(menu.serviceId)!;
    serviceNodes.push({
      kind: 'service', serviceId: menu.serviceId, menu,
      title: menu.title || title(service.view || { name: menu.serviceId } as Permission),
      icon: menu.icon || '📦', path: menu.path || menu.url || '', enabled: menu.enabled !== false,
      view: service.view, edit: service.edit, features: service.features || []
    });
  });
  services.forEach((service, serviceId) => {
    if (seen.has(serviceId)) return;
    serviceNodes.push({
      kind: 'service', serviceId, menu: null,
      title: serviceId === 'blog' ? '首页博客' : title(service.view || { name: serviceId } as Permission),
      icon: serviceId === 'blog' ? '📝' : '📦', path: serviceId === 'blog' ? '/' : '', enabled: true,
      view: service.view, edit: service.edit, features: service.features || []
    });
  });

  return [
    { title: '系统', children: [...system.values()] },
    { title: '服务菜单与功能', children: serviceNodes }
  ];
}

const holdingsFieldOrder = ['type', 'symbol', 'shares', 'cost', 'price', 'pnl', 'pnlPct', 'dailyPnl', 'dailyPnlPct', 'position', 'weight', 'target', 'optinfo', 'signal', 'actions'];

function splitServiceFeatures(features: Permission[]) {
  const buttons: Permission[] = [], fields: Permission[] = [];
  (features || []).forEach(permission => {
    if (permission.featureGroup === 'holdings-field' || (permission.feature && permission.feature.indexOf('col-') === 0)) fields.push(permission);
    else buttons.push(permission);
  });
  fields.sort((a, b) => {
    const ak = a.columnKey || String(a.feature || '').replace(/^col-/, '');
    const bk = b.columnKey || String(b.feature || '').replace(/^col-/, '');
    return holdingsFieldOrder.indexOf(ak) - holdingsFieldOrder.indexOf(bk);
  });
  return { buttons, fields };
}

function buildFeatureHierarchy(features: Permission[]): FeatureBranch[] {
  const root: FeatureBranch[] = [];
  (features || []).forEach(permission => {
    const path = Array.isArray(permission.permissionPath) && permission.permissionPath.length ? permission.permissionPath : ['其他页面功能'];
    let level = root;
    let node: FeatureBranch | null = null;
    path.forEach(item => {
      node = level.find(child => child.title === item) || null;
      if (!node) { node = { title: item, permissions: [], children: [] }; level.push(node); }
      level = node.children;
    });
    node!.permissions.push(permission);
  });
  return root;
}

export function mountPermissionTree(host: HTMLElement, options: { legend?: string } = {}) {
  const model = shallowRef<{ mode: 'readonly' | 'edit'; role: AdminRole | null; rbac: Rbac }>({ mode: 'readonly', role: null, rbac: {} });
  const collapsed = shallowRef<Set<string>>(new Set());

  const isCollapsed = (key: string) => collapsed.value.has(key);
  const toggle = (key: string) => {
    const next = new Set(collapsed.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    collapsed.value = next;
  };

  const toggleButton = (key: string) => h('button', {
    type: 'button', class: 'admin-perm-tree-toggle',
    'aria-expanded': String(!isCollapsed(key)), 'aria-label': '展开/收起',
    onClick: () => toggle(key)
  }, isCollapsed(key) ? '▸' : '▾');

  const check = (permission: Permission | null, label: string, mode: string, rolePerms: string[], isAdminRole: boolean) => {
    if (!permission) return h('span', { class: 'sm-muted' }, '—');
    if (mode === 'readonly') return h('code', { class: 'admin-perm-code' }, permission.id);
    const checked = isAdminRole || rolePerms.includes('*') || rolePerms.includes(permission.id);
    return h('label', { class: 'admin-check admin-check--inline' }, [
      h('input', { type: 'checkbox', name: 'perm', value: permission.id, checked, disabled: isAdminRole }),
      h('span', label)
    ]);
  };

  const resourceRow = (node: ResourceNode, mode: string, rolePerms: string[], isAdminRole: boolean) => h('div', { class: 'admin-perm-tree-row admin-perm-tree-row--resource' }, [
    h('span', { class: 'admin-perm-tree-label' }, node.title),
    h('span', { class: 'admin-perm-tree-cols' }, [
      h('span', { class: 'admin-perm-tree-col' }, [check(node.view, '查看', mode, rolePerms, isAdminRole)]),
      h('span', { class: 'admin-perm-tree-col' }, [check(node.edit, '编辑', mode, rolePerms, isAdminRole)])
    ])
  ]);

  const featureRow = (permission: Permission, mode: string, rolePerms: string[], isAdminRole: boolean) => {
    const badge = permission.featureGroup === 'holdings-field' ? '字段' : (permission.action === 'edit' ? '编辑' : '查看');
    return h('div', { class: 'admin-perm-tree-row admin-perm-tree-row--feature' }, [
      h('span', { class: 'admin-perm-tree-label' }, [permission.name, h('span', { class: 'admin-perm-badge' }, badge)]),
      h('span', { class: 'admin-perm-tree-cols' }, [check(permission, '允许', mode, rolePerms, isAdminRole)])
    ]);
  };

  const featureBranch = (branch: FeatureBranch, key: string, mode: string, rolePerms: string[], isAdminRole: boolean): VNode => h('div', { class: 'admin-perm-branch' }, [
    h('div', { class: 'admin-perm-branch-node' }, [
      toggleButton(key),
      h('span', { class: 'admin-perm-tree-label admin-perm-tree-label--strong' }, branch.title)
    ]),
    h('div', { class: ['admin-perm-branch-children', isCollapsed(key) ? 'collapsed' : null] }, [
      ...branch.permissions.map(permission => featureRow(permission, mode, rolePerms, isAdminRole)),
      ...branch.children.map(child => featureBranch(child, key + '/' + child.title, mode, rolePerms, isAdminRole))
    ])
  ]);

  const serviceNode = (node: ServiceNode, mode: string, rolePerms: string[], isAdminRole: boolean) => {
    const hasChildren = !!(node.view || node.edit || (node.features && node.features.length));
    const key = 'service:' + node.serviceId;
    const meta: string[] = [];
    if (node.path) meta.push(node.path);
    if (node.menu && node.enabled === false) meta.push('已禁用');
    const header = h('div', { class: 'admin-perm-tree-node' }, [
      hasChildren ? toggleButton(key) : h('span', { class: 'admin-perm-tree-toggle admin-perm-tree-toggle--spacer' }),
      h('span', { class: 'admin-perm-tree-icon' }, node.icon),
      h('span', { class: 'admin-perm-tree-label admin-perm-tree-label--strong' }, node.title),
      meta.length ? h('span', { class: 'admin-perm-tree-meta' }, meta.join(' · ')) : null
    ]);
    const children: ReturnType<typeof h>[] = [];
    if (hasChildren) {
      if (node.view || node.edit) {
        children.push(h('div', { class: 'admin-perm-tree-section-label' }, '菜单访问'));
        children.push(resourceRow({ kind: 'resource', title: '进入服务 / 首页卡片', view: node.view, edit: node.edit }, mode, rolePerms, isAdminRole));
      }
      const split = splitServiceFeatures(node.features || []);
      if (split.buttons.length) {
        children.push(h('div', { class: 'admin-perm-tree-section-label' }, '页面菜单、按钮与功能'));
        buildFeatureHierarchy(split.buttons).forEach(branch => {
          children.push(featureBranch(branch, key + ':' + branch.title, mode, rolePerms, isAdminRole));
        });
      }
      if (split.fields.length) {
        children.push(h('div', { class: 'admin-perm-tree-section-label' }, '持仓明细字段'));
        split.fields.forEach(permission => children.push(featureRow(permission, mode, rolePerms, isAdminRole)));
      }
    }
    return h('li', { class: 'admin-perm-tree-item admin-perm-tree-item--service' }, [
      header,
      hasChildren ? h('div', { class: ['admin-perm-tree-children', isCollapsed(key) ? 'collapsed' : null] }, children) : null
    ]);
  };

  const app = createApp(() => {
    const { mode, role, rbac } = model.value;
    const rolePerms = role ? (role.permissions || []) : [];
    const isAdminRole = !!(role && role.id === 'role_admin');
    const groups = buildPermissionTree(rbac);
    const sections = groups.map(group => {
      const system = group.title === '系统';
      return h('section', { class: 'admin-perm-tree-group' }, [
        h('h3', { class: 'admin-perm-tree-group-title' }, group.title),
        h('div', { class: ['admin-perm-tree-head', system ? null : 'admin-perm-tree-head--service'] }, [
          h('span', { class: 'admin-perm-tree-label' }, system ? '权限项' : '服务 / 功能'),
          h('span', { class: 'admin-perm-tree-cols' }, system
            ? [h('span', { class: 'admin-perm-tree-col' }, '查看'), h('span', { class: 'admin-perm-tree-col' }, '编辑')]
            : [h('span', { class: 'admin-perm-tree-col' }, mode === 'readonly' ? '权限 ID' : '授权')])
        ]),
        h('ul', { class: 'admin-perm-tree' }, system
          ? (group.children as ResourceNode[]).map(node => h('li', { class: 'admin-perm-tree-item' }, [resourceRow(node, mode, rolePerms, isAdminRole)]))
          : (group.children as ServiceNode[]).map(node => serviceNode(node, mode, rolePerms, isAdminRole)))
      ]);
    });
    return options.legend ? [h('legend', options.legend), ...sections] : sections;
  });
  app.mount(host);

  return {
    render(mode: 'readonly' | 'edit', role: AdminRole | null, rbac: Rbac) {
      collapsed.value = new Set();
      model.value = { mode, role, rbac };
    },
    dispose() { app.unmount(); }
  };
}
