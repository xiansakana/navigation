/** QQQ dip-playbook rules (手册速查 2026-09-08). Pure functions, no I/O. */

export const TIER_ORDER = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'R1', 'R2'];
export const LEFT_TIERS = ['T1', 'T2', 'T3', 'T4'];
export const CRISIS_TIERS = ['T5', 'T6', 'T7'];
export const RIGHT_TIERS = ['R1', 'R2'];

export const BAG_RATIOS = {
  default: { left: 0.4, crisis: 0.3, right: 0.3 },
  vBoost: { left: 0.55, crisis: 0.2, right: 0.25 }
};

export const TIER_DEFS = {
  T1: { bag: 'left', pctB: 0.06, closeMult: 0.92, vxnMin: null },
  T2: { bag: 'left', pctB: 0.08, closeMult: 0.88, vxnMin: 25, optionKind: 'medium' },
  T3: { bag: 'left', pctB: 0.14, closeMult: 0.82, vxnMin: 32, optionKind: 'deep-start' },
  T4: { bag: 'left', pctB: 0.12, closeMult: 0.78, intradayMult: 0.75, vxnMin: null, optionKind: 'left-fill' },
  T5: { bag: 'crisis', pctB: 0.1, closeMult: 0.7, vxnMin: null },
  T6: { bag: 'crisis', pctB: 0.1, closeMult: 0.6, vxnMin: null, optionKind: 'new-shallow-medium' },
  T7: { bag: 'crisis', pctB: 0.1, closeMult: 0.5, vxnMin: null, optionKind: 'new-shallow-medium' },
  R1: { bag: 'right', pctB: 0.1, vxnMin: 25, optionKind: 'r1' },
  R2: { bag: 'right', pctB: 0.2, optionKind: 'equity-only' }
};

export const EVENT_KEYS = [
  'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'R1', 'R2',
  'T4_intraday', 'takeProfit', 'fakeRight', 'reset', 'openSummary',
  'sleeveTqqq', 'sleeveSoxl'
];

export const DEFAULT_EVENTS = Object.fromEntries(
  EVENT_KEYS.map((k) => [k, k !== 'openSummary'])
);

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function drawdownPct(price, high) {
  if (!high || !Number.isFinite(high) || high <= 0) return null;
  if (!Number.isFinite(price)) return null;
  return ((price - high) / high) * 100;
}

export function computeH(candles, lookback = 60) {
  const rows = Array.isArray(candles) ? candles.filter((c) => Number.isFinite(c?.h) || Number.isFinite(c?.c)) : [];
  const slice = rows.slice(-lookback);
  if (!slice.length) return null;
  return Math.max(...slice.map((c) => Number.isFinite(c.h) ? c.h : c.c));
}

export function sma(values, n) {
  if (!values || values.length < n) return null;
  const slice = values.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function maxClose(values, n) {
  if (!values || !values.length) return null;
  const slice = values.slice(-n);
  return Math.max(...slice);
}

export function triggerPrices(H) {
  if (!Number.isFinite(H) || H <= 0) return null;
  return {
    T1: roundMoney(H * 0.92),
    T2: roundMoney(H * 0.88),
    T3: roundMoney(H * 0.82),
    T4: roundMoney(H * 0.78),
    T4_intraday: roundMoney(H * 0.75),
    T5: roundMoney(H * 0.7),
    T6: roundMoney(H * 0.6),
    T7: roundMoney(H * 0.5),
    reset: roundMoney(H * 0.98)
  };
}

export function computeAmmoB(cashUsd, cashCny, usdCnyRate) {
  const usd = Number(cashUsd) || 0;
  const cny = Number(cashCny) || 0;
  const rate = Number(usdCnyRate) || 0;
  const fromCny = rate > 0 ? cny / rate : 0;
  return roundMoney(usd + fromCny);
}

export function bagCaps(B, variant = 'default') {
  const ratios = BAG_RATIOS[variant] || BAG_RATIOS.default;
  const ammo = Number(B) || 0;
  return {
    variant: BAG_RATIOS[variant] ? variant : 'default',
    ratios,
    left: roundMoney(ammo * ratios.left),
    crisis: roundMoney(ammo * ratios.crisis),
    right: roundMoney(ammo * ratios.right),
    B: roundMoney(ammo)
  };
}

/** Scale each tier's share of B with the active bag split (40/30/30 → 55/20/25). */
export function tierPctOfB(tierId, variant = 'default') {
  const def = TIER_DEFS[tierId];
  if (!def) return 0;
  const base = BAG_RATIOS.default;
  const ratios = BAG_RATIOS[variant] || base;
  const bagBase = base[def.bag];
  const bagTarget = ratios[def.bag];
  if (!bagBase || !Number.isFinite(bagTarget)) return def.pctB;
  return def.pctB * (bagTarget / bagBase);
}

export function formatPctB(pctB) {
  const pct = (Number(pctB) || 0) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Human-readable trigger rule for the tier ladder UI (no dollar amounts). */
export function tierTriggerText(tierId) {
  const def = TIER_DEFS[tierId];
  if (!def) return '';
  if (tierId === 'R1') {
    return '已见 −22%；收盘站上 20 日线且创 5 日新高（VXN≥25 才允许本档期权）';
  }
  if (tierId === 'R2') {
    return 'R1 已触发且未假右侧冻结；其后约 15–40 个交易日未破前低，或已见 −30% 后再上 20 日线';
  }
  const dd = def.closeMult != null ? Math.round((1 - def.closeMult) * 100) : null;
  const parts = [];
  if (dd != null) parts.push(`相对 H 收盘 ≤ −${dd}%（≤ ${def.closeMult}H）`);
  if (def.intradayMult != null) {
    const idd = Math.round((1 - def.intradayMult) * 100);
    parts.push(`或盘中触及 −${idd}%（${def.intradayMult}H 限价）`);
  }
  if (def.vxnMin != null) parts.push(`且 VXN≥${def.vxnMin} 才允许期权（否则改正股，档仍触发）`);
  if (['T5', 'T6', 'T7'].includes(tierId)) parts.push('须先见过 −22% 才解锁危机袋');
  return parts.join('；');
}

export function thirdFriday(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const day = first.getUTCDay();
  const firstFri = ((5 - day + 7) % 7) + 1;
  return new Date(Date.UTC(year, monthIndex, firstFri + 14));
}

export function monthsBetween(from, to) {
  return (to.getTime() - from.getTime()) / (30.4375 * 86400000);
}

export function januaryLeapExpiries(from = new Date()) {
  const out = [];
  const y0 = from.getUTCFullYear();
  for (let y = y0; y <= y0 + 3; y++) {
    const expiry = thirdFriday(y, 0);
    const months = monthsBetween(from, expiry);
    if (months >= 12 && months <= 21) {
      out.push({
        year: y,
        expiry: expiry.toISOString().slice(0, 10),
        months: Math.round(months * 10) / 10
      });
    }
  }
  return out;
}

export function roundStrike(spot, mult, step = 5) {
  const raw = spot * mult;
  return Math.round(raw / step) * step;
}

export function strikeBand(spot, lowMult, highMult, step = 5) {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  return {
    low: roundStrike(spot, lowMult, step),
    high: roundStrike(spot, highMult, step)
  };
}

export function mediumOtmBand(spot) {
  return strikeBand(spot, 1.25, 1.4);
}

export function deepOtmBand(spot) {
  return strikeBand(spot, 1.5, 1.65);
}

export function shallowOtmBand(spot) {
  return strikeBand(spot, 1.15, 1.25);
}

export function otmPct(strike, spot) {
  if (!Number.isFinite(strike) || !Number.isFinite(spot) || spot <= 0) return null;
  return ((strike - spot) / spot) * 100;
}

export function daysUntil(expiry, now = new Date()) {
  if (!expiry) return null;
  const t = new Date(expiry).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - now.getTime()) / 86400000);
}

