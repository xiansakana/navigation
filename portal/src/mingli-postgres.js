import crypto from 'node:crypto';
import { calculateChart } from './mingli-chart.js';
import { prepareWenZhenImport } from './mingli-import.js';
import { categoryName, parseMingliAssignmentIds } from './mingli-categories.js';
import { caseFilterSql } from './mingli-filters.js';
import { readMingliCase, summarizeMingliCase, summarizeMingliImport, validateMingliCase } from './mingli-store.js';

const newId = () => crypto.randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
const selectCases = `SELECT c.*, g.name AS category_name FROM navigation.mingli_cases c
  LEFT JOIN navigation.mingli_categories g ON g.id=c.category_id AND g.user_id=c.user_id`;
const bind = query => {
  let position = 0;
  return query.replace(/\?/g, () => '$' + ++position);
};

export function createMingliPostgresStore(db) {
  const getCase = async (queryable, uid, id) => readMingliCase((await queryable.query(
    selectCases + ' WHERE c.user_id=$1 AND c.id=$2', [uid, id]
  )).rows[0]);
  const write = (uid, run) => db.transaction(async client => {
    // Serialize category deletion, reassignment and import for one owner.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['mingli:' + uid]);
    return run(client);
  });
  const getCategory = async (client, uid, id) => (await client.query(
    'SELECT id,name FROM navigation.mingli_categories WHERE user_id=$1 AND id=$2', [uid, id]
  )).rows[0];
  async function resolveCategory(client, uid, id) {
    if (id == null || id === '') return null;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !await getCategory(client, uid, id)) {
      throw new Error('分类不存在或不属于当前用户');
    }
    return id;
  }
  const findCategory = async (client, uid, name) => (await client.query(
    'SELECT id,name FROM navigation.mingli_categories WHERE user_id=$1 AND lower(name)=lower($2 COLLATE "C")', [uid, name]
  )).rows[0];
  async function insertCategory(client, uid, name) {
    const normalized = categoryName(name);
    const existing = await findCategory(client, uid, normalized);
    if (existing) return existing;
    return (await client.query(
      'INSERT INTO navigation.mingli_categories (id,user_id,name,created_at) VALUES ($1,$2,$3,$4) RETURNING id,name',
      [newId(), uid, normalized, now()]
    )).rows[0];
  }

  return {
    get: (uid, id) => getCase(db, uid, id),
    async list(uid, { search = '', categoryId = '', filters = {}, offset = 0, limit = 30 } = {}) {
      const conditions = ['c.user_id = ?'], args = [uid];
      if (search !== '') {
        const pattern = '%' + String(search).slice(0, 100).replace(/[!%_]/g, '!$&') + '%';
        const fields = ['c.name', 'c.notes', 'c.tags_json'];
        conditions.push('(' + fields.map(field => `lower(${field} COLLATE "C") LIKE lower(? COLLATE "C") ESCAPE '!'`).join(' OR ') + ')');
        args.push(pattern, pattern, pattern);
      }
      if (categoryId === 'uncategorized') conditions.push('c.category_id IS NULL');
      else if (categoryId) {
        if (!/^[a-f0-9]{32}$/.test(categoryId)) throw new Error('分类筛选无效');
        conditions.push('c.category_id=?');
        args.push(categoryId);
      }
      const advanced = caseFilterSql(filters, { postgres: true });
      conditions.push(...advanced.clauses);
      args.push(...advanced.args);
      const where = ' WHERE ' + conditions.join(' AND ');
      return db.transaction(async client => {
        const result = await client.query(bind(selectCases + where + ' ORDER BY c.updated_at DESC, c.id LIMIT ? OFFSET ?'), [...args, limit, offset]);
        const count = await client.query(bind('SELECT count(*) AS count FROM navigation.mingli_cases c' + where), args);
        return { cases: result.rows.map(readMingliCase).map(summarizeMingliCase), total: Number(count.rows[0].count), offset, limit };
      }, { readOnly: true });
    },
    async save(uid, raw, id) {
      const { name, notes, tags } = validateMingliCase(raw);
      return write(uid, async client => {
        const previous = id ? await getCase(client, uid, id) : null;
        if (id && !previous) return null;
        const category = raw.categoryId === undefined ? previous?.categoryId || null : await resolveCategory(client, uid, raw.categoryId);
        const chart = calculateChart(raw.birth);
        const values = [name, JSON.stringify(chart.input), JSON.stringify(chart), JSON.stringify(tags), notes, now(), category, uid];
        const key = id || newId();
        await client.query(id
          ? `UPDATE navigation.mingli_cases SET name=$1,birth_json=$2,chart_json=$3,tags_json=$4,notes=$5,updated_at=$6,category_id=$7
             WHERE user_id=$8 AND id=$9`
          : `INSERT INTO navigation.mingli_cases (name,birth_json,chart_json,tags_json,notes,updated_at,category_id,user_id,id,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6)`, [...values, key]);
        return getCase(client, uid, key);
      });
    },
    remove(uid, id) {
      return write(uid, async client => (await client.query('DELETE FROM navigation.mingli_cases WHERE user_id=$1 AND id=$2', [uid, id])).rowCount > 0);
    },
    async importWenZhen(uid, bundle, commit = false) {
      const prepared = prepareWenZhenImport(bundle);
      const run = async client => {
        const existing = await client.query(`SELECT source_key FROM navigation.mingli_cases
          WHERE user_id=$1 AND source_type='wenzhen' AND source_key=ANY($2::text[])`, [uid, prepared.rows.map(r => r.source.key)]);
        const keys = new Set(existing.rows.map(row => row.source_key));
        const summary = summarizeMingliImport(prepared, prepared.rows.map(row => ({ ...row, duplicate: keys.has(row.source.key) })), commit);
        if (!commit) return summary;
        const ids = [];
        for (const row of prepared.rows) {
          if (keys.has(row.source.key)) continue;
          const category = row.source.group && row.source.group !== '全部' ? await insertCategory(client, uid, row.source.group) : null;
          const id = newId();
          await client.query(`INSERT INTO navigation.mingli_cases
            (id,user_id,name,birth_json,chart_json,tags_json,notes,created_at,updated_at,source_type,source_key,source_json,category_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'wenzhen',$9,$10,$11)`,
          [id, uid, row.name, JSON.stringify(row.birth), JSON.stringify(row.chart), JSON.stringify(row.tags), row.notes, now(), row.source.key, JSON.stringify(row.source), category?.id || null]);
          keys.add(row.source.key);
          ids.push(id);
        }
        return { ...summary, imported: ids.length, duplicates: prepared.rows.length - ids.length, ids };
      };
      return commit ? write(uid, run) : run(db);
    },
    categories: {
      list(uid) {
        return db.transaction(async client => {
          const categories = (await client.query(`SELECT g.id,g.name, count(c.id) AS count FROM navigation.mingli_categories g
            LEFT JOIN navigation.mingli_cases c ON c.category_id=g.id AND c.user_id=g.user_id
            WHERE g.user_id=$1 GROUP BY g.id ORDER BY g.created_at,lower(g.name),g.id`, [uid])).rows;
          const { rows: [counts] } = await client.query(`SELECT count(*) AS total,
            count(*) FILTER (WHERE category_id IS NULL) AS uncategorized FROM navigation.mingli_cases WHERE user_id=$1`, [uid]);
          return { categories: categories.map(row => ({ ...row, count: Number(row.count) })), total: Number(counts.total), uncategorized: Number(counts.uncategorized) };
        }, { readOnly: true });
      },
      save(uid, raw, id) {
        const name = categoryName(raw?.name);
        return write(uid, async client => {
          if (id && !await getCategory(client, uid, id)) return null;
          const existing = await findCategory(client, uid, name);
          if (existing && existing.id !== id) throw new Error('该分类名称已存在');
          if (!id) return insertCategory(client, uid, name);
          return (await client.query('UPDATE navigation.mingli_categories SET name=$1 WHERE user_id=$2 AND id=$3 RETURNING id,name', [name, uid, id])).rows[0];
        });
      },
      remove(uid, id) {
        return write(uid, async client => {
          if (!await getCategory(client, uid, id)) return null;
          const moved = (await client.query('UPDATE navigation.mingli_cases SET category_id=NULL WHERE user_id=$1 AND category_id=$2', [uid, id])).rowCount;
          await client.query('DELETE FROM navigation.mingli_categories WHERE user_id=$1 AND id=$2', [uid, id]);
          return { moved };
        });
      },
      assign(uid, ids, categoryId) {
        const keys = parseMingliAssignmentIds(ids, categoryId);
        return write(uid, async client => {
          const category = await resolveCategory(client, uid, categoryId);
          const existing = (await client.query('SELECT id FROM navigation.mingli_cases WHERE user_id=$1 AND id=ANY($2::text[])', [uid, keys])).rowCount;
          if (existing !== keys.length) return null;
          const { rowCount } = await client.query(
            'UPDATE navigation.mingli_cases SET category_id=$1,updated_at=$2 WHERE user_id=$3 AND id=ANY($4::text[])', [category, now(), uid, keys]);
          return { count: rowCount };
        });
      },
    },
  };
}
