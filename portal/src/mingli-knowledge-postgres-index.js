import { knowledgeCaseRows, knowledgeCaseStamp } from './mingli-knowledge-store.js';

// The caller holds the document row lock so the note and its case index commit together.
export async function syncPostgresKnowledgeCases(client, row) {
  const { digest, stamp } = knowledgeCaseStamp(row), owner = [row.user_id, row.id];
  const { rows: [prior] } = await client.query(`SELECT content_hash FROM navigation.mingli_knowledge_index
    WHERE user_id=$1 AND document_id=$2`, owner);
  if (prior?.content_hash !== digest) {
    const cases = knowledgeCaseRows(row);
    await client.query(`DELETE FROM navigation.mingli_knowledge_cases
      WHERE user_id=$1 AND document_id=$2 AND NOT (case_key=ANY($3::text[]))`, [...owner, cases.map(item => item.key)]);
    if (cases.length) await client.query(`INSERT INTO navigation.mingli_knowledge_cases
      (id,user_id,document_id,case_key,title,birth_json,chart_json,notes,metadata_json,created_at,updated_at)
      SELECT id,$1,$2,key,title,birth,chart,notes,metadata,$4,$4 FROM jsonb_to_recordset($3::jsonb)
        AS extracted(id text,key text,title text,birth text,chart text,notes text,metadata text)
      ON CONFLICT(user_id,document_id,case_key) DO UPDATE SET title=excluded.title,birth_json=excluded.birth_json,
        chart_json=excluded.chart_json,notes=excluded.notes,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
    [...owner, JSON.stringify(cases), new Date().toISOString()]);
  }
  await client.query(`INSERT INTO navigation.mingli_knowledge_index(user_id,document_id,content_hash,source_stamp)
    VALUES($1,$2,$3,$4) ON CONFLICT(user_id,document_id) DO UPDATE SET content_hash=excluded.content_hash,source_stamp=excluded.source_stamp`,
  [...owner, digest, stamp]);
}