export function statsFromMarket(mkt) {
  const candles = Array.isArray(mkt?.candles) ? mkt.candles : [];
  const closes = candles.map((c) => c.c).filter(Number.isFinite);
  const H = computeH(candles, 60);
  const lastClose = closes.length ? closes[closes.length - 1] : (mkt?.close ?? mkt?.price ?? null);
  const price = Number.isFinite(mkt?.price) ? mkt.price : lastClose;
  const low = Number.isFinite(mkt?.low) ? mkt.low : price;
  const high = Number.isFinite(mkt?.high) ? mkt.high : price;
  return {
    symbol: mkt?.symbol || '',
    H,
    triggers: triggerPrices(H),
    lastClose,
    price,
    low,
    high,
    changePercent: Number.isFinite(mkt?.changePercent) ? mkt.changePercent : null,
    sma20: sma(closes, 20),
    high5: maxClose(closes, 5),
    drawdownClose: drawdownPct(lastClose, H),
    drawdownLive: drawdownPct(price, H)
  };
}

function hitClose(close, H, mult) {
  return Number.isFinite(close) && Number.isFinite(H) && close <= H * mult + 1e-9;
}

function hitLive(price, H, mult) {
  return Number.isFinite(price) && Number.isFinite(H) && price <= H * mult + 1e-9;
}

export function shouldReset(stats) {
  if (!stats?.H || !Number.isFinite(stats.lastClose) && !Number.isFinite(stats.price)) return false;
  const close = stats.lastClose;
  const price = stats.price;
  if (Number.isFinite(close) && close >= stats.H * 0.98 - 1e-9) return true;
  if (Number.isFinite(price) && price >= stats.H - 1e-9 && Number.isFinite(stats.lastClose) && stats.lastClose < stats.H * 0.98) {
    return price > stats.H;
  }
  if (Number.isFinite(price) && price >= stats.H * 0.98 - 1e-9 && Number.isFinite(close) && close >= stats.H * 0.98 - 1e-9) {
    return true;
  }
  return Number.isFinite(price) && price > stats.H;
}

function vxnPass(vxn, min) {
  if (min == null) return { ok: true, blocked: false };
  const v = Number(vxn);
  if (!Number.isFinite(v)) return { ok: false, blocked: true, missing: true };
  return { ok: v >= min, blocked: v < min, value: v, min };
}

export function emptyRound() {
  return {
    id: null,
    variant: 'default',
    startedAt: null,
    firstT1At: null,
    hasSeenMinus22: false,
    hasSeenMinus30: false,
    r1At: null,
    r1Sessions: 0,
    r1SwingLow: null,
    r2Frozen: false,
    fakeRight: false,
    triggered: {},
    executed: {},
    firedAlerts: {},
    lastResetAt: null
  };
}

