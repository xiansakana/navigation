import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CHAIN_NOTIFY, chainNotifySettings } from './torn-chain-notifications.js';
import { normalizeBonusHits, reportBonusDefenders, legacyReportBonusDefenders, lookupDefenderLeader, selectedBonusDefenders } from './torn-chain-bonuses.js';

export const DEFAULT_CHAIN_CONFIG = { minHits: 100, maxHits: null, intervalSeconds: 60, apiKey: '', bonusHits: [], leaderFilter: 'all' };

// Torn's documented cooldown duration is six seconds per hit. The public API
// explicitly defines cooldown as its end timestamp; `end` does not document
// when cooldown began, so keep this value explicitly identified as an estimate.
export function estimateCooldownStart(until, hits, detectedAt) {
  if (![until, hits, detectedAt].every(Number.isSafeInteger) || hits <= 0) return null;
  const start = until - hits * 6;
  return start > 0 && start <= detectedAt && start < until ? start : null;
}
export function chainConfig(input, previous = DEFAULT_CHAIN_CONFIG) {
  const result = { ...previous };
  if ('bonusHits' in input) result.bonusHits = normalizeBonusHits(input.bonusHits);
  if ('leaderFilter' in input) {
    if (!['all', 'leader', 'non-leader'].includes(input.leaderFilter)) throw new Error('Leader 筛选配置无效');
    result.leaderFilter = input.leaderFilter;
  }
  if (result.leaderFilter !== 'all' && !result.bonusHits?.length) throw new Error('使用 Leader 筛选时请至少选择一个 Bonus hit');
  for (const field of ['minHits', 'maxHits', 'intervalSeconds']) {
    if (!(field in input)) continue;
    const value = input[field];
    if (field === 'maxHits' && (value === '' || value === null)) { result[field] = null; continue; }
    if (value === '' || value === null || !Number.isSafeInteger(Number(value)) || Number(value) < (field === 'intervalSeconds' ? 30 : 0)) throw new Error('长度须为非负整数，间隔至少 30 秒');
    result[field] = Number(value);
  }
  if (result.maxHits !== null && result.maxHits < result.minHits) throw new Error('最大长度不能小于最小长度');
  if ('apiKey' in input) {
    const key = String(input.apiKey || '').trim();
    if (key && !/^[a-zA-Z0-9]{16}$/.test(key)) throw new Error('API Key 应为 16 位字母或数字');
    result.apiKey = key;
  }
  return result;
}

// One serial lane: approximately 30 requests/minute, leaving headroom for
// other tools. The Portal client below groups these lanes by Torn account.
export function createChainApiClient({ fetchImpl = fetch, spacingMs = 2000, beforeFetch = async () => {} } = {}) {
  let queue = Promise.resolve(), nextAt = 0;
  return (path, key, signal) => {
    const job = queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const url = new URL(path, 'https://api.torn.com/v2/');
      const v2 = /^\/v2\/(key\/info|faction\/(warfarechains|search|\d+\/(chain|chainreport|basic))|user\/\d+\/(profile|faction|personalstats))$/.test(url.pathname);
      const legacyReport = /^\/torn\/[1-9]\d*$/.test(url.pathname) && url.searchParams.get('selections') === 'chainreport';
      if (url.origin !== 'https://api.torn.com' || !v2 && !legacyReport) throw new Error('API 分页地址无效');
      url.searchParams.set('key', key); url.searchParams.set('comment', 'NavChain');
      await delay(Math.max(0, nextAt - Date.now()), undefined, { signal });
      await beforeFetch(signal);
      signal?.throwIfAborted(); nextAt = Date.now() + spacingMs;
      let response;
      try { response = await fetchImpl(url.href, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]), headers: { Accept: 'application/json' }, redirect: 'error' }); }
      catch { if (signal?.aborted) signal.throwIfAborted(); throw Object.assign(new Error('Torn API 网络异常或超时'), { transient: true }); }
      if (response.status === 429) {
        const header = response.headers?.get?.('retry-after'), seconds = Number(header);
        const retryAfterMs = header && Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : 65000;
        throw Object.assign(new Error('Torn API 已限流'), { fatal: true, rateLimited: true, retryAfterMs: Math.max(65000, Number.isFinite(retryAfterMs) ? retryAfterMs : 65000) });
      }
      if (!response.ok) throw Object.assign(new Error('Torn API HTTP ' + response.status), { transient: response.status === 408 || response.status >= 500 });
      const data = await response.json().catch(() => { throw new Error('Torn API 返回无效数据'); });
      if (data.error) {
        const code = Number(data.error.code);
        throw Object.assign(new Error('Torn API 错误 ' + code + (code === 5 ? '：账号请求过多，请等待冷却' : [1, 2, 10, 13, 16, 18].includes(code) ? '，请检查 Key 和权限' : '')), { apiCode: code, fatal: [1, 2, 5, 8, 9, 10, 13, 14, 16, 18].includes(code) });
      }
      return data;
    });
    queue = job.catch(() => {}); return job;
  };
}

