import { DEFAULT_PERSONAL_PERMISSIONS } from './access-defaults.js';

const native = ['bookkeeping', 'knowledge', 'mingli', 'stock-manage', 'torn-chain', 'torn-factions', 'codex-cli', 'qq-codex'];
const titles = { bookkeeping: '记账', knowledge: '知识库', mingli: '命理', 'stock-manage': '股票管理（含量化与梭哈）', 'torn-chain': 'Chain 监控', 'torn-factions': '帮派筛选', 'codex-cli': 'Codex CLI', 'qq-codex': 'QQ Codex', blog: '博客', resources: '资源管理' };
const fail = message => { throw Object.assign(new Error(message), { status: 403 }); };
const key = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const bools = value => value && typeof value.read === 'boolean' && typeof value.write === 'boolean';

export function accessModules(services = []) {
  const ids = new Set([...native, 'blog', 'resources', ...services.filter(s => s.type !== 'external').map(s => s.id)]);
  return [...ids].map(id => ({ id, title: titles[id] || services.find(s => s.id === id)?.title || id, kind: native.includes(id) ? 'personal' : id === 'blog' ? 'publication' : 'instance' }));
}

export function moduleForPath(pathname, services = []) {
  return accessModules(services).map(m => ({ id: m.id, path: m.id === 'blog' ? '/' : m.id === 'torn-chain' ? '/torn-toolbox/chain/' : services.find(s => s.id === m.id)?.path || '/' + m.id + '/' }))
    .sort((a, b) => b.path.length - a.path.length)
    .find(m => m.id === 'blog' ? ['/', '/index.html'].includes(pathname) : pathname === m.path.replace(/\/$/, '') || pathname.startsWith(m.path.replace(/\/$/, '') + '/'))?.id;
}

export function ensureAccessPolicy(rbac) {
  if (!rbac.accessPolicy) rbac.accessPolicy = { version: 1, revision: 1, memberPermissions: [...DEFAULT_PERSONAL_PERMISSIONS, 'blog:post:edit'], teams: [], modules: {} };
  return rbac.accessPolicy;
}

export function modulePolicy(rbac, id, services = []) {
  const module = accessModules(services).find(m => m.id === id);
  if (!module) fail('模块未注册数据访问策略');
  return { enabled: true, defaultScope: module.kind === 'personal' ? 'self' : module.kind === 'publication' ? 'public' : 'service',
    own: { read: true, write: true }, service: { read: true, write: true }, grants: [], instances: [], ...rbac.accessPolicy?.modules?.[id] };
}

// Spaces explicitly bind an existing data owner. Creating/changing a binding never
// copies, reassigns or merges any existing rows, credentials, uploads or jobs.
export function validateAccessPolicy(input, rbac, services = []) {
  if (!input || input.version !== 1 || !Array.isArray(input.memberPermissions) || !Array.isArray(input.teams)
      || !input.modules || typeof input.modules !== 'object' || Array.isArray(input.modules)) throw new Error('访问策略格式无效');
  if (JSON.stringify(input).length > 250000 || input.teams.length > 100) throw new Error('访问策略过大');
  const knownPermissions = new Set((rbac.permissions || []).map(p => p.id));
  if (input.memberPermissions.some(p => !knownPermissions.has(p) || p === '*')) throw new Error('默认成员权限包含未知权限');
  const users = new Set((rbac.users || []).map(u => u.id)), roles = new Set((rbac.roles || []).map(r => r.id));
  const modules = accessModules(services), teams = new Set();
  const result = { version: 1, revision: (rbac.accessPolicy?.revision || 0) + 1, memberPermissions: [...new Set(input.memberPermissions)], teams: [], modules: {} };
  for (const team of input.teams) {
    if (!key(team.id) || teams.has(team.id) || typeof team.name !== 'string' || !team.name.trim() || team.name.length > 80 || !users.has(team.ownerId)) throw new Error('共享空间名称、ID或数据所属账号无效');
    teams.add(team.id); result.teams.push({ id: team.id, name: team.name.trim(), ownerId: team.ownerId });
  }
  for (const [id, policy] of Object.entries(input.modules)) {
    const module = modules.find(m => m.id === id);
    if (!module || typeof policy.enabled !== 'boolean' || !bools(policy.own) || !bools(policy.service) || !Array.isArray(policy.grants) || policy.grants.length > 500 || !Array.isArray(policy.instances)) throw new Error('模块访问配置无效');
    if (policy.instances.some(instance => instance === id || !key(instance) || !services.some(s => s.id === instance && s.type === 'proxy'))) throw new Error('请先在服务配置中注册不同于当前服务的独立实例');
    const validScope = scope => scope === 'self' && module.kind === 'personal' || scope === 'public' && module.kind === 'publication'
      || scope === 'service' && module.kind === 'instance' || typeof scope === 'string' && (scope.startsWith('team:') && module.kind !== 'instance' && teams.has(scope.slice(5))
      || scope.startsWith('user:') && module.kind !== 'instance' && users.has(scope.slice(5)) || scope.startsWith('instance:') && module.kind === 'instance' && policy.instances.includes(scope.slice(9)));
    if (!validScope(policy.defaultScope)) throw new Error('模块默认数据范围无效');
    const grants = policy.grants.map(g => {
      if (!['user', 'role'].includes(g.kind) || !(g.kind === 'user' ? users : roles).has(g.id) || !validScope(g.scope) || !bools(g) || g.write && !g.read) throw new Error('共享授权无效；修改必须同时允许查看');
      return { kind: g.kind, id: g.id, scope: g.scope, read: g.read, write: g.write };
    });
    if (policy.own.write && !policy.own.read || policy.service.write && !policy.service.read) throw new Error('修改必须同时允许查看');
    result.modules[id] = { enabled: policy.enabled, defaultScope: policy.defaultScope, own: { ...policy.own }, service: { ...policy.service }, instances: [...new Set(policy.instances)], grants };
  }
  return result;
}