function allocationText(tier, vxnGate, spot, B, usd, pctB, variant = 'default') {
  const bandM = mediumOtmBand(spot);
  const bandD = deepOtmBand(spot);
  const bandS = shallowOtmBand(spot);
  const leaps = januaryLeapExpiries();
  const leapHint = leaps.length ? leaps.map((x) => x.expiry).join(' / ') : '下一期有量 1 月 LEAP';
  // Percent of B only — dollar amounts belong in the masked「金额」column.
  const budgetPct = `动用 ${formatPctB(pctB)}%B。`;
  const rightPct = formatPctB((BAG_RATIOS[variant] || BAG_RATIOS.default).right);
  const vxnNote = vxnGate.blocked
    ? `VXN ${vxnGate.missing ? '未知' : vxnGate.value} 未达门槛 ${vxnGate.min}：本档全部改买正股，档位仍算触发。`
    : (vxnGate.value != null ? `VXN ${vxnGate.value}≥${vxnGate.min}，允许期权部分。` : '');

  const map = {
    T1: `只买 QQQ 正股（最多 20% 换成 SPY）。禁止任何期权、TQQQ、SOXL。`,
    T2: vxnGate.blocked
      ? `全部改买 QQQ 正股。`
      : `约 70–80% QQQ 正股 + 20–30% 中虚值 Call（12–21 个月、虚值 25–40%，行权价约 ${bandM.low}–${bandM.high}，到期 ${leapHint}）。禁止 50%+ 虚值、剩余不足 9 个月。`,
    T3: vxnGate.blocked
      ? `全部改买 QQQ 正股。`
      : `约 50–60% 正股 + 30–40% 中虚值（${bandM.low}–${bandM.high}）+ 约 10% 深虚值（${bandD.low}–${bandD.high}，累计深虚值 ≤8%B）。禁止 All-in SOXL。`,
    T4: `补左侧：仍以正股和中虚值为主，停止再加同一张深虚值。深虚值累计不超过 8%B。不是打满全部 B。禁止 75%+ 虚值、TQQQ Call。`,
    T5: `只加 QQQ 正股。禁止加旧的 65% 虚值。`,
    T6: `约 70% 正股 + 30% 按新现货的浅/中虚值（约 ${bandS.low}–${bandM.high}）。禁止摊薄同一张已废彩票。`,
    T7: `同 T6。3x 正股仅当 TQQQ 自己也到 −50%。杠杆不超过 10%B。`,
    R1: vxnGate.blocked || !vxnGate.ok
      ? `只用右侧袋的约 1/3：QQQ 正股。禁止一次性打完 ${rightPct}% 右侧。`
      : `正股为主；VXN≥25 时可加不超过本档一半的中浅虚值 Call。禁止打完 ${rightPct}%B 右侧。`,
    R2: `只加 QQQ 正股。禁止追已经大涨、IV 已塌的深虚值彩票。`
  };
  return [budgetPct, map[tier], vxnNote].filter(Boolean).join(' ');
}

export function evaluateSleeves(tqqq, soxl, B, soxlEnabled) {
  const out = [];
  const cap3x = roundMoney((Number(B) || 0) * 0.1);
  if (tqqq?.H && Number.isFinite(tqqq.price)) {
    const dd = drawdownPct(tqqq.price, tqqq.H);
    const t35 = tqqq.H * 0.65;
    const t50 = tqqq.H * 0.5;
    let rec = '未到 TQQQ 自己的 −35%，不要用 QQQ 的 T1 去买 TQQQ。禁止 TQQQ Call。';
    let status = 'idle';
    if (dd != null && dd <= -50) {
      status = 'confirmed';
      rec = `TQQQ 相对自身 H 已 −50%：可打满 3x 袖仓（仍 ≤ $${cap3x.toFixed(2)} / 10%B）。只买正股。`;
    } else if (dd != null && dd <= -35) {
      status = 'confirmed';
      rec = `TQQQ 相对自身 H 已 −35%：最多给 3x 袖仓的 1/3（≤ $${roundMoney(cap3x / 3).toFixed(2)}）。只买正股。`;
    }
    out.push({
      symbol: 'TQQQ',
      H: tqqq.H,
      price: tqqq.price,
      drawdown: dd,
      trigger35: roundMoney(t35),
      trigger50: roundMoney(t50),
      status,
      event: status === 'confirmed' ? (dd <= -50 ? 'sleeveTqqq' : 'sleeveTqqq') : null,
      recommendation: rec
    });
  }
  if (soxl?.H && Number.isFinite(soxl.price)) {
    const dd = drawdownPct(soxl.price, soxl.H);
    let rec = soxlEnabled
      ? '必须另有芯片观点。SOXL 相对自己 H −50% 才开始，−70% 才接近上限。'
      : '未开启芯片观点：SOXL 权重为 0，忽略此梯子。';
    let status = 'idle';
    if (soxlEnabled && dd != null && dd <= -70) {
      status = 'confirmed';
      rec = 'SOXL 相对自身 H 约 −70%：接近袖仓上限（约 8–10% 净值，或改用更多 SOXX 正股）。';
    } else if (soxlEnabled && dd != null && dd <= -50) {
      status = 'confirmed';
      rec = 'SOXL 相对自身 H 已 −50%：可以开始袖仓。不要绑在 QQQ 的 T1 上。';
    }
    out.push({
      symbol: 'SOXL',
      H: soxl.H,
      price: soxl.price,
      drawdown: dd,
      trigger50: roundMoney(soxl.H * 0.5),
      trigger70: roundMoney(soxl.H * 0.3),
      status,
      event: status === 'confirmed' ? 'sleeveSoxl' : null,
      recommendation: rec,
      enabled: !!soxlEnabled
    });
  }
  return out;
}

