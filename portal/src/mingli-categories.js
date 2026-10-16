import crypto from 'node:crypto';

const ID = /^[a-f0-9]{32}$/;
function categoryName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 30) throw new Error('分类名称需为 1—30 字');
  return value.trim();
}

export function createMingliCategories(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mingli_categories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL, UNIQUE(user_id,name)
  ); CREATE TABLE IF NOT EXISTS mingli_feature_migrations (name TEXT PRIMARY KEY);`);
  const find = (uid, id) => db.prepare('SELECT id,name FROM mingli_categories WHERE user_id=? AND id=?').get(uid, id);
  const ensure = (uid, name) => {
    name = categoryName(name);
    const previous = db.prepare('SELECT id FROM mingli_categories WHERE user_id=? AND name=?').get(uid, name);
    if (previous) return previous.id;
    const id = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO mingli_categories VALUES (?,?,?,?)').run(id, uid, name, new Date().toISOString());
    return id;
  };
  // A one-time migration prevents deleted/renamed classifications from being recreated on later reads.
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM mingli_feature_migrations WHERE name=?').get('source-categories-v1')) return;
    for (const row of db.prepare("SELECT id,user_id,source_json FROM mingli_cases WHERE source_type='wenzhen' AND category_id IS NULL AND source_json IS NOT NULL").all()) {
      const name = JSON.parse(row.source_json).group;
      if (typeof name === 'string' && name.trim() && name !== '全部') {
        db.prepare('UPDATE mingli_cases SET category_id=? WHERE user_id=? AND id=?').run(ensure(row.user_id, name), row.user_id, row.id);
      }
    }
    db.prepare('INSERT INTO mingli_feature_migrations VALUES (?)').run('source-categories-v1');
  })();
  const validate = (uid, id) => {
    if (id == null || id === '') return null;
    if (typeof id !== 'string' || !ID.test(id) || !find(uid, id)) throw new Error('分类不存在或不属于当前用户');
    return id;
  };
  return {
    ensure, validate,
    list(uid) {
      return {
        categories: db.prepare(`SELECT g.id,g.name,count(c.id) AS count FROM mingli_categories g
          LEFT JOIN mingli_cases c ON c.category_id=g.id AND c.user_id=g.user_id
          WHERE g.user_id=? GROUP BY g.id ORDER BY g.created_at,g.name,g.id`).all(uid),
        uncategorized: db.prepare('SELECT count(*) AS count FROM mingli_cases WHERE user_id=? AND category_id IS NULL').get(uid).count,
        total: db.prepare('SELECT count(*) AS count FROM mingli_cases WHERE user_id=?').get(uid).count
      };
    },
    save(uid, raw, id = null) {
      const name = categoryName(raw?.name);
      if (id && !find(uid, id)) return null;
      const duplicate = db.prepare('SELECT id FROM mingli_categories WHERE user_id=? AND name=?').get(uid, name);
      if (duplicate && duplicate.id !== id) throw new Error('该分类名称已存在');
      if (id) db.prepare('UPDATE mingli_categories SET name=? WHERE user_id=? AND id=?').run(name, uid, id);
      else id = ensure(uid, name);
      return find(uid, id);
    },
    remove(uid, id) {
      return db.transaction(() => {
        if (!find(uid, id)) return null;
        const moved = db.prepare('UPDATE mingli_cases SET category_id=NULL WHERE user_id=? AND category_id=?').run(uid, id).changes;
        db.prepare('DELETE FROM mingli_categories WHERE user_id=? AND id=?').run(uid, id);
        return { moved };
      })();
    },
    assign(uid, ids, categoryId) {
      if (categoryId === undefined) throw new Error('请选择目标分类');
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error('每次请选择 1—200 个有效案例');
      ids = [...new Set(ids)];
      return db.transaction(() => {
        const selected = validate(uid, categoryId);
        const own = db.prepare('SELECT id FROM mingli_cases WHERE user_id=? AND id=?');
        if (ids.some(id => !own.get(uid, id))) return null;
        const update = db.prepare('UPDATE mingli_cases SET category_id=?,updated_at=? WHERE user_id=? AND id=?');
        const at = new Date().toISOString();
        for (const id of ids) update.run(selected, at, uid, id);
        return { count: ids.length };
      })();
    }
  };
}
