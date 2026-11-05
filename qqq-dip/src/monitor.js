import { evaluate, applyRoundFromEval, newAlertKeys, buildBuyPreview } from './playbook.js';
import { marketStatus, isOpenSummaryTime, isRth } from './market-hours.js';
import { appendMarketSnapshot } from './notify.js';
import { publishBusinessEvent } from '../../shared/business-events.js';
import { withDeadline } from './deadline.js';
import { captureExecutionPlan } from './execution-plan.js';
import { activatePendingOptions } from './pending-options.js';
import { alertMarketOpen, marketAlertRoutes, migrateMarketDeliveries } from './market-alerts.js';

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
    return quotes.searchLeapCalls('QQQ', evalResult.leaps?.shallow?.low || band.low,
      evalResult.leaps?.deep?.high || band.high, first.expiry, last.expiry);
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

      let nextRound = captureExecutionPlan(
        applyRoundFromEval(round, ev, { sessionDate: lastMarketStatus.ymd }), ev.buyPreview);
      const pendingOptions = activatePendingOptions(nextRound, ev);
      nextRound = pendingOptions.round;
      ev.alerts.push(...pendingOptions.alerts);
      if (!nextRound.marketDeliveryVersion) {
        const actions = [0, 500].flatMap((offset) => store.listActionRows?.({ limit: 500, offset }).items || []);
        migrateMarketDeliveries(nextRound, ev.alerts, actions);
      }
      nextRound.pendingRiskAlerts = { ...nextRound.pendingRiskAlerts };
      for (const alert of ev.alerts.filter((row) => ['reset', 'fakeRight'].includes(row.event))) {
        nextRound.pendingRiskAlerts[alert.key] ||= { ...alert, observedAt: new Date().toISOString() };
      }
      for (const [key, alert] of Object.entries(nextRound.pendingRiskAlerts)) {
        if (Date.now() - Date.parse(alert.observedAt) > 7 * 86400000
          || (alert.event === 'fakeRight' && !nextRound.fakeRight)
          || (alert.event === 'reset' && nextRound.startedAt)) delete nextRound.pendingRiskAlerts[key];
      }
      const candidates = [...new Map([...ev.alerts, ...Object.values(nextRound.pendingRiskAlerts)]
        .map((alert) => [alert.key, alert])).values()];
      // Signal history uses the original key; delivery uses independent market
      // keys so an A-share reminder cannot consume the US reminder (or vice versa).
      const fresh = newAlertKeys({ ...ev, alerts: candidates }, {}).filter((alert) => alert.key !== 'SOXL:drawdown70:v2'
        || !['US', 'CN'].some((market) => nextRound.marketDeliveries?.[`SOXL:drawdown90:v2:${market}`]));
      const notify = store.getNotify();
      const pushResults = [];

      for (const alert of fresh) {
        if (!nextRound.observedAlerts?.[alert.key] && !nextRound.firedAlerts?.[alert.key]) store.addAction({
          type: alert.event === 'takeProfit' ? 'alert' : 'signal',
          source: 'auto',
          tier: alert.event,
          message: alert.message,
          payload: { key: alert.key, event: alert.event }
        });
        nextRound.observedAlerts = { ...nextRound.observedAlerts, [alert.key]: nextRound.observedAlerts?.[alert.key] || new Date().toISOString() };
        nextRound.firedAlerts = { ...nextRound.firedAlerts, [alert.key]: nextRound.firedAlerts?.[alert.key] || new Date().toISOString() };
        for (const route of marketAlertRoutes(ev, nextRound, alert)) {
          const deliveryKey = `${alert.key}:${route.market}`;
          if (opts.silent || nextRound.marketDeliveries?.[deliveryKey] || !alertMarketOpen(route.market)
            || Date.now() < (nextRound.retryAlerts?.[deliveryKey] || 0)) continue;
          const market = alertMarket(ev, alert);
          const label = route.market === 'CN' ? 'A股交易时段' : '美股交易时段';
          const qqText = appendMarketSnapshot(`【${label}】${route.symbols.join('、') || '仓位检查'}\n${alert.message}\n仅处理本市场交易腿；其他市场等待其开盘。仍须复核最新报价与实际成交。`, market.stats, market.symbol);
          let qq;
          try {
            qq = await stage('notify', () => publish(notify, { source: 'stock', eventKey: alert.event, message: qqText }));
          } catch (error) {
            qq = { sent: [], errors: [error.message] };
          }
          pushResults.push({ key: deliveryKey, qq });
          store.addAction({
            type: 'notify',
            source: 'auto',
            tier: alert.event,
            message: `${label}：` + (qq.skipped
              ? `QQ 跳过：${qq.reason || alert.event}`
              : `通知${qq.sent?.length ? '已发送' : '失败，交易时段内5分钟后重试'}：${(qq.sent || []).join('，') || '无成功目标'}${(qq.errors || []).length ? `；失败 ${(qq.errors || []).join('；')}` : ''}`),
            payload: { key: alert.key, deliveryKey, market: route.market, ...qq }
          });
          // A disabled event is an intentional suppression. Partial success is
          // recorded without resending to targets which already received it.
          if (qq.sent?.length || qq.reason === 'event-disabled') {
            nextRound.marketDeliveries = { ...nextRound.marketDeliveries, [deliveryKey]: new Date().toISOString() };
          } else {
            nextRound.retryAlerts = { ...nextRound.retryAlerts, [deliveryKey]: Date.now() + 300000 };
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
    if (!isRth() && !alertMarketOpen('CN')) return Math.max(sec, 120) * 1000;
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