export function evaluateLot(lot, ctx) {
  const now = ctx.now || new Date();
  const alerts = [];
  const prohibitions = [];
  const spot = ctx.spot;
  const price = lot.type === 'call' ? ctx.optionPrice : ctx.equityPrice;
  const cost = Number(lot.cost) || 0;
  const multiple = cost > 0 && Number.isFinite(price) ? price / cost : null;
  const holdingHigh = Math.max(Number(lot.holdingHigh) || 0, Number.isFinite(price) ? price : 0);
  const dte = lot.type === 'call' ? daysUntil(lot.expiry, now) : null;
  const otm = lot.type === 'call' ? otmPct(Number(lot.strike), spot) : null;
  const opened = lot.openedAt ? new Date(lot.openedAt) : null;
  const monthsHeld = opened && !Number.isNaN(opened.getTime()) ? monthsBetween(opened, now) : 0;
  const kind = lot.otmClass || (lot.type === 'equity' ? (lot.symbol === 'TQQQ' || lot.symbol === 'SOXL' ? 'levered' : 'equity') : 'medium');

  if (lot.type === 'call') {
    if (kind === 'deep') {
      if (multiple != null && multiple >= 3 && !lot.sold3x) {
        alerts.push({ code: 'deep-3x', event: 'takeProfit', action: '深虚值已 ≥3×：卖原数量 50% 换成 QQQ' });
      }
      if (multiple != null && multiple >= 5 && !lot.sold5x) {
        alerts.push({ code: 'deep-5x', event: 'takeProfit', action: '深虚值已 ≥5×：再卖原数量 25% 变现金，回到弹药 B' });
      }
      if ((lot.sold5x || (multiple != null && multiple >= 5)) && holdingHigh > 0 && price <= holdingHigh * 0.6) {
        alerts.push({ code: 'deep-5x-dd40', event: 'takeProfit', action: '5 倍后从持有期高点回 40%：余下清掉变现金' });
      }
      if (monthsHeld >= 6 && !lot.cleared) {
        alerts.push({ code: 'deep-6mo', event: 'takeProfit', action: '深虚值已满 6 个月：余下清掉变现金' });
      }
      if (dte != null && dte < 120 && otm != null && otm > 15) {
        alerts.push({ code: 'deep-dte120', event: 'takeProfit', action: '距到期 <120 天且仍虚值 >15%：清掉变现金' });
      }
      prohibitions.push('禁止：3 倍后从高点回 20% 全平深虚值');
    } else {
      if (multiple != null && multiple >= 3 && !lot.sold3x) {
        alerts.push({ code: 'mid-3x', event: 'takeProfit', action: '中虚值已 ≥3×：卖原数量约 1/3 换成 QQQ' });
      }
      if (multiple != null && multiple >= 5 && !lot.sold5x) {
        alerts.push({ code: 'mid-5x', event: 'takeProfit', action: '中虚值已 ≥5×：再卖约 1/3（一半正股、一半现金）' });
      }
      if ((lot.reached3x || (multiple != null && multiple >= 3)) && holdingHigh > 0 && price <= holdingHigh * 0.8 && price >= holdingHigh * 0.75) {
        alerts.push({ code: 'mid-trail', event: 'takeProfit', action: '已到过 3 倍后从持有期高点回 20–25%：余下换成 QQQ' });
      } else if ((lot.reached3x || (multiple != null && multiple >= 3)) && holdingHigh > 0 && price <= holdingHigh * 0.75) {
        alerts.push({ code: 'mid-trail', event: 'takeProfit', action: '已到过 3 倍后从持有期高点回超过 25%：余下换成 QQQ' });
      }
      if (monthsHeld >= 8 && multiple != null && multiple < 3) {
        alerts.push({ code: 'mid-8mo', event: 'takeProfit', action: '8 个月仍未到 3 倍：先减一半换成 QQQ' });
      }
      if (dte != null && dte < 120 && otm != null && otm > 15) {
        alerts.push({ code: 'opt-dte4mo', event: 'takeProfit', action: '距到期不足 4 个月且仍虚值 15%+：期权清掉' });
      }
    }
    if (dte != null && dte < 180 && otm != null && otm >= 30) {
      prohibitions.push('不要把剩余不足 6 个月且仍 30%+ 虚值的 Call 当中期仓');
    }
  } else if (kind === 'levered') {
    if (multiple != null && multiple >= 2 && !lot.sold2x) {
      alerts.push({ code: 'lev-2x', event: 'takeProfit', action: 'TQQQ/SOXL 已 2×：减 1/3 换成 QQQ' });
    }
    if (holdingHigh > 0 && Number.isFinite(price) && price <= holdingHigh * 0.8) {
      alerts.push({ code: 'lev-trail', event: 'takeProfit', action: '3x 正股从反弹高点回 20–25%：清剩余' });
    }
  } else {
    prohibitions.push('QQQ/SPY 正股：12 个月内不要用从高点回 8–12% 止损');
  }

  return {
    ...lot,
    mark: price,
    multiple,
    holdingHigh,
    dte,
    otm,
    monthsHeld,
    alerts,
    prohibitions
  };
}

function r1Confirmed(stats, round) {
  if (!round.hasSeenMinus22 && !hitClose(stats.lastClose, stats.H, 0.78) && !hitLive(stats.low, stats.H, 0.75)) {
    return false;
  }
  if (round.r2Frozen && round.fakeRight) return false;
  const close = stats.lastClose;
  return Number.isFinite(close) && Number.isFinite(stats.sma20) && Number.isFinite(stats.high5)
    && close > stats.sma20 && close >= stats.high5 - 1e-9;
}

function r2Confirmed(stats, round, rth) {
  if (!round.hasSeenMinus22 || round.r2Frozen) return false;
  if (!round.triggered?.R1 && !round.r1At) return false;
  const sessions = Number(round.r1Sessions) || 0;
  const noNewLow = sessions >= 15 && sessions <= 40;
  const post30Break = round.hasSeenMinus30 && Number.isFinite(stats.lastClose) && Number.isFinite(stats.sma20) && stats.lastClose > stats.sma20;
  if (!rth && (noNewLow || post30Break)) return true;
  return noNewLow || post30Break;
}

function fakeRightHit(stats, round) {
  if (!round.r1At || round.r1SwingLow == null) return false;
  const floor = Number(round.r1SwingLow) * 0.99;
  const low = Math.min(
    Number.isFinite(stats.low) ? stats.low : Infinity,
    Number.isFinite(stats.lastClose) ? stats.lastClose : Infinity
  );
  return Number.isFinite(low) && low < floor;
}

