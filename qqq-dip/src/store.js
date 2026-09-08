import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRoot } from './config.js';
import { DEFAULT_EVENTS, emptyRound } from './playbook.js';

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function defaultNotify(seed = {}) {
  return {
    desktop: seed.desktop === true,
    qq: {
      enabled: seed.qq?.enabled !== false,
      url: seed.qq?.url || 'http://127.0.0.1:8787/notify',
      token: seed.qq?.token || ''
    },
    targets: Array.isArray(seed.targets) && seed.targets.length
      ? seed.targets
      : [{ id: 't-default', type: 'group', groupId: '', atUserId: '', userId: '' }],
    events: { ...DEFAULT_EVENTS, ...(seed.events || {}) }
  };
}

export function defaultCash() {
  return { cashUsd: 0, cashCny: 0, usdCnyRate: 7.2 };
}

export function defaultSettings() {
  return {
    variant: 'default',
    autoStart: false,
    intervalSeconds: 30,
    showSpy: true,
    soxlEnabled: false
  };
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

export function createStore(config) {
  const dbPath = path.resolve(resolveRoot(), config.dbPath || 'data/qqq-dip.db');
  const jsonPath = dbPath.replace(/\.db$/i, '.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

  let data = emptyData(config);
  if (fs.existsSync(jsonPath)) {
    data = { ...emptyData(config), ...parseJson(fs.readFileSync(jsonPath, 'utf8'), {}) };
    data.cash = { ...defaultCash(), ...(data.cash || {}) };
    data.round = { ...emptyRound(), ...(data.round || {}) };
    data.settings = { ...defaultSettings(), ...(data.settings || {}) };
    data.notify = defaultNotify(data.notify);
    data.quotes = data.quotes && typeof data.quotes === 'object' ? data.quotes : {};
    data.lots = Array.isArray(data.lots) ? data.lots : [];
    data.actions = Array.isArray(data.actions) ? data.actions : [];
  }

  function persist() {
    const tmp = jsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, jsonPath);
  }

  function getCash() {
    return { ...defaultCash(), ...data.cash };
  }

  function setCash(cash) {
    data.cash = {
      cashUsd: Number(cash.cashUsd) || 0,
      cashCny: Number(cash.cashCny) || 0,
      usdCnyRate: Number(cash.usdCnyRate) > 0 ? Number(cash.usdCnyRate) : getCash().usdCnyRate
    };
    persist();
    return data.cash;
  }

  function getRound() {
    return { ...emptyRound(), ...data.round };
  }

  function setRound(round) {
    data.round = round;
    persist();
    return round;
  }

  function getSettings() {
    return { ...defaultSettings(), ...data.settings };
  }

  function setSettings(patch) {
    data.settings = { ...getSettings(), ...patch };
    persist();
    return data.settings;
  }

  function getNotify() {
    return defaultNotify(data.notify);
  }

  function setNotify(patch, previous = getNotify()) {
    const prev = defaultNotify(previous);
    const incoming = patch || {};
    const qq = { ...prev.qq, ...(incoming.qq || {}) };
    if (!incoming.qq?.token || !String(incoming.qq.token).trim() || String(incoming.qq.token).includes('*')) {
      qq.token = prev.qq.token;
    }
    const targets = Array.isArray(incoming.targets) ? incoming.targets : prev.targets;
    data.notify = {
      desktop: incoming.desktop ?? prev.desktop,
      qq,
      targets: targets.map((t, i) => ({
        id: t.id || `t-${Date.now()}-${i}`,
        type: t.type === 'private' ? 'private' : 'group',
        groupId: String(t.groupId || '').trim(),
        atUserId: String(t.atUserId || '').trim(),
        userId: String(t.userId || '').trim()
      })),
      events: { ...DEFAULT_EVENTS, ...prev.events, ...(incoming.events || {}) }
    };
    persist();
    return data.notify;
  }

  function getQuotes() {
    return data.quotes || {};
  }

  function setQuotes(quotes) {
    data.quotes = quotes || {};
    persist();
    return data.quotes;
  }

  function addAction(entry) {
    const row = {
      id: entry.id || randomUUID(),
      ts: entry.ts || new Date().toISOString(),
      type: entry.type || 'signal',
      source: entry.source || 'auto',
      tier: entry.tier || null,
      symbol: entry.symbol || null,
      message: String(entry.message || ''),
      payload: entry.payload != null ? entry.payload : null
    };
    data.actions.unshift(row);
    if (data.actions.length > 1000) data.actions = data.actions.slice(0, 1000);
    persist();
    return row;
  }

  function listActionRows({ limit = 100, offset = 0 } = {}) {
    const start = Number(offset) || 0;
    const lim = Math.min(Number(limit) || 100, 500);
    return {
      total: data.actions.length,
      items: data.actions.slice(start, start + lim)
    };
  }

  function patchAction(id, patch) {
    const prev = data.actions.find((a) => a.id === id);
    if (!prev) return null;
    prev.type = patch.type || prev.type;
    if (patch.message != null) prev.message = String(patch.message);
    prev.payload = { ...(prev.payload || {}), ...(patch.payload || {}) };
    persist();
    return prev;
  }

  function getLots() {
    return data.lots.slice();
  }

  function saveLot(lot) {
    const id = lot.id || randomUUID();
    const next = { ...lot, id };
    const idx = data.lots.findIndex((l) => l.id === id);
    if (idx >= 0) data.lots[idx] = next;
    else data.lots.push(next);
    persist();
    return next;
  }

  function removeLot(id) {
    data.lots = data.lots.filter((l) => l.id !== id);
    persist();
  }

  function markFired(key) {
    const round = getRound();
    round.firedAlerts = { ...(round.firedAlerts || {}), [key]: new Date().toISOString() };
    setRound(round);
    return round;
  }

  function markExecuted(tier, payload) {
    const round = getRound();
    round.executed = {
      ...(round.executed || {}),
      [tier]: { usd: Number(payload.usd) || 0, at: new Date().toISOString(), note: payload.note || '' }
    };
    setRound(round);
    return round;
  }

  persist();

  return {
    dbPath: jsonPath,
    getCash,
    setCash,
    getRound,
    setRound,
    getSettings,
    setSettings,
    getNotify,
    setNotify,
    getQuotes,
    setQuotes,
    addAction,
    listActionRows,
    patchAction,
    getLots,
    saveLot,
    removeLot,
    markFired,
    markExecuted
  };
}
