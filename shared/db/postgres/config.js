const DATABASE_NAMES = Object.freeze({
  identity: ['NAVIGATION_RBAC_POSTGRES_URL'],
  mingli: ['NAVIGATION_MINGLI_POSTGRES_URL'],
  blog: ['NAVIGATION_BLOG_POSTGRES_URL'],
  knowledge: ['NAVIGATION_KNOWLEDGE_POSTGRES_URL'],
  resources: ['NAVIGATION_RESOURCES_POSTGRES_URL'],
  torn: ['NAVIGATION_TORN_POSTGRES_URL'],
  tornUsers: ['NAVIGATION_TORN_POSTGRES_URL', 'NAVIGATION_TORN_USERS_POSTGRES_URL'],
  qqMonitoring: ['NAVIGATION_QQ_MONITOR_POSTGRES_URL'],
  quant: ['NAVIGATION_QUANT_POSTGRES_URL'],
  bookkeeping: ['NAVIGATION_BOOKKEEPING_POSTGRES_URL'],
  portfolio: ['NAVIGATION_PORTFOLIO_POSTGRES_URL'],
  qqqDip: ['NAVIGATION_QQQ_DIP_POSTGRES_URL'],
});

function invalid() {
  return Object.assign(new Error('PostgreSQL 生产连接配置缺失或不一致'), { code: 'POSTGRES_CONFIG_INVALID', status: 503 });
}

export function postgresProductionTarget(env = process.env) {
  if (env.NAVIGATION_DATABASE_ENGINE !== 'postgres') return null;
  const connectionString = env.NAVIGATION_POSTGRES_URL;
  const database = env.NAVIGATION_POSTGRES_DATABASE;
  if (!connectionString || !database) throw invalid();
  let url;
  try { url = new URL(connectionString); } catch { throw invalid(); }
  try {
    if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname ||
        decodeURIComponent(url.pathname.slice(1)) !== database) throw invalid();
  } catch { throw invalid(); }
  if (Object.values(DATABASE_NAMES).flat().some(key => env[key] && env[key] !== connectionString)) throw invalid();
  return { connectionString, database };
}

export function postgresUrlFor(scope, env = process.env) {
  const aliases = DATABASE_NAMES[scope];
  if (!aliases) throw new Error('Unknown PostgreSQL database scope: ' + scope);
  return postgresProductionTarget(env)?.connectionString || aliases.map(key => env[key]).find(Boolean);
}
