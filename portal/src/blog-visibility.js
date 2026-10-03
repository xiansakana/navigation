const audiences = new Set(['public', 'members', 'self']);
const durations = { '3d': 3, '1m': 30, '6m': 180 };

export function normalizeVisibility(value, createdAt = new Date().toISOString()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('可见范围参数无效');
  const audience = value.audience ?? 'public';
  const period = value.period ?? 'always';
  if (!audiences.has(audience) || !['always', 'custom', ...Object.keys(durations)].includes(period)) throw new Error('可见范围参数无效');
  function date(input) {
    if (input == null || input === '') return null;
    if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input) || !Number.isFinite(Date.parse(input))) throw new Error('可见时间无效');
    return new Date(input).toISOString();
  }
  const startsAt = period === 'custom' ? date(value.startsAt) : null;
  const endsAt = period === 'custom' ? date(value.endsAt) : durations[period]
    ? new Date(Date.parse(createdAt) + durations[period] * 86400000).toISOString() : null;
  if (period === 'custom' && !startsAt && !endsAt) throw new Error('请至少设置一个可见时间');
  if (startsAt && endsAt && startsAt >= endsAt) throw new Error('结束时间必须晚于开始时间');
  return { audience, period, startsAt, endsAt };
}

// Ownership is the only bypass: management permission does not reveal private posts.
export function visibilityFilter(session = {}, alias = 'blog_posts', now = new Date().toISOString()) {
  const owner = !session.isGuest && session.userId ? session.userId : '';
  const member = !session.isGuest && Boolean(session.userId) ? 1 : 0;
  return {
    sql: `(${alias}.author_id = ? OR ((${alias}.audience = 'public' OR (${alias}.audience = 'members' AND ? = 1))
      AND (${alias}.visible_from IS NULL OR ${alias}.visible_from <= ?)
      AND (${alias}.visible_until IS NULL OR ${alias}.visible_until > ?)))`,
    params: [owner, member, now, now]
  };
}

export function canViewPost(db, id, session, now) {
  const filter = visibilityFilter(session, 'blog_posts', now);
  return Boolean(db.prepare(`SELECT 1 FROM blog_posts WHERE id = ? AND ${filter.sql}`).get(id, ...filter.params));
}