// Resolve key ownership before allocating lanes: all keys of the same Torn
// player, including Chain keys, must share one quota. Unknown keys are checked
// serially. The process also caps aggregate starts to 10/s across owners.
export function createTornAccountClient({ fetchImpl = fetch, spacingMs = 2000, globalSpacingMs = 100 } = {}) {
  const identities = new Map(), lanes = new Map();
  let globalQueue = Promise.resolve(), globalNext = 0, blockedUntil = 0, blockedCode;
  const cooldownError = () => Object.assign(new Error('Torn API 限流冷却中'), { fatal: true, localCooldown: true, apiCode: blockedCode, rateLimited: ![8, 9].includes(blockedCode), retryAfterMs: Math.max(0, blockedUntil - Date.now()) });
  const beforeFetch = signal => {
    const job = globalQueue.catch(() => {}).then(async () => {
      if (Date.now() < blockedUntil) throw cooldownError();
      await delay(Math.max(0, globalNext - Date.now()), undefined, { signal });
      if (Date.now() < blockedUntil) throw cooldownError();
      signal?.throwIfAborted(); globalNext = Date.now() + globalSpacingMs;
    });
    globalQueue = job.catch(() => {}); return job;
  };
  const options = { fetchImpl, spacingMs, beforeFetch }, bootstrap = createChainApiClient(options);
  const identity = (key, signal) => {
    if (!identities.has(key)) {
      const pending = bootstrap('key/info', key, signal).then(data => {
        if (!Number.isSafeInteger(data.info?.user?.id) || data.info.user.id <= 0) throw Object.assign(new Error('无法确认 API Key 所属账号，扫描已停止'), { fatal: true });
        return data;
      }).catch(error => { identities.delete(key); throw error; });
      identities.set(key, pending);
    }
    return identities.get(key);
  };
  return async (path, key, signal) => {
    try {
      const data = await identity(key, signal); signal?.throwIfAborted();
      if (path === 'key/info') return data;
      const owner = data.info.user.id;
      if (!lanes.has(owner)) lanes.set(owner, createChainApiClient(options));
      return await lanes.get(owner)(path, key, signal);
    } catch (error) {
      if (!error.localCooldown && ([5, 8, 9].includes(error.apiCode) || error.rateLimited)) {
        blockedUntil = Math.max(blockedUntil, Date.now() + Math.max(60000, error.retryAfterMs || 0)); blockedCode = error.apiCode;
      }
      throw error;
    }
  };
}

export const portalTornRequest = createTornAccountClient();

