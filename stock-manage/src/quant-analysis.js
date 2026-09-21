/**
 * Quant signal engine adapted from others/torn-stocks-quant.
 * It is data-source agnostic: callers provide real-market OHLCV candles.
 */

export const DEFAULT_QUANT_CONFIG = Object.freeze({
  rsiPeriod: 14,
  rsiOverbought: 58,
  rsiOversold: 42,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  buyThreshold: 0.25,
  sellThreshold: -0.3
});

const finite = Number.isFinite;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function boundedNumber(value, fallback, min, max, integer = false) {
  const number = Number(value);
  if (!finite(number)) return fallback;
  const bounded = clamp(number, min, max);
  return integer ? Math.round(bounded) : bounded;
}

function round(value, digits = 2) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function normalizeQuantConfig(input = {}) {
  const config = {
    rsiPeriod: boundedNumber(input.rsiPeriod, DEFAULT_QUANT_CONFIG.rsiPeriod, 2, 50, true),
    rsiOverbought: boundedNumber(input.rsiOverbought, DEFAULT_QUANT_CONFIG.rsiOverbought, 51, 95),
    rsiOversold: boundedNumber(input.rsiOversold, DEFAULT_QUANT_CONFIG.rsiOversold, 5, 49),
    macdFast: boundedNumber(input.macdFast, DEFAULT_QUANT_CONFIG.macdFast, 2, 50, true),
    macdSlow: boundedNumber(input.macdSlow, DEFAULT_QUANT_CONFIG.macdSlow, 3, 100, true),
    macdSignal: boundedNumber(input.macdSignal, DEFAULT_QUANT_CONFIG.macdSignal, 2, 50, true),
    bollingerPeriod: boundedNumber(input.bollingerPeriod, DEFAULT_QUANT_CONFIG.bollingerPeriod, 5, 100, true),
    bollingerStdDev: boundedNumber(input.bollingerStdDev, DEFAULT_QUANT_CONFIG.bollingerStdDev, 0.5, 5),
    buyThreshold: boundedNumber(input.buyThreshold, DEFAULT_QUANT_CONFIG.buyThreshold, 0, 1),
    sellThreshold: boundedNumber(input.sellThreshold, DEFAULT_QUANT_CONFIG.sellThreshold, -1, 0)
  };
  const rawRsiCrossed = finite(Number(input.rsiOversold))
    && finite(Number(input.rsiOverbought))
    && Number(input.rsiOversold) >= Number(input.rsiOverbought);
  if (rawRsiCrossed || config.rsiOversold >= config.rsiOverbought) {
    config.rsiOversold = DEFAULT_QUANT_CONFIG.rsiOversold;
    config.rsiOverbought = DEFAULT_QUANT_CONFIG.rsiOverbought;
  }
  if (config.macdFast >= config.macdSlow) {
    config.macdFast = DEFAULT_QUANT_CONFIG.macdFast;
    config.macdSlow = DEFAULT_QUANT_CONFIG.macdSlow;
  }
  return config;
}

export function sma(values, period) {
  const result = new Array(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return result;
  let sum = 0;
  let invalid = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (finite(values[i])) sum += values[i];
    else invalid += 1;
    if (i >= period) {
      if (finite(values[i - period])) sum -= values[i - period];
      else invalid -= 1;
    }
    if (i >= period - 1 && invalid === 0) result[i] = sum / period;
  }
  return result;
}

export function ema(values, period) {
  const result = new Array(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return result;
  const seed = values.slice(0, period);
  if (!seed.every(finite)) return result;
  result[period - 1] = seed.reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    if (finite(values[i]) && finite(result[i - 1])) {
      result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1];
    }
  }
  return result;
}

export function rsi(closes, period = 14) {
  const result = new Array(closes.length).fill(Number.NaN);
  if (closes.length < period + 1) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) averageGain += change;
    else averageLoss += Math.abs(change);
  }
  averageGain /= period;
  averageLoss /= period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

export function macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const line = new Array(closes.length).fill(Number.NaN);
  const firstValid = slowPeriod - 1;
  for (let i = firstValid; i < closes.length; i += 1) {
    if (finite(fast[i]) && finite(slow[i])) line[i] = fast[i] - slow[i];
  }
  const validLine = line.slice(firstValid).filter(finite);
  const compactSignal = ema(validLine, signalPeriod);
  const signal = new Array(closes.length).fill(Number.NaN);
  compactSignal.forEach((value, index) => { signal[firstValid + index] = value; });
  const histogram = line.map((value, index) => (
    finite(value) && finite(signal[index]) ? value - signal[index] : Number.NaN
  ));
  return { line, signal, histogram };
}

export function bollingerBands(closes, period = 20, multiplier = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(Number.NaN);
  const lower = new Array(closes.length).fill(Number.NaN);
  for (let i = period - 1; i < closes.length; i += 1) {
    if (!finite(middle[i])) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      variance += (closes[j] - middle[i]) ** 2;
    }
    const standardDeviation = Math.sqrt(variance / period);
    upper[i] = middle[i] + multiplier * standardDeviation;
    lower[i] = middle[i] - multiplier * standardDeviation;
  }
  return { upper, middle, lower };
}

