// Timeframes and bar bucketing shared by all data providers.

export const TIMEFRAMES = [
  { id: '1m', label: '1m', sec: 60 },
  { id: '5m', label: '5m', sec: 300 },
  { id: '15m', label: '15m', sec: 900 },
  { id: '1h', label: '1H', sec: 3600 },
  { id: '4h', label: '4H', sec: 14400 },
  { id: '1D', label: '1D', sec: 86400 },
  { id: '1W', label: '1W', sec: 604800 },
];

export const tfSec = (id) => TIMEFRAMES.find((t) => t.id === id)?.sec ?? 86400;

/** Start of the bucket containing `t`, with buckets offset by `align` seconds. */
export function bucketStart(t, sec, align = 0) {
  return Math.floor((t - align) / sec) * sec + align;
}

/** Aggregate bars into larger buckets (e.g. 1h -> 4h, 1D -> 1W). */
export function aggregate(bars, sec, align = 0) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const start = bucketStart(b.time, sec, align);
    if (!cur || cur.time !== start) {
      cur = { time: start, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  return out;
}

/** Approximate bars per year, used to annualise backtest statistics. */
export function barsPerYear(tfId, market) {
  const sec = tfSec(tfId);
  if (market === 'nse' || market === 'bse') {
    // ~250 sessions of 6h15m
    const sessionSec = 6.25 * 3600;
    if (sec >= 604800) return 52;
    if (sec >= 86400) return 250;
    return 250 * Math.max(1, Math.round(sessionSec / sec));
  }
  if (market === 'forex') return sec >= 604800 ? 52 : 260;
  return (365 * 86400) / sec;
}
