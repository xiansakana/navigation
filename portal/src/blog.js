import crypto from 'node:crypto';
import { enqueueMediaCleanup, kickMediaCleanup } from './blog-media-cleanup.js';
import { startVideoUpload, findVideoUpload, writeVideoPart, completedVideoParts, finishVideoUpload, forgetVideoUpload, abortVideoUpload } from './blog-video-upload.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { imageCacheHeaders, respondImageNotModified } from './blog-image-cache.js';
import { normalizeVisibility, blogAccess, postWriteAccess } from './blog-visibility.js';
import { getDatabase } from '../../shared/db/index.js';
import { findUserById, resolveUserPermissions } from './rbac.js';
import { portalIdentity } from './postgres-rbac.js';
import { uploadImage, uploadVideo, normalizeMediaPosition, withBlogMediaResponse } from './blog-media-storage.js';
import { normalizeContent, normalizeTags, normalizeLocation, contentSearchText, normalizeSearch } from './blog-content.js';
import { parseCoordinates, resolveAddress } from './blog-address.js';
import { commentAccess, listComments, createComment, deleteComment } from './blog-comments.js';
import { removeUploadFiles } from './blog-media-process.js';
import { getImage, listPosts, listVisibleTags, getVisibleMedia } from './blog-read.js';
import { readBlogMediaRow, readBlogMediaRows, writeBlogMediaRow } from './blog-media-db.js';
import { createPostgresBlogRepository } from './blog-postgres.js';
import { getBlogPostgresRepository } from './blog-postgres-runtime.js';

export { getImage, listPosts, listVisibleTags, getVisibleMedia } from './blog-read.js';
export { blogAccess } from './blog-visibility.js';

const MAX_REQUEST_BYTES = 128 * 1024;

export function validateContent(value, allowEmpty = false) {
    return normalizeContent(value, 'text', allowEmpty);
}