export function evaluate(input) {
  const variant = input.variant === 'vBoost' ? 'vBoost' : 'default';
  const B = computeAmmoB(input.cashUsd, input.cashCny, input.usdCnyRate);
  const bags = bagCaps(B, variant);
  const round = { ...emptyRound(), ...(input.round || {}) };
  round.variant = variant;
  const rth = !!input.rth;
  const qqq = statsFromMarket(input.qqq || {});
  const tqqq = statsFromMarket(input.tqqq || {});
  const soxl = statsFromMarket(input.soxl || {});
  const spy = statsFromMarket(input.spy || {});
  const vxnPrice = Number(input.vxn?.price);
  const vxn = Number.isFinite(vxnPrice) ? vxnPrice : null;

  const recovered = shouldReset(qqq);
  const hadRound = !!(round.hasSeenMinus22 || Object.keys(round.triggered || {}).length);
  const reset = recovered && hadRound;
  const alerts = [];
  if (reset) {
    alerts.push({
      key: 'reset',
      event: 'reset',
      message: `QQQ 收盘/现价回到 0.98H 或创新高（H=${qqq.H?.toFixed(2)}）。未触发档作废，已买仓位留下。停止加仓。`
    });
  }

  const closeMinus22 = hitClose(qqq.lastClose, qqq.H, 0.78);
  const intraT4 = hitLive(qqq.low, qqq.H, 0.75) || hitLive(qqq.price, qqq.H, 0.75);
  const closeMinus30 = hitClose(qqq.lastClose, qqq.H, 0.7);
  if (closeMinus22 || intraT4) round.hasSeenMinus22 = true;
  if (closeMinus30 || hitLive(qqq.price, qqq.H, 0.7)) round.hasSeenMinus30 = true;

  const fakeRight = !reset && fakeRightHit(qqq, round);
  if (fakeRight) {
    round.fakeRight = true;
    round.r2Frozen = true;
    alerts.push({
      key: 'fakeRight',
      event: 'fakeRight',
      message: `假右侧：跌破 R1 前低 ${Number(round.r1SwingLow).toFixed(2)}（1% 容差）。清 R1 期权，正股留，R2 冻结，转等 T5 或新低后的新 R1。`
    });
  }

  const executed = round.executed || {};
  const used = { left: 0, crisis: 0, right: 0 };
  TIER_ORDER.forEach((id) => {
    const def = TIER_DEFS[id];
    const usd = Number(executed[id]?.usd) || 0;
    used[def.bag] += usd;
  });

  const tiers = [];
  TIER_ORDER.forEach((id) => {
    const def = TIER_DEFS[id];
    const pctB = tierPctOfB(id, variant);
    const usd = roundMoney(B * pctB);
    const vxnGate = vxnPass(vxn, def.vxnMin);
    let status = 'idle';
    let pendingClose = false;

    if (reset && !executed[id]) {
      status = 'void';
    } else if (executed[id]) {
      status = 'executed';
    } else if (id === 'T4') {
      if (closeMinus22) status = 'confirmed';
      else if (intraT4) {
        status = 'confirmed';
        alerts.push({
          key: 'T4_intraday',
          event: 'T4_intraday',
          message: `T4 盘中触及 0.75H 限价 ${qqq.triggers?.T4_intraday}（现价/低点 ${qqq.price}/${qqq.low}）。`
        });
      } else if (rth && hitLive(qqq.price, qqq.H, 0.78)) {
        status = 'intraday';
        pendingClose = true;
      }
    } else if (id === 'R1') {
      if (r1Confirmed(qqq, round)) status = 'confirmed';
      else if (!round.hasSeenMinus22) status = 'locked';
      else if (round.r2Frozen && round.fakeRight) status = 'frozen';
    } else if (id === 'R2') {
      if (round.r2Frozen) status = 'frozen';
      else if (!round.hasSeenMinus22) status = 'locked';
      else if (r2Confirmed(qqq, round, rth)) status = 'confirmed';
      else if (!round.triggered?.R1 && !round.r1At) status = 'locked';
    } else {
      const closeHit = hitClose(qqq.lastClose, qqq.H, def.closeMult);
      const liveHit = hitLive(qqq.price, qqq.H, def.closeMult);
      if (closeHit) status = 'confirmed';
      else if (rth && liveHit) {
        status = 'intraday';
        pendingClose = true;
      }
    }

    if (['T5', 'T6', 'T7'].includes(id) && !round.hasSeenMinus22 && status !== 'void' && status !== 'executed') {
      if (status === 'idle' || status === 'intraday') status = status === 'intraday' ? 'intraday' : 'locked';
    }

    const rec = allocationText(id, vxnGate, qqq.price, B, usd, pctB, variant);

    if (status === 'confirmed') {
      alerts.push({
        key: id,
        event: id,
        message: `${id} 触发。${rec}`
      });
    }

    tiers.push({
      id,
      bag: def.bag,
      pctB,
      usd,
      triggerPrice: def.closeMult ? qqq.triggers?.[id] : null,
      intradayPrice: def.intradayMult ? qqq.triggers?.T4_intraday : null,
      triggerCondition: tierTriggerText(id),
      status,
      pendingClose,
      vxnGate,
      recommendation: rec,
      executedUsd: Number(executed[id]?.usd) || 0
    });
  });

  const leftLive = tiers.filter((t) => LEFT_TIERS.includes(t.id) && (t.status === 'confirmed' || t.status === 'intraday') && t.status !== 'executed');
  const deepestLeft = leftLive.length ? leftLive[leftLive.length - 1] : null;
  const sameDaySkip = new Set();
  if (deepestLeft && leftLive.length > 1) {
    leftLive.forEach((t) => {
      if (t.id !== deepestLeft.id && t.id !== 'T4') sameDaySkip.add(t.id);
    });
    if (deepestLeft.id !== 'T4') {
      const t4 = tiers.find((t) => t.id === 'T4');
      if (t4 && t4.status === 'intraday') sameDaySkip.add('T4');
    }
  }

  let primary = null;
  if (reset) {
    primary = {
      title: '高点重置，停止加仓',
      body: alerts.find((a) => a.event === 'reset')?.message || '',
      prohibitions: ['未触发档作废', '已实现仓位留下', '下一根 −8% 视为新轮']
    };
  } else if (fakeRight) {
    primary = {
      title: '假右侧',
      body: alerts.find((a) => a.event === 'fakeRight')?.message || '',
      prohibitions: ['禁止假突破后加仓 Call', 'R2 冻结']
    };
  } else {
    const actionable = tiers.filter((t) => (t.status === 'confirmed' || t.status === 'intraday') && !sameDaySkip.has(t.id));
    const pick = actionable.find((t) => t.status === 'confirmed') || actionable[0];
    if (pick) {
      const wait = pick.pendingClose ? '盘中触及，待收盘确认。' : '';
      const skipNote = sameDaySkip.size
        ? `同一天连跳多档：只执行最深左侧 ${deepestLeft.id}，T4 留到收盘或 0.75H 限价。`
        : '';
      primary = {
        title: `${pick.id} ${pick.status === 'confirmed' ? '操作推荐' : '盘中预警'}`,
        body: [wait, pick.recommendation, skipNote].filter(Boolean).join(' '),
        tier: pick.id,
        prohibitions: globalProhibitions(pick.id, round)
      };
    } else if (!round.hasSeenMinus22) {
      const next = qqq.triggers?.T1;
      primary = {
        title: '观察区',
        body: next
          ? `尚未到 T1。QQQ H=${qqq.H?.toFixed(2)}，T1 触发价 ${next}（−8%）。右侧袋锁定。`
          : '等待行情与 60 日高点。',
        prohibitions: globalProhibitions(null, round)
      };
    } else {
      primary = {
        title: '已见到 −22%，等待下一信号',
        body: '左侧停止加期权。危机袋按 T5/T6/T7 跌到再买。右侧必须等 R1（收盘上 20 日线且创 5 日新高），禁止「觉得到底了」提前打 R 袋。',
        prohibitions: globalProhibitions(null, round)
      };
    }
  }

  const lots = (input.lots || []).map((lot) => {
    const isCall = lot.type === 'call';
    const under = (lot.symbol || 'QQQ').replace(/\d.*/, '') || 'QQQ';
    const eq = under === 'TQQQ' ? tqqq : under === 'SOXL' ? soxl : under === 'SPY' ? spy : qqq;
    return evaluateLot(lot, {
      now: input.now || new Date(),
      spot: eq.price,
      equityPrice: eq.price,
      optionPrice: isCall ? lot.mark : eq.price
    });
  });
  lots.forEach((lot) => {
    lot.alerts.forEach((a) => {
      alerts.push({
        key: `${lot.id}:${a.code}`,
        event: a.event,
        message: `${lot.symbol || lot.id} ${a.action}`
      });
    });
  });

  const sleeves = evaluateSleeves(tqqq, soxl, B, !!input.soxlEnabled);
  sleeves.forEach((s) => {
    if (s.status === 'confirmed') {
      alerts.push({ key: s.symbol, event: s.event, message: s.recommendation });
    }
  });

  const remaining = {
    left: roundMoney(Math.max(0, bags.left - used.left)),
    crisis: roundMoney(Math.max(0, bags.crisis - used.crisis)),
    right: roundMoney(Math.max(0, bags.right - used.right))
  };

  return {
    B,
    bags,
    remaining,
    used,
    variant,
    rth,
    vxn,
    vxnGates: { t2: vxnPass(vxn, 25), t3: vxnPass(vxn, 32) },
    qqq,
    tqqq,
    soxl,
    spy,
    reset,
    fakeRight,
    round,
    tiers,
    sameDaySkip: Array.from(sameDaySkip),
    primary,
    sleeves,
    lots,
    leaps: {
      expiries: januaryLeapExpiries(input.now || new Date()),
      medium: mediumOtmBand(qqq.price),
      deep: deepOtmBand(qqq.price),
      shallow: shallowOtmBand(qqq.price)
    },
    alerts,
    buyPreview: buildBuyPreview({
      B,
      bags,
      remaining,
      variant,
      qqq,
      tiers,
      primary,
      leaps: {
        expiries: januaryLeapExpiries(input.now || new Date()),
        medium: mediumOtmBand(qqq.price),
        deep: deepOtmBand(qqq.price),
        shallow: shallowOtmBand(qqq.price)
      },
      sameDaySkip: Array.from(sameDaySkip),
      reset,
      fakeRight,
      round
    }, input.suggestedContracts || [])
  };
}

