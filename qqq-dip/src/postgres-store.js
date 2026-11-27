import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRoot } from './config.js';
import { DEFAULT_EVENTS, emptyRound } from './playbook.js';
import { portfolioDipLots } from './portfolio-lots.js';
import { getPortfolioCash, setPortfolioCash, migrateDipCashOnce, getPortfolioStore } from '../../shared/db/portfolio-bridge.js';
import { defaultCash, defaultNotify, defaultSettings, paginateActions } from './store.js';

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function emptyData(config) {
  return {
    cash: defaultCash(),
    round: emptyRound(),
    settings: defaultSettings(),
    notify: defaultNotify(config?.notify),
    quotes: {},
    lots: [],
    actions: []
  };
}

function normalizeData(config, raw) {
  const data = { ...emptyData(config), ...(raw || {}) };
  data.cash = { ...defaultCash(), ...(data.cash || {}) };
  data.round = { ...emptyRound(), ...(data.round || {}) };
  data.settings = { ...defaultSettings(), ...(data.settings || {}) };
  data.notify = defaultNotify(data.notify);
  data.quotes = data.quotes && typeof data.quotes === 'object' ? data.quotes : {};
  data.lots = Array.isArray(data.lots) ? data.lots : [];
  data.actions = Array.isArray(data.actions) ? data.actions : [];
  return data;
}

