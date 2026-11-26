import { createHash, randomUUID } from 'node:crypto';
import { commentAccess, parseCommentContent } from './blog-comments.js';
import { contentSearchText, normalizeContent, normalizeLocation, normalizeSearch, normalizeTags, renderMarkdown } from './blog-content.js';
import { normalizeMediaPosition } from './blog-media-storage.js';
import { presentBlogPosts } from './blog-read.js';
import { normalizeVisibility, postWriteAccess, visibilityFilter } from './blog-visibility.js';

const key = () => randomUUID().replaceAll('-', '');
const date = () => new Date().toISOString();
const missingComment = { status: 404, error: '评论不存在或不可见' };
const bind = (statement, offset = 0) => statement.replace(/\?/g, () => '$' + ++offset);
const first = async (client, query, args) => (await client.query(query, args)).rows[0];

async function enqueueCleanup(client, items, uid, kind = 'object') {
  for (const item of items) {
    if (!item.storageKey || item.storageKey.startsWith('/') || item.storageKey.split('/').includes('..')) throw new Error('媒体存储路径无效');
    const multipartId = item.multipartId || '', at = date();
    const id = createHash('sha256').update(JSON.stringify([kind, item.storageKey, multipartId])).digest('hex');
    await client.query(`INSERT INTO navigation.blog_media_cleanup (id,user_id,kind,storage_key,multipart_id,next_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (id) DO NOTHING`, [id, uid, kind, item.storageKey, multipartId, at]);
  }
}

async function visiblePost(client, id, session, now, lock = false) {
  const filter = visibilityFilter(session, 'p', now);
  return first(client, `SELECT p.author_id FROM navigation.blog_posts p WHERE p.id=$1 AND ${bind(filter.sql, 1)}${lock ? ' FOR SHARE' : ''}`, [id, ...filter.params]);
}

