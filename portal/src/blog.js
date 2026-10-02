import crypto from 'node:crypto';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { deleteStoredMedia, uploadImage, uploadVideo } from './blog-media-storage.js';
import { normalizeContent, normalizeTags, normalizeLocation, renderMarkdown } from './blog-content.js';
import { parseCoordinates, resolveAddress } from './blog-address.js';

const MAX_REQUEST_BYTES = 128 * 1024;

export function blogAccess(session) {
    const permissions = session.permissions || [];
    const canPost = !session.isGuest && hasPermission(permissions, 'blog:post:edit');
    const canManage = !session.isGuest && hasPermission(permissions, 'blog:manage:edit');
    return { canView: hasPermission(permissions, 'blog:feed:view') || canPost || canManage, canPost, canManage };
}

export function validateContent(value, allowEmpty = false) {
    return normalizeContent(value, 'text', allowEmpty);
}

function transaction(db, operation) {
    db.exec('BEGIN');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function getImage(db, id) {
    return db.prepare('SELECT i.mime_type AS mimeType, i.image_data AS imageData FROM blog_images i JOIN blog_posts p ON p.id = i.post_id WHERE i.id = ?').get(id);
}

export function listPosts(db, before, limit = 20, tag = '') {
    const cursor = before ? db.prepare('SELECT created_at, id FROM blog_posts WHERE id = ?').get(before) : null;
    if (before && !cursor) return [];
    const conditions = [];
    const params = [];
    if (cursor) {
        conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    if (tag) {
        conditions.push('EXISTS (SELECT 1 FROM blog_post_tags t WHERE t.post_id = blog_posts.id AND t.tag = ?)');
        params.push(tag);
    }
    const rows = db.prepare(`SELECT id, author_id AS authorId, author_name AS authorName,
        content, content_format AS contentFormat, location_json AS locationJson, created_at AS createdAt, updated_at AS updatedAt FROM blog_posts
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit);
    const tags = db.prepare('SELECT tag FROM blog_post_tags WHERE post_id = ? ORDER BY rowid');
    const legacy = db.prepare('SELECT id FROM blog_images WHERE post_id = ? ORDER BY position, id');
    const media = db.prepare('SELECT id, kind, url, mime_type AS mimeType FROM blog_media WHERE post_id = ? ORDER BY position, id');
    return rows.map(row => {
        const items = media.all(row.id);
        const oldImages = legacy.all(row.id).map(image => ({ id: image.id, kind: 'image', url: '/api/blog/images/' + image.id }));
        const { locationJson, ...post } = row;
        return { ...post, location: locationJson ? JSON.parse(locationJson) : null, contentHtml: row.contentFormat === 'markdown' ? renderMarkdown(row.content) : null, content: normalizeContent(row.content, row.contentFormat, true), tags: tags.all(row.id).map(item => item.tag), images: [...oldImages, ...items.filter(item => item.kind === 'image')],
            videos: items.filter(item => item.kind === 'video') };
    });
}

export function createPost(db, session, content, hasMedia = false, options = {}) {
    const format = options.contentFormat ?? 'text';
    const text = normalizeContent(content, format, hasMedia === true);
    const tags = normalizeTags(options.tags);
    const location = normalizeLocation(options.location);
    const id = crypto.randomUUID().replaceAll('-', '');
    const now = new Date().toISOString();
    transaction(db, () => {
        db.prepare('INSERT INTO blog_posts (id, author_id, author_name, content, content_format, location_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, session.userId, session.username, text, format, location ? JSON.stringify(location) : null, now, now);
        for (const tag of tags) db.prepare('INSERT INTO blog_post_tags (post_id, tag) VALUES (?, ?)').run(id, tag);
    });
    return id;
}

export function canChangePost(db, id, session) {
    const row = db.prepare('SELECT author_id FROM blog_posts WHERE id = ?').get(id);
    if (!row) return { status: 404, error: '文章不存在' };
    const access = blogAccess(session);
    if (!access.canManage && !(access.canPost && row.author_id === session.userId)) {
        return { status: 403, error: '无权修改这篇文章' };
    }
    return { status: 200 };
}

export function addMedia(db, postId, session, item) {
    const access = canChangePost(db, postId, session);
    if (access.status !== 200) return access;
    const id = crypto.randomUUID().replaceAll('-', '');
    const last = db.prepare('SELECT MAX(position) AS position FROM blog_media WHERE post_id = ?').get(postId);
    db.prepare('INSERT INTO blog_media (id, post_id, author_id, kind, mime_type, url, storage_key, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, postId, session.userId, item.kind, item.mimeType, item.url, item.storageKey,
            (last.position ?? -1) + 1, new Date().toISOString());
    return { status: 201, id, url: item.url };
}

export function changePost(db, id, session, content, remove = false, options = {}) {
    const access = canChangePost(db, id, session);
    if (access.status !== 200) return access;
    if (remove) {
        const removedMedia = db.prepare('SELECT storage_key AS storageKey FROM blog_media WHERE post_id = ?').all(id);
        transaction(db, () => {
            db.prepare('DELETE FROM blog_media WHERE post_id = ?').run(id);
            db.prepare('DELETE FROM blog_images WHERE post_id = ?').run(id);
            db.prepare('DELETE FROM blog_post_tags WHERE post_id = ?').run(id);
            db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id);
        });
        return { status: 200, removedMedia };
    }
    const existing = [
        ...db.prepare('SELECT id FROM blog_images WHERE post_id = ?').all(id),
        ...db.prepare('SELECT id FROM blog_media WHERE post_id = ?').all(id)
    ].map(row => row.id);
    const keepIds = options.keepMediaIds == null ? existing : options.keepMediaIds;
    if (!Array.isArray(keepIds) || new Set(keepIds).size !== keepIds.length
        || keepIds.some(mediaId => !existing.includes(mediaId))) throw new Error('文章媒体参数无效');
    const format = options.contentFormat ?? 'text';
    const text = normalizeContent(content, format, keepIds.length > 0);
    const previous = db.prepare('SELECT location_json FROM blog_posts WHERE id = ?').get(id);
    const location = options.location === undefined ? previous.location_json : JSON.stringify(normalizeLocation(options.location));
    const tags = options.tags === undefined ? null : normalizeTags(options.tags);
    const removedMedia = db.prepare('SELECT id, storage_key AS storageKey FROM blog_media WHERE post_id = ?').all(id)
        .filter(item => !keepIds.includes(item.id));
    transaction(db, () => {
        for (const mediaId of existing) {
            if (keepIds.includes(mediaId)) continue;
            db.prepare('DELETE FROM blog_images WHERE post_id = ? AND id = ?').run(id, mediaId);
            db.prepare('DELETE FROM blog_media WHERE post_id = ? AND id = ?').run(id, mediaId);
        }
        if (tags) {
            db.prepare('DELETE FROM blog_post_tags WHERE post_id = ?').run(id);
            for (const tag of tags) db.prepare('INSERT INTO blog_post_tags (post_id, tag) VALUES (?, ?)').run(id, tag);
        }
        db.prepare('UPDATE blog_posts SET content = ?, content_format = ?, location_json = ?, updated_at = ? WHERE id = ?')
            .run(text, format, location, new Date().toISOString(), id);
    });
    return { status: 200, removedMedia };
}

async function readJson(req) {
    let size = 0;
    const parts = [];
    for await (const part of req) {
        size += part.length;
        if (size > MAX_REQUEST_BYTES) throw new Error('请求内容过大');
        parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function handleBlogApi(req, res, url, session, json, config) {
    const access = blogAccess(session);
    if (!access.canView) return json(res, 403, { ok: false, error: '无权查看博客' });
    if (req.method === 'GET' && url.pathname === '/api/blog/location') {
        let coordinates;
        try { coordinates = parseCoordinates(url.searchParams); }
        catch (error) { return json(res, 400, { ok: false, error: error.message }); }
        try {
            const label = await resolveAddress(coordinates);
            return json(res, 200, { ok: true, label });
        } catch { return json(res, 503, { ok: false, error: '地址暂不可用，请稍后重新定位' }); }
    }
    const db = getDatabase();
    if (req.method === 'GET' && url.pathname.startsWith('/api/blog/images/')) {
        const image = getImage(db, url.pathname.split('/').at(-1));
        if (!image) return json(res, 404, { ok: false, error: '图片不存在' });
        const bytes = Buffer.from(image.imageData);
        res.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': bytes.length,
            'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
        return res.end(bytes);
    }
    if (req.method === 'GET' && url.pathname === '/api/blog/posts') {
        const before = url.searchParams.get('before');
        if (before && !/^[a-f0-9]{32}$/.test(before)) return json(res, 400, { ok: false, error: '分页参数无效' });
        const tag = url.searchParams.get('tag') || '';
        try { normalizeTags([tag]); } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
        const tags = db.prepare('SELECT t.tag, COUNT(*) AS count FROM blog_post_tags t JOIN blog_posts p ON p.id = t.post_id GROUP BY t.tag ORDER BY count DESC, t.tag').all();
        return json(res, 200, { ok: true, posts: listPosts(db, before, 20, tag), tags, ...access, userId: session.userId });
    }
    if (req.method === 'POST' && !access.canPost && !access.canManage) return json(res, 403, { ok: false, error: '无权发布博客' });
    const match = url.pathname.match(/^\/api\/blog\/posts\/([a-f0-9]{32})(?:\/media)?$/);
    const id = match?.[1];
    if (req.method === 'DELETE') {
        const result = changePost(db, id, session, null, true);
        if (result.removedMedia?.length) {
            try { await deleteStoredMedia(result.removedMedia); }
            catch (error) { console.error('博客媒体清理失败:', error); }
        }
        return json(res, result.status, { ok: result.status === 200, error: result.error });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/media')) {
        const allowed = canChangePost(db, id, session);
        if (allowed.status !== 200) return json(res, allowed.status, { ok: false, error: allowed.error });
        try {
            const kind = url.searchParams.get('kind');
            const item = kind === 'image'
                ? await uploadImage(req, (config.services || []).find(service => service.id === 'piclist'))
                : kind === 'video' ? await uploadVideo(req) : null;
            if (!item) throw new Error('媒体类型无效');
            const result = addMedia(db, id, session, item);
            return json(res, result.status, { ok: result.status === 201, id: result.id, url: result.url, error: result.error });
        } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return json(res, 415, { ok: false, error: '请使用 JSON 请求' });
    }
    try {
        const body = await readJson(req);
        if (req.method === 'POST') {
            const postId = createPost(db, session, body.content, body.hasMedia, { contentFormat: body.contentFormat, tags: body.tags, location: body.location });
            return json(res, 201, { ok: true, id: postId });
        }
        const result = changePost(db, id, session, body.content, false, { keepMediaIds: body.keepMediaIds, contentFormat: body.contentFormat, tags: body.tags, location: body.location });
        if (result.removedMedia?.length) {
            try { await deleteStoredMedia(result.removedMedia); }
            catch (error) { console.error('博客媒体清理失败:', error); }
        }
        return json(res, result.status, { ok: result.status === 200, error: result.error });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
}