export async function createPostgresStore(config, db) {
  const dbPath = path.resolve(resolveRoot(), config.dbPath || 'data/qqq-dip.db');
  const jsonPath = dbPath.replace(/\.db$/i, '.json');
  const readState = "SELECT data FROM navigation.qqq_dip_state WHERE id='default'";
  let row = (await db.query(readState)).rows[0];
  if (!row) {
    const legacy = fs.existsSync(jsonPath) ? parseJson(fs.readFileSync(jsonPath, 'utf8'), {}) : {};
    const payload = JSON.stringify(normalizeData(config, legacy));
    row = (await db.query(`INSERT INTO navigation.qqq_dip_state(id,data,updated_at) VALUES('default',$1,$2)
      ON CONFLICT(id) DO NOTHING RETURNING data`, [payload, new Date().toISOString()])).rows[0];
    row ??= (await db.query(readState)).rows[0];
  }
  const canonicalQqToken = String(config?.notify?.qq?.token || '').trim();
  const resolveNotifyToken = stored => {
    const saved = String(stored || '').trim();
    return canonicalQqToken || saved;
  };
  let data = normalizeData(config, parseJson(row.data, {}));
  await migrateDipCashOnce(data.cash);

  let writeChain = Promise.resolve();
  function update(change) {
    const write = writeChain.then(async () => {
      const { payload, result } = await db.transaction(async client => {
        const { rows: [current] } = await client.query(readState + ' FOR UPDATE');
        if (!current) throw new Error('抄底监控状态不存在');
        const draft = normalizeData(config, parseJson(current.data, {}));
        if (canonicalQqToken) draft.notify.qq.token = canonicalQqToken;
        const result = change(draft);
        const payload = JSON.stringify(draft);
        if (payload !== current.data) {
          await client.query("UPDATE navigation.qqq_dip_state SET data=$1, updated_at=$2 WHERE id='default'",
            [payload, new Date().toISOString()]);
        }
        return { payload, result };
      });
      data = JSON.parse(payload);
      return result;
    });
    // A rejected transaction leaves the cache intact and the next write can retry.
    writeChain = write.catch(() => {});
    return write;
  }

  async function getCash() {
    return { ...defaultCash(), ...(await getPortfolioCash()) };
  }
  async function setCash(cash) {
    const prev = await getCash();
    const next = await setPortfolioCash({
      cashUsd: cash.cashUsd != null ? Number(cash.cashUsd) || 0 : prev.cashUsd,
      cashCny: cash.cashCny != null ? Number(cash.cashCny) || 0 : prev.cashCny,
      usdCnyRate: Number(cash.usdCnyRate) > 0 ? Number(cash.usdCnyRate) : prev.usdCnyRate,
      fxSource: cash.fxSource != null ? cash.fxSource : prev.fxSource,
      fxUpdatedAt: cash.fxUpdatedAt != null ? cash.fxUpdatedAt : prev.fxUpdatedAt
    });
    // The portfolio owns cash. The state document keeps the original migration input.
    return { ...defaultCash(), ...next };
  }
  function getRound() { return structuredClone({ ...emptyRound(), ...data.round }); }
  function setRound(round) {
    return update(draft => {
      draft.round = round;
      return round;
    });
  }
  function getSettings() { return { ...defaultSettings(), ...data.settings }; }
  function setSettings(patch) {
    return update(draft => {
      draft.settings = { ...draft.settings, ...patch };
      return draft.settings;
    });
  }
  function getNotify() {
    const n = defaultNotify(structuredClone(data.notify));
    n.qq.token = resolveNotifyToken(n.qq.token);
    return n;
  }
  function setNotify(patch, previous) {
    return update(draft => {
      const prev = defaultNotify(previous ?? draft.notify);
      const incoming = patch || {};
      const qq = { ...prev.qq, ...(incoming.qq || {}) };
      if (!incoming.qq?.token || !String(incoming.qq.token).trim() || String(incoming.qq.token).includes('*')) {
        qq.token = resolveNotifyToken(prev.qq.token);
      }
      const targets = Array.isArray(incoming.targets) ? incoming.targets : prev.targets;
      draft.notify = {
        desktop: incoming.desktop ?? prev.desktop,
        qq,
        slack: { enabled: incoming.slack?.enabled ?? prev.slack.enabled },
        targets: targets.map((t, i) => ({ id: t.id || `t-${Date.now()}-${i}`, type: t.type === 'private' ? 'private' : 'group',
          groupId: String(t.groupId || '').trim(), atUserId: String(t.atUserId || '').trim(), userId: String(t.userId || '').trim() })),
        events: { ...DEFAULT_EVENTS, ...prev.events, ...(incoming.events || {}) }
      };
      return draft.notify;
    });
  }
  function getQuotes() { return structuredClone(data.quotes || {}); }
  function setQuotes(quotes) {
    return update(draft => {
      draft.quotes = quotes || {};
      return draft.quotes;
    });
  }
  function addAction(entry) {
    const row = { id: entry.id || randomUUID(), ts: entry.ts || new Date().toISOString(), type: entry.type || 'signal',
      source: entry.source || 'auto', tier: entry.tier || null, symbol: entry.symbol || null,
      message: String(entry.message || ''), payload: entry.payload != null ? entry.payload : null };
    return update(draft => {
      draft.actions.unshift(row);
      if (draft.actions.length > 1000) draft.actions.length = 1000;
      return row;
    });
  }
  function listActionRows({ limit = 100, offset = 0, source = 'all' } = {}) {
    return structuredClone(paginateActions(data.actions, { limit, offset, source }));
  }
  function patchAction(id, patch) {
    return update(draft => {
      const prev = draft.actions.find(a => a.id === id);
      if (!prev || prev.type !== 'note' || prev.source !== 'user' || prev.payload?.syncedTradeIds?.length) return null;
      if (patch.message != null) prev.message = String(patch.message);
      return prev;
    });
  }
  function reconcileLots(state, trades) {
    const manual = state.lots.filter(lot => lot.source !== 'portfolio-trade');
    const fillMetadata = state.actions.flatMap(action => (action.payload?.syncedTradeIds || []).map((id, index) => ({
      id: `portfolio:${id}`, otmClass: action.payload?.legs?.[index]?.otmClass
    })));
    return [...manual, ...portfolioDipLots(trades, [...fillMetadata, ...state.lots], state.hiddenTradeLots || [])];
  }
  async function getLots() {
    const { trades } = await (await getPortfolioStore()).read();
    const next = reconcileLots(data, trades);
    if (JSON.stringify(next) === JSON.stringify(data.lots)) return structuredClone(data.lots);
    return update(draft => {
      draft.lots = reconcileLots(draft, trades);
      return draft.lots;
    });
  }
  function saveLot(lot) {
    const id = lot.id || randomUUID();
    const next = { ...lot, id };
    return update(draft => {
      const idx = draft.lots.findIndex(l => l.id === id);
      if (idx >= 0) draft.lots[idx] = next;
      else draft.lots.push(next);
      return next;
    });
  }
  function removeLot(id) {
    return update(draft => {
      if (draft.lots.some(lot => lot.id === id && lot.source === 'portfolio-trade')) {
        draft.hiddenTradeLots = [...new Set([...(draft.hiddenTradeLots || []), id])];
      }
      draft.lots = draft.lots.filter(l => l.id !== id);
    });
  }
  function markFired(key) {
    return update(({ round }) => {
      round.firedAlerts = { ...(round.firedAlerts || {}), [key]: new Date().toISOString() };
      return round;
    });
  }
  async function markExecuted(tier, payload) {
    const cashUsd = Math.max(0, Number(payload.cashUsd) || 0);
    const cashCny = Math.max(0, Number(payload.cashCny) || 0);
    const cash = await getCash();
    const usd = payload.usd != null ? Number(payload.usd) || 0
      : roundMoneyLocal(cashUsd + (cash.usdCnyRate > 0 ? cashCny / cash.usdCnyRate : 0));
    return update(({ round }) => {
      const previous = round.executed?.[tier] || {};
      round.executed = {
        ...(round.executed || {}),
        [tier]: {
          usd: roundMoneyLocal((Number(previous.usd) || 0) + usd),
          cashUsd: roundMoneyLocal((Number(previous.cashUsd) || 0) + cashUsd),
          cashCny: roundMoneyLocal((Number(previous.cashCny) || 0) + cashCny),
          complete: payload.complete !== false,
          at: new Date().toISOString(),
          note: payload.note || ''
        }
      };
      return round;
    });
  }
  function roundMoneyLocal(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  return { dbPath: jsonPath, mode: 'postgres', getCash, setCash, getRound, setRound, getSettings, setSettings,
    getNotify, setNotify, getQuotes, setQuotes, addAction, listActionRows, patchAction, getLots, saveLot, removeLot,
    markFired, markExecuted };
}