export function formatOccSymbol(underlying, expiry, strike, type = 'C') {
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return '';
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const strikeInt = Math.round(Number(strike) * 1000);
  return `${String(underlying).toUpperCase()}${yy}${mm}${dd}${type}${String(strikeInt).padStart(8, '0')}`;
}

function pickSuggestedContract(suggestedContracts, band) {
  if (!Array.isArray(suggestedContracts) || !suggestedContracts.length || !band) return null;
  const inBand = suggestedContracts.filter((c) => c.strike >= band.low && c.strike <= band.high);
  const list = inBand.length ? inBand : suggestedContracts;
  const mid = (band.low + band.high) / 2;
  return list.reduce((best, c) => {
    if (!best) return c;
    return Math.abs(c.strike - mid) < Math.abs(best.strike - mid) ? c : best;
  }, null);
}

function equityLeg(symbol, usd, price, note, pct) {
  const px = Number(price);
  const budget = roundMoney(usd);
  const shares = px > 0 ? Math.floor(budget / px) : 0;
  return {
    kind: 'equity',
    symbol,
    side: 'buy',
    usd: budget,
    pct,
    price: px,
    shares,
    estUsd: roundMoney(shares * px),
    note
  };
}

function callLeg({ underlying, expiry, strike, usd, spot, note, pct, otmClass, contract }) {
  const strikeNum = Number(strike);
  const expiryDate = contract?.expiry || expiry;
  const occ = contract?.ticker || formatOccSymbol(underlying, expiryDate, strikeNum, 'C');
  return {
    kind: 'call',
    symbol: underlying,
    side: 'buy',
    usd: roundMoney(usd),
    pct,
    expiry: expiryDate,
    strike: strikeNum,
    otmPct: otmPct(strikeNum, spot),
    contractsHint: '按期权报价重算张数',
    note,
    otmClass,
    occSymbol: occ
  };
}

