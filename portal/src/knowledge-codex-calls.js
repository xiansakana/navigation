function validateCall(input) {
  if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','prompt','result','state','model','sessionId'].includes(k))
    ||!/^[a-f0-9-]{16,64}$/i.test(input.id||'')||!['running','succeeded','failed','cancelled'].includes(input.state)
    ||typeof input.prompt!=='string'||input.prompt.length>100000||typeof input.result!=='string'||input.result.length>500000
    ||typeof input.model!=='string'||input.model.length>160||typeof input.sessionId!=='string'||input.sessionId.length>100)throw new Error('Codex调用记录无效');
}

export function createPostgresKnowledgeCodexCalls(db) {
  return {
    record(uid, document, input, lease) {
      validateCall(input);
      return db.transaction(async client => {
        const { rows: [active] } = await client.query(`SELECT attempt FROM navigation.knowledge_documents
          WHERE user_id=$1 AND id=$2 AND status='processing' AND backend='codex' AND lease=$3 AND heartbeat>=$4 FOR UPDATE`,
        [uid, document.id, lease, new Date(Date.now() - 15 * 60000).toISOString()]);
        if (!active) return false;
        const key = [uid, document.id, active.attempt, input.id];
        const { rows: [prior] } = await client.query(`SELECT prompt,model,state FROM navigation.knowledge_codex_calls
          WHERE user_id=$1 AND document_id=$2 AND attempt=$3 AND id=$4`, key);
        if (prior && (prior.prompt !== input.prompt || prior.model !== input.model)) throw new Error('Codex调用内容不一致');
        if (prior && prior.state !== 'running') return true;
        await client.query(`INSERT INTO navigation.knowledge_codex_calls
          (user_id,document_id,attempt,id,prompt,result,state,model,session_id,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT(user_id,document_id,attempt,id) DO UPDATE SET
          result=excluded.result,state=excluded.state,session_id=excluded.session_id,updated_at=excluded.updated_at`,
        [...key, input.prompt, input.result, input.state, input.model, input.sessionId, Date.now()]);
        return true;
      });
    },
  };
}

// Worker leases establish ownership; callers cannot supply a Portal user or document owner.
export function createKnowledgeCodexCalls(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_codex_calls (
    user_id TEXT NOT NULL,document_id TEXT NOT NULL,attempt INTEGER NOT NULL,id TEXT NOT NULL,
    prompt TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,document_id,attempt,id));
    CREATE INDEX IF NOT EXISTS knowledge_codex_call_document ON knowledge_codex_calls(user_id,document_id,created_at);`);
  return {record(uid,document,input) {
    validateCall(input);
    const prior=db.prepare('SELECT * FROM knowledge_codex_calls WHERE user_id=? AND document_id=? AND attempt=? AND id=?').get(uid,document.id,document.attempt,input.id);
    if(prior&&(prior.prompt!==input.prompt||prior.model!==input.model))throw new Error('Codex调用内容不一致');
    if(prior&&prior.state!=='running')return;
    const now=Date.now();
    db.prepare(`INSERT INTO knowledge_codex_calls VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,document_id,attempt,id)
      DO UPDATE SET result=excluded.result,state=excluded.state,session_id=excluded.session_id,updated_at=excluded.updated_at`)
      .run(uid,document.id,document.attempt,input.id,input.prompt,input.result,input.state,input.model,input.sessionId,prior?.created_at||now,now);
  }};
}
