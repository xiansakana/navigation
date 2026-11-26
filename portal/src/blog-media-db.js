const mediaTables = /\bblog_(?:posts|media_cleanup|media|video_parts|video_uploads)\b/g;
const integerFields = ['position', 'byte_size', 'part_number', 'progress', 'attempts'];

function nativeQuery(db, sql, values) {
  let position = 0;
  return db.query(sql.replace(mediaTables, table => 'navigation.' + table).replace(/\?/g, () => '$' + ++position), values);
}

function normalizeRow(row) {
  if (row) for (const name of integerFields) {
    if (row[name] == null) continue;
    const value = Number(row[name]);
    if (!Number.isSafeInteger(value)) throw new Error('媒体数据超出整数范围');
    row[name] = value;
  }
  return row;
}

export function readBlogMediaRow(db, sql, ...values) {
  return db.query ? nativeQuery(db, sql, values).then(result => normalizeRow(result.rows[0])) : db.prepare(sql).get(...values);
}

export function readBlogMediaRows(db, sql, ...values) {
  return db.query ? nativeQuery(db, sql, values).then(result => result.rows.map(normalizeRow)) : db.prepare(sql).all(...values);
}

export function writeBlogMediaRow(db, sql, ...values) {
  return db.query ? nativeQuery(db, sql, values) : db.prepare(sql).run(...values);
}