function splitBudget(totalUsd, parts) {
  const total = roundMoney(totalUsd);
  const weights = parts.map((p) => p.pct);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let allocated = 0;
  return parts.map((part, i) => {
    const isLast = i === parts.length - 1;
    const usd = isLast ? roundMoney(total - allocated) : roundMoney(total * (part.pct / sum));
    allocated += usd;
    return { ...part, usd };
  });
}

function defaultLeapExpiry(ev) {
  const expiries = ev.leaps?.expiries || [];
  return expiries[0]?.expiry || null;
}

function strikeFromBand(band, spot) {
  if (!band) return roundStrike(spot, 1.32);
  return Math.round((band.low + band.high) / 2 / 5) * 5;
}

export function buildBuyPreview(ev, suggestedContracts = []) {
  const primary = ev?.primary;
  if (ev?.reset || ev?.fakeRight) {
    return {
      available: false,
      title: primary?.title || '不可买入',
      reason: primary?.body || '当前为风控/重置状态，不加仓。'
    };
  }
  if (!primary?.tier) {
    return {
      available: false,
      title: primary?.title || '观察区',
      reason: primary?.body || '尚未到可操作档位。'
    };
  }
  const tier = (ev.tiers || []).find((t) => t.id === primary.tier);
  if (!tier || (tier.status !== 'confirmed' && tier.status !== 'intraday')) {
    return {
      available: false,
      title: primary.title,
      reason: '当前推荐不可生成买入清单。'
    };
  }

  const spot = Number(ev.qqq?.price);
  const totalUsd = roundMoney(tier.usd);
  const leaps = ev.leaps || {};
  const medium = leaps.medium || mediumOtmBand(spot);
  const deep = leaps.deep || deepOtmBand(spot);
  const shallow = leaps.shallow || shallowOtmBand(spot);
  const leapExpiry = defaultLeapExpiry(ev);
  const mediumContract = pickSuggestedContract(suggestedContracts, medium);
  const deepContract = pickSuggestedContract(
    suggestedContracts.filter((c) => c.strike >= deep.low && c.strike <= deep.high),
    deep
  ) || pickSuggestedContract(suggestedContracts, deep);

  const legs = [];
  const notes = [];
  if (tier.pendingClose) notes.push('盘中触及，待收盘确认后再下单。');
  if ((ev.sameDaySkip || []).length) {
    notes.push(`同一天只执行最深档 ${primary.tier}，其余已触发档跳过。`);
  }

  const blocked = tier.vxnGate?.blocked;
  const id = tier.id;

  if (id === 'T1') {
    legs.push(equityLeg('QQQ', totalUsd, spot, 'T1 只买 QQQ 正股', 100));
    notes.push('最多 20% 可换成 SPY 降波（需自行调整比例）。');
  } else if (id === 'T2') {
    if (blocked) {
      legs.push(equityLeg('QQQ', totalUsd, spot, 'VXN 未达标，全部改买正股', 100));
    } else {
      const parts = splitBudget(totalUsd, [
        { pct: 75, tag: 'equity', note: '约 75% QQQ 正股' },
        { pct: 25, tag: 'call-medium', note: '约 25% 中虚值 LEAP Call' }
      ]);
      legs.push(equityLeg('QQQ', parts[0].usd, spot, parts[0].note, 75));
      const strike = mediumContract?.strike || strikeFromBand(medium, spot);
      const expiry = mediumContract?.expiry || leapExpiry;
      legs.push(callLeg({
        underlying: 'QQQ',
        expiry,
        strike,
        usd: parts[1].usd,
        spot,
        note: parts[1].note,
        pct: 25,
        otmClass: 'medium',
        contract: mediumContract
      }));
    }
  } else if (id === 'T3') {
    if (blocked) {
      legs.push(equityLeg('QQQ', totalUsd, spot, 'VXN 未达标，全部改买正股', 100));
    } else {
      const parts = splitBudget(totalUsd, [
        { pct: 55, tag: 'equity' },
        { pct: 35, tag: 'call-medium' },
        { pct: 10, tag: 'call-deep' }
      ]);
      legs.push(equityLeg('QQQ', parts[0].usd, spot, '约 55% QQQ 正股', 55));
      legs.push(callLeg({
        underlying: 'QQQ',
        expiry: mediumContract?.expiry || leapExpiry,
        strike: mediumContract?.strike || strikeFromBand(medium, spot),
        usd: parts[1].usd,
        spot,
        note: '约 35% 中虚值 Call',
        pct: 35,
        otmClass: 'medium',
        contract: mediumContract
      }));
      legs.push(callLeg({
        underlying: 'QQQ',
        expiry: deepContract?.expiry || leapExpiry,
        strike: deepContract?.strike || strikeFromBand(deep, spot),
        usd: parts[2].usd,
        spot,
        note: '约 10% 深虚值（累计深虚值 ≤8%B）',
        pct: 10,
        otmClass: 'deep',
        contract: deepContract
      }));
    }
  } else if (id === 'T4') {
    const parts = splitBudget(totalUsd, [{ pct: 80 }, { pct: 20 }]);
    legs.push(equityLeg('QQQ', parts[0].usd, spot, '补左侧：正股为主', 80));
    if (!blocked && leapExpiry) {
      legs.push(callLeg({
        underlying: 'QQQ',
        expiry: mediumContract?.expiry || leapExpiry,
        strike: mediumContract?.strike || strikeFromBand(medium, spot),
        usd: parts[1].usd,
        spot,
        note: '停止再加同一张深虚值；可加中虚值',
        pct: 20,
        otmClass: 'medium',
        contract: mediumContract
      }));
    } else {
      legs.push(equityLeg('QQQ', parts[1].usd, spot, '余下预算继续正股', 20));
    }
    if (tier.intradayPrice) {
      notes.push(`盘中限价参考 0.75H ≈ ${tier.intradayPrice}。T4 不是打满全部 B。`);
    }
  } else if (id === 'T5' || id === 'R2') {
    legs.push(equityLeg('QQQ', totalUsd, spot, '只加 QQQ 正股', 100));
  } else if (id === 'T6' || id === 'T7') {
    const parts = splitBudget(totalUsd, [{ pct: 70 }, { pct: 30 }]);
    legs.push(equityLeg('QQQ', parts[0].usd, spot, '约 70% 正股', 70));
    if (!blocked && leapExpiry) {
      legs.push(callLeg({
        underlying: 'QQQ',
        expiry: mediumContract?.expiry || leapExpiry,
        strike: mediumContract?.strike || strikeFromBand(shallow, spot),
        usd: parts[1].usd,
        spot,
        note: '约 30% 按新现货的浅/中虚值 Call',
        pct: 30,
        otmClass: 'shallow-medium',
        contract: mediumContract
      }));
    } else {
      legs.push(equityLeg('QQQ', parts[1].usd, spot, '余下预算继续正股', 30));
    }
    if (id === 'T7') notes.push('3x 正股仅当 TQQQ 自己也到 −50%，且 ≤10%B。');
  } else if (id === 'R1') {
    if (blocked || !tier.vxnGate?.ok) {
      legs.push(equityLeg('QQQ', totalUsd, spot, '右侧袋 1/3：只买正股', 100));
    } else {
      const parts = splitBudget(totalUsd, [{ pct: 80 }, { pct: 20 }]);
      legs.push(equityLeg('QQQ', parts[0].usd, spot, '正股为主', 80));
      legs.push(callLeg({
        underlying: 'QQQ',
        expiry: mediumContract?.expiry || leapExpiry,
        strike: mediumContract?.strike || strikeFromBand(shallow, spot),
        usd: parts[1].usd,
        spot,
        note: '不超过本档一半的中浅虚值 Call',
        pct: 20,
        otmClass: 'shallow',
        contract: mediumContract
      }));
    }
    notes.push('禁止一次性打完 30% 右侧袋。');
  }

  const checklist = [
    `H = ${ev.qqq?.H != null ? ev.qqq.H.toFixed(2) : '—'}，${id} 触发价 ${tier.triggerPrice ?? '—'}${tier.intradayPrice ? ` / 盘中 ${tier.intradayPrice}` : ''}`,
    `弹药 B = $${Number(ev.B || 0).toFixed(2)}，本档预算 $${totalUsd.toFixed(2)}（${formatPctB(tier.pctB)}%B）`,
    `袋内剩余：左 $${ev.remaining?.left ?? 0} / 危机 $${ev.remaining?.crisis ?? 0} / 右 $${ev.remaining?.right ?? 0}`,
    medium ? `T2 行权价区间参考：$${medium.low}–$${medium.high}` : null,
    ...legs.filter((l) => l.kind === 'call').map((l) => (
      `${l.occSymbol || 'Call'}：下单前记下成本、3×/5×目标价、6 个月清仓日、到期 ${l.expiry || '—'}`
    ))
  ].filter(Boolean);

  return {
    available: true,
    title: `${id} 买入预览`,
    tier: id,
    status: tier.status,
    totalUsd,
    spot,
    pendingClose: !!tier.pendingClose,
    legs,
    checklist,
    notes,
    prohibitions: primary.prohibitions || globalProhibitions(id, ev.round),
    recommendation: tier.recommendation || primary.body
  };
}

