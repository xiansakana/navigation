import crypto from 'node:crypto';
import { calculateChart } from './mingli-chart.js';
import { prepareWenZhenImport } from './mingli-import.js';
import { createMingliCategories } from './mingli-categories.js';

export function createMingliStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mingli_cases (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    birth_json TEXT NOT NULL, chart_json TEXT NOT NULL, tags_json TEXT NOT NULL,
    notes TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS mingli_cases_owner ON mingli_cases(user_id, updated_at DESC);`);
  const columns = db.prepare('PRAGMA table_info(mingli_cases)').all().map(c => c.name);
  for (const name of ['source_type', 'source_key', 'source_json', 'category_id']) if (!columns.includes(name)) db.exec('ALTER TABLE mingli_cases ADD COLUMN ' + name + ' TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS mingli_cases_source ON mingli_cases(user_id, source_type, source_key)');
  db.exec('CREATE INDEX IF NOT EXISTS mingli_cases_category ON mingli_cases(user_id,category_id)');
  const categories = createMingliCategories(db);
  const selectCases = 'SELECT *, (SELECT name FROM mingli_categories g WHERE g.id=mingli_cases.category_id AND g.user_id=mingli_cases.user_id) AS category_name FROM mingli_cases';
  const read = row => row && ({ id: row.id, name: row.name, birth: JSON.parse(row.birth_json),
    chart: JSON.parse(row.chart_json), tags: JSON.parse(row.tags_json), notes: row.notes,
    createdAt: row.created_at, updatedAt: row.updated_at, categoryId: row.category_id || null, categoryName: row.category_name || null, source: row.source_json ? JSON.parse(row.source_json) : null });
  const get = (uid, id) => read(db.prepare(selectCases + ' WHERE user_id = ? AND id = ?').get(uid, id));
  return {
    get, categories,
    list(uid, { search = '', categoryId = '', offset = 0, limit = 30 } = {}) {
      const pattern = '%' + String(search).slice(0, 100).replace(/[!%_]/g, '!$&') + '%';
      let where = "user_id = ? AND (name LIKE ? ESCAPE '!' OR notes LIKE ? ESCAPE '!' OR tags_json LIKE ? ESCAPE '!')";
      const args = [uid, pattern, pattern, pattern];
      if (categoryId === 'uncategorized') where += ' AND category_id IS NULL';
      else if (categoryId) {
        if (!/^[a-f0-9]{32}$/.test(categoryId)) throw new Error('分类筛选无效');
        where += ' AND category_id=?'; args.push(categoryId);
      }
      const total = db.prepare('SELECT count(*) AS count FROM mingli_cases WHERE ' + where).get(...args).count;
      const cases = db.prepare(selectCases + ' WHERE ' + where + ' ORDER BY updated_at DESC, id LIMIT ? OFFSET ?').all(...args, limit, offset)
        .map(read).map(({ chart, notes, source, ...item }) => ({ ...item, source: source ? { provider: source.provider, matched: source.matched } : null, pillars: chart.pillars.map(p => p.ganZhi), notePreview: notes.slice(0, 120) }));
      return { cases, total, offset, limit };
    },
    save(uid, raw, id = null) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('案例格式无效');
      const name = String(raw.name ?? '').trim();
      if (!name || name.length > 80) throw new Error('案例名称需为 1—80 字');
      const notes = String(raw.notes ?? '');
      if (notes.length > 20000) throw new Error('笔记最多 20000 字');
      if (!Array.isArray(raw.tags) || raw.tags.length > 12 || raw.tags.some(t => typeof t !== 'string' || t.length > 30)) throw new Error('最多 12 个标签，每个不超过 30 字');
      const previous = id ? get(uid, id) : null;
      if (id && !previous) return null;
      const categoryId = raw.categoryId === undefined ? previous?.categoryId || null : categories.validate(uid, raw.categoryId);
      const chart = calculateChart(raw.birth), tags = [...new Set(raw.tags.map(t => t.trim()).filter(Boolean))];
      const now = new Date().toISOString();
      if (id) {
        db.prepare('UPDATE mingli_cases SET name=?, birth_json=?, chart_json=?, tags_json=?, notes=?, updated_at=?,category_id=? WHERE user_id=? AND id=?')
          .run(name, JSON.stringify(chart.input), JSON.stringify(chart), JSON.stringify(tags), notes, now, categoryId, uid, id);
      } else {
        id = crypto.randomBytes(16).toString('hex');
        db.prepare('INSERT INTO mingli_cases (id,user_id,name,birth_json,chart_json,tags_json,notes,created_at,updated_at,category_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, uid, name, JSON.stringify(chart.input), JSON.stringify(chart), JSON.stringify(tags), notes, now, now, categoryId);
      }
      return get(uid, id);
    },
    importWenZhen(uid, bundle, commit = false) {
      const prepared = prepareWenZhenImport(bundle);
      const exists = db.prepare('SELECT id FROM mingli_cases WHERE user_id=? AND source_type=? AND source_key=?');
      const rows = prepared.rows.map(r => ({ ...r, duplicate: !!exists.get(uid, 'wenzhen', r.source.key) }));
      const summary = { total: prepared.total, valid: rows.length, duplicates: rows.filter(r => r.duplicate).length,
        matched: rows.filter(r => r.source.matched).length, mismatches: rows.filter(r => !r.source.matched).length, errors: prepared.errors };
      if (!commit) return { ...summary, preview: rows.map(r => ({ name: r.name, solar: r.chart.solar, clock: r.chart.clock, gender: r.birth.gender, group: r.source.group,
        originalPillars: r.source.originalPillars, pillars: r.chart.pillars.map(p => p.ganZhi).join(''), duplicate: r.duplicate, matched: r.source.matched })) };
      if (prepared.errors.length) throw new Error('存在无效案例，请先修正文件后重新预览');
      if (summary.mismatches) throw new Error('存在四柱不一致的案例，需人工核对后再导入');
      let imported = 0;
      const ids = [];
      db.transaction(() => {
        for (const row of rows) {
          if (exists.get(uid, 'wenzhen', row.source.key)) continue;
          const id = crypto.randomBytes(16).toString('hex'), now = new Date().toISOString();
          const categoryId = row.source.group && row.source.group !== '全部' ? categories.ensure(uid, row.source.group) : null;
          db.prepare('INSERT INTO mingli_cases (id,user_id,name,birth_json,chart_json,tags_json,notes,created_at,updated_at,source_type,source_key,source_json,category_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id, uid, row.name, JSON.stringify(row.birth), JSON.stringify(row.chart), JSON.stringify(row.tags), row.notes, now, now, 'wenzhen', row.source.key, JSON.stringify(row.source), categoryId);
          ids.push(id); imported++;
        }
      })();
      return { ...summary, imported, duplicates: rows.length - imported, ids };
    },
    remove(uid, id) { return db.prepare('DELETE FROM mingli_cases WHERE user_id=? AND id=?').run(uid, id).changes > 0; }
  };
}
