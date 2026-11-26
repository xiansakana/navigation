import { hasPermission } from './rbac.js';

const audiences = new Set(['public', 'members', 'self']);
const durations = { '3d': 3, '1m': 30, '6m': 180 };

export function blogAccess(session) {
  const permissions = session.permissions || [];
  const postPermission = !session.isGuest && hasPermission(permissions, 'blog:post:edit');
  const managePermission = !session.isGuest && hasPermission(permissions, 'blog:manage:edit');
  return {
    canView: session.isGuest || hasPermission(permissions, 'blog:feed:view') || postPermission || managePermission,
    canPost: postPermission && session.dataAccess?.writable !== false,
    canManage: managePermission && session.dataAccess?.writable !== false,
  };
}

export function postWriteAccess(row, session) {
  if (!row) return { status: 404, error: '文章不存在' };
  if (session.dataAccess && session.dataAccess.scope !== 'public' && row.author_id !== session.dataAccess.ownerId) return { status: 404, error: '文章不属于当前数据范围' };
  const { canPost, canManage } = blogAccess(session);
  if (!canManage && !(canPost && row.author_id === session.userId)) return { status: 403, error: '无权修改这篇文章' };
  return { status: 200 };
}

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

// Authors and authenticated blog managers can inspect every audience and time window.
export function visibilityFilter(session = {}, alias = 'blog_posts', now = new Date().toISOString()) {
  if (session.dataAccess && session.dataAccess.scope !== 'public') return { sql: `${alias}.author_id = ?`, params: [session.dataAccess.ownerId] };
  if (session.userId && !session.isGuest && hasPermission(session.permissions || [], 'blog:manage:edit')) return { sql: '1 = 1', params: [] };
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