async function getPost(db, id, lock = false) {
  return first(db, 'SELECT * FROM navigation.blog_posts WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id]);
}

async function setTags(client, id, tags) {
  await client.query('DELETE FROM navigation.blog_post_tags WHERE post_id=$1', [id]);
  if (tags.length) await client.query('INSERT INTO navigation.blog_post_tags (post_id,tag) SELECT $1, unnest($2::text[])', [id, tags]);
}

async function forgetUpload(client, id) {
  await client.query('DELETE FROM navigation.blog_video_uploads WHERE id=$1', [id]);
  await client.query('DELETE FROM navigation.blog_video_parts WHERE upload_id=$1', [id]);
}

async function insertMedia(client, id, userId, item, position) {
  const last = await first(client, 'SELECT max(position) AS position FROM navigation.blog_media WHERE post_id=$1', [id]);
  const mediaId = key();
  await client.query(`INSERT INTO navigation.blog_media
    (id,post_id,author_id,kind,mime_type,url,storage_key,position,created_at,thumbnail_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [mediaId, id, userId, item.kind, item.mimeType, item.url, item.storageKey,
    normalizeMediaPosition(position) ?? (last.position === null ? 0 : Number(last.position) + 1), date(), item.thumbnailData || null]);
  return { status: 201, id: mediaId, url: '/api/blog/media/' + mediaId };
}

export function createPostgresBlogRepository(db) {
  return {
    db,
    async listVisibleTags(session, now) {
      const filter = visibilityFilter(session, 'p', now);
      const { rows } = await db.query(`SELECT t.tag, count(*) AS count FROM navigation.blog_post_tags t
        JOIN navigation.blog_posts p ON p.id=t.post_id WHERE ${bind(filter.sql)}
        GROUP BY t.tag ORDER BY count DESC, t.tag`, filter.params);
      return rows.map(row => ({ ...row, count: Number(row.count) }));
    },
    async listPosts(before, limit, tag, query, session, now) {
      const search = normalizeSearch(query);
      if (search) {
        const unindexed = await db.query('SELECT id,content,content_format FROM navigation.blog_posts WHERE search_text IS NULL');
        for (const row of unindexed.rows) {
          await db.query('UPDATE navigation.blog_posts SET search_text=$1 WHERE id=$2 AND search_text IS NULL',
            [contentSearchText(row.content, row.content_format), row.id]);
        }
      }
      return db.transaction(async client => {
        const cursor = before ? await first(client, 'SELECT created_at,id FROM navigation.blog_posts WHERE id=$1', [before]) : null;
        if (before && !cursor) return [];
        const filter = visibilityFilter(session, 'p', now);
        const conditions = [filter.sql], params = [...filter.params];
        if (cursor) {
          conditions.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
          params.push(cursor.created_at, cursor.created_at, cursor.id);
        }
        if (tag) {
          conditions.push('EXISTS (SELECT 1 FROM navigation.blog_post_tags t WHERE t.post_id=p.id AND t.tag=?)');
          params.push(tag);
        }
        if (search) {
          conditions.push(`(strpos(p.search_text, ?) > 0 OR strpos(lower(p.author_name COLLATE "C"), ?) > 0
            OR EXISTS (SELECT 1 FROM navigation.blog_post_tags t WHERE t.post_id=p.id AND strpos(lower(t.tag COLLATE "C"), ?) > 0)
            OR strpos(lower(coalesce(p.location_json::jsonb->>'label','') COLLATE "C"), ?) > 0)`);
          params.push(search, search, search, search);
        }
        const { rows } = await client.query(bind(`SELECT p.id,p.author_id AS "authorId",p.author_name AS "authorName",p.content,
          p.content_format AS "contentFormat",p.location_json AS "locationJson",p.audience,p.visibility_period AS period,
          p.visible_from AS "startsAt",p.visible_until AS "endsAt",p.created_at AS "createdAt",p.updated_at AS "updatedAt"
          FROM navigation.blog_posts p WHERE ${conditions.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`), [...params, limit]);
        if (!rows.length) return [];
        const ids = rows.map(row => row.id);
        const tags = await client.query('SELECT post_id AS "postId",tag FROM navigation.blog_post_tags WHERE post_id=ANY($1::text[]) ORDER BY _sqlite_rowid', [ids]);
        const legacy = await client.query('SELECT post_id AS "postId",id,position FROM navigation.blog_images WHERE post_id=ANY($1::text[]) ORDER BY position,id', [ids]);
        const media = await client.query(`SELECT post_id AS "postId",id,kind,position,mime_type AS "mimeType",thumbnail_data IS NOT NULL AS "thumbnailReady"
          FROM navigation.blog_media WHERE post_id=ANY($1::text[]) ORDER BY position,id`, [ids]);
        const comments = commentAccess(session).canViewComments
          ? (await client.query('SELECT post_id AS "postId",count(*) AS count FROM navigation.blog_comments WHERE post_id=ANY($1::text[]) GROUP BY post_id', [ids])).rows
          : [];
        return presentBlogPosts(rows, tags.rows, legacy.rows, media.rows, comments);
      }, { readOnly: true });
    },
    getImage(id, session) {
      const filter = visibilityFilter(session, 'p');
      return first(db, `SELECT i.mime_type AS "mimeType",i.image_data AS "imageData" FROM navigation.blog_images i
        JOIN navigation.blog_posts p ON p.id=i.post_id WHERE i.id=$1 AND ${bind(filter.sql, 1)}`, [id, ...filter.params]);
    },
    getVisibleMedia(id, session, now, thumbnail) {
      const filter = visibilityFilter(session, 'p', now);
      return first(db, `SELECT m.url,m.storage_key AS "storageKey",m.mime_type AS "mimeType"
        ${thumbnail ? ',m.thumbnail_data AS "thumbnailData"' : ''} FROM navigation.blog_media m
        JOIN navigation.blog_posts p ON p.id=m.post_id WHERE m.id=$1 AND ${bind(filter.sql, 1)}`, [id, ...filter.params]);
    },
    async createPost(session, content, hasMedia, options = {}) {
      const format = options.contentFormat ?? 'text';
      const text = normalizeContent(content, format, hasMedia === true), tags = normalizeTags(options.tags);
      const location = normalizeLocation(options.location), id = key(), now = date();
      const visibility = normalizeVisibility(options.visibility ?? {}, now);
      await db.transaction(async client => {
        await client.query(`INSERT INTO navigation.blog_posts
          (id,author_id,author_name,content,content_format,search_text,location_json,audience,visibility_period,visible_from,visible_until,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [id, session.userId, session.username, text, format, contentSearchText(text, format), location ? JSON.stringify(location) : null,
          visibility.audience, visibility.period, visibility.startsAt, visibility.endsAt, now]);
        await setTags(client, id, tags);
      });
      return id;
    },
    async canChangePost(id, session) {
      return postWriteAccess(await getPost(db, id), session);
    },
    addMedia(id, session, item, position) {
      return db.transaction(async client => {
        const access = postWriteAccess(await getPost(client, id, true), session);
        if (access.status !== 200) return access;
        return insertMedia(client, id, session.userId, item, position);
      });
    },
    completeVideo(upload, session, item) {
      return db.transaction(async client => {
        const access = postWriteAccess(await getPost(client, upload.post_id, true), session);
        if (access.status !== 200) return access;
        const current = await first(client, 'SELECT state FROM navigation.blog_video_uploads WHERE id=$1 FOR UPDATE', [upload.id]);
        if (!current || current.state !== 'storing') return { status: 404 };
        const result = await insertMedia(client, upload.post_id, session.userId, item, upload.position);
        await client.query("UPDATE navigation.blog_video_uploads SET state='done',progress=100,media_id=$1 WHERE id=$2", [result.id, upload.id]);
        return result;
      });
    },
    changePost(id, session, content, remove = false, options = {}) {
      return db.transaction(async client => {
        const post = await getPost(client, id, true), access = postWriteAccess(post, session);
        if (access.status !== 200) return access;
        const { rows: allMedia } = await client.query('SELECT id,storage_key AS "storageKey" FROM navigation.blog_media WHERE post_id=$1', [id]);
        if (remove) {
          await enqueueCleanup(client, allMedia, session.userId);
          const { rows: uploads } = await client.query('SELECT id,multipart_id,storage_key FROM navigation.blog_video_uploads WHERE post_id=$1', [id]);
          for (const upload of uploads) {
            const local = upload.multipart_id === 'local';
            await enqueueCleanup(client, [{ storageKey: upload.storage_key, multipartId: local ? upload.id : upload.multipart_id }], session.userId, local ? 'local' : 'multipart');
            await forgetUpload(client, upload.id);
          }
          for (const table of ['blog_media', 'blog_images', 'blog_post_tags', 'blog_comments']) {
            await client.query('DELETE FROM navigation.' + table + ' WHERE post_id=$1', [id]);
          }
          await client.query('DELETE FROM navigation.blog_posts WHERE id=$1', [id]);
          return { status: 200, removedMedia: allMedia };
        }
        const legacy = (await client.query('SELECT id FROM navigation.blog_images WHERE post_id=$1', [id])).rows.map(row => row.id);
        const existing = [...legacy, ...allMedia.map(row => row.id)];
        const keep = options.keepMediaIds ?? existing;
        if (!Array.isArray(keep) || new Set(keep).size !== keep.length || keep.some(mediaId => !existing.includes(mediaId))) throw new Error('文章媒体参数无效');
        const removedMedia = allMedia.filter(item => !keep.includes(item.id));
        const format = options.contentFormat ?? 'text', text = normalizeContent(content, format, keep.length > 0);
        const location = options.location === undefined ? post.location_json : JSON.stringify(normalizeLocation(options.location));
        const visibility = options.visibility === undefined
          ? { audience: post.audience, period: post.visibility_period, startsAt: post.visible_from, endsAt: post.visible_until }
          : normalizeVisibility(options.visibility, post.created_at);
        await enqueueCleanup(client, removedMedia, session.userId);
        await client.query('DELETE FROM navigation.blog_images WHERE post_id=$1 AND NOT (id=ANY($2::text[]))', [id, keep]);
        await client.query('DELETE FROM navigation.blog_media WHERE post_id=$1 AND NOT (id=ANY($2::text[]))', [id, keep]);
        if (options.tags !== undefined) await setTags(client, id, normalizeTags(options.tags));
        await client.query(`UPDATE navigation.blog_posts SET content=$1,content_format=$2,search_text=$3,location_json=$4,
          audience=$5,visibility_period=$6,visible_from=$7,visible_until=$8,updated_at=$9 WHERE id=$10`,
        [text, format, contentSearchText(text, format), location, visibility.audience, visibility.period,
          visibility.startsAt, visibility.endsAt, date(), id]);
        return { status: 200, removedMedia };
      });
    },
    async listComments(id, session, before) {
      const access = commentAccess(session);
      if (!access.canViewComments) return { status: 404, error: '评论不可见' };
      return db.transaction(async client => {
        const author = await visiblePost(client, id, session);
        if (!author) return { status: 404, error: '评论不可见' };
        const cursor = before ? await first(client, 'SELECT created_at,id FROM navigation.blog_comments WHERE id=$1 AND post_id=$2', [before, id]) : null;
        if (before && !cursor) return { status: 400, error: '评论分页无效' };
        const { rows } = await client.query(`SELECT id,author_id AS "authorId",author_name AS "authorName",content,
          content_format AS "contentFormat",created_at AS "createdAt" FROM navigation.blog_comments WHERE post_id=$1
          ${cursor ? 'AND (created_at < $2 OR (created_at = $2 AND id < $3))' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`,
        cursor ? [id, cursor.created_at, cursor.id] : [id]);
        const more = rows.length > 20;
        if (more) rows.pop();
        return { status: 200, comments: rows.map(item => ({ ...item,
          contentHtml: item.contentFormat === 'markdown' ? renderMarkdown(item.content) : null,
          canDelete: !session.isGuest && (access.canManageComments || (access.canComment && (item.authorId === session.userId || author.author_id === session.userId))),
        })), next: more ? rows.at(-1).id : null };
      }, { readOnly: true });
    },
    createComment(id, session, value) {
      if (!commentAccess(session).canComment) return { status: 403, error: '无权发表评论' };
      return db.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['blog-comment:' + session.userId]);
        if (!await visiblePost(client, id, session, date(), true)) return { status: 404, error: '博客不存在或不可见' };
        const { content, error } = parseCommentContent(value);
        if (error) return { status: 400, error };
        const last = await first(client, 'SELECT created_at FROM navigation.blog_comments WHERE author_id=$1 ORDER BY created_at DESC LIMIT 1', [session.userId]);
        if (last && Date.now() - Date.parse(last.created_at) < 2000) return { status: 429, error: '评论太快，请稍后再试' };
        const commentId = key();
        await client.query(`INSERT INTO navigation.blog_comments (id,post_id,author_id,author_name,content,created_at,content_format)
          VALUES ($1,$2,$3,$4,$5,$6,'markdown')`, [commentId, id, session.userId, session.username, content, date()]);
        return { status: 201, id: commentId };
      });
    },
    deleteComment(id, session) {
      return db.transaction(async client => {
        const row = await first(client, 'SELECT post_id,author_id FROM navigation.blog_comments WHERE id=$1', [id]);
        if (!row) return missingComment;
        const post = await visiblePost(client, row.post_id, session, date(), true);
        if (!post) return missingComment;
        const access = commentAccess(session);
        if (session.isGuest || !(access.canManageComments || access.canComment && (row.author_id === session.userId || post.author_id === session.userId))) {
          return { status: 403, error: '无权删除评论' };
        }
        await client.query('DELETE FROM navigation.blog_comments WHERE id=$1', [id]);
        return { status: 200 };
      });
    },
    enqueueCleanup: (items, uid, kind) => enqueueCleanup(db, items, uid, kind),
    async readLocation(id) {
      return (await first(db, 'SELECT location_json FROM navigation.blog_posts WHERE id=$1', [id]))?.location_json;
    },
    async updateLocation(id, previous, location) {
      await db.query('UPDATE navigation.blog_posts SET location_json=$1 WHERE id=$2 AND location_json=$3', [location, id, previous]);
    },
  };
}
