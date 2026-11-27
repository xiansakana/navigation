import crypto from 'node:crypto';

const newId = () => crypto.randomBytes(16).toString('hex');
const kinds = { expense: ['支出', '已报销', '退款入账', '报销入账'], income: ['收入'] };
export const categoryKind = type => Object.keys(kinds).find(k => kinds[k].includes(type)) || null;

function name(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 200) throw new Error('名称应为 1 至 200 个字符');
  return s;
}

const categoryRow = (row) => ({ ...row, sort_order: Number(row.sort_order), archived: Number(row.archived) });

export function createPostgresBookkeepingCatalog(db) {
  const one = async (run, sql, args = []) => (await run.query(sql, args)).rows[0];
  const many = async (run, sql, args = []) => (await run.query(sql, args)).rows;

  async function get(run, uid, cid) {
    const row = await one(run, 'SELECT * FROM navigation.bookkeeping_categories WHERE user_id=$1 AND id=$2', [uid, cid]);
    if (!row) throw new Error('分类不存在');
    return categoryRow(row);
  }

  async function nextSort(run, uid, kind, parent) {
    const row = await one(run, `SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM navigation.bookkeeping_categories
      WHERE user_id=$1 AND kind=$2 AND parent_id=$3`, [uid, kind, parent]);
    return Number(row.n);
  }

  async function ensureGroup(uid, group, run = db) {
    const g = name(group);
    await run.query(`INSERT INTO navigation.bookkeeping_groups(id,user_id,name,sort_order)
      SELECT $1,$2,$3,COALESCE(MAX(sort_order),-1)+1 FROM navigation.bookkeeping_groups WHERE user_id=$2
      ON CONFLICT DO NOTHING`, [newId(), uid, g]);
  }

  async function ensureCategory(uid, kind, primary, sub = '', run = db) {
    if (!kind) return;
    const insert = async (n, parent) => {
      await run.query(`INSERT INTO navigation.bookkeeping_categories(id,user_id,kind,parent_id,name,sort_order)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [newId(), uid, kind, parent, name(n), await nextSort(run, uid, kind, parent)]);
      const row = await one(run, `SELECT id FROM navigation.bookkeeping_categories
        WHERE user_id=$1 AND kind=$2 AND parent_id=$3 AND name=$4`, [uid, kind, parent, name(n)]);
      return row.id;
    };
    const cid = await insert(primary || '其他', '');
    if (sub) await insert(sub, cid);
  }

  async function seed(uid, run = db) {
    if (await one(run, 'SELECT 1 FROM navigation.bookkeeping_catalog_init WHERE user_id=$1', [uid])) return;
    const rows = await many(run, `SELECT DISTINCT type,category,subcategory FROM navigation.bookkeeping_entries
      WHERE user_id=$1 ORDER BY _sqlite_rowid`, [uid]);
    for (const row of rows) await ensureCategory(uid, categoryKind(row.type), row.category, row.subcategory, run);
    for (const c of ['餐饮', '购物', '交通', '住房', '娱乐', '医疗', '学习', '通讯', '旅行', '人情', '其他']) await ensureCategory(uid, 'expense', c, '', run);
    for (const c of ['工资', '奖金', '福利', '其他']) await ensureCategory(uid, 'income', c, '', run);
    const groups = await many(run, `SELECT DISTINCT group_name FROM navigation.bookkeeping_accounts
      WHERE user_id=$1 ORDER BY _sqlite_rowid`, [uid]);
    for (const row of groups) await ensureGroup(uid, row.group_name, run);
    await run.query('INSERT INTO navigation.bookkeeping_catalog_init(user_id) VALUES($1) ON CONFLICT DO NOTHING', [uid]);
  }

  async function usage(run, uid, row) {
    const types = kinds[row.kind], primary = row.parent_id ? (await get(run, uid, row.parent_id)).name : row.name;
    const args = [uid, primary, ...types];
    let clause = '';
    if (row.parent_id) { args.push(row.name); clause = ' AND subcategory=$' + args.length; }
    const result = await one(run, `SELECT COUNT(*) AS n FROM navigation.bookkeeping_entries
      WHERE user_id=$1 AND category=$2 AND type IN (${types.map((_, i) => '$' + (i + 3)).join(',')})${clause}`, args);
    return Number(result.n);
  }

  async function list(uid, run = db) {
    await seed(uid, run);
    const rows = await many(run, `SELECT * FROM navigation.bookkeeping_categories
      WHERE user_id=$1 ORDER BY kind,parent_id,sort_order,_sqlite_rowid`, [uid]);
    const out = [];
    for (const r of rows) {
      out.push({ id: r.id, kind: r.kind, parentId: r.parent_id, name: r.name, icon: r.icon,
        sortOrder: Number(r.sort_order), archived: !!Number(r.archived), count: await usage(run, uid, r) });
    }
    return out;
  }

  async function groupList(uid, run = db) {
    await seed(uid, run);
    const rows = await many(run, `SELECT g.*,COUNT(a.id) AS count FROM navigation.bookkeeping_groups g
      LEFT JOIN navigation.bookkeeping_accounts a ON a.user_id=g.user_id AND a.group_name=g.name
      WHERE g.user_id=$1 GROUP BY g.id ORDER BY g.sort_order,g._sqlite_rowid`, [uid]);
    return rows.map(g => ({ id: g.id, name: g.name, sortOrder: Number(g.sort_order), count: Number(g.count) }));
  }

  async function updateEntries(run, uid, row, primary, sub) {
    const types = kinds[row.kind];
    const args = row.parent_id
      ? [primary, sub, uid, (await get(run, uid, row.parent_id)).name, row.name]
      : [primary, uid, row.name];
    const result = await run.query(row.parent_id
      ? `UPDATE navigation.bookkeeping_entries SET category=$1,subcategory=$2
        WHERE user_id=$3 AND category=$4 AND subcategory=$5 AND type IN (${types.map((_, i) => '$' + (i + 6)).join(',')})`
      : `UPDATE navigation.bookkeeping_entries SET category=$1
        WHERE user_id=$2 AND category=$3 AND type IN (${types.map((_, i) => '$' + (i + 4)).join(',')})`,
    [...args, ...types]);
    return result.rowCount;
  }

  async function save(uid, input, cid, run = db) {
    await seed(uid, run);
    const old = cid ? await get(run, uid, cid) : null, kind = old?.kind || input.kind;
    if (!kinds[kind]) throw new Error('分类类型应为支出或收入');
    const parentId = input.parentId ?? old?.parent_id ?? '';
    const parent = parentId ? await get(run, uid, parentId) : null;
    if (parent && (parent.parent_id || parent.kind !== kind || parent.archived)) throw new Error('请选择同类型的启用一级分类');
    if (old && !!old.parent_id !== !!parentId) throw new Error('不能更改分类层级，请使用合并');
    if (parentId === cid) throw new Error('分类不能成为自己的上级');
    const n = name(input.name), icon = String(input.icon ?? old?.icon ?? '◈').slice(0, 20), archived = input.archived === true ? 1 : 0;
    if (await one(run, `SELECT 1 FROM navigation.bookkeeping_categories
      WHERE user_id=$1 AND kind=$2 AND parent_id=$3 AND name=$4 AND id!=$5`, [uid, kind, parentId, n, cid || ''])) {
      throw new Error('同级分类名称已存在，可使用合并');
    }
    if (old && (old.name !== n || old.parent_id !== parentId)) await updateEntries(run, uid, old, parent?.name || n, n);
    const id = cid || newId();
    await run.query(`INSERT INTO navigation.bookkeeping_categories(id,user_id,kind,parent_id,name,icon,sort_order,archived)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,icon=excluded.icon,archived=excluded.archived`,
    [id, uid, kind, parentId, n, icon, await nextSort(run, uid, kind, parentId), archived]);
    return id;
  }

  async function merge(uid, fromId, targetId, run = db) {
    const source = await get(run, uid, fromId), target = await get(run, uid, targetId);
    if (fromId === targetId || source.kind !== target.kind || !!source.parent_id !== !!target.parent_id
      || target.archived || (target.parent_id && (await get(run, uid, target.parent_id)).archived)) {
      throw new Error('请合并到其他同类型、同层级的启用分类');
    }
    const changed = await updateEntries(run, uid, source,
      target.parent_id ? (await get(run, uid, target.parent_id)).name : target.name, target.name);
    if (!source.parent_id) {
      const children = await many(run, 'SELECT * FROM navigation.bookkeeping_categories WHERE user_id=$1 AND parent_id=$2', [uid, fromId]);
      for (const child of children) {
        const duplicate = await one(run, 'SELECT id FROM navigation.bookkeeping_categories WHERE user_id=$1 AND parent_id=$2 AND name=$3',
          [uid, targetId, child.name]);
        if (duplicate) await run.query('DELETE FROM navigation.bookkeeping_categories WHERE user_id=$1 AND id=$2', [uid, child.id]);
        else await run.query('UPDATE navigation.bookkeeping_categories SET parent_id=$1 WHERE user_id=$2 AND id=$3', [targetId, uid, child.id]);
      }
    }
    await run.query('DELETE FROM navigation.bookkeeping_categories WHERE user_id=$1 AND id=$2', [uid, fromId]);
    return { changed };
  }

  async function remove(uid, cid, run = db) {
    const row = await get(run, uid, cid);
    if (await usage(run, uid, row)) throw new Error('分类已有账单，请停用或合并到其他分类');
    await run.query('DELETE FROM navigation.bookkeeping_categories WHERE user_id=$1 AND (id=$2 OR parent_id=$2)', [uid, cid]);
  }

  async function reorder(uid, type, ids, run = db) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new Error('排序列表无效');
    const table = type === 'groups' ? 'bookkeeping_groups' : 'bookkeeping_categories';
    const actual = (await many(run, `SELECT id FROM navigation.${table} WHERE user_id=$1`, [uid])).map(r => r.id);
    if (ids.length !== actual.length || ids.some(cid => !actual.includes(cid))) throw new Error('排序列表与当前用户数据不一致，请刷新');
    for (const [i, cid] of ids.entries()) {
      await run.query(`UPDATE navigation.${table} SET sort_order=$1 WHERE user_id=$2 AND id=$3`, [i, uid, cid]);
    }
  }

  async function saveGroup(uid, input, gid, run = db) {
    await seed(uid, run);
    const old = gid ? await one(run, 'SELECT * FROM navigation.bookkeeping_groups WHERE user_id=$1 AND id=$2', [uid, gid]) : null;
    if (gid && !old) throw new Error('资产分组不存在');
    const n = name(input.name);
    if (await one(run, 'SELECT 1 FROM navigation.bookkeeping_groups WHERE user_id=$1 AND name=$2 AND id!=$3', [uid, n, gid || ''])) {
      throw new Error('分组名称已存在，可使用合并');
    }
    if (old) {
      await run.query('UPDATE navigation.bookkeeping_accounts SET group_name=$1 WHERE user_id=$2 AND group_name=$3', [n, uid, old.name]);
      await run.query('UPDATE navigation.bookkeeping_groups SET name=$1 WHERE user_id=$2 AND id=$3', [n, uid, gid]);
    } else await ensureGroup(uid, n, run);
    if (gid) return gid;
    return (await one(run, 'SELECT id FROM navigation.bookkeeping_groups WHERE user_id=$1 AND name=$2', [uid, n])).id;
  }

  async function removeGroup(uid, gid, targetId = null, run = db) {
    const groups = await groupList(uid, run);
    const old = groups.find(g => g.id === gid), target = targetId && groups.find(g => g.id === targetId);
    if (!old) throw new Error('分组不存在');
    if (targetId && (!target || targetId === gid)) throw new Error('目标分组无效');
    if (old.count && !target) throw new Error('分组内有账户，请合并到其他分组');
    if (target) await run.query('UPDATE navigation.bookkeeping_accounts SET group_name=$1 WHERE user_id=$2 AND group_name=$3',
      [target.name, uid, old.name]);
    await run.query('DELETE FROM navigation.bookkeeping_groups WHERE user_id=$1 AND id=$2', [uid, gid]);
  }

  async function validateEntry(uid, input, old = null, run = db) {
    await seed(uid, run);
    const kind = categoryKind(input.type); if (!kind) return;
    const primary = await one(run, `SELECT * FROM navigation.bookkeeping_categories
      WHERE user_id=$1 AND kind=$2 AND parent_id='' AND name=$3`, [uid, kind, input.category]);
    const unchanged = old && categoryKind(old.type) === kind && old.category === input.category;
    if (!primary || (Number(primary.archived) && !unchanged)) throw new Error('分类不存在或已停用，请先在分类管理中维护');
    if (input.subcategory) {
      const child = await one(run, 'SELECT * FROM navigation.bookkeeping_categories WHERE user_id=$1 AND parent_id=$2 AND name=$3',
        [uid, primary.id, input.subcategory]);
      if (!child || (Number(child.archived) && !(unchanged && old.subcategory === input.subcategory))) throw new Error('二级分类不存在或已停用');
    }
  }

  return { seed, list, save, merge, remove, reorder, groupList, saveGroup, removeGroup, ensureGroup, ensureCategory, validateEntry };
}