function transaction(db, operation) {
    db.exec('BEGIN');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createPost(db, session, content, hasMedia = false, options = {}) {
    const format = options.contentFormat ?? 'text';
    const text = normalizeContent(content, format, hasMedia === true);
    const tags = normalizeTags(options.tags);
    const location = normalizeLocation(options.location);
    const id = crypto.randomUUID().replaceAll('-', '');
    const now = new Date().toISOString();
    const visibility = normalizeVisibility(options.visibility ?? {}, now);
    transaction(db, () => {
        db.prepare('INSERT INTO blog_posts (id, author_id, author_name, content, content_format, search_text, location_json, audience, visibility_period, visible_from, visible_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, session.userId, session.username, text, format, contentSearchText(text, format), location ? JSON.stringify(location) : null, visibility.audience, visibility.period, visibility.startsAt, visibility.endsAt, now, now);
        for (const tag of tags) db.prepare('INSERT INTO blog_post_tags (post_id, tag) VALUES (?, ?)').run(id, tag);
    });
    return id;
}

export function canChangePost(db, id, session) {
    const row = db.prepare('SELECT author_id FROM blog_posts WHERE id = ?').get(id);
    return postWriteAccess(row, session);
}

export function addMedia(db, postId, session, item, position = null) {
    position = normalizeMediaPosition(position);
    const access = canChangePost(db, postId, session);
    if (access.status !== 200) return access;
    const id = crypto.randomUUID().replaceAll('-', '');
    const last = db.prepare('SELECT MAX(position) AS position FROM blog_media WHERE post_id = ?').get(postId);
    db.prepare('INSERT INTO blog_media (id, post_id, author_id, kind, mime_type, url, storage_key, position, created_at, thumbnail_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, postId, session.userId, item.kind, item.mimeType, item.url, item.storageKey,
            position ?? (last.position ?? -1) + 1, new Date().toISOString(), item.thumbnailData || null);
    return { status: 201, id, url: '/api/blog/media/' + id };
}

export function changePost(db, id, session, content, remove = false, options = {}) {
    const access = canChangePost(db, id, session);
    if (access.status !== 200) return access;
    if (remove) {
        const removedMedia = db.prepare('SELECT storage_key AS storageKey FROM blog_media WHERE post_id = ?').all(id);
        transaction(db, () => {
            enqueueMediaCleanup(db, removedMedia, session.userId);
            for (const upload of db.prepare('SELECT * FROM blog_video_uploads WHERE post_id = ?').all(id)) {
                enqueueMediaCleanup(db, [{ storageKey: upload.storage_key, multipartId: upload.multipart_id === 'local' ? upload.id : upload.multipart_id }], session.userId, upload.multipart_id === 'local' ? 'local' : 'multipart');
                forgetVideoUpload(db, upload.id);
            }
            db.prepare('DELETE FROM blog_media WHERE post_id = ?').run(id);
            db.prepare('DELETE FROM blog_images WHERE post_id = ?').run(id);
            db.prepare('DELETE FROM blog_post_tags WHERE post_id = ?').run(id);
            db.prepare('DELETE FROM blog_comments WHERE post_id = ?').run(id);
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
    const previous = db.prepare('SELECT location_json, created_at, audience, visibility_period, visible_from, visible_until FROM blog_posts WHERE id = ?').get(id);
    const visibility = options.visibility === undefined ? { audience: previous.audience, period: previous.visibility_period, startsAt: previous.visible_from, endsAt: previous.visible_until } : normalizeVisibility(options.visibility, previous.created_at);
    const location = options.location === undefined ? previous.location_json : JSON.stringify(normalizeLocation(options.location));
    const tags = options.tags === undefined ? null : normalizeTags(options.tags);
    const removedMedia = db.prepare('SELECT id, storage_key AS storageKey FROM blog_media WHERE post_id = ?').all(id)
        .filter(item => !keepIds.includes(item.id));
    transaction(db, () => {
        enqueueMediaCleanup(db, removedMedia, session.userId);
        for (const mediaId of existing) {
            if (keepIds.includes(mediaId)) continue;
            db.prepare('DELETE FROM blog_images WHERE post_id = ? AND id = ?').run(id, mediaId);
            db.prepare('DELETE FROM blog_media WHERE post_id = ? AND id = ?').run(id, mediaId);
        }
        if (tags) {
            db.prepare('DELETE FROM blog_post_tags WHERE post_id = ?').run(id);
            for (const tag of tags) db.prepare('INSERT INTO blog_post_tags (post_id, tag) VALUES (?, ?)').run(id, tag);
        }
        db.prepare('UPDATE blog_posts SET content = ?, content_format = ?, search_text = ?, location_json = ?, audience = ?, visibility_period = ?, visible_from = ?, visible_until = ?, updated_at = ? WHERE id = ?')
            .run(text, format, contentSearchText(text, format), location, visibility.audience, visibility.period, visibility.startsAt, visibility.endsAt, new Date().toISOString(), id);
    });
    return { status: 200, removedMedia };
}

function enrichLocation(repository, id) {
    setImmediate(async () => {
        try {
            const previous = await repository.readLocation(id);
            const location = previous && JSON.parse(previous);
            if (!location || location.label || location.latitude == null) return;
            const label = await resolveAddress(location);
            if (label) await repository.updateLocation(id, previous, JSON.stringify({ ...location, label }));
        } catch { /* A slow lookup can be retried when the post is edited. */ }
    }).unref();
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

const processing = new Set();
export const activeVideoJobs = () => processing.size;
export async function processVideoJob(db, upload, session, config) {
    if (processing.has(upload.id)) return;
    const deferred = config?.runtime?.externalWorkers && process.env.NAVIGATION_PROCESS_ROLE !== 'background';
    processing.add(upload.id);
    try {
        const result = await writeBlogMediaRow(db, "UPDATE blog_video_uploads SET state = 'queued', error = NULL WHERE id = ? AND state IN ('uploading','queued','compressing','storing')", upload.id);
        if (!(result.changes ?? result.rowCount) || deferred) { processing.delete(upload.id); return; }
    } catch (error) {
        processing.delete(upload.id);
        throw error;
    }
    const repository = db.query ? createPostgresBlogRepository(db) : sqliteBlogRepository(db);
    setImmediate(async () => {
        try {
            const existing = upload.multipart_id === 'local' ? await readBlogMediaRow(db, 'SELECT id FROM blog_media WHERE post_id = ? AND storage_key = ?', upload.post_id, upload.storage_key) : null;
            if (existing) {
                await writeBlogMediaRow(db, "UPDATE blog_video_uploads SET state = 'done', progress = 100, media_id = ? WHERE id = ?", existing.id, upload.id);
                return;
            }
            const item = await finishVideoUpload(db, upload);
            if (config) {
                const rbac = await portalIdentity.load(config), user = findUserById(rbac, upload.user_id);
                session = { userId: upload.user_id, permissions: user?.enabled ? resolveUserPermissions(rbac, user) : [], isGuest: false };
            }
            const result = await repository.completeVideo(upload, session, item);
            if (upload.multipart_id !== 'local') await repository.enqueueCleanup([{ storageKey: upload.storage_key }], session.userId);
            if (result.status !== 201) {
                await repository.enqueueCleanup([item], session.userId);
                throw new Error('博客已删除或上传已取消');
            }
        } catch (error) {
            try {
                if (upload.multipart_id === 'local') await repository.enqueueCleanup([{ storageKey: upload.storage_key }], upload.user_id);
                await writeBlogMediaRow(db, "UPDATE blog_video_uploads SET state = 'failed', error = ? WHERE id = ? AND state <> 'done'", error.message.slice(0, 500), upload.id);
            } catch (writeError) { console.error('[blog video]', writeError.code || writeError.name); }
        } finally {
            await removeUploadFiles(upload.id).catch(() => {});
            processing.delete(upload.id); kickMediaCleanup(db);
        }
    });
}
export async function resumeVideoJobs(db, config) {
    for (const upload of await readBlogMediaRows(db, "SELECT * FROM blog_video_uploads WHERE state IN ('queued', 'compressing', 'storing')")) {
        await processVideoJob(db, upload, { userId: upload.user_id, permissions: [], isGuest: false }, config);
    }
}

function sqliteBlogRepository(db) {
    return {
        db,
        listVisibleTags: (session, now) => listVisibleTags(db, session, now),
        listPosts: (...args) => listPosts(db, ...args),
        getImage: (id, session) => getImage(db, id, session),
        getVisibleMedia: (...args) => getVisibleMedia(db, ...args),
        listComments: (...args) => listComments(db, ...args),
        createComment: (...args) => createComment(db, ...args),
        deleteComment: (...args) => deleteComment(db, ...args),
        createPost: (...args) => createPost(db, ...args),
        canChangePost: (...args) => canChangePost(db, ...args),
        changePost: (...args) => changePost(db, ...args),
        addMedia: (...args) => addMedia(db, ...args),
        enqueueCleanup: (...args) => enqueueMediaCleanup(db, ...args),
        completeVideo(upload, session, item) {
            const current = db.prepare('SELECT 1 FROM blog_video_uploads WHERE id = ?').get(upload.id);
            const result = current ? addMedia(db, upload.post_id, session, item, upload.position) : { status: 404 };
            if (result.status === 201) db.prepare("UPDATE blog_video_uploads SET state='done',progress=100,media_id=? WHERE id=?").run(result.id, upload.id);
            return result;
        },
        readLocation: id => db.prepare('SELECT location_json FROM blog_posts WHERE id=?').get(id)?.location_json,
        updateLocation: (id, previous, location) => db.prepare('UPDATE blog_posts SET location_json=? WHERE id=? AND location_json=?').run(location, id, previous),
    };
}

export async function handleBlogApi(req, res, url, session, json, config) {
    res.setHeader?.('Cache-Control', 'private, no-store');
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
    const repository = await getBlogPostgresRepository() || sqliteBlogRepository(getDatabase());
    const db = repository.db;
    const commentsMatch = url.pathname.match(/^\/api\/blog\/posts\/([a-f0-9]{32})\/comments$/);
    const commentMatch = url.pathname.match(/^\/api\/blog\/comments\/([a-f0-9]{32})$/);
    if (commentsMatch || commentMatch) {
        try {
            if (req.method === 'POST' && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { ok: false, error: '请使用 JSON 请求' });
            let result;
            if (commentsMatch && req.method === 'GET') result = await repository.listComments(commentsMatch[1], session, url.searchParams.get('before'));
            else if (commentsMatch && req.method === 'POST') result = await repository.createComment(commentsMatch[1], session, (await readJson(req)).content);
            else if (commentMatch && req.method === 'DELETE') result = await repository.deleteComment(commentMatch[1], session);
            else result = { status: 405, error: '请求方法无效' };
            return json(res, result.status, { ...result, ok: result.status < 400 });
        } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/blog/images/')) {
        const image = await repository.getImage(url.pathname.split('/').at(-1), session);
        if (!image) return json(res, 404, { ok: false, error: '图片不存在' });
        const bytes = Buffer.from(image.imageData);
        const cache = imageCacheHeaders(bytes);
        if (respondImageNotModified(req, res, cache)) return;
        res.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': bytes.length,
            ...cache });
        return res.end(bytes);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/blog/media/')) {
        const thumbnail = url.searchParams.get('thumbnail') === '1';
        const media = await repository.getVisibleMedia(url.pathname.split('/').at(-1), session, undefined, thumbnail);
        if (!media) return json(res, 404, { ok: false, error: '媒体不存在' });
        if (thumbnail) {
            const placeholder = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#263247"/><text x="160" y="164" text-anchor="middle" fill="#b6c2d5" font-size="18">缩略图生成中</text></svg>';
            const bytes = media.thumbnailData ? Buffer.from(media.thumbnailData) : Buffer.from(placeholder);
            const cache = media.thumbnailData ? imageCacheHeaders(bytes) : { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
            if (media.thumbnailData && respondImageNotModified(req, res, cache)) return;
            res.writeHead(200, { 'Content-Type': media.thumbnailData ? 'image/jpeg' : 'image/svg+xml', 'Content-Length': bytes.length, ...cache });
            return res.end(bytes);
        }
        const cache = media.mimeType.startsWith('image/') ? imageCacheHeaders(url.pathname + '\n' + media.url) : { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
        if (cache.ETag && respondImageNotModified(req, res, cache)) return;
        try {
            await withBlogMediaResponse(media, req.headers.range, async upstream => {
            if (![200, 206, 416].includes(upstream.status)) throw new Error('媒体读取失败');
            const output = { 'Content-Type': media.mimeType, ...cache };
            for (const key of ['content-length', 'content-range', 'accept-ranges']) {
                if (upstream.headers.has(key)) output[key] = upstream.headers.get(key);
            }
            res.writeHead(upstream.status, output);
            if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
            else res.end();
            });
        } catch {
            if (res.headersSent) res.destroy();
            else json(res, 502, { ok: false, error: '媒体读取失败，请稍后重试' });
        }
        return;
    }
    if (req.method === 'GET' && url.pathname === '/api/blog/posts') {
        const before = url.searchParams.get('before');
        if (before && !/^[a-f0-9]{32}$/.test(before)) return json(res, 400, { ok: false, error: '分页参数无效' });
        const tag = url.searchParams.get('tag') || '';
        const query = url.searchParams.get('q') || '';
        try { normalizeTags([tag]); normalizeSearch(query); } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
        const tags = await repository.listVisibleTags(session);
        return json(res, 200, { ok: true, posts: await repository.listPosts(before, 20, tag, query, session), tags, ...access, ...commentAccess(session), userId: session.userId, isGuest: Boolean(session.isGuest) });
    }
    if (req.method === 'POST' && !access.canPost && !access.canManage) return json(res, 403, { ok: false, error: '无权发布博客' });
    const uploadMatch = url.pathname.match(/^\/api\/blog\/video-uploads\/([a-f0-9]{32})(?:\/parts\/([1-9]\d{0,4}))?$/);
    if (uploadMatch) {
        const upload = await findVideoUpload(db, uploadMatch[1], session);
        if (!upload) return json(res, 404, { ok: false, error: '视频上传不存在' });
        const allowed = await repository.canChangePost(upload.post_id, session);
        if (allowed.status !== 200) return json(res, allowed.status, { ok: false, error: allowed.error });
        try {
            if (req.method === 'GET' && !uploadMatch[2]) return json(res, 200, { ok: true, state: upload.state, progress: upload.progress, error: upload.error, id: upload.media_id, url: upload.media_id ? '/api/blog/media/' + upload.media_id : null });
            if (req.method === 'PUT' && uploadMatch[2]) {
                await writeVideoPart(db, upload, Number(uploadMatch[2]), req);
                return json(res, 200, { ok: true });
            }
            if (req.method === 'DELETE' && !uploadMatch[2]) {
                await abortVideoUpload(db, upload);
                return json(res, 200, { ok: true });
            }
            if (req.method === 'POST' && !uploadMatch[2]) {
                if (upload.state === 'uploading') {
                    await completedVideoParts(db, upload);
                    await processVideoJob(db, upload, session, config);
                }
                return json(res, 202, { ok: true, state: upload.state, processing: true });
            }
        } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
        return json(res, 405, { ok: false, error: '请求方法无效' });
    }
    const startMatch = url.pathname.match(/^\/api\/blog\/posts\/([a-f0-9]{32})\/video-uploads$/);
    if (startMatch && req.method === 'POST') {
        const allowed = await repository.canChangePost(startMatch[1], session);
        if (allowed.status !== 200) return json(res, allowed.status, { ok: false, error: allowed.error });
        try {
            const body = await readJson(req);
            const stale = await readBlogMediaRows(db, 'SELECT * FROM blog_video_uploads WHERE user_id = ? AND created_at < ?', session.userId, new Date(Date.now() - 86400000).toISOString());
            for (const upload of stale) await abortVideoUpload(db, upload);
            const result = await startVideoUpload(db, startMatch[1], session.userId, body.size, body.mimeType, body.position);
            return json(res, 201, { ok: true, ...result });
        } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    const match = url.pathname.match(/^\/api\/blog\/posts\/([a-f0-9]{32})(?:\/media)?$/);
    const id = match?.[1];
    if (req.method === 'DELETE') {
        const allowed = await repository.canChangePost(id, session);
        if (allowed.status !== 200) return json(res, allowed.status, { ok: false, error: allowed.error });
        const result = await repository.changePost(id, session, null, true);
        kickMediaCleanup(db);
        return json(res, result.status, { ok: result.status === 200, cleanupPending: Boolean(result.removedMedia?.length), error: result.error });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/media')) {
        const allowed = await repository.canChangePost(id, session);
        if (allowed.status !== 200) return json(res, allowed.status, { ok: false, error: allowed.error });
        try {
            const kind = url.searchParams.get('kind');
            const position = normalizeMediaPosition(url.searchParams.has('position') ? Number(url.searchParams.get('position')) : null);
            const item = kind === 'image'
                ? await uploadImage(req, (config.services || []).find(service => service.id === 'piclist'))
                : kind === 'video' ? await uploadVideo(req) : null;
            if (!item) throw new Error('媒体类型无效');
            const result = await repository.addMedia(id, session, item, position);
            if (result.status !== 201) { await repository.enqueueCleanup([item], session.userId); kickMediaCleanup(db); }
            return json(res, result.status, { ok: result.status === 201, id: result.id, url: result.url, error: result.error });
        } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return json(res, 415, { ok: false, error: '请使用 JSON 请求' });
    }
    try {
        const body = await readJson(req);
        if (req.method === 'POST') {
            const postId = await repository.createPost(session, body.content, body.hasMedia, { contentFormat: body.contentFormat, tags: body.tags, location: body.location, visibility: body.visibility });
            enrichLocation(repository, postId);
            return json(res, 201, { ok: true, id: postId });
        }
        const result = await repository.changePost(id, session, body.content, false, { keepMediaIds: body.keepMediaIds, contentFormat: body.contentFormat, tags: body.tags, location: body.location, visibility: body.visibility });
        if (result.status === 200) enrichLocation(repository, id);
        kickMediaCleanup(db);
        return json(res, result.status, { ok: result.status === 200, cleanupPending: Boolean(result.removedMedia?.length), error: result.error });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
}
