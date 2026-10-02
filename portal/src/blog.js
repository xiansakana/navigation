import crypto from 'node:crypto';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';

const MAX_CONTENT_LENGTH = 10000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const IMAGE_SIGNATURES = {
    'image/jpeg': function(bytes) { return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; },
    'image/png': function(bytes) { return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); },
    'image/gif': function(bytes) { return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)); },
    'image/webp': function(bytes) { return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'; }
};

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

export function validateContent(value, allowEmpty = false) {
    if (typeof value !== 'string') throw new Error('请输入博客内容');
    const content = value.trim();
    if (!content && !allowEmpty) throw new Error('请输入博客内容或添加图片');
    if (content.length > MAX_CONTENT_LENGTH) throw new Error('博客内容最多 10000 字');
    return content;
}

export function decodeImages(images) {
    if (images == null) return [];
    if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error('最多上传 4 张图片');
    return images.map(function(image) {
        const mime = image?.mime;
        const data = image?.data;
        if (!Object.hasOwn(IMAGE_SIGNATURES, mime) || typeof data !== 'string'
            || data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4
            || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
            throw new Error('图片格式无效，仅支持 JPG、PNG、WebP、GIF');
        }
        const bytes = Buffer.from(data, 'base64');
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== data
            || !IMAGE_SIGNATURES[mime](bytes)) {
            throw new Error('图片无效或超过每张 5MB 限制');
        }
        return { mime, bytes };
    });
}

function transaction(db, operation) {
    db.exec('BEGIN');
    try {
        const result = operation();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

function insertImages(db, postId, authorId, images, startPosition) {
    const insert = db.prepare('INSERT INTO blog_images (id, post_id, author_id, mime_type, image_data, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    images.forEach(function(image, index) {
        insert.run(crypto.randomUUID().replaceAll('-', ''), postId, authorId, image.mime,
            image.bytes, startPosition + index, new Date().toISOString());
    });
}

export function getImage(db, id) {
    return db.prepare('SELECT i.mime_type AS mimeType, i.image_data AS imageData FROM blog_images i JOIN blog_posts p ON p.id = i.post_id WHERE i.id = ?').get(id);
}

export function listPosts(db, before, limit = 20) {
    const cursor = before ? db.prepare('SELECT created_at, id FROM blog_posts WHERE id = ?').get(before) : null;
    if (before && !cursor) return [];
    const sql = `SELECT id, author_id AS authorId, author_name AS authorName,
        content, created_at AS createdAt, updated_at AS updatedAt FROM blog_posts`;
    const rows = cursor
        ? db.prepare(sql + ' WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(cursor.created_at, cursor.created_at, cursor.id, limit)
        : db.prepare(sql + ' ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    const findImages = db.prepare('SELECT id FROM blog_images WHERE post_id = ? ORDER BY position, id');
    return rows.map(function(row) {
        return { ...row, images: findImages.all(row.id).map(function(image) { return { id: image.id, url: '/api/blog/images/' + image.id }; }) };
    });
}

export function createPost(db, session, content, images = []) {
    const decoded = decodeImages(images);
    const text = validateContent(content, decoded.length > 0);
    const id = crypto.randomUUID().replaceAll('-', '');
    const now = new Date().toISOString();
    transaction(db, function() {
        db.prepare('INSERT INTO blog_posts (id, author_id, author_name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, session.userId, session.username, text, now, now);
        insertImages(db, id, session.userId, decoded, 0);
    });
    return id;
}

export function changePost(db, id, session, content, remove = false, options = {}) {
    const row = db.prepare('SELECT author_id FROM blog_posts WHERE id = ?').get(id);
    if (!row) return { status: 404, error: '文章不存在' };
    const access = blogAccess(session);
    if (!access.canManage && !(access.canPost && row.author_id === session.userId)) {
        return { status: 403, error: '无权修改这篇文章' };
    }
    if (remove) {
        transaction(db, function() {
            db.prepare('DELETE FROM blog_images WHERE post_id = ?').run(id);
            db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id);
        });
        return { status: 200 };
    }
    const existing = db.prepare('SELECT id FROM blog_images WHERE post_id = ? ORDER BY position, id').all(id).map(function(image) { return image.id; });
    const keepIds = options.keepImageIds == null ? existing : options.keepImageIds;
    if (!Array.isArray(keepIds) || new Set(keepIds).size !== keepIds.length
        || keepIds.some(function(imageId) { return !existing.includes(imageId); })) {
        throw new Error('文章图片参数无效');
    }
    const decoded = decodeImages(options.images);
    if (keepIds.length + decoded.length > MAX_IMAGES) throw new Error('每篇最多 4 张图片');
    const text = validateContent(content, keepIds.length + decoded.length > 0);
    transaction(db, function() {
        const removeImage = db.prepare('DELETE FROM blog_images WHERE post_id = ? AND id = ?');
        existing.filter(function(imageId) { return !keepIds.includes(imageId); })
            .forEach(function(imageId) { removeImage.run(id, imageId); });
        const setPosition = db.prepare('UPDATE blog_images SET position = ? WHERE post_id = ? AND id = ?');
        keepIds.forEach(function(imageId, position) {
            setPosition.run(position, id, imageId);
        });
        insertImages(db, id, session.userId, decoded, keepIds.length);
        db.prepare('UPDATE blog_posts SET content = ?, updated_at = ? WHERE id = ?')
            .run(text, new Date().toISOString(), id);
    });
    return { status: 200 };
}

export async function handleBlogApi(req, res, url, session, json) {
    const access = blogAccess(session);
    if (!access.canView) return json(res, 403, { ok: false, error: '无权查看博客' });
    const db = getDatabase();
    if (req.method === 'GET' && url.pathname.startsWith('/api/blog/images/')) {
        const image = getImage(db, url.pathname.split('/').at(-1));
        if (!image) return json(res, 404, { ok: false, error: '图片不存在' });
        const bytes = Buffer.from(image.imageData);
        res.writeHead(200, {
            'Content-Type': image.mimeType,
            'Content-Length': bytes.length,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store'
        });
        return res.end(bytes);
    }
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
            if (size > MAX_REQUEST_BYTES) return json(res, 413, { ok: false, error: '图片或内容过大' });
            chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (req.method === 'POST') {
            const postId = createPost(db, session, body.content, body.images);
            return json(res, 201, { ok: true, id: postId });
        }
        const result = changePost(db, id, session, body.content, false,
            { keepImageIds: body.keepImageIds, images: body.images });
        return json(res, result.status, { ok: result.status === 200, error: result.error });
    } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
    }
}
