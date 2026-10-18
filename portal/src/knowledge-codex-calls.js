// Worker leases establish ownership; callers cannot supply a Portal user or document owner.
export function createKnowledgeCodexCalls(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_codex_calls (
    user_id TEXT NOT NULL,document_id TEXT NOT NULL,attempt INTEGER NOT NULL,id TEXT NOT NULL,
    prompt TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,document_id,attempt,id));
    CREATE INDEX IF NOT EXISTS knowledge_codex_call_document ON knowledge_codex_calls(user_id,document_id,created_at);`);
  return {record(uid,document,input) {
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','prompt','result','state','model','sessionId'].includes(k))
      ||!/^[a-f0-9-]{16,64}$/i.test(input.id||'')||!['running','succeeded','failed','cancelled'].includes(input.state)
      ||typeof input.prompt!=='string'||input.prompt.length>100000||typeof input.result!=='string'||input.result.length>500000
      ||typeof input.model!=='string'||input.model.length>160||typeof input.sessionId!=='string'||input.sessionId.length>100)throw new Error('Codex调用记录无效');
    const prior=db.prepare('SELECT * FROM knowledge_codex_calls WHERE user_id=? AND document_id=? AND attempt=? AND id=?').get(uid,document.id,document.attempt,input.id);
    if(prior&&(prior.prompt!==input.prompt||prior.model!==input.model))throw new Error('Codex调用内容不一致');
    if(prior&&prior.state!=='running')return;
    const now=Date.now();
    db.prepare(`INSERT INTO knowledge_codex_calls VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,document_id,attempt,id)
      DO UPDATE SET result=excluded.result,state=excluded.state,session_id=excluded.session_id,updated_at=excluded.updated_at`)
      .run(uid,document.id,document.attempt,input.id,input.prompt,input.result,input.state,input.model,input.sessionId,prior?.created_at||now,now);
  }};
}