export function createChainStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS torn_chain_monitors (
    user_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]', seen_json TEXT NOT NULL DEFAULT '[]'
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS torn_chain_notifications (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL)');
  db.exec("CREATE TABLE IF NOT EXISTS torn_chain_observations (user_id TEXT PRIMARY KEY, known_json TEXT NOT NULL DEFAULT '[]')");
  const ensure = uid => db.prepare('INSERT OR IGNORE INTO torn_chain_monitors(user_id,config_json) VALUES(?,?)').run(uid, JSON.stringify(DEFAULT_CHAIN_CONFIG));
  const get = uid => {
    ensure(uid); const row = db.prepare('SELECT * FROM torn_chain_monitors WHERE user_id=?').get(uid);
    const history = JSON.parse(row.history_json).map(record => ({ ...record, cooldownStartedAt: Object.hasOwn(record, 'cooldownStartedAt') ? record.cooldownStartedAt : estimateCooldownStart(record.cooldownUntil, record.hits, record.detectedAt) }));
    return { config: { ...DEFAULT_CHAIN_CONFIG, ...JSON.parse(row.config_json) }, history, seen: JSON.parse(row.seen_json) };
  };
  return {
    get,
    updateBonus(uid, id, patch) {
      const { history } = get(uid), row = history.find(item => item.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      db.prepare('UPDATE torn_chain_monitors SET history_json=? WHERE user_id=?').run(JSON.stringify(history), uid);
      return row;
    },
    loadKnown(uid) { const row = db.prepare('SELECT known_json FROM torn_chain_observations WHERE user_id=?').get(uid); return new Map(row ? JSON.parse(row.known_json) : []); },
    saveKnown(uid, known) { db.prepare('INSERT INTO torn_chain_observations(user_id,known_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET known_json=excluded.known_json').run(uid, JSON.stringify([...known].slice(-5000))); },
    getNotify(uid) { const row = db.prepare('SELECT settings_json FROM torn_chain_notifications WHERE user_id=?').get(uid); return row ? JSON.parse(row.settings_json) : structuredClone(DEFAULT_CHAIN_NOTIFY); },
    saveNotify(uid, input) { const settings = chainNotifySettings(input); db.prepare('INSERT INTO torn_chain_notifications(user_id,settings_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json').run(uid, JSON.stringify(settings)); return settings; },
    save(uid, input) { const config = chainConfig(input, get(uid).config); db.prepare('UPDATE torn_chain_monitors SET config_json=? WHERE user_id=?').run(JSON.stringify(config), uid); return config; },
    clear(uid) { ensure(uid); db.prepare("UPDATE torn_chain_monitors SET history_json='[]' WHERE user_id=?").run(uid); },
    record(uid, candidate, chain, fresh, now) {
      const { config, history, seen } = get(uid), id = Number(chain.id);
      if (chain.current < config.minHits || config.maxHits !== null && chain.current > config.maxHits || history.some(row => row.id === id)) return;
      const finalHits = Number.isSafeInteger(candidate.chain) && candidate.chain > 0 ? candidate.chain : chain.current;
      history.push({ id, factionId: Number(candidate.faction.id), name: String(candidate.faction.name || candidate.faction.id).slice(0, 160), hits: chain.current, cooldownStartedAt: estimateCooldownStart(chain.cooldown, finalHits, now), cooldownUntil: chain.cooldown, detectedAt: now, fresh: fresh && !seen.includes(id), notifyEligible: chain.cooldown > now && !seen.includes(id) });
      if (!seen.includes(id)) seen.push(id);
      db.prepare('UPDATE torn_chain_monitors SET history_json=?,seen_json=? WHERE user_id=?').run(JSON.stringify(history.slice(-200)), JSON.stringify(seen.slice(-5000)), uid);
      return history.at(-1);
    }
  };
}

