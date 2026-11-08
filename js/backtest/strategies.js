// Built-in strategy templates. Each one is plain JavaScript you can open in the
// editor, change and save as your own strategy.

const HEADER = `// Available: bars, open, high, low, close, volume (arrays), params, ta (indicators)
// Return a function of the bar index i that gives the position you want after bar i closes:
//   'long', 'short', 'flat', or null to keep the current position.
// Orders fill at the next bar's open.
`;

export const TEMPLATES = [
  {
    id: 'ema-cross',
    name: 'EMA crossover',
    code: `${HEADER}
// @param fast 9 2 200 1 Fast EMA
// @param slow 21 3 400 1 Slow EMA

const fast = ta.ema(close, params.fast);
const slow = ta.ema(close, params.slow);

return (i) => {
  if (ta.crossover(fast, slow, i)) return 'long';
  if (ta.crossunder(fast, slow, i)) return 'short';
  return null;
};
`,
  },
  {
    id: 'golden-cross',
    name: 'Golden cross (SMA 50/200)',
    code: `${HEADER}
// @param fast 50 5 300 1 Fast SMA
// @param slow 200 10 500 1 Slow SMA

const fast = ta.sma(close, params.fast);
const slow = ta.sma(close, params.slow);

return (i) => {
  if (isNaN(slow[i])) return null;
  return fast[i] > slow[i] ? 'long' : 'flat';
};
`,
  },
  {
    id: 'rsi-reversion',
    name: 'RSI mean reversion',
    code: `${HEADER}
// @param length 14 2 50 1 RSI length
// @param oversold 30 5 50 1 Buy below
// @param exitAt 55 40 90 1 Exit above

const r = ta.rsi(close, params.length);

return (i) => {
  if (ta.crossover(r, params.oversold, i)) return 'long';
  if (r[i] > params.exitAt) return 'flat';
  return null;
};
`,
  },
  {
    id: 'bollinger',
    name: 'Bollinger band bounce',
    code: `${HEADER}
// @param length 20 5 100 1 Length
// @param mult 2 1 4 0.1 Std-dev multiplier

const bb = ta.bollinger(close, params.length, params.mult);

return (i) => {
  if (close[i] < bb.lower[i]) return 'long';
  if (close[i] > bb.middle[i]) return 'flat';
  return null;
};
`,
  },
  {
    id: 'macd',
    name: 'MACD signal cross',
    code: `${HEADER}
// @param fast 12 2 50 1 Fast
// @param slow 26 5 100 1 Slow
// @param signal 9 2 50 1 Signal

const m = ta.macd(close, params.fast, params.slow, params.signal);

return (i) => {
  if (ta.crossover(m.macd, m.signal, i)) return 'long';
  if (ta.crossunder(m.macd, m.signal, i)) return 'flat';
  return null;
};
`,
  },
  {
    id: 'supertrend',
    name: 'Supertrend',
    code: `${HEADER}
// @param period 10 2 50 1 ATR period
// @param mult 3 1 6 0.1 ATR multiplier

const st = ta.supertrend(high, low, close, params.period, params.mult);

return (i) => {
  if (st.dir[i] === 1 && st.dir[i - 1] === -1) return 'long';
  if (st.dir[i] === -1 && st.dir[i - 1] === 1) return 'short';
  return null;
};
`,
  },
  {
    id: 'donchian',
    name: 'Donchian breakout',
    code: `${HEADER}
// @param entry 20 5 100 1 Breakout lookback
// @param exit 10 2 50 1 Exit lookback

const upper = ta.highest(high, params.entry);
const lower = ta.lowest(low, params.exit);

return (i) => {
  if (i < 1) return null;
  if (close[i] > upper[i - 1]) return 'long';
  if (close[i] < lower[i - 1]) return 'flat';
  return null;
};
`,
  },
];

export const BLANK = `${HEADER}
// @param length 20 2 200 1 Lookback

const avg = ta.sma(close, params.length);

return (i) => {
  // your rules here
  if (close[i] > avg[i]) return 'long';
  if (close[i] < avg[i]) return 'flat';
  return null;
};
`;
