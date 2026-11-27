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
  let data;
  const row = (await db.query("SELECT data FROM navigation.qqq_dip_state WHERE id='default'")).rows[0];
  if (row) data = normalizeData(config, parseJson(row.data, {}));
  else {
    const legacy = fs.existsSync(jsonPath) ? parseJson(fs.readFileSync(jsonPath, 'utf8'), {}) : {};
    data = normalizeData(config, legacy);
    await db.query(`INSERT INTO navigation.qqq_dip_state(id,data,updated_at) VALUES('default',$1,$2)
      ON CONFLICT(id) DO NOTHING`, [JSON.stringify(data), new Date().toISOString()]);
  }
  const canonicalQqToken = String(config?.notify?.qq?.token || '').trim();
  const resolveNotifyToken = stored => {
    const saved = String(stored || '').trim();
    return canonicalQqToken || saved;
  };
  const syncNotifyToken = () => {
    if (!canonicalQqToken) return;
    if (String(data.notify?.qq?.token || '').trim() !== canonicalQqToken) {
      data.notify = defaultNotify({ ...data.notify, qq: { ...data.notify?.qq, token: canonicalQqToken } });
    }
  };
  syncNotifyToken();
  await migrateDipCashOnce({ ...defaultCash(), ...(data.cash || {}) });
  data.cash = { ...defaultCash(), ...(await getPortfolioCash()) };

  let writeChain = Promise.resolve();
  function persist() {
    const payload = JSON.stringify(data);
    writeChain = writeChain.then(() => db.query(`INSERT INTO navigation.qqq_dip_state(id,data,updated_at)
      VALUES('default',$1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
    [payload, new Date().toISOString()]));
    return writeChain;
  }

  async function getCash() {
    const cash = { ...defaultCash(), ...(await getPortfolioCash()) };
    data.cash = cash;
    return { ...cash };
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
    data.cash = { ...defaultCash(), ...next };
    await persist();
    return data.cash;
  }
  function getRound() { return { ...emptyRound(), ...data.round }; }
  async function setRound(round) { data.round = round; await persist(); return round; }
  function getSettings() { return { ...defaultSettings(), ...data.settings }; }
  async function setSettings(patch) { data.settings = { ...getSettings(), ...patch }; await persist(); return data.settings; }
  function getNotify() {
    const n = defaultNotify(data.notify);
    n.qq.token = resolveNotifyToken(n.qq.token);
    return n;
  }
  async function setNotify(patch, previous = getNotify()) {
    const prev = defaultNotify(previous);
    const incoming = patch || {};
    const qq = { ...prev.qq, ...(incoming.qq || {}) };
    if (!incoming.qq?.token || !String(incoming.qq.token).trim() || String(incoming.qq.token).includes('*')) {
      qq.token = resolveNotifyToken(prev.qq.token);
    }
    const targets = Array.isArray(incoming.targets) ? incoming.targets : prev.targets;
    data.notify = {
      desktop: incoming.desktop ?? prev.desktop,
      qq,
      slack: { enabled: incoming.slack?.enabled ?? prev.slack.enabled },
      targets: targets.map((t, i) => ({ id: t.id || `t-${Date.now()}-${i}`, type: t.type === 'private' ? 'private' : 'group',
        groupId: String(t.groupId || '').trim(), atUserId: String(t.atUserId || '').trim(), userId: String(t.userId || '').trim() })),
      events: { ...DEFAULT_EVENTS, ...prev.events, ...(incoming.events || {}) }
    };
    await persist();
    return data.notify;
  }
  function getQuotes() { return data.quotes || {}; }
  async function setQuotes(quotes) { data.quotes = quotes || {}; await persist(); return data.quotes; }
  async function addAction(entry) {
    const row = { id: entry.id || randomUUID(), ts: entry.ts || new Date().toISOString(), type: entry.type || 'signal',
      source: entry.source || 'auto', tier: entry.tier || null, symbol: entry.symbol || null,
      message: String(entry.message || ''), payload: entry.payload != null ? entry.payload : null };
    data.actions.unshift(row);
    if (data.actions.length > 1000) data.actions = data.actions.slice(0, 1000);
    await persist();
    return row;
  }
  function listActionRows({ limit = 100, offset = 0, source = 'all' } = {}) {
    return paginateActions(data.actions, { limit, offset, source });
  }
  async function patchAction(id, patch) {
    const prev = data.actions.find(a => a.id === id);
    if (!prev || prev.type !== 'note' || prev.source !== 'user' || prev.payload?.syncedTradeIds?.length) return null;
    if (patch.message != null) prev.message = String(patch.message);
    await persist();
    return prev;
  }
  async function getLots() {
    const manual = data.lots.filter(lot => lot.source !== 'portfolio-trade');
    const fillMetadata = data.actions.flatMap(action => (action.payload?.syncedTradeIds || []).map((id, index) => ({
      id: `portfolio:${id}`, otmClass: action.payload?.legs?.[index]?.otmClass
    })));
    const portfolio = await getPortfolioStore();
    const synced = portfolioDipLots((await portfolio.read()).trades, [...fillMetadata, ...data.lots], data.hiddenTradeLots || []);
    const next = [...manual, ...synced];
    if (JSON.stringify(next) !== JSON.stringify(data.lots)) {
      data.lots = next;
      await persist();
    }
    return data.lots.slice();
  }
  async function saveLot(lot) {
    const id = lot.id || randomUUID();
    const next = { ...lot, id };
    const idx = data.lots.findIndex(l => l.id === id);
    if (idx >= 0) data.lots[idx] = next;
    else data.lots.push(next);
    await persist();
    return next;
  }
  async function removeLot(id) {
    if (data.lots.some(lot => lot.id === id && lot.source === 'portfolio-trade')) {
      data.hiddenTradeLots = [...new Set([...(data.hiddenTradeLots || []), id])];
    }
    data.lots = data.lots.filter(l => l.id !== id);
    await persist();
  }
  async function markFired(key) {
    const round = getRound();
    round.firedAlerts = { ...(round.firedAlerts || {}), [key]: new Date().toISOString() };
    await setRound(round);
    return round;
  }
  async function markExecuted(tier, payload) {
    const cashUsd = Math.max(0, Number(payload.cashUsd) || 0);
    const cashCny = Math.max(0, Number(payload.cashCny) || 0);
    const cash = await getCash();
    const usd = payload.usd != null ? Number(payload.usd) || 0
      : roundMoneyLocal(cashUsd + (cash.usdCnyRate > 0 ? cashCny / cash.usdCnyRate : 0));
    const round = getRound();
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
    await setRound(round);
    return round;
  }
  function roundMoneyLocal(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  return { dbPath: jsonPath, mode: 'postgres', getCash, setCash, getRound, setRound, getSettings, setSettings,
    getNotify, setNotify, getQuotes, setQuotes, addAction, listActionRows, patchAction, getLots, saveLot, removeLot,
    markFired, markExecuted };
}