export class ChainMonitor {
  constructor({ uid, store, request, notify = async () => {}, authorize = () => true, now = () => Math.floor(Date.now() / 1000), schedule = setTimeout, cancel = clearTimeout, wait = delay }) {
    Object.assign(this, { uid, store, request, notify, authorize, now, schedule, cancel, wait });
    this.running = false; this.busy = false; this.known = new Map(); this.cursor = 0;
    this.state = { running: false, rounds: 0, candidates: 0, confirmed: 0, failed: 0, partial: false, error: '', lastScanAt: null, nextScanAt: null, retryAt: null, retryAttempt: 0, retryMessage: '', chains: [], detailsAt: null, detailsStale: false };
  }
  status() { return { ...this.state, chains: this.state.chains.map(row => ({ ...row })), running: this.running, busy: this.busy }; }
  safeError(error) { const message = String(error?.message || '请求失败'); return (this.config?.apiKey ? message.replaceAll(this.config.apiKey, '[Key]') : message).slice(0, 240); }
  async api(path, key, signal) {
    const check = () => { if (!this.running || signal?.aborted || !this.authorize()) throw Object.assign(new Error('监控已停止或权限已变更'), { fatal: true }); };
    for (let attempt = 0; ; attempt++) {
      check();
      try { const data = await this.request(path, key, signal); check(); return data; }
      catch (error) {
        check();
        const limited = ![8, 9].includes(error.apiCode) && (error.apiCode === 5 || error.rateLimited);
        if (!limited && (!error.transient || error.fatal)) throw error;
        if (attempt >= 3) throw Object.assign(new Error((limited ? 'Torn API 持续限流' : 'Torn API 网络或服务持续异常') + '，自动重试 3 次后停止；已保存记录保留，请稍后继续'), { fatal: true });
        const ms = limited ? Math.max(65000 * 2 ** attempt, Number(error.retryAfterMs) || 0) : 10000 * 2 ** attempt;
        Object.assign(this.state, { retryAt: this.now() + Math.ceil(ms / 1000), retryAttempt: attempt + 1, retryMessage: (limited ? '限流冷却' : '网络或服务异常') + '，等待自动重试（' + (attempt + 1) + '/3）', nextScanAt: null });
        try { await this.wait(ms, undefined, { signal }); check(); }
        finally { Object.assign(this.state, { retryAt: null, retryAttempt: 0, retryMessage: '' }); }
      }
    }
  }
  start() {
    if (this.running || this.busy) throw new Error('监控正在运行或上次请求尚未结束');
    if (!this.authorize()) throw new Error('无权启动 Chain 监控');
    this.config = this.store.get(this.uid).config;
    if (!this.config.apiKey) throw new Error('请先保存 Public API Key');
    // Restore recent active observations so chains disappearing from the active
    // listing during a restart still receive a detail check. Cooldown dedup is
    // handled by the durable seen IDs, not this optimization cache.
    this.known = new Map([...this.store.loadKnown(this.uid)].filter(([, row]) => row.status === 'active' && this.now() - row.listedAt <= 600));
    this.cursor = 0; this.state.rounds = 0; this.state.error = ''; this.state.notificationError = '';
    this.running = true; this.controller = new AbortController();
    this.promise = this.scan();
  }
  stop() { this.running = false; this.cancel(this.timer); this.controller?.abort(); this.state.nextScanAt = null; }
  reportAttempts(row) { return row.bonusReaderVersion === 2 ? row.bonusAttempts || 0 : 0; }
  async enrichReport(row, check, signal) {
    const selected = this.config.bonusHits.filter(hit => hit <= row.hits);
    if (!selected.length || selected.every(hit => row.bonusDetails?.some(bonus => bonus.hit === hit)) || this.reportAttempts(row) >= 3 || row.bonusAttemptedAt && this.now() - row.bonusAttemptedAt < 60) return row;
    check();
    const attempt = { bonusReaderVersion: 2, bonusAttempts: this.reportAttempts(row) + 1, bonusAttemptedAt: this.now() };
    try {
      let parsed, bonusSource = 'api-v2';
      try {
        const { chainreport } = await this.api('faction/' + row.id + '/chainreport', this.config.apiKey, signal); check();
        parsed = reportBonusDefenders(chainreport, row);
      } catch (error) {
        // Some newly completed public reports return v2 error 6 even though
        // the same chain is listed and its official v1 report is available.
        // Never fall back on authentication, rate limits or private-data errors.
        if (error.apiCode !== 6 || error.fatal) throw error;
        check();
        const { chainreport } = await this.api('https://api.torn.com/torn/' + row.id + '?selections=chainreport', this.config.apiKey, signal); check();
        parsed = legacyReportBonusDefenders(chainreport, row); bonusSource = 'api-v1';
      }
      const bonusDetails = parsed.map(bonus => ({ ...row.bonusDetails?.find(old => old.hit === bonus.hit && old.defenderId === bonus.defenderId), ...bonus }));
      const complete = selected.every(hit => bonusDetails.some(bonus => bonus.hit === hit));
      return this.store.updateBonus(this.uid, row.id, { ...attempt, bonusDetails, bonusSource, bonusStatus: complete ? 'ready' : 'partial' }) || row;
    } catch (error) {
      if (!signal.aborted) this.store.updateBonus(this.uid, row.id, { ...attempt, bonusStatus: 'unavailable' });
      if (error.fatal || signal.aborted) throw error;
      return this.store.get(this.uid).history.find(item => item.id === row.id) || row;
    }
  }
  async enrichBonus(row, check, signal) {
    row = await this.enrichReport(row, check, signal);
    if (this.config.leaderFilter === 'all') return row;
    const bonusDetails = (row.bonusDetails || []).map(bonus => ({ ...bonus }));
    for (const bonus of bonusDetails) {
      if (!this.config.bonusHits.includes(bonus.hit) || bonus.hit > row.hits || typeof bonus.isLeader === 'boolean' || (bonus.leaderAttempts || 0) >= 3 || bonus.leaderAttemptedAt && this.now() - bonus.leaderAttemptedAt < 60) continue;
      check();
      let cached = this.leaderCache.get(bonus.defenderId);
      if (cached && this.now() - cached.leaderCheckedAt >= (typeof cached.isLeader === 'boolean' ? 300 : 60)) cached = null;
      if (!cached && !this.leaderBudget) continue;
      if (!cached) {
        this.leaderBudget--;
        try {
          const result = await lookupDefenderLeader(bonus.defenderId, async path => { check(); const data = await this.api(path, this.config.apiKey, signal); check(); return data; }, this.factionCache);
          cached = { ...result, leaderCheckedAt: this.now() };
        } catch (error) {
          if (error.fatal || signal.aborted) throw error;
          check(); cached = { isLeader: null, factionId: null, leaderCheckedAt: this.now() };
        }
        this.leaderCache.set(bonus.defenderId, cached);
      }
      Object.assign(bonus, cached, { leaderAttempts: (bonus.leaderAttempts || 0) + 1, leaderAttemptedAt: this.now() });
    }
    return this.store.updateBonus(this.uid, row.id, { bonusDetails }) || row;
  }
  needsBonus(row) {
    return this.config.bonusHits.some(hit => {
      if (hit > row.hits) return false;
      const bonus = row.bonusDetails?.find(item => item.hit === hit);
      if (!bonus) return this.reportAttempts(row) < 3 && (!row.bonusAttemptedAt || this.now() - row.bonusAttemptedAt >= 60);
      return this.config.leaderFilter !== 'all' && typeof bonus.isLeader !== 'boolean' && (bonus.leaderAttempts || 0) < 3 && (!bonus.leaderAttemptedAt || this.now() - bonus.leaderAttemptedAt >= 60);
    });
  }
  async notifyRecord(row, check) {
    if (this.config.leaderFilter !== 'all') {
      const unresolved = this.config.bonusHits.some(hit => {
        if (hit > row.hits) return false;
        const bonus = row.bonusDetails?.find(item => item.hit === hit);
        return !bonus ? this.reportAttempts(row) < 3 : typeof bonus.isLeader !== 'boolean' && (bonus.leaderAttempts || 0) < 3;
      });
      if (unresolved && row.cooldownUntil > this.now()) { this.store.updateBonus(this.uid, row.id, { notificationPending: true }); return; }
    }
    check(); this.store.updateBonus(this.uid, row.id, { notificationPending: false });
    if (row.cooldownUntil <= this.now()) return;
    if (this.config.leaderFilter !== 'all' && !selectedBonusDefenders(row, this.config.bonusHits, this.config.leaderFilter).length) return;
    try { await this.notify({ ...row, bonusSelection: this.config.bonusHits, leaderFilter: this.config.leaderFilter }); this.state.notificationError = ''; }
    catch { this.state.notificationError = '冷却记录已保存，但通知未能全部投递，请检查通知管理（不自动重试）'; }
  }
  async scan() {
    if (!this.running || this.busy) return;
    this.busy = true; const signal = this.controller.signal;
    this.state.detailsStale = true;
    const valid = () => this.running && !signal.aborted && this.authorize();
    const check = () => { if (!valid()) throw Object.assign(new Error('监控已停止或权限已变更'), { fatal: true }); };
    const stats = { candidates: 0, belowMinimum: 0, confirmed: 0, failed: 0, partial: false, error: '' };
    this.leaderBudget = 10; this.leaderCache ||= new Map(); this.factionCache = new Map();
    for (const [id, cached] of this.leaderCache) if (this.now() - cached.leaderCheckedAt >= 300) this.leaderCache.delete(id);
    try {
      check(); const candidates = new Map(), visited = new Set(), skipped = new Set();
      const belowMinimum = hits => Number.isSafeInteger(hits) && hits >= 0 && hits < this.config.minHits;
      // Oldest starts first: default descending pages expose older pages as
      // `prev`, while `next` can be null even on a full first page.
      let path = 'faction/warfarechains?cat=active&limit=100&sort=asc', pages = 0;
      while (path) {
        check(); if (visited.has(path)) { stats.partial = true; break; } visited.add(path);
        const data = await this.api(path, this.config.apiKey, signal); check();
        if (!Array.isArray(data.warfarechains)) throw new Error('API 未返回 Chain 列表');
        for (const row of data.warfarechains) if (Number.isSafeInteger(row?.id) && row.id > 0 && Number.isSafeInteger(row.faction?.id) && row.faction.id > 0) {
          const old = this.known.get(row.id);
          if (belowMinimum(row.chain) && !(old?.status === 'active' && Number.isSafeInteger(old.hits) && old.hits >= this.config.minHits)) { skipped.add(row.id); continue; }
          candidates.set(row.id, row); skipped.delete(row.id); if (old) old.listedAt = this.now();
        }
        path = data._metadata?.links?.next || null; pages++;
        // Live active responses can omit BOTH links on a full ascending page.
        // `from` is inclusive; retain the boundary and deduplicate Chain IDs.
        if (!path && data.warfarechains.length === 100) {
          const starts = data.warfarechains.map(row => row.start);
          if (starts.every(start => Number.isSafeInteger(start) && start > 0)) path = 'faction/warfarechains?cat=active&limit=100&sort=asc&from=' + Math.max(...starts);
          else stats.partial = true;
        }
        if (path && pages >= 10) { stats.partial = true; break; }
      }
      const listedIds = new Set(candidates.keys());
      for (const [id, old] of this.known) if (old.status === 'active' && this.now() - old.listedAt <= 600 && !candidates.has(id) && !belowMinimum(old.hits ?? old.candidate?.chain)) { candidates.set(id, old.candidate); skipped.delete(id); }
      stats.belowMinimum = skipped.size;
      stats.candidates = candidates.size;
      const eligible = [...candidates.values()].filter(row => { const old = this.known.get(row.id); return !(old?.status === 'cooldown' && old.until > this.now()); });
      const count = Math.min(40, eligible.length); stats.remainingCandidates = eligible.length - count;
      const chosen = new Set(Array.from({ length: count }, (_, i) => eligible[(this.cursor + i) % eligible.length].id));
      this.state.chains = [...candidates.values()].map(candidate => {
        const old = this.known.get(candidate.id), cached = old?.status === 'cooldown' && old.until > this.now();
        const hits = cached && Number.isSafeInteger(old.hits) ? old.hits : Number.isSafeInteger(candidate.chain) ? candidate.chain : null;
        return { id: candidate.id, factionId: candidate.faction.id, name: String(candidate.faction.name || candidate.faction.id).slice(0, 160), hits, hitsSource: cached && Number.isSafeInteger(old.hits) ? 'verified' : 'list', status: cached ? 'cooldown' : 'waiting', cached: !!cached, listed: listedIds.has(candidate.id), verifiedAt: old?.checkedAt || null, previousStatus: old?.status || null, attemptedAt: null, cooldownUntil: cached ? old.until : null, timeoutSeconds: null, inRange: hits === null ? null : hits >= this.config.minHits && (this.config.maxHits === null || hits <= this.config.maxHits), reason: cached ? '已确认冷却且尚未到期，复用缓存' : chosen.has(candidate.id) ? '等待本轮核验' : '本轮核验名额已满，等待后续轮换' };
      });
      this.state.detailsAt = this.now(); this.state.detailsStale = false;
      Object.assign(this.state, stats);
      const detailRows = new Map(this.state.chains.map(row => [row.id, row]));
      for (let i = 0; i < count; i++) {
        check(); const candidate = eligible[(this.cursor + i) % eligible.length];
        const row = detailRows.get(candidate.id); row.status = 'checking'; row.reason = '正在核验'; row.attemptedAt = this.now();
        let detailConfirmed = false;
        try {
          const { chain } = await this.api('faction/' + candidate.faction.id + '/chain', this.config.apiKey, signal); check();
          if (!chain || chain.id !== candidate.id || !['current', 'cooldown', 'timeout'].every(field => Number.isSafeInteger(chain[field]) && chain[field] >= 0)) {
            row.status = 'unknown'; row.reason = chain && Number.isSafeInteger(chain.id) && chain.id !== candidate.id ? `返回的 Chain ID ${chain.id} 与候选 ${candidate.id} 不一致，未判定状态` : 'API 缺少有效的 Chain 长度或计时数据，未判定状态';
            stats.failed++; this.state.failed = stats.failed; continue;
          }
          const old = this.known.get(chain.id), status = chain.cooldown > this.now() ? 'cooldown' : chain.timeout > 0 ? 'active' : 'ended';
          detailConfirmed = true;
          Object.assign(row, { status, hits: chain.current, hitsSource: 'verified', verifiedAt: this.now(), previousStatus: status, cooldownUntil: chain.cooldown || null, timeoutSeconds: chain.timeout, inRange: chain.current >= this.config.minHits && (this.config.maxHits === null || chain.current <= this.config.maxHits), reason: listedIds.has(chain.id) ? '详情核验成功' : '已从列表消失，保留跟踪后核验成功' });
          this.known.set(chain.id, { status, until: chain.cooldown, hits: chain.current, checkedAt: row.verifiedAt, candidate, listedAt: this.now() });
          this.store.saveKnown(this.uid, this.known); stats.confirmed++; this.state.confirmed = stats.confirmed;
          if (status === 'cooldown') {
            let record = this.store.record(this.uid, candidate, chain, old?.status === 'active', this.now());
            if (record) record = await this.enrichBonus(record, check, signal);
            if (record?.notifyEligible) {
              await this.notifyRecord(record, check);
            }
          }
        } catch (error) {
          if (detailConfirmed) row.reason = 'Chain 已核验，后续处理未完成：' + this.safeError(error);
          else if (!valid()) { row.status = 'waiting'; row.reason = '监控已停止，本条核验未完成'; }
          else { row.status = 'failed'; row.reason = this.safeError(error); stats.failed++; this.state.failed = stats.failed; }
          if (error.fatal || !valid()) throw error;
        }
      }
      this.cursor = eligible.length ? (this.cursor + count) % eligible.length : 0;
      // Backfill recent saved records when bonus selections are enabled later.
      // At most five reports per round, with three attempts per saved record.
      const backlog = [...this.store.get(this.uid).history].reverse().filter(row => this.needsBonus(row) || row.notificationPending).slice(0, 5);
      for (const row of backlog) { check(); const enriched = await this.enrichBonus(row, check, signal); if (enriched.notificationPending) await this.notifyRecord(enriched, check); }
      for (const [id, old] of this.known) if (this.now() - old.listedAt > 86400) this.known.delete(id);
      this.state.rounds++; this.state.lastScanAt = this.now();
    } catch (error) {
      if (!signal.aborted) { stats.error = String(error.message).replaceAll(this.config.apiKey, '[Key]'); if (error.fatal) this.stop(); }
    } finally {
      for (const row of this.state.chains) if (row.status === 'checking') { row.status = 'waiting'; row.reason = '核验未完成，等待下一轮'; }
      this.store.saveKnown(this.uid, this.known);
      Object.assign(this.state, stats); this.busy = false;
      if (valid()) {
        this.state.nextScanAt = this.now() + this.config.intervalSeconds;
        this.timer = this.schedule(() => { this.promise = this.scan(); }, this.config.intervalSeconds * 1000); this.timer?.unref?.();
      } else this.stop();
    }
  }
}
