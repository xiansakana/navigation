const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const displayTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

export async function geminiQuotaHint(response) {
  const retryAfter = response.headers.get('retry-after')?.trim() || '';
  const headerWait = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  const body = await response.json().catch(() => null);
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const retry = details.find(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(retry?.retryDelay || '');
  const quota = details.find(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');
  const dailyQuota = Array.isArray(quota?.violations) && quota.violations.some(violation =>
    /per[_ -]?day|daily/i.test(String(violation?.quotaId || '') + ' ' + String(violation?.quotaMetric || '')));
  return { retryAfterMs: Math.max(0, headerWait || 0, Number(seconds?.[1] || 0) * 1000), dailyQuota };
}

export function cooldownFor(error, priorStrikes, time = Date.now()) {
  const strikes = Math.min(12, priorStrikes + 1);
  const fallback = error.dailyQuota || [402, 404].includes(error.status) ? DAY
    : Math.min(60, 2 ** (strikes - 1)) * MINUTE;
  const retryAt = new Date(time + Math.max(fallback, Math.min(error.retryAfterMs || 0, DAY))).toISOString();
  return {
    strikes,
    retryAt,
    stage: 'Gemini 冷却中（HTTP ' + error.status + '）· ' + displayTime.format(new Date(retryAt)) + ' 自动续跑',
  };
}

export function initializeSqliteGeminiCooldowns(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_gemini_cooldowns (
    user_id TEXT NOT NULL, model TEXT NOT NULL, retry_at TEXT NOT NULL, strikes INTEGER NOT NULL,
    PRIMARY KEY (user_id, model)
  )`);
}

export async function pauseGeminiJob(db, row, model, error) {
  const { user_id: uid, id, lease } = row;
  const time = new Date().toISOString();
  if (db.query) return db.transaction(async client => {
    const { rows: [previous] } = await client.query(
      'SELECT strikes FROM navigation.knowledge_gemini_cooldowns WHERE user_id=$1 AND model=$2', [uid, model]);
    const cooldown = cooldownFor(error, Number(previous?.strikes || 0));
    const updated = await client.query(`UPDATE navigation.knowledge_documents SET status='queued',stage=$4,
      error='',lease=NULL,heartbeat=NULL,updated_at=$5
      WHERE user_id=$1 AND id=$2 AND lease=$3 AND status='processing'`, [uid, id, lease, cooldown.stage, time]);
    if (!updated.rowCount) return;
    await client.query(`INSERT INTO navigation.knowledge_gemini_cooldowns(user_id,model,retry_at,strikes)
      VALUES($1,$2,$3,$4) ON CONFLICT(user_id,model) DO UPDATE SET retry_at=excluded.retry_at,strikes=excluded.strikes`,
    [uid, model, cooldown.retryAt, cooldown.strikes]);
  });
  return db.transaction(() => {
    const previous = db.prepare('SELECT strikes FROM knowledge_gemini_cooldowns WHERE user_id=? AND model=?').get(uid, model);
    const cooldown = cooldownFor(error, previous?.strikes || 0);
    const updated = db.prepare(`UPDATE knowledge_documents SET status='queued',stage=?,
      error='',lease=NULL,heartbeat=NULL,updated_at=?
      WHERE user_id=? AND id=? AND lease=? AND status='processing'`).run(cooldown.stage, time, uid, id, lease);
    if (!updated.changes) return;
    db.prepare(`INSERT INTO knowledge_gemini_cooldowns(user_id,model,retry_at,strikes)
      VALUES(?,?,?,?) ON CONFLICT(user_id,model) DO UPDATE SET retry_at=excluded.retry_at,strikes=excluded.strikes`)
      .run(uid, model, cooldown.retryAt, cooldown.strikes);
  }).immediate();
}

export async function clearGeminiCooldown(db, uid, model) {
  if (db.query) return db.query(
    'DELETE FROM navigation.knowledge_gemini_cooldowns WHERE user_id=$1 AND model=$2 AND retry_at<=$3',
    [uid, model, new Date().toISOString()]);
  db.prepare('DELETE FROM knowledge_gemini_cooldowns WHERE user_id=? AND model=? AND retry_at<=?')
    .run(uid, model, new Date().toISOString());
}
