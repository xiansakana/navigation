import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const labelOf = label => String(label || 'Windows 视频工作器').trim().slice(0, 80);
const deviceListRow = ({ capabilities_json, ...device }) => ({
  ...device, online: !device.revokedAt && !!device.lastSeen && Date.now() - Date.parse(device.lastSeen) < 90000,
  capabilities: JSON.parse(capabilities_json || '{}'),
});

export function createPostgresKnowledgeDeviceStore(db) {
  return {
    start(label) {
      return db.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('knowledge:pairing', 0))");
        const time = Date.now();
        await client.query('DELETE FROM navigation.knowledge_worker_pairings WHERE expires<$1', [time]);
        const { rows: [row] } = await client.query('SELECT count(*) AS n FROM navigation.knowledge_worker_pairings');
        if (Number(row.n) >= 1000) throw Object.assign(new Error('配对请求过多，请稍后重试'), { status: 429 });
        const deviceCode = crypto.randomBytes(32).toString('hex'), userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
        await client.query('INSERT INTO navigation.knowledge_worker_pairings(secret_hash,user_code,label,expires) VALUES($1,$2,$3,$4)',
          [hash(deviceCode), userCode, labelOf(label), time + 600000]);
        return { deviceCode, userCode, expiresIn: 600, interval: 5 };
      });
    },
    async inspect(code) {
      const { rows: [row] } = await db.query(`SELECT label,expires FROM navigation.knowledge_worker_pairings
        WHERE user_code=$1 AND expires>$2 AND consumed=0 AND user_id IS NULL`, [String(code).toUpperCase(), Date.now()]);
      return row ? { label: row.label, expiresAt: new Date(Number(row.expires)).toISOString() } : null;
    },
    async approve(uid, code) {
      const result = await db.query(`UPDATE navigation.knowledge_worker_pairings SET user_id=$1
        WHERE user_code=$2 AND expires>$3 AND user_id IS NULL AND consumed=0`, [uid, String(code).toUpperCase(), Date.now()]);
      return result.rowCount === 1;
    },
    async poll(secret, authorize, label = '') {
      const secretHash = hash(secret);
      const { rows: [preview] } = await db.query(`SELECT user_id FROM navigation.knowledge_worker_pairings
        WHERE secret_hash=$1 AND expires>$2 AND consumed=0 AND last_poll<=$3`, [secretHash, Date.now(), Date.now() - 2000]);
      const approvedUid = preview?.user_id && await authorize(preview.user_id) ? preview.user_id : null;
      return db.transaction(async client => {
        const { rows: [pair] } = await client.query('SELECT * FROM navigation.knowledge_worker_pairings WHERE secret_hash=$1 FOR UPDATE', [secretHash]);
        const time = Date.now();
        if (!pair || Number(pair.expires) <= time || Number(pair.consumed)) return { status: 'expired' };
        if (Number(pair.last_poll) > time - 2000) return { status: 'slow_down' };
        await client.query('UPDATE navigation.knowledge_worker_pairings SET last_poll=$2 WHERE secret_hash=$1', [pair.secret_hash, time]);
        if (!pair.user_id || pair.user_id !== preview?.user_id) return { status: 'pending' };
        if (pair.user_id !== approvedUid) return { status: 'denied' };
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('knowledge:devices:' || $1, 0))", [pair.user_id]);
        const { rows: [row] } = await client.query('SELECT count(*) AS n FROM navigation.knowledge_worker_devices WHERE user_id=$1 AND revoked_at IS NULL', [pair.user_id]);
        if (Number(row.n) >= 20) return { status: 'device_limit' };
        const deviceId = crypto.randomBytes(16).toString('hex'), token = 'nkw_' + crypto.randomBytes(32).toString('hex');
        const tokenHash = hash(token);
        await client.query('INSERT INTO navigation.knowledge_worker_devices(id,user_id,label,token_hash,created_at) VALUES($1,$2,$3,$4,$5)',
          [deviceId, pair.user_id, String(label || pair.label).trim().slice(0, 80), tokenHash, new Date().toISOString()]);
        await client.query('INSERT INTO navigation.knowledge_workers(user_id,token_hash) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',
          [pair.user_id, 'device-only:' + tokenHash]);
        await client.query('UPDATE navigation.knowledge_worker_pairings SET consumed=1 WHERE secret_hash=$1', [pair.secret_hash]);
        return { status: 'approved', token, deviceId };
      });
    },
    async authenticate(token) {
      const { rows: [row] } = await db.query('SELECT id,user_id,label FROM navigation.knowledge_worker_devices WHERE token_hash=$1 AND revoked_at IS NULL', [hash(token)]);
      return row;
    },
    async list(uid) {
      const { rows } = await db.query(`SELECT d.id,d.label,d.created_at AS "createdAt",d.revoked_at AS "revokedAt",
          i.last_seen AS "lastSeen",i.capabilities_json FROM navigation.knowledge_worker_devices d
        LEFT JOIN navigation.knowledge_worker_instances i ON i.user_id=d.user_id AND i.worker_id=d.id
        WHERE d.user_id=$1 ORDER BY d.created_at DESC`, [uid]);
      return rows.map(deviceListRow);
    },
    revoke(uid, id) {
      return db.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('knowledge:worker:' || $1, 0))", [uid]);
        const time = new Date().toISOString();
        const result = await client.query('UPDATE navigation.knowledge_worker_devices SET revoked_at=$3 WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL', [uid, id, time]);
        if (!result.rowCount) return false;
        await client.query('DELETE FROM navigation.knowledge_worker_instances WHERE user_id=$1 AND worker_id=$2', [uid, id]);
        await client.query(`UPDATE navigation.knowledge_documents SET status='failed',stage='处理设备已停用',
          error='请使用其他工作器重试',lease=NULL,updated_at=$3 WHERE user_id=$1 AND worker_id=$2 AND status='processing'`, [uid, id, time]);
        return true;
      });
    },
  };
}

