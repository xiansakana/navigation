import { evaluate, applyRoundFromEval, newAlertKeys, buildBuyPreview } from './playbook.js';
import { marketStatus, isOpenSummaryTime, isRth } from './market-hours.js';
import { appendMarketSnapshot } from './notify.js';
import { publishBusinessEvent } from '../../shared/business-events.js';
import { withDeadline } from './deadline.js';
import { captureExecutionPlan } from './execution-plan.js';

const SYMBOLS = ['QQQ', 'TQQQ', 'SOXL', 'SPY'];

function alertMarket(ev, alert) {
  const symbol = alert?.symbol || 'QQQ';
  const key = symbol.toLowerCase();
  return { symbol, stats: ev?.[key] || ev?.qqq };
}

export function createMonitor({ store, quotes, onSnapshot, refreshFx, publish = publishBusinessEvent, stageTimeoutMs = 240000, tickTimeoutMs = 300000 }) {
  let timer = null;
  let running = false;
  let busy = false;
  let lastError = null;
  let lastPush = null;
  let checks = 0;
  let lastEval = null;
  let lastMarketStatus = marketStatus();
  let phase = 'idle';
  let phaseStartedAt = null;
  let tickStartedAt = null;
  let lastCompletedAt = null;
  let consecutiveFailures = 0;
  let tickDeadlineAt = 0;

  async function stage(name, operation, limitMs = stageTimeoutMs) {
    phase = name;
    phaseStartedAt = new Date().toISOString();
    const remainingMs = tickDeadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error(`监控整轮超时，阶段 ${name}`);
    return withDeadline(operation, Math.min(limitMs, remainingMs), `监控阶段 ${name}`);
  }

  function status() {
    return {
      running,
      busy,
      checks,
      lastError,
      lastPush,
      market: lastMarketStatus,
      intervalSeconds: store.getSettings().intervalSeconds,
      phase,
      phaseStartedAt,
      tickStartedAt,
      lastCompletedAt,
      consecutiveFailures
    };
  }

  async function enrichLots(lots) {
    const out = [];
    for (const lot of lots) {
      if (lot.type === 'call' && lot.symbol && quotes.parseOptionSymbol(lot.symbol)) {
        try {
          const snap = await quotes.getOptionSnapshot(lot.symbol);
          out.push({ ...lot, mark: snap.price });
        } catch (e) {
          out.push({ ...lot, markError: e.message });
        }
      } else {
        out.push(lot);
      }
    }
    return out;
  }

  async function suggestLeaps(evalResult) {
    const expiries = evalResult.leaps?.expiries || [];
    const band = evalResult.leaps?.medium;
    if (!band || !expiries.length) return [];
    const first = expiries[0];
    const last = expiries[expiries.length - 1];
    return quotes.searchLeapCalls('QQQ', band.low, band.high, first.expiry, last.expiry);
  }

  async function tick(opts = {}) {
    if (busy) return lastEval;
    busy = true;
    tickStartedAt = new Date().toISOString();
    tickDeadlineAt = Date.now() + tickTimeoutMs;
    lastMarketStatus = marketStatus();
    const rth = isRth();
    try {
      if (refreshFx) await stage('refreshFx', refreshFx);
      const settings = store.getSettings();
      const cash = store.getCash();
      const round = store.getRound();
      const bundle = await stage('marketQuotes', () => quotes.getMarketBundle(
        settings.showSpy === false ? ['QQQ', 'TQQQ', 'SOXL'] : SYMBOLS,
        { previousVxn: store.getQuotes().VXN }
      ));
      const markets = bundle.markets;
      store.setQuotes(markets);
      const lots = await stage('positionQuotes', () => enrichLots(store.getLots()));
      const ev = evaluate({
        cashUsd: cash.strategyCashUsd ?? cash.cashUsd,
        cashCny: cash.strategyCashCny ?? cash.cashCny,
        usdCnyRate: cash.usdCnyRate,
        variant: settings.variant,
        soxlEnabled: settings.soxlEnabled,
        round,
        rth,
        sessionDate: lastMarketStatus.ymd,
        qqq: markets.QQQ,
        tqqq: markets.TQQQ,
        soxl: markets.SOXL,
        spy: markets.SPY,
        vxn: markets.VXN,
        cnyProxy: markets['159509'],
        lots
      });
      ev.quoteErrors = bundle.errors;
      try {
        ev.suggestedContracts = await stage('suggestLeaps', () => suggestLeaps(ev));
      } catch {
        ev.suggestedContracts = [];
      }
      ev.buyPreview = buildBuyPreview(ev, ev.suggestedContracts);
      // Persist observed peaks only, never pretend a suggested sale was filled.
      for (const lot of ev.lots || []) {
        const previous = lots.find((row) => row.id === lot.id);
        if (store.saveLot && previous && (lot.holdingHigh > (Number(previous.holdingHigh) || 0)
          || (lot.multiple >= 3 && !previous.reached3x) || (lot.multiple >= 5 && !previous.reached5x))) {
          store.saveLot({ ...previous, holdingHigh: lot.holdingHigh,
            reached3x: previous.reached3x || lot.multiple >= 3,
            reached5x: previous.reached5x || lot.multiple >= 5 });
        }
      }

      const nextRound = captureExecutionPlan(
        applyRoundFromEval(round, ev, { sessionDate: lastMarketStatus.ymd }), ev.buyPreview);
      // Recover recent, still-active legacy signals that were consumed by the
      // off-hours filter without ever attempting notification. Never replay a
      // signal with a delivery attempt or change its plan/budget state.
      if (!nextRound.deliveryVersion) {
        nextRound.firedAlerts = { ...nextRound.firedAlerts };
        const actions = [0, 500].flatMap((offset) => store.listActionRows?.({ limit: 500, offset }).items || []);
        for (const alert of ev.alerts) {
          const firedAt = nextRound.firedAlerts?.[alert.key];
          const signal = actions.find((a) => a.payload?.key === alert.key && a.type === 'signal'
            && Math.abs(Date.parse(a.ts) - Date.parse(firedAt)) < 10000);
          if (!signal || Date.now() - Date.parse(firedAt) > 7 * 86400000) continue;
          const attempted = actions.some((a) => a.type === 'notify' && a.tier === alert.event && a.ts >= signal.ts);
          if (!attempted) {
            nextRound.observedAlerts = { ...nextRound.observedAlerts, [alert.key]: firedAt };
            delete nextRound.firedAlerts[alert.key];
          }
        }
        nextRound.deliveryVersion = 1;
      }
      const fresh = newAlertKeys(ev, nextRound.firedAlerts || round.firedAlerts);
      const notify = store.getNotify();
      const pushResults = [];

      for (const alert of fresh) {
        if (!nextRound.observedAlerts?.[alert.key]) store.addAction({
          type: alert.event === 'takeProfit' ? 'alert' : 'signal',
          source: 'auto',
          tier: alert.event,
          message: alert.message,
          payload: { key: alert.key, event: alert.event }
        });
        nextRound.observedAlerts = { ...nextRound.observedAlerts, [alert.key]: nextRound.observedAlerts?.[alert.key] || new Date().toISOString() };
        if (!opts.silent && !(Date.now() < (nextRound.retryAlerts?.[alert.key] || 0))) {
          const market = alertMarket(ev, alert);
          const qqText = appendMarketSnapshot(alert.message, market.stats, market.symbol);
          let qq;
          try {
            qq = await stage('notify', () => publish(notify, { source: 'stock', eventKey: alert.event, message: qqText }));
          } catch (error) {
            qq = { sent: [], errors: [error.message] };
          }
          pushResults.push({ key: alert.key, qq });
          store.addAction({
            type: 'notify',
            source: 'auto',
            tier: alert.event,
            message: qq.skipped
              ? `QQ 跳过：${qq.reason || alert.event}`
              : `通知${qq.sent?.length ? '已发送' : '失败，5分钟后重试'}：${(qq.sent || []).join('，') || '无成功目标'}${(qq.errors || []).length ? `；失败 ${(qq.errors || []).join('；')}` : ''}`,
            payload: { key: alert.key, ...qq }
          });
          // A disabled event is an intentional suppression. Partial success is
          // recorded without resending to targets which already received it.
          if (qq.sent?.length || qq.reason === 'event-disabled') {
            nextRound.firedAlerts = { ...(nextRound.firedAlerts || {}), [alert.key]: new Date().toISOString() };
          } else {
            nextRound.retryAlerts = { ...nextRound.retryAlerts, [alert.key]: Date.now() + 300000 };
          }
          store.setRound(nextRound);
        }
      }

      // Once per NY trading day, five minutes after the opening bell. The delay
      // gives live quote providers time to roll over from the previous session.
      const openKey = `openSummary:${lastMarketStatus.ymd}`;
      const openAlready = !!(nextRound.firedAlerts || {})[openKey];
      if (!opts.silent && isOpenSummaryTime() && !openAlready) {
        const text = ev.primary ? `${ev.primary.title}：${ev.primary.body}` : '抄底监控已开盘';
        const qq = await stage('openSummary', () => publish(notify, { source: 'stock', eventKey: 'openSummary', message: appendMarketSnapshot(text, ev.qqq, 'QQQ') }));
        nextRound.firedAlerts = { ...(nextRound.firedAlerts || {}), [openKey]: new Date().toISOString() };
        store.addAction({
          type: 'notify',
          source: 'auto',
          tier: 'openSummary',
          message: qq.skipped
            ? `QQ 跳过开盘摘要：${qq.reason || 'openSummary'}`
            : `QQ 已发送开盘摘要：${(qq.sent || []).join('，') || '无目标'}${(qq.errors || []).length ? `；失败 ${(qq.errors || []).join('；')}` : ''}`,
          payload: { key: openKey, ...qq }
        });
        pushResults.push({ key: openKey, qq });
      }

      store.setRound(nextRound);
      ev.round = nextRound;
      lastEval = ev;
      lastError = Object.keys(bundle.errors || {}).length ? bundle.errors : null;
      lastPush = pushResults.length ? { at: new Date().toISOString(), items: pushResults } : lastPush;
      checks += 1;
      consecutiveFailures = 0;
      lastCompletedAt = new Date().toISOString();
      return ev;
    } catch (e) {
      lastError = e.message || String(e);
      consecutiveFailures += 1;
      console.error('qqq-dip monitor:', JSON.stringify({ phase, tickStartedAt, phaseStartedAt, error: lastError, consecutiveFailures }));
      throw e;
    } finally {
      busy = false;
      phase = 'idle';
      phaseStartedAt = null;
      if (onSnapshot) onSnapshot(buildSnapshot());
    }
  }

  function intervalMs() {
    const sec = Number(store.getSettings().intervalSeconds) || 30;
    if (!isRth()) return Math.max(sec, 120) * 1000;
    return Math.max(10, sec) * 1000;
  }

  function loop() {
    if (!running) return;
    tick().catch((e) => {
      lastError = e.message || String(e);
    }).finally(() => {
      if (!running) return;
      timer = setTimeout(loop, intervalMs());
    });
  }

  function start() {
    if (running) return status();
    running = true;
    lastError = null;
    loop();
    if (onSnapshot) onSnapshot(buildSnapshot());
    return status();
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (onSnapshot) onSnapshot(buildSnapshot());
    return status();
  }

  function buildSnapshot() {
    const cash = store.getCash();
    const settings = store.getSettings();
    return {
      ok: true,
      monitor: status(),
      cash,
      settings,
      evaluation: lastEval,
      lots: store.getLots(),
      quotes: store.getQuotes()
    };
  }

  function getEvaluation() {
    return lastEval;
  }

  function setEvaluation(ev) {
    lastEval = ev || null;
    if (onSnapshot) onSnapshot(buildSnapshot());
    return lastEval;
  }

  return { start, stop, tick, status, buildSnapshot, getEvaluation, setEvaluation };
}
