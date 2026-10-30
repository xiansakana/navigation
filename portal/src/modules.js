function blogApi(pathname, method) {
    if (pathname === '/api/blog/posts' && (method === 'GET' || method === 'POST')) return true;
    if (pathname === '/api/blog/location' && method === 'GET') return true;
    if (/^\/api\/blog\/posts\/[a-f0-9]{32}\/video-uploads$/.test(pathname) && method === 'POST') return true;
    if (/^\/api\/blog\/video-uploads\/[a-f0-9]{32}$/.test(pathname) && ['GET', 'POST', 'DELETE'].includes(method)) return true;
    if (/^\/api\/blog\/posts\/[a-f0-9]{32}\/comments$/.test(pathname) && ['GET', 'POST'].includes(method)) return true;
    if (/^\/api\/blog\/comments\/[a-f0-9]{32}$/.test(pathname) && method === 'DELETE') return true;
    if (/^\/api\/blog\/video-uploads\/[a-f0-9]{32}\/parts\/[1-9]\d{0,4}$/.test(pathname) && method === 'PUT') return true;
    if (/^\/api\/blog\/media\/[a-f0-9]{32}$/.test(pathname) && method === 'GET') return true;
    if (/^\/api\/blog\/posts\/[a-f0-9]{32}$/.test(pathname) && (method === 'PUT' || method === 'DELETE')) return true;
    if (/^\/api\/blog\/posts\/[a-f0-9]{32}\/media$/.test(pathname) && method === 'POST') return true;
    if (/^\/api\/blog\/images\/[a-f0-9]{32}$/.test(pathname) && method === 'GET') return true;
    return false;
}

// Single catalog for built-in module entry points, API ownership, menus and observability.
export const PORTAL_MODULES = Object.freeze([
  { id: 'torn-users', title: '用户监控', namespace: 'torn-users', runtime: 'torn-monitor-worker', tables: ['torn_user_monitors'], apiPrefix: '/api/torn-users/' },
  { id: 'torn-shopping', title: '扫货助手', namespace: 'torn-shopping', runtime: 'torn-monitor-worker', tables: ['torn_shopping'], apiPrefix: '/api/torn-shopping/' },
  { id: 'torn-factions', title: '帮派筛选', namespace: 'torn-factions', runtime: 'torn-monitor-worker', tables: ['torn_faction_scans', 'torn_faction_rows', 'torn_faction_networth'], apiPrefix: '/api/torn-factions/' },
  { id: 'torn-chain', title: '监控', namespace: 'torn-chain', runtime: 'torn-monitor-worker', tables: ['torn_chain_monitors', 'torn_chain_notifications', 'torn_destruction_monitors', 'torn_destruction_observations'], apiPrefix: '/api/torn-chain/' },
  { id: 'blog', title: '博客', namespace: 'blog', runtime: 'portal', tables: ['blog_posts'], apiPrefix: '/api/blog/', matches: blogApi },
  { id: 'codex-cli', title: 'Codex CLI', namespace: 'codex-cli', runtime: 'qq-bot', tables: ['qq_codex_jobs'],
    path: '/codex-cli/', permission: 'codex-cli:view', icon: '⌘', sort: 9940, description: '会话工作台、任务进度、账户额度与服务器配置', apiPrefix: '/api/codex-cli/' },
  { id: 'knowledge', title: '知识库', namespace: 'knowledge', runtime: 'portal + knowledge-worker', tables: ['knowledge_documents'],
    path: '/knowledge/', permission: 'knowledge:view', icon: '📚', sort: 9950, description: '上传视频，积累可检索的完整学习笔记', apiPrefix: '/api/knowledge/' },
  { id: 'mingli', title: '命理', namespace: 'mingli', runtime: 'portal', tables: ['mingli_cases'],
    path: '/mingli/', permission: 'mingli:view', icon: '☯', sort: 9960, description: '八字排盘、大运流年与个人案例笔记', apiPrefix: '/api/mingli/' },
  { id: 'bookkeeping', title: '记账', namespace: 'bookkeeping', runtime: 'portal', tables: ['bookkeeping_entries'],
    path: '/bookkeeping/', permission: 'bookkeeping:view', icon: '📒', sort: 9970, description: 'iCost 账单、收支统计与多币种资产账户', apiPrefix: '/api/bookkeeping/' },
  { id: 'resources', title: '资源管理', namespace: 'resources', runtime: 'portal', tables: [],
    path: '/resources/', permission: 'service:resources:view', icon: '🖥️', sort: 9980, description: '服务器负载、服务状态与资源占用监控', apiPath: '/api/resources/metrics' },
  { id: 'qq-codex', title: 'QQ Codex 设置', namespace: 'qq-codex', runtime: 'qq-bot', tables: [], apiPrefix: '/api/qq-codex/' }
]);

export function findModuleApi(pathname, method) {
  return PORTAL_MODULES.find(module => method && module.matches ? module.matches(pathname, method) : module.apiPath ? pathname === module.apiPath : pathname.startsWith(module.apiPrefix));
}

export function moduleMenu(module, overrides = {}) {
  return { id: 'menu_' + module.id, title: module.title, description: module.description, icon: module.icon,
    type: 'hub', sort: module.sort, enabled: true, ...overrides,
    path: module.path, permission: module.permission, serviceId: module.id };
}

export function moduleInventory(db, services = []) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const tasks = (table, field) => tables.has(table)
    ? Object.fromEntries(db.prepare(`SELECT ${field} AS state, COUNT(*) AS count FROM ${table} GROUP BY ${field}`).all().map(row => [row.state, row.count])) : {};
  const heartbeat = key => tables.has('meta') ? Number(db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value || 0) : 0;
  const worker = module => {
    if (module.id === 'knowledge' && tables.has('knowledge_worker_instances')) {
      return { online: db.prepare('SELECT COUNT(*) AS count FROM knowledge_worker_instances WHERE last_seen > ?').get(new Date(Date.now() - 120000).toISOString()).count, remote: true };
    }
    const at = module.runtime === 'torn-monitor-worker' ? heartbeat('torn_monitor_worker_heartbeat') : ['blog', 'bookkeeping'].includes(module.id) ? heartbeat('portal_background_heartbeat') : module.id === 'codex-cli' ? heartbeat('codex_worker_heartbeat') : 0;
    return at ? { online: Date.now() - at < 45000 ? 1 : 0, at, remote: false } : null;
  };
  const builtin = PORTAL_MODULES.map(module => ({ id: module.id, title: module.title, path: module.path || '/',
    runtime: module.runtime, type: 'builtin', status: 'registered',
    worker: worker(module),
    // Counts and states only; never send amounts, prompts, personal rows or settings.
    tasks: module.id === 'knowledge' ? tasks('knowledge_documents', 'status') : module.id === 'codex-cli' ? tasks('qq_codex_jobs', 'state') : {},
    records: module.tables.reduce((sum, table) => sum + (tables.has(table) ? db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count : 0), 0) }));
  return builtin.concat(services.filter(service => !PORTAL_MODULES.some(module => module.id === service.id)).map(service => ({
    id: service.id, title: service.title || service.id, path: service.path || '', type: service.type,
    runtime: ['torn-company', 'torn-undercut'].includes(service.id) ? 'torn-monitor-worker' : service.type === 'external' ? 'external' : service.id, status: service.enabled === false ? 'disabled' : 'registered', tasks: {}, records: null
  })));
}

// Native monitor page assets must bypass the toolbox proxy as one allowlisted bundle.
export const TORN_MONITOR_ASSETS = Object.freeze(['index.html', 'app.js', 'factions.js', 'users.js', 'style.css']);