export function createKnowledgeDeviceStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_worker_devices (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,label TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,revoked_at TEXT);
    CREATE INDEX IF NOT EXISTS knowledge_devices_owner ON knowledge_worker_devices(user_id);
    CREATE TABLE IF NOT EXISTS knowledge_worker_pairings (
    secret_hash TEXT PRIMARY KEY,user_code TEXT NOT NULL UNIQUE,label TEXT NOT NULL,
    expires INTEGER NOT NULL,user_id TEXT,consumed INTEGER NOT NULL DEFAULT 0,last_poll INTEGER NOT NULL DEFAULT 0);`);
  return {
    start(label) {
      db.prepare('DELETE FROM knowledge_worker_pairings WHERE expires<?').run(Date.now());
      if (db.prepare('SELECT count(*) n FROM knowledge_worker_pairings').get().n >= 1000) throw Object.assign(new Error('配对请求过多，请稍后重试'), { status: 429 });
      const deviceCode = crypto.randomBytes(32).toString('hex'), userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      db.prepare('INSERT INTO knowledge_worker_pairings(secret_hash,user_code,label,expires) VALUES (?,?,?,?)')
        .run(hash(deviceCode), userCode, labelOf(label), Date.now() + 600000);
      return { deviceCode, userCode, expiresIn: 600, interval: 5 };
    },
    inspect(code) {
      const row = db.prepare('SELECT label,expires,user_id,consumed FROM knowledge_worker_pairings WHERE user_code=? AND expires>?').get(String(code).toUpperCase(), Date.now());
      if (!row || row.consumed || row.user_id) return null;
      return { label: row.label, expiresAt: new Date(row.expires).toISOString() };
    },
    approve(uid, code) {
      return db.prepare('UPDATE knowledge_worker_pairings SET user_id=? WHERE user_code=? AND expires>? AND user_id IS NULL AND consumed=0')
        .run(uid, String(code).toUpperCase(), Date.now()).changes > 0;
    },
    poll(secret, authorize, label = '') {
      return db.transaction(() => {
        const s = db.prepare('SELECT * FROM knowledge_worker_pairings WHERE secret_hash=?').get(hash(secret));
        if (!s || s.expires <= Date.now() || s.consumed) return { status: 'expired' };
        if (s.last_poll > Date.now() - 2000) return { status: 'slow_down' };
        db.prepare('UPDATE knowledge_worker_pairings SET last_poll=? WHERE secret_hash=?').run(Date.now(), s.secret_hash);
        if (!s.user_id) return { status: 'pending' };
        if (!authorize(s.user_id)) return { status: 'denied' };
        const id = crypto.randomBytes(16).toString('hex'), token = 'nkw_' + crypto.randomBytes(32).toString('hex');
        if (db.prepare('SELECT count(*) n FROM knowledge_worker_devices WHERE user_id=? AND revoked_at IS NULL').get(s.user_id).n >= 20) return { status: 'device_limit' };
        db.prepare('INSERT INTO knowledge_worker_devices(id,user_id,label,token_hash,created_at) VALUES (?,?,?,?,?)').run(id, s.user_id, String(label || s.label).trim().slice(0, 80), hash(token), new Date().toISOString());
        db.prepare('INSERT OR IGNORE INTO knowledge_workers(user_id,token_hash) VALUES (?,?)').run(s.user_id, 'device-only:' + hash(token));
        db.prepare('UPDATE knowledge_worker_pairings SET consumed=1 WHERE secret_hash=?').run(s.secret_hash);
        return { status: 'approved', token, deviceId: id };
      }).immediate();
    },
    authenticate(token) { return db.prepare('SELECT id,user_id,label FROM knowledge_worker_devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(token)); },
    list(uid) {
      return db.prepare(`SELECT d.id,d.label,d.created_at AS createdAt,d.revoked_at AS revokedAt,i.last_seen AS lastSeen,i.capabilities_json
        FROM knowledge_worker_devices d LEFT JOIN knowledge_worker_instances i ON i.user_id=d.user_id AND i.worker_id=d.id WHERE d.user_id=? ORDER BY d.created_at DESC`).all(uid)
        .map(deviceListRow);
    },
    revoke(uid, id) {
      return db.transaction(() => {
        if (!db.prepare('UPDATE knowledge_worker_devices SET revoked_at=? WHERE user_id=? AND id=? AND revoked_at IS NULL').run(new Date().toISOString(), uid, id).changes) return false;
        db.prepare('DELETE FROM knowledge_worker_instances WHERE user_id=? AND worker_id=?').run(uid, id);
        db.prepare("UPDATE knowledge_documents SET status='failed',stage='处理设备已停用',error='请使用其他工作器重试',lease=NULL,updated_at=? WHERE user_id=? AND worker_id=? AND status='processing'").run(new Date().toISOString(), uid, id);
        return true;
      }).immediate();
    }
  };
}