export function globalProhibitions(tier, round) {
  const list = [
    '不要用 VXN 套 BSM 给 50%+ 虚值定价，看买卖价',
    '禁止 TQQQ Call',
    '禁止在 −22% 把全部 B 打完',
    '未见到 −22% 不准动右侧袋',
    '正股禁止用 12% 从高点止损',
    '深虚值禁止 3 倍后回撤 20% 全平'
  ];
  if (tier === 'T1') list.unshift('T1 禁止期权和 3x');
  if (!round?.hasSeenMinus22) list.unshift('右侧两把锁：没到 −22%，R 袋锁定');
  return list;
}

export function applyRoundFromEval(prev, ev, { sessionDate } = {}) {
  const next = { ...emptyRound(), ...(prev || {}) };
  if (ev.reset) {
    return {
      ...emptyRound(),
      variant: ev.variant,
      lastResetAt: new Date().toISOString(),
      executed: next.executed,
      firedAlerts: {}
    };
  }
  next.variant = ev.variant;
  next.hasSeenMinus22 = !!(next.hasSeenMinus22 || ev.round.hasSeenMinus22);
  next.hasSeenMinus30 = !!(next.hasSeenMinus30 || ev.round.hasSeenMinus30);
  if (ev.fakeRight) {
    next.fakeRight = true;
    next.r2Frozen = true;
  }
  ev.tiers.forEach((t) => {
    if (t.status === 'confirmed') {
      if (!next.triggered[t.id]) {
        next.triggered[t.id] = { at: new Date().toISOString(), sessionDate: sessionDate || null };
      }
      if (t.id === 'T1' && !next.firstT1At) next.firstT1At = new Date().toISOString();
      if (t.id === 'R1' && !next.r1At) {
        next.r1At = new Date().toISOString();
        next.r1SwingLow = ev.qqq.low;
      }
    }
  });
  return next;
}

export function newAlertKeys(ev, firedAlerts) {
  const fired = firedAlerts || {};
  return ev.alerts.filter((a) => a.key && !fired[a.key]);
}
