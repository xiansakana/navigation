import { evaluate, applyRoundFromEval, newAlertKeys } from './playbook.js';
import { marketStatus, isRth } from './market-hours.js';
import { notifyDipEvent } from './notify.js';

const SYMBOLS = ['QQQ', 'TQQQ', 'SOXL', 'SPY'];

export function createMonitor({ store, quotes, onSnapshot }) {
  let timer = null;
  let running = false;
  let busy = false;
  let lastError = null;
  let lastPush = null;
  let checks = 0;
  let lastEval = null;
  let lastMarketStatus = marketStatus();

  function status() {
    return {
      running,
      busy,
      checks,
      lastError,
      lastPush,
      market: lastMarketStatus,
      intervalSeconds: store.getSettings().intervalSeconds
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
    lastMarketStatus = marketStatus();
    const rth = isRth();
    try {
      const settings = store.getSettings();
      const cash = store.getCash();
      const round = store.getRound();
      const bundle = await quotes.getMarketBundle(
        settings.showSpy === false ? ['QQQ', 'TQQQ', 'SOXL'] : SYMBOLS
      );
      const markets = bundle.markets;
      store.setQuotes(markets);
      const lots = await enrichLots(store.getLots());
      const ev = evaluate({
        cashUsd: cash.cashUsd,
        cashCny: cash.cashCny,
        usdCnyRate: cash.usdCnyRate,
        variant: settings.variant,
        soxlEnabled: settings.soxlEnabled,
        round,
        rth,
        qqq: markets.QQQ,
        tqqq: markets.TQQQ,
        soxl: markets.SOXL,
        spy: markets.SPY,
        vxn: markets.VXN,
        lots
      });
      ev.quoteErrors = bundle.errors;
      try {
        ev.suggestedContracts = await suggestLeaps(ev);
      } catch {
        ev.suggestedContracts = [];
      }

      const nextRound = applyRoundFromEval(round, ev, { sessionDate: lastMarketStatus.ymd });
      const fresh = newAlertKeys(ev, nextRound.firedAlerts || round.firedAlerts);
      const notify = store.getNotify();
      const pushResults = [];

      for (const alert of fresh) {
        const action = store.addAction({
          type: alert.event === 'takeProfit' ? 'alert' : 'signal',
          source: 'auto',
          tier: alert.event,
          message: alert.message,
          payload: { key: alert.key, event: alert.event }
        });
        const quietOffHours = !rth && !['reset', 'takeProfit', 'openSummary'].includes(alert.event);
        if (!opts.silent && !quietOffHours) {
          const qq = await notifyDipEvent(notify, alert.event, alert.message);
          pushResults.push({ key: alert.key, qq });
          store.addAction({
            type: 'notify',
            source: 'auto',
            tier: alert.event,
            message: qq.skipped
              ? `QQ 跳过：${qq.reason || alert.event}`
              : `QQ 已发送：${(qq.sent || []).join('，') || '无目标'}${(qq.errors || []).length ? `；失败 ${(qq.errors || []).join('；')}` : ''}`,
            payload: qq
          });
        }
        nextRound.firedAlerts = { ...(nextRound.firedAlerts || {}), [alert.key]: new Date().toISOString() };
        void action;
      }

      if (opts.openSummary && rth && checks === 0) {
        const text = ev.primary ? `${ev.primary.title}：${ev.primary.body}` : '抄底监控已开盘';
        await notifyDipEvent(notify, 'openSummary', text);
      }

      store.setRound(nextRound);
      ev.round = nextRound;
      lastEval = ev;
      lastError = Object.keys(bundle.errors || {}).length ? bundle.errors : null;
      lastPush = pushResults.length ? { at: new Date().toISOString(), items: pushResults } : lastPush;
      checks += 1;
      if (onSnapshot) onSnapshot(buildSnapshot());
      return ev;
    } catch (e) {
      lastError = e.message || String(e);
      if (onSnapshot) onSnapshot(buildSnapshot());
      throw e;
    } finally {
      busy = false;
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

  return { start, stop, tick, status, buildSnapshot };
}
