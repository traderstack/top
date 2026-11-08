// Technical-analysis helpers. Every function returns an array aligned with its
// input, using NaN where there is not yet enough data.

const nanArray = (n) => new Array(n).fill(NaN);

export function sma(src, period) {
  const out = nanArray(src.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (isNaN(v)) { sum = 0; count = 0; continue; }
    sum += v; count++;
    if (count > period) { sum -= src[i - period]; count = period; }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

export function ema(src, period) {
  const out = nanArray(src.length);
  const k = 2 / (period + 1);
  let prev = NaN;
  let seed = 0;
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (isNaN(v)) continue;
    if (isNaN(prev)) {
      seed += v; n++;
      if (n === period) { prev = seed / period; out[i] = prev; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's smoothing (used by RSI and ATR). */
export function rma(src, period) {
  const out = nanArray(src.length);
  let prev = NaN;
  let seed = 0;
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (isNaN(v)) continue;
    if (isNaN(prev)) {
      seed += v; n++;
      if (n === period) { prev = seed / period; out[i] = prev; }
    } else {
      prev = (prev * (period - 1) + v) / period;
      out[i] = prev;
    }
  }
  return out;
}

export function stdev(src, period) {
  const out = nanArray(src.length);
  const mean = sma(src, period);
  for (let i = period - 1; i < src.length; i++) {
    if (isNaN(mean[i])) continue;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (src[j] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

export function rsi(src, period = 14) {
  const gains = nanArray(src.length);
  const losses = nanArray(src.length);
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    gains[i] = Math.max(d, 0);
    losses[i] = Math.max(-d, 0);
  }
  const ag = rma(gains, period);
  const al = rma(losses, period);
  return ag.map((g, i) => (isNaN(g) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])));
}

export function macd(src, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast);
  const s = ema(src, slow);
  const line = f.map((v, i) => v - s[i]);
  const sig = ema(line, signal);
  return { macd: line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

export function bollinger(src, period = 20, mult = 2) {
  const mid = sma(src, period);
  const sd = stdev(src, period);
  return {
    middle: mid,
    upper: mid.map((m, i) => m + mult * sd[i]),
    lower: mid.map((m, i) => m - mult * sd[i]),
  };
}

export function trueRange(high, low, close) {
  return high.map((h, i) => (i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]))));
}

export function atr(high, low, close, period = 14) {
  return rma(trueRange(high, low, close), period);
}

export function highest(src, period) {
  const out = nanArray(src.length);
  for (let i = period - 1; i < src.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.max(m, src[j]);
    out[i] = m;
  }
  return out;
}

export function lowest(src, period) {
  const out = nanArray(src.length);
  for (let i = period - 1; i < src.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.min(m, src[j]);
    out[i] = m;
  }
  return out;
}

/** Supertrend: returns the trailing line and direction (1 = up, -1 = down). */
export function supertrend(high, low, close, period = 10, mult = 3) {
  const a = atr(high, low, close, period);
  const n = close.length;
  const line = nanArray(n);
  const dir = new Array(n).fill(0);
  let upper = NaN;
  let lower = NaN;
  for (let i = 0; i < n; i++) {
    if (isNaN(a[i])) continue;
    const hl2 = (high[i] + low[i]) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    const prevClose = close[i - 1];
    upper = isNaN(upper) || bu < upper || prevClose > upper ? bu : upper;
    lower = isNaN(lower) || bl > lower || prevClose < lower ? bl : lower;
    const prevDir = dir[i - 1] || 1;
    let d = prevDir;
    if (prevDir === 1 && close[i] < lower) d = -1;
    else if (prevDir === -1 && close[i] > upper) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

/** Volume-weighted average price, reset at each new session (calendar day in `tzOffsetSec`). */
export function vwap(bars, tzOffsetSec = 0) {
  const out = nanArray(bars.length);
  let pv = 0;
  let vol = 0;
  let day = null;
  bars.forEach((b, i) => {
    const d = Math.floor((b.time + tzOffsetSec) / 86400);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * (b.volume || 0);
    vol += b.volume || 0;
    out[i] = vol ? pv / vol : tp;
  });
  return out;
}

export const crossover = (a, b, i) => i > 0 && a[i - 1] <= val(b, i - 1) && a[i] > val(b, i);
export const crossunder = (a, b, i) => i > 0 && a[i - 1] >= val(b, i - 1) && a[i] < val(b, i);
const val = (x, i) => (Array.isArray(x) ? x[i] : x);