function rsiSignal(value, config) {
  if (!finite(value)) return 'HOLD';
  if (value <= config.rsiOversold) return 'BUY';
  if (value >= config.rsiOverbought) return 'SELL';
  return 'HOLD';
}

function macdSignal(line, signal, previousLine, previousSignal) {
  if (![line, signal, previousLine, previousSignal].every(finite)) return 'HOLD';
  if (previousLine <= previousSignal && line > signal) return 'BUY';
  if (previousLine >= previousSignal && line < signal) return 'SELL';
  return 'HOLD';
}

function bollingerSignal(price, upper, lower, middle) {
  if (![price, upper, lower, middle].every(finite)) return 'HOLD';
  if (price <= lower) return 'BUY';
  if (price >= upper) return 'SELL';
  const width = upper - lower;
  if (!(width > 0)) return 'HOLD';
  const position = (price - lower) / width;
  if (position < 0.15) return 'BUY';
  if (position > 0.85) return 'SELL';
  return 'HOLD';
}

function emptyResult({ symbol, name, price, changePercent, status, message, dataPoints = 0 }) {
  return {
    symbol,
    name: name || symbol,
    price: finite(price) ? round(price, 4) : null,
    changePercent: finite(changePercent) ? round(changePercent) : null,
    signal: 'HOLD',
    strength: 0,
    combinedScore: 0,
    rsi: null,
    rsiSignal: 'HOLD',
    macd: null,
    macdSignalValue: null,
    macdHistogram: null,
    macdSignal: 'HOLD',
    bollingerUpper: null,
    bollingerMiddle: null,
    bollingerLower: null,
    bollingerPosition: null,
    bollingerSignal: 'HOLD',
    sma50: null,
    trend: 'UNKNOWN',
    dataPoints,
    asOf: null,
    status,
    message
  };
}

export function analyzeCandles({
  symbol,
  name = symbol,
  price,
  changePercent,
  candles,
  config: rawConfig = DEFAULT_QUANT_CONFIG,
  historySource = null,
  quoteSource = null
}) {
  const config = normalizeQuantConfig(rawConfig);
  const cleanCandles = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({ ...candle, timestamp: Number(candle?.timestamp), close: Number(candle?.close) }))
    .filter((candle) => finite(candle.timestamp) && finite(candle.close) && candle.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const minimumPoints = Math.max(50, config.rsiPeriod + 1, config.macdSlow + config.macdSignal, config.bollingerPeriod);
  const last = cleanCandles.at(-1);
  const displayPrice = finite(Number(price)) && Number(price) > 0 ? Number(price) : last?.close;
  const derivedChange = cleanCandles.length >= 2
    ? ((last.close - cleanCandles.at(-2).close) / cleanCandles.at(-2).close) * 100
    : Number.NaN;
  const displayChange = finite(Number(changePercent)) ? Number(changePercent) : derivedChange;
  if (cleanCandles.length < minimumPoints) {
    return {
      ...emptyResult({
        symbol,
        name,
        price: displayPrice,
        changePercent: displayChange,
        dataPoints: cleanCandles.length,
        status: 'insufficient',
        message: `历史数据不足（${cleanCandles.length} 条，至少需要 ${minimumPoints} 条）`
      }),
      historySource,
      quoteSource
    };
  }

  const closes = cleanCandles.map((candle) => candle.close);
  const index = closes.length - 1;
  const analysisPrice = closes[index];
  const rsiValues = rsi(closes, config.rsiPeriod);
  const macdValues = macd(closes, config.macdFast, config.macdSlow, config.macdSignal);
  const bands = bollingerBands(closes, config.bollingerPeriod, config.bollingerStdDev);
  const sma50Values = sma(closes, 50);
  const rsiValue = rsiValues[index];
  const macdValue = macdValues.line[index];
  const macdSignalValue = macdValues.signal[index];
  const macdHistogram = macdValues.histogram[index];
  const upper = bands.upper[index];
  const middle = bands.middle[index];
  const lower = bands.lower[index];
  const sma50Value = sma50Values[index];
  const indicatorSignals = {
    rsi: rsiSignal(rsiValue, config),
    macd: macdSignal(macdValue, macdSignalValue, macdValues.line[index - 1], macdValues.signal[index - 1]),
    bollinger: bollingerSignal(analysisPrice, upper, lower, middle)
  };
  const toScore = (signal) => signal === 'BUY' ? 1 : signal === 'SELL' ? -1 : 0;
  let trendBonus = finite(sma50Value) ? (analysisPrice > sma50Value ? 0.15 : -0.15) : 0;
  if (finite(macdHistogram) && macdHistogram > 0) trendBonus += 0.05;
  const combinedScore = round(
    toScore(indicatorSignals.rsi) * 0.35
      + toScore(indicatorSignals.macd) * 0.35
      + toScore(indicatorSignals.bollinger) * 0.2
      + trendBonus
  );
  const signal = combinedScore > config.buyThreshold
    ? 'BUY'
    : combinedScore < config.sellThreshold ? 'SELL' : 'HOLD';
  const bandWidth = upper - lower;

  return {
    symbol,
    name: name || symbol,
    price: round(displayPrice, 4),
    changePercent: round(displayChange),
    signal,
    strength: signal === 'HOLD' ? 0 : Math.min(100, Math.round(Math.abs(combinedScore) * 100)),
    combinedScore,
    rsi: round(rsiValue, 1),
    rsiSignal: indicatorSignals.rsi,
    macd: round(macdValue, 4),
    macdSignalValue: round(macdSignalValue, 4),
    macdHistogram: round(macdHistogram, 4),
    macdSignal: indicatorSignals.macd,
    bollingerUpper: round(upper, 4),
    bollingerMiddle: round(middle, 4),
    bollingerLower: round(lower, 4),
    bollingerPosition: finite(bandWidth) && bandWidth > 0 ? round(((analysisPrice - lower) / bandWidth) * 100, 1) : null,
    bollingerSignal: indicatorSignals.bollinger,
    sma50: round(sma50Value, 4),
    trend: finite(sma50Value) ? (analysisPrice >= sma50Value ? 'ABOVE_SMA50' : 'BELOW_SMA50') : 'UNKNOWN',
    dataPoints: cleanCandles.length,
    asOf: last.timestamp,
    historySource,
    quoteSource,
    status: 'ok',
    message: ''
  };
}

