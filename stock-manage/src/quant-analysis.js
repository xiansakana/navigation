/**
 * Real-stock quantitative analysis.
 * The indicator weights and signal rules mirror torn-stocks-quant, while the
 * candles are supplied by the stock-manage Finnhub adapter.
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

function finite(value) {
  return Number.isFinite(value);
}

function round(value, digits = 2) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function sma(values, period) {
  const result = new Array(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period <= 0) return result;
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    let valid = true;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (!finite(values[j])) {
        valid = false;
        break;
      }
      sum += values[j];
    }
    if (valid) result[i] = sum / period;
  }
  return result;
}

export function ema(values, period) {
  const result = new Array(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    if (!finite(values[i])) return result;
    sum += values[i];
  }
  result[period - 1] = sum / period;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    if (!finite(values[i]) || !finite(result[i - 1])) continue;
    result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1];
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
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
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
  const signalValues = ema(validLine, signalPeriod);
  const signal = new Array(closes.length).fill(Number.NaN);
  for (let i = 0; i < signalValues.length; i += 1) signal[firstValid + i] = signalValues[i];

  const histogram = new Array(closes.length).fill(Number.NaN);
  for (let i = 0; i < closes.length; i += 1) {
    if (finite(line[i]) && finite(signal[i])) histogram[i] = line[i] - signal[i];
  }
  return { line, signal, histogram };
}

export function bollingerBands(closes, period = 20, stdDevMultiplier = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(Number.NaN);
  const lower = new Array(closes.length).fill(Number.NaN);

  for (let i = period - 1; i < closes.length; i += 1) {
    if (!finite(middle[i])) continue;
    let sumSqDiff = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      sumSqDiff += (closes[j] - middle[i]) ** 2;
    }
    const standardDeviation = Math.sqrt(sumSqDiff / period);
    upper[i] = middle[i] + stdDevMultiplier * standardDeviation;
    lower[i] = middle[i] - stdDevMultiplier * standardDeviation;
  }
  return { upper, middle, lower };
}

function signalFromRsi(value, config) {
  if (!finite(value)) return 'HOLD';
  if (value <= config.rsiOversold) return 'BUY';
  if (value >= config.rsiOverbought) return 'SELL';
  return 'HOLD';
}

function signalFromMacd(macdLine, signalLine, previousMacd, previousSignal) {
  if (![macdLine, signalLine, previousMacd, previousSignal].every(finite)) return 'HOLD';
  if (previousMacd <= previousSignal && macdLine > signalLine) return 'BUY';
  if (previousMacd >= previousSignal && macdLine < signalLine) return 'SELL';
  return 'HOLD';
}

function signalFromBollinger(price, upper, lower, middle) {
  if (![price, upper, lower, middle].every(finite)) return 'HOLD';
  if (price <= lower) return 'BUY';
  if (price >= upper) return 'SELL';
  const bandWidth = upper - lower;
  if (bandWidth > 0) {
    const position = (price - lower) / bandWidth;
    if (position < 0.15) return 'BUY';
    if (position > 0.85) return 'SELL';
  }
  return 'HOLD';
}

function holdResult(symbol, name, price, message, status, changePercent, dataPoints) {
  return {
    symbol,
    name,
    price: finite(price) ? price : 0,
    changePercent: finite(changePercent) ? round(changePercent) : null,
    signal: 'HOLD',
    strength: 0,
    combinedScore: 0,
    rsi: null,
    rsiSignal: 'HOLD',
    macd: null,
    macdSignal: 'HOLD',
    bollingerPosition: null,
    bollingerSignal: 'HOLD',
    trend: 'UNKNOWN',
    dataPoints: dataPoints || 0,
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
  config = DEFAULT_QUANT_CONFIG
}) {
  const cleanCandles = Array.isArray(candles)
    ? candles.filter((candle) => candle && finite(candle.close))
    : [];
  const last = cleanCandles[cleanCandles.length - 1];
  const fallbackPrice = last?.close || 0;
  const currentPrice = finite(price) && price > 0 ? price : fallbackPrice;

  if (cleanCandles.length < 50) {
    return holdResult(
      symbol,
      name,
      currentPrice,
      `历史数据不足（${cleanCandles.length} 条，至少需要 50 条）`,
      'insufficient',
      changePercent,
      cleanCandles.length
    );
  }

  const closes = cleanCandles.map((candle) => candle.close);
  const lastIndex = closes.length - 1;
  const indicators = {
    rsi: rsi(closes, config.rsiPeriod),
    macd: macd(closes, config.macdFast, config.macdSlow, config.macdSignal),
    bollingerBands: bollingerBands(closes, config.bollingerPeriod, config.bollingerStdDev),
    sma50: sma(closes, 50)
  };
  const previousIndex = lastIndex - 1;
  const rsiValue = indicators.rsi[lastIndex];
  const macdLine = indicators.macd.line[lastIndex];
  const macdSignalLine = indicators.macd.signal[lastIndex];
  const rsiSignal = signalFromRsi(rsiValue, config);
  const macdSignal = signalFromMacd(
    macdLine,
    macdSignalLine,
    indicators.macd.line[previousIndex],
    indicators.macd.signal[previousIndex]
  );
  const upper = indicators.bollingerBands.upper[lastIndex];
  const middle = indicators.bollingerBands.middle[lastIndex];
  const lower = indicators.bollingerBands.lower[lastIndex];
  const bollingerSignal = signalFromBollinger(currentPrice, upper, lower, middle);
  const bandWidth = upper - lower;
  const bollingerPosition = bandWidth > 0 ? ((currentPrice - lower) / bandWidth) * 100 : null;

  const rsiScore = rsiSignal === 'BUY' ? 1 : rsiSignal === 'SELL' ? -1 : 0;
  const macdScore = macdSignal === 'BUY' ? 1 : macdSignal === 'SELL' ? -1 : 0;
  const bollingerScore = bollingerSignal === 'BUY' ? 1 : bollingerSignal === 'SELL' ? -1 : 0;
  let trendBonus = 0;
  if (finite(indicators.sma50[lastIndex])) trendBonus = currentPrice > indicators.sma50[lastIndex] ? 0.15 : -0.15;
  if (finite(indicators.macd.histogram[lastIndex]) && indicators.macd.histogram[lastIndex] > 0) trendBonus += 0.05;

  const combinedScore = round(rsiScore * 0.35 + macdScore * 0.35 + bollingerScore * 0.2 + trendBonus);
  const signal = combinedScore > config.buyThreshold
    ? 'BUY'
    : combinedScore < config.sellThreshold
      ? 'SELL'
      : 'HOLD';
  const strength = signal === 'HOLD' ? 0 : Math.min(100, Math.round(Math.abs(combinedScore) * 100));

  return {
    symbol,
    name,
    price: round(currentPrice, 4),
    changePercent: finite(changePercent) ? round(changePercent) : null,
    signal,
    strength,
    combinedScore,
    rsi: round(rsiValue, 1),
    rsiSignal,
    macd: round(macdLine, 4),
    macdSignal,
    bollingerPosition: round(bollingerPosition, 1),
    bollingerSignal,
    trend: finite(indicators.sma50[lastIndex])
      ? currentPrice >= indicators.sma50[lastIndex] ? 'ABOVE_SMA50' : 'BELOW_SMA50'
      : 'UNKNOWN',
    dataPoints: cleanCandles.length,
    asOf: last.timestamp || null,
    status: 'ok'
  };
}
