import { caseFilterSql } from './mingli-filters.js';

const read = row => {
  if (!row) return row;
  const metadata = JSON.parse(row.metadata_json);
  return { id: row.id, title: row.title, documentId: row.document_id, documentTitle: row.document_title,
    topic: row.topic, sourceUrl: '/knowledge/?document=' + row.document_id + (metadata.anchor ? '#' + metadata.anchor : ''),
    originalUrl: row.source_url, birth: JSON.parse(row.birth_json), chart: JSON.parse(row.chart_json),
    notes: row.notes, ...metadata, createdAt: row.created_at, updatedAt: row.updated_at };
};

export function createPostgresKnowledgeCaseStore(db) {
  const base = ` FROM navigation.mingli_knowledge_cases c
    JOIN navigation.knowledge_documents d ON d.id=c.document_id AND d.user_id=c.user_id
    WHERE c.user_id=$1 AND d.status IN ('ready','failed') AND d.notes<>''`;
  async function list(uid, { search = '', filters = {}, documentId = '', offset = 0, limit = 30 } = {}) {
    let where = base, params = [uid];
    const add = (sql, ...values) => {
      let index = params.length + 1;
      where += ' AND (' + sql.replace(/\?/g, () => '$' + (index++)) + ')';
      params.push(...values);
    };
    if (search) {
      const value = '%' + String(search).slice(0, 100).replace(/[!%_]/g, '!$&') + '%';
      let index = params.length + 1;
      where += ` AND (c.title ILIKE $${index} ESCAPE '!' OR c.notes ILIKE $${index + 1} ESCAPE '!'
        OR d.title ILIKE $${index + 2} ESCAPE '!' OR d.tags_json ILIKE $${index + 3} ESCAPE '!')`;
      params.push(value, value, value, value);
    }
    if (documentId) {
      if (!/^[a-f0-9]{32}$/.test(documentId)) throw new Error('来源筛选无效');
      let index = params.length + 1;
      where += ' AND c.document_id=$' + index;
      params.push(documentId);
    }
    const advanced = caseFilterSql(filters, { postgres: true });
    for (const clause of advanced.clauses) add(clause.replace(/\bnotes\b/g, 'c.notes'));
    params.push(...advanced.args);
    const counts = (await db.query('SELECT count(*) AS total,count(DISTINCT substr(c.case_key,1,8)) AS "uniqueCharts"' + where, params)).rows[0];
    const limitIndex = params.length + 1;
    const cases = (await db.query('SELECT c.*,d.title AS document_title,d.topic,d.source_url' + where
      + ' ORDER BY c.updated_at DESC,c.id LIMIT $' + limitIndex + ' OFFSET $' + (limitIndex + 1),
    [...params, limit, offset])).rows.map(read);
    const documents = (await db.query(`SELECT d.id,d.title,count(*) AS count${base} GROUP BY d.id,d.title ORDER BY d.title`, [uid])).rows
      .map(row => ({ ...row, count: Number(row.count) }));
    return { cases, total: Number(counts.total), uniqueCharts: Number(counts.uniqueCharts), documents, offset, limit };
  }
  async function get(uid, id) {
    return read((await db.query('SELECT c.*,d.title AS document_title,d.topic,d.source_url' + base + ' AND c.id=$2', [uid, id])).rows[0]);
  }
  return { list, get, sync() {}, syncDocument() {}, removeDocument() {} };
}
