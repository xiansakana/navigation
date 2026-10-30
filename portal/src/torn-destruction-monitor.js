import { ChainMonitor, chainConfig, createChainStore } from './torn-chain-monitor.js';

export const DESTRUCTION_DEFAULTS = { apiKey: '', apiKeys: [], apiIntervalSeconds: 2, minRespect: 0, maxRespect: 10000, intervalSeconds: 15 };
export function destructionConfig(input, previous = DESTRUCTION_DEFAULTS) {
  const result = { ...DESTRUCTION_DEFAULTS, ...previous };
  const keys = chainConfig({ ...input, minHits: 0, maxHits: null, intervalSeconds: 60, bonusHits: [], leaderFilter: 'all' }, { ...result, bonusHits: [], leaderFilter: 'all' });
  for (const field of ['apiKey', 'apiKeys', 'apiIntervalSeconds']) result[field] = keys[field];
  for (const field of ['minRespect', 'maxRespect', 'intervalSeconds']) if (field in input) {
    const value = input[field];
    if (field === 'maxRespect' && (value === '' || value === null)) { result[field] = null; continue; }
    const min = field === 'intervalSeconds' ? 5 : 0, max = field === 'intervalSeconds' ? 3600 : 2147483647;
    if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(field === 'intervalSeconds' ? '轮次间隔须为 5–3600 秒整数' : 'respect 须为非负整数');
    result[field] = Number(value);
  }
  if (result.maxRespect !== null && result.maxRespect < result.minRespect) throw new Error('最大 respect 不能小于最小 respect');
  return Object.fromEntries(Object.keys(DESTRUCTION_DEFAULTS).map(key => [key, result[key]]));
}
export function inRespectRange(row, config) { return row.respect >= config.minRespect && (config.maxRespect === null || row.respect <= config.maxRespect); }
function factionRow(row, now) {
  if (!Number.isSafeInteger(row?.id) || row.id <= 0 || !Number.isSafeInteger(row.respect) || row.respect < 0 || typeof row.is_destroyed !== 'boolean' || !Number.isSafeInteger(row.leader?.id) || row.leader.id <= 0) throw new Error('API 帮派资料缺少有效 respect、摧毁状态或 Leader');
  return { id: row.id, name: String(row.name || row.id).slice(0, 160), respect: row.respect, leaderId: row.leader.id, leaderName: String(row.leader.name || row.leader.id).slice(0, 160), isDestroyed: row.is_destroyed, checkedAt: now };
}
export function createDestructionStore(db) {
  const legacy = createChainStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS torn_destruction_monitors(user_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS torn_destruction_observations(user_id TEXT NOT NULL, faction_id INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(user_id,faction_id));`);
  const ensure = uid => {
    if (db.prepare('SELECT 1 FROM torn_destruction_monitors WHERE user_id=?').get(uid)) return;
    const old = legacy.get(uid).config;
    const config = destructionConfig({ apiKeys: old.apiKeys, apiIntervalSeconds: old.apiIntervalSeconds });
    db.prepare('INSERT OR IGNORE INTO torn_destruction_monitors(user_id,config_json) VALUES(?,?)').run(uid, JSON.stringify(config));
  };
  const get = uid => { ensure(uid); const row = db.prepare('SELECT * FROM torn_destruction_monitors WHERE user_id=?').get(uid); return { config: destructionConfig({}, JSON.parse(row.config_json)), history: JSON.parse(row.history_json) }; };
  const observation = db.prepare('SELECT row_json FROM torn_destruction_observations WHERE user_id=? AND faction_id=?');
  const write = db.prepare('INSERT INTO torn_destruction_observations(user_id,faction_id,row_json) VALUES(?,?,?) ON CONFLICT(user_id,faction_id) DO UPDATE SET row_json=excluded.row_json');
  const observe = db.transaction((uid, row) => {
    const saved = observation.get(uid, row.id), old = saved && JSON.parse(saved.row_json);
    // Destruction is irreversible. A stale live API cache must not revive a dead faction.
    if (old?.isDestroyed) return null;
    let event = null;
    // An observed zero is actionable before Torn marks the faction destroyed.
    // First-seen zeros are baseline-only; existing pre-upgrade live zeros are
    // handled once on their next verification. Never reset this durable marker.
    const zero = row.respect === 0 && old?.lastAliveAt && !old.zeroHandled;
    if (old?.lastAliveAt && !old.zeroHandled && (zero || row.isDestroyed)) {
      event = { kind: zero ? 'respect-zero' : 'destruction', id: row.id, name: old.name, leaderId: old.leaderId, leaderName: old.leaderName,
        previousRespect: old.respect > 0 ? old.respect : old.lastPositiveRespect ?? null, respect: row.respect,
        lastAliveAt: old.lastAliveAt, detectedAt: row.checkedAt, cause: 'unknown', isDestroyed: row.isDestroyed,
        ...(row.isDestroyed ? { destroyedConfirmedAt: row.checkedAt } : {}) };
      const { history } = get(uid); history.push(event);
      db.prepare('UPDATE torn_destruction_monitors SET history_json=? WHERE user_id=?').run(JSON.stringify(history.slice(-200)), uid);
    } else if (row.isDestroyed && old?.zeroHandled) {
      const { history } = get(uid), found = history.find(item => item.id === row.id && item.kind === 'respect-zero');
      if (found && !found.destroyedConfirmedAt) {
        found.isDestroyed = true; found.destroyedConfirmedAt = row.checkedAt;
        db.prepare('UPDATE torn_destruction_monitors SET history_json=? WHERE user_id=?').run(JSON.stringify(history), uid);
      }
    }
    write.run(uid, row.id, JSON.stringify({ ...row, previousRespect: old?.respect ?? null,
      zeroHandled: !!old?.zeroHandled || row.respect === 0 || row.isDestroyed,
      lastPositiveRespect: row.respect > 0 ? row.respect : old?.lastPositiveRespect ?? (old?.respect > 0 ? old.respect : null),
      lastAliveAt: row.isDestroyed ? old?.lastAliveAt || null : row.checkedAt }));
    return event;
  });
  return { get, observe,
    save(uid, input) { const config = destructionConfig(input, get(uid).config); db.prepare('UPDATE torn_destruction_monitors SET config_json=? WHERE user_id=?').run(JSON.stringify(config), uid); return config; },
    observations(uid) { ensure(uid); return db.prepare('SELECT row_json FROM torn_destruction_observations WHERE user_id=? ORDER BY faction_id').all(uid).map(row => JSON.parse(row.row_json)); },
    clear(uid) { ensure(uid); db.prepare("UPDATE torn_destruction_monitors SET history_json='[]' WHERE user_id=?").run(uid); },
    getNotify: legacy.getNotify, saveNotify: legacy.saveNotify
  };
}

// Reuse the account-aware Key pool, abortable retries and quota lane of Chain.
// Runtime uses only official faction/search, never warfarechains or reports.
export class DestructionMonitor extends ChainMonitor {
  constructor(options) {
    super(options);
    this.state = { running: false, rounds: 0, pages: 0, tracked: 0, confirmed: 0, destroyed: 0, zeroed: 0, failed: 0, partial: false, error: '', lastScanAt: null, nextScanAt: null, retryAt: null, retryAttempt: 0, retryMessage: '', chains: [], detailsAt: null, detailsStale: false };
  }
  status() {
    const config = this.store.get(this.uid).config;
    return { ...super.status(), kind: 'destruction', factions: this.store.observations(this.uid).filter(row => !row.isDestroyed && (inRespectRange(row, config) || row.respect === 0 && row.zeroHandled)).sort((a, b) => a.respect - b.respect || a.id - b.id) };
  }
  start() {
    if (this.running || this.busy) throw new Error('监控正在运行或上次请求尚未结束');
    if (!this.authorize()) throw new Error('无权启动监控');
    this.config = this.store.get(this.uid).config;
    if (!this.config.apiKeys.length) throw new Error('请先保存 Public API Key');
    this.resetKeys(); this.state.error = ''; this.state.notificationError = ''; this.state.rounds = 0; this.state.destroyed = 0; this.state.zeroed = 0;
    this.running = true; this.controller = new AbortController(); this.promise = this.scan();
  }
  searchPath(filters, offset = 0) { return 'faction/search?limit=100&offset=' + offset + '&filters=' + encodeURIComponent(filters.join(',')); }
  async scan() {
    if (!this.running || this.busy) return;
    this.busy = true; const signal = this.controller.signal;
    const valid = () => this.running && !signal.aborted && this.authorize();
    const check = () => { if (!valid()) throw Object.assign(new Error('监控已停止或权限已变更'), { fatal: true }); };
    Object.assign(this.state, { pages: 0, confirmed: 0, failed: 0, outsideRange: 0, partial: false, error: '', detailsStale: true, problems: [] });
    try {
      check(); await this.prepareKeys(signal); check();
      const observed = new Map(this.store.observations(this.uid).filter(row => !row.isDestroyed && (inRespectRange(row, this.config) || row.respect === 0 && row.zeroHandled)).map(row => [row.id, row]));
      const deliver = async event => {
        if (!event) return;
        if (event.kind === 'respect-zero') this.state.zeroed++; else this.state.destroyed++;
        check();
        try { await this.notify(event); }
        catch { this.state.notificationError = '清零/摧毁记录已保存，通知投递失败；请检查通知管理（不自动重发）'; }
      };

      const filters = ['notDestroyed', 'respect:>=:' + this.config.minRespect, ...(this.config.maxRespect === null ? [] : ['respect:<=:' + this.config.maxRespect])];
      const current = new Map(), visited = new Set(), rawSeen = new Set(); let offset = 0, path = this.searchPath(filters);
      while (path) {
        check(); if (visited.has(path) || visited.size >= 1000) throw new Error('帮派分页未完成，本轮不更新基线，稍后自动重试');
        visited.add(path); const data = await this.api(path, signal); check();
        if (!Array.isArray(data.search)) throw new Error('API 未返回帮派列表');
        let added = 0;
        for (const item of data.search) {
          check();
          const row = factionRow(item, this.now());
          if (!rawSeen.has(row.id)) added++; rawSeen.add(row.id);
          // Explicit zero evidence does not depend on a complete listing.
          // Other baseline updates still wait for every page to succeed.
          if (row.respect === 0 && observed.has(row.id)) await deliver(this.store.observe(this.uid, row));

          // Listings can shift during pagination; only keep live in-range rows.
          if (row.isDestroyed || !inRespectRange(row, this.config)) { this.state.outsideRange++; continue; }
          current.set(row.id, row);
        }
        if (data.search.length && !added) throw new Error('API 分页重复，本轮不更新基线');
        this.state.pages++; this.state.confirmed = current.size;
        const next = data._metadata?.links?.next;
        if (next) {
          const url = new URL(next, 'https://api.torn.com/v2/faction/search');
          const value = url.searchParams.get('offset'), nextOffset = Number(value);
          if (url.origin !== 'https://api.torn.com' || url.pathname !== '/v2/faction/search' || value === null || !Number.isSafeInteger(nextOffset) || nextOffset <= offset) throw new Error('API 分页地址或 offset 无效，本轮不更新基线');
          offset = nextOffset;
          // API next links may lose filters/limit: reconstruct our own request.
          path = this.searchPath(filters, offset);
        } else { offset += 100; path = data.search.length === 100 ? this.searchPath(filters, offset) : null; }
      }
      check();
      const missing = this.store.observations(this.uid).filter(row => !row.isDestroyed && (inRespectRange(row, this.config) || row.respect === 0 && row.zeroHandled) && !current.has(row.id));
      for (const row of current.values()) this.store.observe(this.uid, row);
      this.state.tracked = current.size + missing.length; this.state.detailsStale = false; this.state.detailsAt = this.now();
      for (const old of missing) {
        check();
        try {
          const data = await this.api(this.searchPath(['id:=:' + old.id]), signal); check();
          if (!Array.isArray(data.search) || data.search.length !== 1 || data.search[0].id !== old.id) throw new Error('API 未确认该帮派状态，保留最后存活记录');
          const row = factionRow(data.search[0], this.now()), event = this.store.observe(this.uid, row); this.state.confirmed++;
          // Persist/dedup before delivery; later destruction confirmation is silent.
          await deliver(event);
        } catch (error) {
          if (error.fatal || !valid()) throw error;
          this.state.failed++; this.state.error = this.safeError(error); this.state.problems.push({ id: old.id, reason: this.safeError(error) });
        }
      }
      this.state.rounds++; this.state.lastScanAt = this.now();
    } catch (error) {
      if (!signal.aborted) { this.state.error = this.safeError(error); this.state.partial = true; if (error.fatal) this.stop(); }
    } finally {
      this.busy = false;
      if (valid()) {
        this.state.nextScanAt = this.now() + this.config.intervalSeconds;
        this.timer = this.schedule(() => { this.promise = this.scan(); }, this.config.intervalSeconds * 1000); this.timer?.unref?.();
      } else this.stop();
    }
  }
}
