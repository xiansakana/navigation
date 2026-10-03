import crypto from 'node:crypto';
import { hasPermission } from './rbac.js';
import { canViewPost } from './blog-visibility.js';

export function commentAccess(session) {
  const permissions = session.permissions || [];
  const canManageComments = !session.isGuest && hasPermission(permissions, 'blog:comment-manage:edit');
  const canComment = !session.isGuest && hasPermission(permissions, 'blog:comment:edit');
  return { canViewComments: hasPermission(permissions, 'blog:comment:view') || canComment || canManageComments, canComment, canManageComments };
}
export function listComments(db, postId, session, before) {
  if (!commentAccess(session).canViewComments || !canViewPost(db, postId, session)) return { status: 404, error: '评论不可见' };
  let cursor;
  if (before) {
    cursor = db.prepare('SELECT created_at, id FROM blog_comments WHERE id = ? AND post_id = ?').get(before, postId);
    if (!cursor) return { status: 400, error: '评论分页无效' };
  }
  const items = db.prepare(`SELECT id, author_id AS authorId, author_name AS authorName, content, created_at AS createdAt FROM blog_comments
    WHERE post_id = ? ${cursor ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT 21`)
    .all(postId, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []));
  const more = items.length > 20; if (more) items.pop();
  const author = db.prepare('SELECT author_id FROM blog_posts WHERE id = ?').get(postId);
  const access = commentAccess(session);
  return { status: 200, comments: items.map(item => ({ ...item, canDelete: !session.isGuest && (access.canManageComments || (access.canComment && (item.authorId === session.userId || author.author_id === session.userId))) })), next: more ? items.at(-1).id : null };
}
export function createComment(db, postId, session, value) {
  if (!commentAccess(session).canComment) return { status: 403, error: '无权发表评论' };
  if (!canViewPost(db, postId, session)) return { status: 404, error: '博客不存在或不可见' };
  const content = String(value ?? '').trim().normalize('NFC');
  if (!content || content.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) return { status: 400, error: '评论请输入 1–2000 字' };
  const last = db.prepare('SELECT created_at FROM blog_comments WHERE author_id = ? ORDER BY created_at DESC LIMIT 1').get(session.userId);
  if (last && Date.now() - Date.parse(last.created_at) < 2000) return { status: 429, error: '评论太快，请稍后再试' };
  const id = crypto.randomUUID().replaceAll('-', '');
  db.prepare('INSERT INTO blog_comments VALUES (?, ?, ?, ?, ?, ?)').run(id, postId, session.userId, session.username, content, new Date().toISOString());
  return { status: 201, id };
}
export function deleteComment(db, id, session) {
  const row = db.prepare('SELECT c.post_id, c.author_id, p.author_id AS postAuthor FROM blog_comments c JOIN blog_posts p ON p.id = c.post_id WHERE c.id = ?').get(id);
  if (!row || !canViewPost(db, row.post_id, session)) return { status: 404, error: '评论不存在或不可见' };
  const access = commentAccess(session);
  if (session.isGuest || !(access.canManageComments || (access.canComment && (row.author_id === session.userId || row.postAuthor === session.userId)))) return { status: 403, error: '无权删除评论' };
  db.prepare('DELETE FROM blog_comments WHERE id = ?').run(id);
  return { status: 200 };
}
