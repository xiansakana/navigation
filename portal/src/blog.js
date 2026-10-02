import crypto from 'node:crypto';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';

const MAX_CONTENT_LENGTH = 10000;

export function blogAccess(session) {
    const permissions = session.permissions || [];
    const canPost = !session.isGuest && hasPermission(permissions, 'blog:post:edit');
    const canManage = !session.isGuest && hasPermission(permissions, 'blog:manage:edit');
    return {
        canView: hasPermission(permissions, 'blog:feed:view') || canPost || canManage,
        canPost,
        canManage
    };
}

export function validateContent(value) {
    if (typeof value !== 'string') throw new Error('请输入博客内容');
    const content = value.trim();
    if (!content) throw new Error('请输入博客内容');
    if (content.length > MAX_CONTENT_LENGTH) throw new Error('博客内容最多 10000 字');
    return content;
}

export function listPosts(db, before, limit = 20) {
    const cursor = before ? db.prepare('SELECT created_at, id FROM blog_posts WHERE id = ?').get(before) : null;
    if (before && !cursor) return [];
    const sql = `SELECT id, author_id AS authorId, author_name AS authorName,
        content, created_at AS createdAt, updated_at AS updatedAt FROM blog_posts`;
    if (cursor) {
        return db.prepare(sql + ' WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(cursor.created_at, cursor.created_at, cursor.id, limit);
    }
    return db.prepare(sql + ' ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
}

export function createPost(db, session, content) {
    const id = crypto.randomUUID().replaceAll('-', '');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO blog_posts (id, author_id, author_name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, session.userId, session.username, validateContent(content), now, now);
    return id;
}

export function changePost(db, id, session, content, remove = false) {
    const row = db.prepare('SELECT author_id FROM blog_posts WHERE id = ?').get(id);
    if (!row) return { status: 404, error: '文章不存在' };
    const access = blogAccess(session);
    if (!access.canManage && !(access.canPost && row.author_id === session.userId)) {
        return { status: 403, error: '无权修改这篇文章' };
    }
    if (remove) db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id);
    else db.prepare('UPDATE blog_posts SET content = ?, updated_at = ? WHERE id = ?')
        .run(validateContent(content), new Date().toISOString(), id);
    return { status: 200 };
}

export async function handleBlogApi(req, res, url, session, json) {
    const access = blogAccess(session);
    if (!access.canView) return json(res, 403, { ok: false, error: '无权查看博客' });
    const db = getDatabase();
    if (req.method === 'GET') {
        const before = url.searchParams.get('before');
        if (before && !/^[a-f0-9]{32}$/.test(before)) {
            return json(res, 400, { ok: false, error: '分页参数无效' });
        }
        return json(res, 200, { ok: true, posts: listPosts(db, before), ...access, userId: session.userId });
    }
    if (req.method === 'POST' && !access.canPost) {
        return json(res, 403, { ok: false, error: '无权发布博客' });
    }
    const id = url.pathname.split('/').at(-1);
    if (req.method === 'DELETE') {
        const result = changePost(db, id, session, null, true);
        return json(res, result.status, { ok: result.status === 200, error: result.error });
    }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return json(res, 415, { ok: false, error: '请使用 JSON 请求' });
    }
    try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 45000) return json(res, 413, { ok: false, error: '内容过长' });
            chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const content = validateContent(body.content);
        if (req.method === 'POST') {
            const postId = createPost(db, session, content);
            return json(res, 201, { ok: true, id: postId });
        }
        const result = changePost(db, id, session, content);
        return json(res, result.status, { ok: result.status === 200, error: result.error });
    } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
    }
}