export function resolveDataAccess(rbac, session, moduleId, scope, action = 'read', services = []) {
  const policy = modulePolicy(rbac, moduleId, services), module = accessModules(services).find(m => m.id === moduleId);
  const actor = (rbac.users || []).find(u => u.id === (session.actorUserId || session.userId) && u.enabled !== false);
  if (!actor || !policy.enabled || !['read', 'write'].includes(action)) fail('模块已禁用或账号无权访问');
  scope = scope || policy.defaultScope;
  const granted = policy.grants.some(g => g.scope === scope && g[action] && (g.kind === 'user' ? g.id === actor.id : actor.roleIds?.includes(g.id)));
  let ownerId = actor.id, label = '我的数据', allowed = false, binding = null;
  if (scope === 'self' && module.kind === 'personal') allowed = policy.own[action] || granted;
  else if (scope === 'public' && module.kind === 'publication') { label = '博客动态'; allowed = policy.service[action] || granted; }
  else if (scope === 'service' && module.kind === 'instance') { label = '共享服务'; allowed = policy.service[action] || granted; }
  else {
    const grant = policy.grants.filter(g => g.scope === scope && g[action] && (g.kind === 'user' ? g.id === actor.id : actor.roleIds?.includes(g.id)));
    if (!grant.length) fail('没有此数据范围的' + (action === 'write' ? '修改' : '查看') + '授权');
    if (scope.startsWith('user:') && module.kind !== 'instance') { ownerId = scope.slice(5); label = (rbac.users || []).find(u => u.id === ownerId)?.username || ''; }
    else if (scope.startsWith('team:') && module.kind !== 'instance') { const team = rbac.accessPolicy?.teams.find(t => t.id === scope.slice(5)); if (!team) fail('共享空间不存在'); ownerId = team.ownerId; label = team.name; }
    else if (scope.startsWith('instance:') && module.kind === 'instance' && policy.instances.includes(scope.slice(9))) { binding = services.find(s => s.id === scope.slice(9) && s.type === 'proxy'); if (!binding) fail('服务实例未配置'); label = binding.title || binding.id; }
    else fail('数据范围与模块不兼容');
    allowed = true;
  }
  if (!allowed || !(rbac.users || []).some(u => u.id === ownerId && u.enabled !== false)) fail('没有此数据范围的访问授权或数据所属账号已停用');
  return { moduleId, scope, label, ownerId, actorId: actor.id, action, binding };
}

export function listDataAccess(rbac, session, moduleId, services = []) {
  const policy = modulePolicy(rbac, moduleId, services);
  const scopes = new Set([policy.defaultScope, ...policy.grants.map(g => g.scope)]);
  const kind = accessModules(services).find(m => m.id === moduleId)?.kind;
  scopes.add(kind === 'personal' ? 'self' : kind === 'publication' ? 'public' : 'service');
  return [...scopes].flatMap(scope => {
    try {
      const access = resolveDataAccess(rbac, session, moduleId, scope, 'read', services);
      let writable = false; try { resolveDataAccess(rbac, session, moduleId, scope, 'write', services); writable = true; } catch { /* Read-only grant. */ }
      return [{ scope, label: access.label, writable }];
    } catch { return []; }
  });
}

export function dataRequestAction(req, pathname) {
  if (req.method === 'POST' && pathname === '/api/mingli/chart') return 'read';
  // These GET endpoints provision credentials or expose an interactive control
  // channel. A read-only share must never acquire a worker or writable session.
  if (/\/worker-package$|\/worker-install$/.test(pathname)) return 'write';
  return ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read' : 'write';
}