export function backtestCandles({
  symbol,
  candles,
  config: rawConfig = DEFAULT_QUANT_CONFIG,
  initialCapital = 10000,
  startTimestamp = null
}) {
  const config = normalizeQuantConfig(rawConfig);
  const capital = Math.max(100, Number(initialCapital) || 10000);
  const cleanCandles = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({ ...candle, timestamp: Number(candle?.timestamp), close: Number(candle?.close) }))
    .filter((candle) => finite(candle.timestamp) && finite(candle.close) && candle.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const minimumPoints = Math.max(50, config.rsiPeriod + 1, config.macdSlow + config.macdSignal, config.bollingerPeriod);
  if (cleanCandles.length < minimumPoints + 1) {
    return {
      symbol,
      status: 'insufficient',
      message: `历史数据不足（${cleanCandles.length} 条）`,
      initialCapital: round(capital),
      finalEquity: round(capital),
      totalReturn: 0,
      buyHoldReturn: 0,
      maxDrawdown: 0,
      winRate: 0,
      trades: [],
      equityCurve: []
    };
  }

  let cash = capital;
  let shares = 0;
  let entryPrice = 0;
  let peak = capital;
  let maxDrawdown = 0;
  const trades = [];
  const equityCurve = [];
  const requestedStartIndex = Number.isFinite(Number(startTimestamp))
    ? cleanCandles.findIndex((candle) => candle.timestamp >= Number(startTimestamp))
    : -1;
  const startIndex = Math.max(minimumPoints - 1, requestedStartIndex >= 0 ? requestedStartIndex : 0);
  const firstPrice = cleanCandles[startIndex].close;

  for (let index = startIndex; index < cleanCandles.length; index += 1) {
    const candle = cleanCandles[index];
    const history = cleanCandles.slice(Math.max(0, index - 249), index + 1);
    const analysis = analyzeCandles({ symbol, price: candle.close, candles: history, config });
    if (analysis.status === 'ok' && analysis.signal === 'BUY' && shares === 0 && cash > 0) {
      shares = cash / candle.close;
      entryPrice = candle.close;
      trades.push({ timestamp: candle.timestamp, side: 'BUY', price: round(candle.close, 4), shares: round(shares, 4) });
      cash = 0;
    } else if (analysis.status === 'ok' && analysis.signal === 'SELL' && shares > 0) {
      cash = shares * candle.close;
      const pnl = (candle.close - entryPrice) * shares;
      trades.push({
        timestamp: candle.timestamp,
        side: 'SELL',
        price: round(candle.close, 4),
        shares: round(shares, 4),
        pnl: round(pnl)
      });
      shares = 0;
      entryPrice = 0;
    }
    const equity = cash + shares * candle.close;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
    equityCurve.push({
      timestamp: candle.timestamp,
      equity: round(equity),
      buyHoldEquity: round(capital * candle.close / firstPrice)
    });
  }

  const finalPrice = cleanCandles.at(-1).close;
  const finalEquity = cash + shares * finalPrice;
  const completed = trades.filter((trade) => trade.side === 'SELL');
  const winners = completed.filter((trade) => trade.pnl > 0).length;
  return {
    symbol,
    status: 'ok',
    initialCapital: round(capital),
    finalEquity: round(finalEquity),
    totalReturn: round((finalEquity - capital) / capital, 4),
    buyHoldReturn: round((finalPrice - firstPrice) / firstPrice, 4),
    maxDrawdown: round(maxDrawdown, 4),
    winRate: completed.length ? round(winners / completed.length, 4) : 0,
    completedTrades: completed.length,
    openPosition: shares > 0,
    trades,
    equityCurve
  };
}
