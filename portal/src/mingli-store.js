import crypto from 'node:crypto';
import { calculateChart } from './mingli-chart.js';

export function createMingliStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mingli_cases (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    birth_json TEXT NOT NULL, chart_json TEXT NOT NULL, tags_json TEXT NOT NULL,
    notes TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS mingli_cases_owner ON mingli_cases(user_id, updated_at DESC);`);
  const read = row => row && ({ id: row.id, name: row.name, birth: JSON.parse(row.birth_json),
    chart: JSON.parse(row.chart_json), tags: JSON.parse(row.tags_json), notes: row.notes,
    createdAt: row.created_at, updatedAt: row.updated_at });
  const get = (uid, id) => read(db.prepare('SELECT * FROM mingli_cases WHERE user_id = ? AND id = ?').get(uid, id));
  return {
    get,
    list(uid, { search = '', offset = 0, limit = 30 } = {}) {
      const pattern = '%' + String(search).slice(0, 100).replace(/[!%_]/g, '!$&') + '%';
      const where = "user_id = ? AND (name LIKE ? ESCAPE '!' OR notes LIKE ? ESCAPE '!' OR tags_json LIKE ? ESCAPE '!')";
      const args = [uid, pattern, pattern, pattern];
      const total = db.prepare('SELECT count(*) AS count FROM mingli_cases WHERE ' + where).get(...args).count;
      const cases = db.prepare('SELECT * FROM mingli_cases WHERE ' + where + ' ORDER BY updated_at DESC, id LIMIT ? OFFSET ?').all(...args, limit, offset)
        .map(read).map(({ chart, notes, ...item }) => ({ ...item, pillars: chart.pillars.map(p => p.ganZhi), notePreview: notes.slice(0, 120) }));
      return { cases, total, offset, limit };
    },
    save(uid, raw, id = null) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('案例格式无效');
      const name = String(raw.name ?? '').trim();
      if (!name || name.length > 80) throw new Error('案例名称需为 1—80 字');
      const notes = String(raw.notes ?? '');
      if (notes.length > 20000) throw new Error('笔记最多 20000 字');
      if (!Array.isArray(raw.tags) || raw.tags.length > 12 || raw.tags.some(t => typeof t !== 'string' || t.length > 30)) throw new Error('最多 12 个标签，每个不超过 30 字');
      if (id && !get(uid, id)) return null;
      const chart = calculateChart(raw.birth), tags = [...new Set(raw.tags.map(t => t.trim()).filter(Boolean))];
      const now = new Date().toISOString();
      if (id) {
        db.prepare('UPDATE mingli_cases SET name=?, birth_json=?, chart_json=?, tags_json=?, notes=?, updated_at=? WHERE user_id=? AND id=?')
          .run(name, JSON.stringify(chart.input), JSON.stringify(chart), JSON.stringify(tags), notes, now, uid, id);
      } else {
        id = crypto.randomBytes(16).toString('hex');
        db.prepare('INSERT INTO mingli_cases VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, uid, name, JSON.stringify(chart.input), JSON.stringify(chart), JSON.stringify(tags), notes, now, now);
      }
      return get(uid, id);
    },
    remove(uid, id) { return db.prepare('DELETE FROM mingli_cases WHERE user_id=? AND id=?').run(uid, id).changes > 0; }
  };
}
