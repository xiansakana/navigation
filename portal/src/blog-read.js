import { visibilityFilter, canViewPost } from './blog-visibility.js';
import { normalizeContent, renderMarkdown, contentSearchText, normalizeSearch } from './blog-content.js';
import { commentAccess } from './blog-comments.js';

function groupByPost(rows) {
    const groups = new Map();
    for (const { postId, ...row } of rows) {
        const group = groups.get(postId);
        if (group) group.push(row);
        else groups.set(postId, [row]);
    }
    return groups;
}

export function presentBlogPosts(rows, tagRows, legacyRows, mediaRows, commentRows) {
    const tags = groupByPost(tagRows), legacy = groupByPost(legacyRows), media = groupByPost(mediaRows);
    const counts = new Map(commentRows.map(row => [row.postId, Number(row.count)]));
    return rows.map(row => {
        const items = (media.get(row.id) || []).map(item => ({ ...item, position: Number(item.position), url: '/api/blog/media/' + item.id, thumbnailUrl: '/api/blog/media/' + item.id + '?thumbnail=1' }));
        const oldImages = (legacy.get(row.id) || []).map(image => ({ id: image.id, kind: 'image', position: Number(image.position), url: '/api/blog/images/' + image.id }));
        const { locationJson, audience, period, startsAt, endsAt, ...post } = row;
        return { ...post, commentCount: counts.get(row.id) || 0, visibility: { audience, period, startsAt, endsAt }, location: locationJson ? JSON.parse(locationJson) : null, contentHtml: row.contentFormat === 'markdown' ? renderMarkdown(row.content) : null, content: normalizeContent(row.content, row.contentFormat, true), tags: (tags.get(row.id) || []).map(item => item.tag), images: [...oldImages, ...items.filter(item => item.kind === 'image')],
            videos: items.filter(item => item.kind === 'video') };
    });
}

export function getImage(db, id, session = {}) {
    const parent = db.prepare('SELECT post_id FROM blog_images WHERE id = ?').get(id);
    if (!parent || !canViewPost(db, parent.post_id, session)) return undefined;
    return db.prepare('SELECT i.mime_type AS mimeType, i.image_data AS imageData FROM blog_images i JOIN blog_posts p ON p.id = i.post_id WHERE i.id = ?').get(id);
}

export function listPosts(db, before, limit = 20, tag = '', query = '', session = {}, now = new Date().toISOString()) {
    const search = normalizeSearch(query);
    if (search) {
        const update = db.prepare('UPDATE blog_posts SET search_text = ? WHERE id = ?');
        for (const row of db.prepare('SELECT id, content, content_format FROM blog_posts WHERE search_text IS NULL').all()) {
            update.run(contentSearchText(row.content, row.content_format), row.id);
        }
    }
    const cursor = before ? db.prepare('SELECT created_at, id FROM blog_posts WHERE id = ?').get(before) : null;
    if (before && !cursor) return [];
    const filter = visibilityFilter(session, 'blog_posts', now);
    const conditions = [filter.sql];
    const params = [...filter.params];
    if (cursor) {
        conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    if (tag) {
        conditions.push('EXISTS (SELECT 1 FROM blog_post_tags t WHERE t.post_id = blog_posts.id AND t.tag = ?)');
        params.push(tag);
    }
    if (search) {
        conditions.push(`(instr(search_text, ?) > 0 OR instr(lower(author_name), ?) > 0
            OR EXISTS (SELECT 1 FROM blog_post_tags s WHERE s.post_id = blog_posts.id AND instr(lower(s.tag), ?) > 0)
            OR instr(lower(COALESCE(json_extract(location_json, '$.label'), '')), ?) > 0)`);
        params.push(search, search, search, search);
    }
    const rows = db.prepare(`SELECT id, author_id AS authorId, author_name AS authorName,
        content, content_format AS contentFormat, location_json AS locationJson, audience, visibility_period AS period, visible_from AS startsAt, visible_until AS endsAt, created_at AS createdAt, updated_at AS updatedAt FROM blog_posts
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit);
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map(row => row.id));
    const pageIds = 'post_id IN (SELECT value FROM json_each(?))';
    const tags = db.prepare(`SELECT post_id AS postId, tag FROM blog_post_tags WHERE ${pageIds} ORDER BY rowid`).all(ids);
    const legacy = db.prepare(`SELECT post_id AS postId, id, position FROM blog_images WHERE ${pageIds} ORDER BY position, id`).all(ids);
    const media = db.prepare(`SELECT post_id AS postId, id, kind, position, mime_type AS mimeType, thumbnail_data IS NOT NULL AS thumbnailReady
        FROM blog_media WHERE ${pageIds} ORDER BY position, id`).all(ids);
    const counts = commentAccess(session).canViewComments
        ? db.prepare(`SELECT post_id AS postId, COUNT(*) AS count FROM blog_comments WHERE ${pageIds} GROUP BY post_id`).all(ids)
        : [];
    return presentBlogPosts(rows, tags, legacy, media, counts);
}


export function listVisibleTags(db, session, now) {
    const filter = visibilityFilter(session, 'p', now);
    return db.prepare(`SELECT t.tag, COUNT(*) AS count FROM blog_post_tags t JOIN blog_posts p ON p.id = t.post_id
        WHERE ${filter.sql} GROUP BY t.tag ORDER BY count DESC, t.tag`).all(...filter.params);
}

export function getVisibleMedia(db, id, session, now, thumbnail = false) {
    const filter = visibilityFilter(session, 'p', now);
    return db.prepare(`SELECT m.url, m.storage_key AS storageKey, m.mime_type AS mimeType ${thumbnail ? ', m.thumbnail_data AS thumbnailData' : ''} FROM blog_media m JOIN blog_posts p ON p.id = m.post_id
        WHERE m.id = ? AND ${filter.sql}`).get(id, ...filter.params);
}
