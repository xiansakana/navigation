import crypto from 'node:crypto';

const newId = () => crypto.randomBytes(16).toString('hex');
const kinds = { expense: ['支出', '已报销', '退款入账', '报销入账'], income: ['收入'] };
export const categoryKind = type => Object.keys(kinds).find(k => kinds[k].includes(type)) || null;
function name(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 200) throw new Error('名称应为 1 至 200 个字符');
  return s;
}
export function createBookkeepingCatalog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bookkeeping_categories (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,parent_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,icon TEXT NOT NULL DEFAULT '◈',sort_order INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id,kind,parent_id,name));
    CREATE TABLE IF NOT EXISTS bookkeeping_groups (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,name));
    CREATE TABLE IF NOT EXISTS bookkeeping_catalog_init (user_id TEXT PRIMARY KEY);`);
  function get(uid, cid) {
    const row = db.prepare('SELECT * FROM bookkeeping_categories WHERE user_id=? AND id=?').get(uid, cid);
    if (!row) throw new Error('分类不存在');
    return row;
  }
  function ensureGroup(uid, group) {
    const g = name(group);
    db.prepare('INSERT OR IGNORE INTO bookkeeping_groups(id,user_id,name,sort_order) VALUES (?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM bookkeeping_groups WHERE user_id=?))').run(newId(), uid, g, uid);
  }
  function ensureCategory(uid, kind, primary, sub = '') {
    if (!kind) return;
    const insert = (n, parent) => {
      db.prepare(`INSERT OR IGNORE INTO bookkeeping_categories(id,user_id,kind,parent_id,name,sort_order)
        VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM bookkeeping_categories WHERE user_id=? AND kind=? AND parent_id=?))`).run(newId(), uid, kind, parent, name(n), uid, kind, parent);
      return db.prepare('SELECT id FROM bookkeeping_categories WHERE user_id=? AND kind=? AND parent_id=? AND name=?').get(uid, kind, parent, name(n)).id;
    };
    const cid = insert(primary || '其他', '');
    if (sub) insert(sub, cid);
  }
  function seed(uid) {
    if (db.prepare('SELECT 1 FROM bookkeeping_catalog_init WHERE user_id=?').get(uid)) return;
    db.transaction(() => {
      for (const row of db.prepare('SELECT DISTINCT type,category,subcategory FROM bookkeeping_entries WHERE user_id=? ORDER BY rowid').all(uid)) {
        ensureCategory(uid, categoryKind(row.type), row.category, row.subcategory);
      }
      for (const c of ['餐饮', '购物', '交通', '住房', '娱乐', '医疗', '学习', '通讯', '旅行', '人情', '其他']) ensureCategory(uid, 'expense', c);
      for (const c of ['工资', '奖金', '福利', '其他']) ensureCategory(uid, 'income', c);
      for (const g of db.prepare('SELECT DISTINCT group_name FROM bookkeeping_accounts WHERE user_id=? ORDER BY rowid').all(uid)) ensureGroup(uid, g.group_name);
      db.prepare('INSERT OR IGNORE INTO bookkeeping_catalog_init VALUES (?)').run(uid);
    })();
  }
  function usage(uid, row) {
    const types = kinds[row.kind], primary = row.parent_id ? get(uid, row.parent_id).name : row.name;
    const clause = row.parent_id ? ' AND subcategory=?' : '';
    return db.prepare(`SELECT COUNT(*) AS n FROM bookkeeping_entries WHERE user_id=? AND category=? AND type IN (${types.map(() => '?').join(',')})${clause}`).get(uid, primary, ...types, ...(row.parent_id ? [row.name] : [])).n;
  }
  function list(uid) {
    seed(uid);
    return db.prepare('SELECT * FROM bookkeeping_categories WHERE user_id=? ORDER BY kind,parent_id,sort_order,rowid').all(uid).map(r => ({
      id: r.id, kind: r.kind, parentId: r.parent_id, name: r.name, icon: r.icon, sortOrder: r.sort_order, archived: !!r.archived, count: usage(uid, r)
    }));
  }
  function groupList(uid) {
    seed(uid);
    return db.prepare(`SELECT g.*,COUNT(a.id) AS count FROM bookkeeping_groups g LEFT JOIN bookkeeping_accounts a ON a.user_id=g.user_id AND a.group_name=g.name
      WHERE g.user_id=? GROUP BY g.id ORDER BY g.sort_order,g.rowid`).all(uid).map(g => ({ id:g.id, name:g.name, sortOrder:g.sort_order, count:g.count }));
  }
  function updateEntries(uid, row, primary, sub) {
    const types = kinds[row.kind];
    const sql = row.parent_id ? 'UPDATE bookkeeping_entries SET category=?,subcategory=? WHERE user_id=? AND category=? AND subcategory=?' : 'UPDATE bookkeeping_entries SET category=? WHERE user_id=? AND category=?';
    const args = row.parent_id ? [primary, sub, uid, get(uid, row.parent_id).name, row.name] : [primary, uid, row.name];
    return db.prepare(sql + ` AND type IN (${types.map(() => '?').join(',')})`).run(...args, ...types).changes;
  }
  function save(uid, input, cid) {
    seed(uid);
    return db.transaction(() => {
      const old = cid ? get(uid, cid) : null, kind = old?.kind || input.kind;
      if (!kinds[kind]) throw new Error('分类类型应为支出或收入');
      const parentId = input.parentId ?? old?.parent_id ?? '';
      const parent = parentId ? get(uid, parentId) : null;
      if (parent && (parent.parent_id || parent.kind !== kind || parent.archived)) throw new Error('请选择同类型的启用一级分类');
      if (old && !!old.parent_id !== !!parentId) throw new Error('不能更改分类层级，请使用合并');
      if (parentId === cid) throw new Error('分类不能成为自己的上级');
      const n = name(input.name), icon = String(input.icon ?? old?.icon ?? '◈').slice(0, 20), archived = input.archived === true ? 1 : 0;
      if (db.prepare('SELECT 1 FROM bookkeeping_categories WHERE user_id=? AND kind=? AND parent_id=? AND name=? AND id!=?').get(uid, kind, parentId, n, cid || '')) throw new Error('同级分类名称已存在，可使用合并');
      if (old && (old.name !== n || old.parent_id !== parentId)) updateEntries(uid, old, parent?.name || n, n);
      const id = cid || newId();
      db.prepare(`INSERT INTO bookkeeping_categories(id,user_id,kind,parent_id,name,icon,sort_order,archived)
        VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM bookkeeping_categories WHERE user_id=? AND kind=? AND parent_id=?),?)
        ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,icon=excluded.icon,archived=excluded.archived`).run(id, uid, kind, parentId, n, icon, uid, kind, parentId, archived);
      return id;
    })();
  }
  function merge(uid, fromId, targetId) {
    return db.transaction(() => {
      const source = get(uid, fromId), target = get(uid, targetId);
      if (fromId === targetId || source.kind !== target.kind || !!source.parent_id !== !!target.parent_id || target.archived || (target.parent_id && get(uid,target.parent_id).archived)) throw new Error('请合并到其他同类型、同层级的启用分类');
      const changed = updateEntries(uid, source, target.parent_id ? get(uid, target.parent_id).name : target.name, target.name);
      if (!source.parent_id) {
        for (const child of db.prepare('SELECT * FROM bookkeeping_categories WHERE user_id=? AND parent_id=?').all(uid, fromId)) {
          const duplicate = db.prepare('SELECT id FROM bookkeeping_categories WHERE user_id=? AND parent_id=? AND name=?').get(uid, targetId, child.name);
          if (duplicate) db.prepare('DELETE FROM bookkeeping_categories WHERE user_id=? AND id=?').run(uid, child.id);
          else db.prepare('UPDATE bookkeeping_categories SET parent_id=? WHERE user_id=? AND id=?').run(targetId, uid, child.id);
        }
      }
      db.prepare('DELETE FROM bookkeeping_categories WHERE user_id=? AND id=?').run(uid, fromId);
      return { changed };
    })();
  }
  function remove(uid, cid) {
    return db.transaction(() => {
      const row = get(uid, cid);
      if (usage(uid, row)) throw new Error('分类已有账单，请停用或合并到其他分类');
      db.prepare('DELETE FROM bookkeeping_categories WHERE user_id=? AND (id=? OR parent_id=?)').run(uid, cid, cid);
    })();
  }
  function reorder(uid, type, ids) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new Error('排序列表无效');
    const table = type === 'groups' ? 'bookkeeping_groups' : 'bookkeeping_categories';
    const actual = db.prepare(`SELECT id FROM ${table} WHERE user_id=?`).all(uid).map(r => r.id);
    if (ids.length !== actual.length || ids.some(cid => !actual.includes(cid))) throw new Error('排序列表与当前用户数据不一致，请刷新');
    db.transaction(() => ids.forEach((cid, i) => db.prepare(`UPDATE ${table} SET sort_order=? WHERE user_id=? AND id=?`).run(i, uid, cid)))();
  }
  function saveGroup(uid, input, gid) {
    seed(uid);
    return db.transaction(() => {
      const old = gid ? db.prepare('SELECT * FROM bookkeeping_groups WHERE user_id=? AND id=?').get(uid, gid) : null;
      if (gid && !old) throw new Error('资产分组不存在');
      const n = name(input.name);
      if (db.prepare('SELECT 1 FROM bookkeeping_groups WHERE user_id=? AND name=? AND id!=?').get(uid, n, gid || '')) throw new Error('分组名称已存在，可使用合并');
      if (old) {
        db.prepare('UPDATE bookkeeping_accounts SET group_name=? WHERE user_id=? AND group_name=?').run(n, uid, old.name);
        db.prepare('UPDATE bookkeeping_groups SET name=? WHERE user_id=? AND id=?').run(n, uid, gid);
      } else { ensureGroup(uid, n); }
      return gid || db.prepare('SELECT id FROM bookkeeping_groups WHERE user_id=? AND name=?').get(uid, n).id;
    })();
  }
  function removeGroup(uid, gid, targetId = null) {
    return db.transaction(() => {
      const old = groupList(uid).find(g => g.id === gid), target = targetId && groupList(uid).find(g => g.id === targetId);
      if (!old) throw new Error('分组不存在');
      if (targetId && (!target || targetId === gid)) throw new Error('目标分组无效');
      if (old.count && !target) throw new Error('分组内有账户，请合并到其他分组');
      if (target) db.prepare('UPDATE bookkeeping_accounts SET group_name=? WHERE user_id=? AND group_name=?').run(target.name, uid, old.name);
      db.prepare('DELETE FROM bookkeeping_groups WHERE user_id=? AND id=?').run(uid, gid);
    })();
  }
  function validateEntry(uid, input, old = null) {
    seed(uid); const kind = categoryKind(input.type); if (!kind) return;
    const primary = db.prepare('SELECT * FROM bookkeeping_categories WHERE user_id=? AND kind=? AND parent_id=? AND name=?').get(uid, kind, '', input.category);
    const unchanged = old && categoryKind(old.type) === kind && old.category === input.category;
    if (!primary || (primary.archived && !unchanged)) throw new Error('分类不存在或已停用，请先在分类管理中维护');
    if (input.subcategory) {
      const child = db.prepare('SELECT * FROM bookkeeping_categories WHERE user_id=? AND parent_id=? AND name=?').get(uid, primary.id, input.subcategory);
      if (!child || (child.archived && !(unchanged && old.subcategory === input.subcategory))) throw new Error('二级分类不存在或已停用');
    }
  }
  return { seed, list, save, merge, remove, reorder, groupList, saveGroup, removeGroup, ensureGroup, ensureCategory, validateEntry };
}
