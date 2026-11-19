export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rbac_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quotes (
      symbol TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS holdings_meta (
      symbol TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quant_user_state (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blog_posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blog_posts_created
      ON blog_posts (created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS blog_images (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      image_data BLOB NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blog_images_post
      ON blog_images (post_id, position);

    CREATE TABLE IF NOT EXISTS blog_media (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
      mime_type TEXT NOT NULL,
      url TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blog_media_post
      ON blog_media (post_id, position);

    CREATE TABLE IF NOT EXISTS quant_backtest_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_quant_backtests_user_created
      ON quant_backtest_results (user_id, created_at DESC);
  `);
  ensureRbacRevision(db);

  const ensureColumn = (table, column, definition) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS blog_post_tags (
      post_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (post_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_blog_post_tags_tag ON blog_post_tags (tag, post_id);
  `);
  ensureColumn('blog_posts', 'location_json', 'TEXT');
  ensureColumn('blog_posts', 'content_format', "TEXT NOT NULL DEFAULT 'text'");
  ensureColumn('blog_posts', 'search_text', 'TEXT');
  ensureColumn('blog_posts', 'audience', "TEXT NOT NULL DEFAULT 'public'");
  ensureColumn('blog_posts', 'visibility_period', "TEXT NOT NULL DEFAULT 'always'");
  ensureColumn('blog_posts', 'visible_from', 'TEXT');
  ensureColumn('blog_posts', 'visible_until', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS blog_media_cleanup (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      storage_key TEXT NOT NULL, multipart_id TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL,
      last_error TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blog_media_cleanup_due ON blog_media_cleanup (next_at);
    CREATE TABLE IF NOT EXISTS blog_video_uploads (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL, mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL, storage_key TEXT NOT NULL, multipart_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blog_video_uploads_post ON blog_video_uploads (post_id);
    CREATE TABLE IF NOT EXISTS blog_video_parts (
      upload_id TEXT NOT NULL, part_number INTEGER NOT NULL, etag TEXT NOT NULL, byte_size INTEGER NOT NULL,
      PRIMARY KEY (upload_id, part_number)
    );
  `);


  ensureColumn('blog_video_uploads', 'position', 'INTEGER');
  ensureColumn('blog_video_uploads', 'state', "TEXT NOT NULL DEFAULT 'uploading'");
  ensureColumn('blog_video_uploads', 'progress', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('blog_video_uploads', 'error', 'TEXT');
  ensureColumn('blog_video_uploads', 'media_id', 'TEXT');
  ensureColumn('blog_media', 'thumbnail_data', 'BLOB');
  ensureColumn('blog_media', 'thumbnail_attempts', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS blog_comments (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL, author_id TEXT NOT NULL,
    author_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_blog_comments_post ON blog_comments(post_id, created_at, id);`);
  ensureColumn('blog_comments', 'content_format', "TEXT NOT NULL DEFAULT 'text'");

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '6')").run();
  } else if (Number(row.value) < 6) {
    db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
  }
}

export function ensureRbacRevision(db) {
  const migrate = () => {
  if (!db.prepare('PRAGMA table_info(rbac_snapshot)').all().some(column => column.name === 'revision')) {
    db.exec('ALTER TABLE rbac_snapshot ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  // Also invalidate caches for legacy maintenance tools updating payload directly.
  db.exec(`CREATE TRIGGER IF NOT EXISTS rbac_payload_revision AFTER UPDATE OF payload ON rbac_snapshot
    WHEN NEW.revision = OLD.revision BEGIN
      UPDATE rbac_snapshot SET revision = OLD.revision + 1 WHERE id = NEW.id;
    END`);
  };
  if (db.transaction) db.transaction(migrate).immediate();
  else migrate();
}
