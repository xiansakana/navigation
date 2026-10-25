import { DAY, FACTION_DEFAULTS, factionConfig, historicNetworth, validHistoricPoint, analyzeFactionHistory, possibleFactionEvent, redactFactionKeys } from './torn-faction-analysis.js';
import { setImmediate as yieldScan, setTimeout as waitForRetry } from 'node:timers/promises';

export const HISTORY_BATCH_DAYS = 100;

export function createFactionStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS torn_faction_scans(user_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, run_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS torn_faction_rows(user_id TEXT NOT NULL, faction_id INTEGER NOT NULL, respect INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(user_id,faction_id));
    CREATE TABLE IF NOT EXISTS torn_faction_networth(user_id TEXT NOT NULL, leader_id INTEGER NOT NULL, day INTEGER NOT NULL, point_json TEXT NOT NULL, PRIMARY KEY(user_id,leader_id,day));`);
  const ensure = uid => db.prepare('INSERT OR IGNORE INTO torn_faction_scans(user_id,config_json) VALUES(?,?)').run(uid, JSON.stringify(FACTION_DEFAULTS));
  const lists = new Map();
  const saveRow = db.prepare('INSERT INTO torn_faction_rows(user_id,faction_id,respect,row_json) VALUES(?,?,?,?) ON CONFLICT(user_id,faction_id) DO UPDATE SET respect=excluded.respect,row_json=excluded.row_json');
  return {
    get(uid) {
      ensure(uid); const row = db.prepare('SELECT * FROM torn_faction_scans WHERE user_id=?').get(uid), saved = JSON.parse(row.config_json), config = factionConfig({}, saved);
      const legacy = 'dailyDropPct' in saved || 'peakDropPct' in saved;
      const run = legacy ? { stage: '已切换为金额条件，请确认金额阈值后启动；历史缓存保留' } : JSON.parse(row.run_json);
      if (legacy) {
        db.transaction(() => { db.prepare('UPDATE torn_faction_scans SET config_json=?,run_json=? WHERE user_id=?').run(JSON.stringify(config), JSON.stringify(run), uid); db.prepare('DELETE FROM torn_faction_rows WHERE user_id=?').run(uid); })(); lists.delete(uid);
      }
      run.rows = db.prepare('SELECT row_json FROM torn_faction_rows WHERE user_id=? ORDER BY respect,faction_id').all(uid).map(item => JSON.parse(item.row_json)); return { config, run };
    },
    save(uid, input) { const config = factionConfig(input, this.get(uid).config); db.transaction(() => { db.prepare('UPDATE torn_faction_scans SET config_json=?,run_json=? WHERE user_id=?').run(JSON.stringify(config), '{}', uid); db.prepare('DELETE FROM torn_faction_rows WHERE user_id=?').run(uid); })(); lists.delete(uid); return config; },
    saveRun(uid, run) {
      ensure(uid); const { rows, ...state } = run;
      db.transaction(() => {
        if (!rows || lists.get(uid) !== rows) {
          db.prepare('DELETE FROM torn_faction_rows WHERE user_id=?').run(uid);
          for (const row of rows || []) saveRow.run(uid, row.id, row.respect, JSON.stringify(row));
        } else { const row = rows.find(item => item.id === run.currentFaction); if (row) saveRow.run(uid, row.id, row.respect, JSON.stringify(row)); }
        db.prepare('UPDATE torn_faction_scans SET run_json=? WHERE user_id=?').run(JSON.stringify(state), uid);
      })();
      if (rows) lists.set(uid, rows); else lists.delete(uid);
    },
    point(uid, id, day) { const row = db.prepare('SELECT point_json FROM torn_faction_networth WHERE user_id=? AND leader_id=? AND day=?').get(uid, id, day); return row ? JSON.parse(row.point_json) : null; },
    savePoint(uid, id, point) { db.prepare('INSERT INTO torn_faction_networth(user_id,leader_id,day,point_json) VALUES(?,?,?,?) ON CONFLICT(user_id,leader_id,day) DO UPDATE SET point_json=excluded.point_json').run(uid, id, point.day, JSON.stringify(point)); }
  };
}

export class FactionScanner {
  constructor({ uid, store, request, authorize = () => true, now = () => Math.floor(Date.now() / 1000), wait = waitForRetry }) {
    Object.assign(this, { uid, store, request, authorize, now, wait }); this.running = false; this.busy = false; this.run = store.get(uid).run;
  }
  status() { return { ...this.run, running: this.running, busy: this.busy }; }
  stop() { this.running = false; this.controller?.abort(); }
  start() {
    if (this.running || this.busy) throw new Error('扫描仍在运行或停止中');
    if (!this.authorize()) throw new Error('无权启动扫描');
    this.config = this.store.get(this.uid).config;
    if (!this.config.apiKey) throw new Error('请先保存 Public API Key');
    this.running = true; this.controller = new AbortController(); this.promise = this.scan().catch(error => { this.run.error = redactFactionKeys(error.message, this.config); this.run.stage = '扫描或持久化失败'; this.running = false; this.busy = false; });
  }
  async scan() {
    this.busy = true;
    const signal = this.controller.signal, config = this.config, today = Math.floor(this.now() / DAY);
    const check = () => {
      if (!this.running || signal.aborted || !this.authorize()) throw Object.assign(new Error('已停止或权限已撤销'), { fatal: true });
      if (Math.floor(this.now() / DAY) !== today) throw Object.assign(new Error('扫描已跨过 Torn 日期，请再次启动刷新当天数据；历史缓存保留'), { fatal: true });
    };
    const persist = () => this.store.saveRun(this.uid, this.run);
    let keys = [...config.apiKeys], keyCursor = 0;
    const rejected = new Set(), verified = new Map(), skippedKeys = [];
    const updateKeys = () => {
      const owners = new Map();
      for (const key of config.apiKeys) if (!rejected.has(key) && (config.apiKeys.length === 1 || verified.has(key))) {
        const owner = verified.get(key) || 'single'; if (!owners.has(owner)) owners.set(owner, key);
      }
      keys = [...owners.values()];
      Object.assign(this.run, { keyCount: config.apiKeys.length, availableKeyCount: config.apiKeys.length - rejected.size, ownerCount: owners.size, skippedKeys: [...skippedKeys] });
    };
    const rejectKey = (key, error) => {
      if (!rejected.has(key)) {
        rejected.add(key); skippedKeys.push({ index: config.apiKeys.indexOf(key) + 1, code: error.apiCode || null, reason: error.apiCode ? 'API 错误 ' + error.apiCode : '无法确认所属账号' });
      }
      updateKeys(); persist();
    };
    const noKeys = () => Object.assign(new Error('所有 API Key 均不可用或无法确认所属账号，扫描已停止；进度与缓存保留' + (skippedKeys.at(-1)?.code ? '；最后失败：错误 ' + skippedKeys.at(-1).code : '')), { fatal: true });
    const request = async (path, selectedKey) => {
      let key = selectedKey || keys[keyCursor++ % keys.length];
      if (!key) throw noKeys();
      const stage = this.run.stage;
      for (let attempt = 0; ; attempt++) {
        check();
        try {
          const data = await this.request(path, key, signal); check();
          this.run.requests = (this.run.requests || 0) + 1; return data;
        } catch (error) {
          if (signal.aborted || !this.running || !this.authorize()) throw error;
          if ([1, 2, 10, 13, 16, 18].includes(error.apiCode)) {
            rejectKey(key, error);
            if (selectedKey) throw Object.assign(error, { keyRejected: true });
            if (!keys.length) throw noKeys();
            key = keys[keyCursor++ % keys.length]; attempt = -1; continue;
          }
          if (error.apiCode !== 5 && !error.rateLimited || [8, 9].includes(error.apiCode)) throw error;
          if (attempt >= 3) throw Object.assign(new Error('Torn API 持续限流，自动重试 3 次后停止；进度与缓存保留，请减少同账号其他工具的请求后继续'), { fatal: true });
          const ms = Math.max(65000 * 2 ** attempt, Number(error.retryAfterMs) || 0);
          this.run.retryAt = this.now() + Math.ceil(ms / 1000); this.run.rateLimitRetries = attempt + 1;
          this.run.stage = 'Torn API 请求过多，冷却后自动重试（' + (attempt + 1) + '/3）'; persist();
          try { await this.wait(ms, undefined, { signal }); check(); }
          finally { this.run.retryAt = null; this.run.rateLimitRetries = 0; this.run.stage = stage; persist(); }
        }
      }
    };
    try {
      check(); this.run.error = ''; this.run.retryAt = null; this.run.rateLimitRetries = 0; this.run.startedAt = this.now();
      const requestsBeforeKeys = this.run.requests || 0;
      this.run.skippedKeys = []; this.run.availableKeyCount = config.apiKeys.length;
      if (keys.length > 1) {
        this.run.stage = '核验 API Key 所属账号'; persist();
        for (const key of config.apiKeys) {
          try {
            const data = await request('key/info', key), id = data.info?.user?.id;
            if (!Number.isSafeInteger(id) || id <= 0) { rejectKey(key, {}); continue; }
            verified.set(key, id);
          } catch (error) { if (!error.keyRejected) throw error; }
        }
      }
      updateKeys(); if (!keys.length) throw noKeys();
      const keyRequests = (this.run.requests || 0) - requestsBeforeKeys;
      if (this.run.today !== today || !this.run.listComplete) {
        this.run = { today, rows: [], cursor: 0, requests: keyRequests, cached: 0, skippedDays: 0, listComplete: false, stage: '读取帮派列表', startedAt: this.now() }; persist();
        updateKeys();
        const filters = ['notDestroyed', 'respect:>=:' + config.minRespect, ...(config.maxRespect === null ? [] : ['respect:<=:' + config.maxRespect])];
        let path = 'faction/search?limit=100&offset=0&filters=' + encodeURIComponent(filters.join(','));
        const visited = new Set(), factions = new Map(); let pages = 0;
        while (path) {
          if (visited.has(path) || ++pages > 1000) throw new Error('帮派分页未完成，不能保证全局升序；请缩小 respect 范围');
          visited.add(path);
          const data = await request(path);
          if (!Array.isArray(data.search)) throw new Error('API 未返回帮派列表');
          for (const row of data.search) {
            if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.respect) || !Number.isSafeInteger(row.leader?.id) || row.id <= 0 || row.leader.id <= 0) continue;
            if (row.is_destroyed || row.respect < config.minRespect || config.maxRespect !== null && row.respect > config.maxRespect) continue;
            factions.set(row.id, { id: row.id, name: String(row.name).slice(0, 160), respect: row.respect, leaderId: row.leader.id, leaderName: String(row.leader.name || row.leader.id).slice(0, 160), status: 'waiting', reason: '待扫描' });
          }
          this.run.listed = factions.size; persist();
          const links = data._metadata?.links;
          if (!links || !Object.hasOwn(links, 'next')) throw new Error('分页信息缺失，不能确认列表完整');
          path = links.next;
          if (path) {
            const next = new URL(path, 'https://api.torn.com/v2/'), offset = Number(next.searchParams.get('offset'));
            if (next.origin !== 'https://api.torn.com' || next.pathname !== '/v2/faction/search' || Number(next.searchParams.get('limit')) !== 100 || !Number.isSafeInteger(offset) || offset !== pages * 100) throw new Error('帮派分页地址无效');
            // Torn may HTML-escape comparison operators in pagination filters.
            // Retain only the validated offset and rebuild the original query.
            path = 'faction/search?limit=100&offset=' + offset + '&filters=' + encodeURIComponent(filters.join(','));
          }
        }
        this.run.rows = [...factions.values()].sort((a, b) => a.respect - b.respect || a.id - b.id); this.run.listComplete = true; this.run.cursor = 0; persist();
      }
      updateKeys();
      this.run.batchEnd = this.run.cursor;
      while (this.run.cursor < this.run.rows.length) {
        check();
        if (this.run.cursor >= this.run.batchEnd) {
          this.run.factionBatch = Math.floor(this.run.cursor / config.batchSize) + 1;
          this.run.batchEnd = Math.min(this.run.rows.length, this.run.cursor + config.batchSize);
          this.run.stage = '自动扫描帮派第 ' + this.run.factionBatch + ' 批'; persist();
          await yieldScan(undefined, { signal }); check();
        }
        check(); const row = this.run.rows[this.run.cursor]; row.status = 'scanning'; row.reason = '核验当前 Leader 和身份时间'; this.run.currentFaction = row.id; persist();
        try {
          const { basic } = await request('faction/' + row.id + '/basic');
          if (basic?.id !== row.id || !Number.isSafeInteger(basic.leader_id) || basic.leader_id <= 0) throw new Error('当前 Leader 信息无效');
          if (basic.leader_id !== row.leaderId) { row.status = 'unknown'; row.reason = '列表后的 Leader 已变更，请刷新列表重新扫描'; }
          else {
            const { profile } = await request('user/' + row.leaderId + '/profile');
            const { faction } = await request('user/' + row.leaderId + '/faction');
            if (profile?.id !== row.leaderId || profile.faction_id !== row.id || faction?.id !== row.id || !Number.isSafeInteger(faction.days_in_faction) || !Number.isSafeInteger(profile.signed_up)) throw new Error('Leader 的当前帮派或入帮时间无法确认');
            const birth = Math.floor(profile.signed_up / DAY) + 1;
            const first = config.historyMode === 'full' ? birth : Math.max(birth, today - config.historyDays);
            if (first >= today || today - first > 10000) throw new Error('可用历史范围不足或超过安全上限');
            if (!Number.isSafeInteger(profile.last_action?.timestamp) || profile.last_action.timestamp <= 0 || profile.last_action.timestamp > this.now()) throw new Error('Leader 最后活动时间无效');
            row.totalDays = today - first + 1; row.loadedDays = 0; row.historyBatch = 1; row.historyStart = first; row.lastAction = profile.last_action.timestamp; row.B = today - Math.floor(row.lastAction / DAY); row.C = faction.days_in_faction; persist();
            const eligibility = possibleFactionEvent({ today, first, lastAction: row.lastAction, daysInFaction: row.C }, config);
            if (!eligibility.possible) {
              Object.assign(row, { status: 'excluded', reason: '身份条件提前排除：历史范围内不存在同时满足 C≥A 和 A−B 的日期', checkedAt: this.now(), earlyExcluded: true });
              this.run.cursor++; persist(); continue;
            }
            const points = [];
            for (let day = today; day >= first;) {
              check(); this.run.stage = '倒序追溯 networth 更新时间'; this.run.currentDay = day;
              let point = day < today ? this.store.point(this.uid, row.leaderId, day) : null;
              if (point && (!validHistoricPoint(point) || point.day !== day)) point = null;
              if (point) this.run.cached = (this.run.cached || 0) + 1;
              else {
                point = historicNetworth(await request('user/' + row.leaderId + '/personalstats?stat=networth&timestamp=' + day * DAY), day);
                this.store.savePoint(this.uid, row.leaderId, point);
              }
              // The API's last-update timestamp proves that the as-of value
              // was unchanged until this query day. Retain a continuous daily
              // series for peak/recovery checks, but avoid those API requests.
              const from = Math.max(first, Math.floor(point.timestamp / DAY));
              for (let fill = day; fill >= from; fill--) {
                check();
                row.historyBatch = Math.floor(row.loadedDays / HISTORY_BATCH_DAYS) + 1;
                const cached = this.store.point(this.uid, row.leaderId, fill);
                if (cached && (!validHistoricPoint(cached) || cached.value !== point.value || cached.timestamp !== point.timestamp)) throw new Error('历史缓存与更新时间矛盾，不能跳过该区间');
                const sample = { ...point, day: fill };
                if (fill !== day && !cached) this.store.savePoint(this.uid, row.leaderId, sample);
                points.push(sample); row.loadedDays++;
                if (row.loadedDays % HISTORY_BATCH_DAYS === 0) {
                  persist(); await yieldScan(undefined, { signal }); check();
                }
              }
              this.run.skippedDays = (this.run.skippedDays || 0) + day - from;
              day = from - 1; persist();
            }
            // Leadership/membership may change during a long history scan.
            const { basic: current } = await request('faction/' + row.id + '/basic');
            const { profile: latest } = await request('user/' + row.leaderId + '/profile');
            const { faction: membership } = await request('user/' + row.leaderId + '/faction');
            if (current?.id !== row.id || current.leader_id !== row.leaderId || latest?.id !== row.leaderId || latest.faction_id !== row.id || membership?.id !== row.id) throw new Error('扫描期间 Leader 或帮派归属变化，结果未确认');
            if (Math.floor(this.now() / DAY) !== today) throw Object.assign(new Error('扫描已跨过 Torn 日期，请再次启动以刷新当天数据；历史缓存保留'), { fatal: true });
            Object.assign(row, analyzeFactionHistory(points, { today, lastAction: latest.last_action?.timestamp, daysInFaction: membership.days_in_faction }, config), { checkedAt: this.now() });
          }
          this.run.cursor++; persist();
        } catch (error) {
          if (signal.aborted || error.fatal) throw error;
          row.status = 'unknown'; row.reason = redactFactionKeys(error.message, config); row.checkedAt = this.now(); this.run.cursor++; persist();
        }
      }
      this.run.stage = '本次列表扫描完成';
    } catch (error) {
      if (!signal.aborted) this.run.error = redactFactionKeys(error.message, config);
      this.run.stage = signal.aborted ? '已暂停，下次启动从断点继续' : '扫描停止，请查看错误';
      const row = this.run.rows?.[this.run.cursor]; if (row?.status === 'scanning') { this.run.currentFaction = row.id; row.status = 'waiting'; row.reason = '已中断，历史缓存保留，等待继续'; }
    } finally { persist(); this.running = false; this.busy = false; }
  }
}
