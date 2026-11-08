// Bar-by-bar backtester.
//
// A strategy is JavaScript that receives the price arrays and returns a function
// `(i) => 'long' | 'short' | 'flat' | null` giving the desired position after bar i
// closes (null keeps the current position). Orders fill at the NEXT bar's open, so a
// strategy can never trade on information it would not have had.
import * as ta from '../ta.js';

/** Parse `// @param name default [min] [max] [step]` lines into parameter specs. */
export function parseParams(code) {
  const params = [];
  for (const m of code.matchAll(/^\s*\/\/\s*@param\s+(\w+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?(?:\s+(-?[\d.]+))?(?:\s+(-?[\d.]+))?(?:\s+(.*))?$/gm)) {
    params.push({
      name: m[1],
      default: +m[2],
      min: m[3] != null ? +m[3] : undefined,
      max: m[4] != null ? +m[4] : undefined,
      step: m[5] != null ? +m[5] : undefined,
      label: m[6]?.trim() || m[1],
    });
  }
  return params;
}

/** Compile strategy code into a builder. Throws with a readable message on syntax errors. */
export function compileStrategy(code) {
  let factory;
  try {
    // eslint-disable-next-line no-new-func
    factory = new Function('bars', 'open', 'high', 'low', 'close', 'volume', 'params', 'ta', `"use strict";\n${code}`);
  } catch (e) {
    throw new Error(`Strategy code error: ${e.message}`);
  }
  return {
    params: parseParams(code),
    build(bars, params) {
      const cols = {
        open: bars.map((b) => b.open),
        high: bars.map((b) => b.high),
        low: bars.map((b) => b.low),
        close: bars.map((b) => b.close),
        volume: bars.map((b) => b.volume || 0),
      };
      let fn;
      try {
        fn = factory(bars, cols.open, cols.high, cols.low, cols.close, cols.volume, params, ta);
      } catch (e) {
        throw new Error(`Strategy setup error: ${e.message}`);
      }
      if (typeof fn !== 'function') throw new Error('Strategy must `return (i) => ...` — a function of the bar index.');
      return fn;
    },
  };
}

const DIR = { long: 1, short: -1, flat: 0, buy: 1, sell: -1, exit: 0 };

/**
 * opts: initialCapital, positionPct, commissionPct, slippagePct, allowShort,
 *       stopLossPct, takeProfitPct, intQty, barsPerYear
 */
export function runBacktest(bars, signalFn, opts) {
  const o = {
    initialCapital: 100000, positionPct: 100, commissionPct: 0.05, slippagePct: 0,
    allowShort: false, stopLossPct: 0, takeProfitPct: 0, intQty: false, barsPerYear: 252, ...opts,
  };
  let cash = o.initialCapital;
  let pos = null; // {dir, qty, entryPrice, entryTime, entryIndex, fees}
  let pending = null; // target direction to execute at next open
  const trades = [];
  const equity = [];
  const markers = [];
  const slip = o.slippagePct / 100;
  const fee = o.commissionPct / 100;

  const equityAt = (price) => cash + (pos ? pos.dir * pos.qty * price : 0);

  function open(dir, price, i) {
    const fill = price * (1 + dir * slip);
    const budget = equityAt(price) * (o.positionPct / 100);
    let qty = budget / (fill * (1 + fee));
    if (o.intQty) qty = Math.floor(qty);
    if (!(qty > 0)) return;
    const f = qty * fill * fee;
    cash -= dir * qty * fill + f;
    pos = { dir, qty, entryPrice: fill, entryTime: bars[i].time, entryIndex: i, fees: f };
    markers.push({ time: bars[i].time, side: dir > 0 ? 'buy' : 'sell', text: dir > 0 ? 'Long' : 'Short' });
  }

  function close(price, i, reason) {
    const fill = price * (1 - pos.dir * slip);
    const f = pos.qty * fill * fee;
    cash += pos.dir * pos.qty * fill - f;
    const gross = pos.dir * pos.qty * (fill - pos.entryPrice);
    const pnl = gross - pos.fees - f;
    trades.push({
      dir: pos.dir, qty: pos.qty,
      entryTime: pos.entryTime, entryPrice: pos.entryPrice,
      exitTime: bars[i].time, exitPrice: fill,
      pnl, pnlPct: (pnl / (pos.qty * pos.entryPrice)) * 100,
      bars: i - pos.entryIndex, reason,
    });
    markers.push({ time: bars[i].time, side: pos.dir > 0 ? 'sell' : 'buy', text: reason === 'signal' ? 'Exit' : reason === 'stop' ? 'Stop' : reason === 'target' ? 'Target' : 'End' });
    pos = null;
  }

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    // 1. Fill the order decided at the previous close.
    if (pending !== null) {
      if (pos && pos.dir !== pending) close(b.open, i, 'signal');
      if (!pos && pending !== 0) open(pending, b.open, i);
      pending = null;
    }

    // 2. Stop loss / take profit inside this bar (stop assumed first when both touch).
    if (pos) {
      const sl = o.stopLossPct > 0 ? pos.entryPrice * (1 - pos.dir * o.stopLossPct / 100) : null;
      const tp = o.takeProfitPct > 0 ? pos.entryPrice * (1 + pos.dir * o.takeProfitPct / 100) : null;
      if (sl != null && (pos.dir > 0 ? b.low <= sl : b.high >= sl)) {
        close(pos.dir > 0 ? Math.min(b.open, sl) : Math.max(b.open, sl), i, 'stop');
      } else if (tp != null && (pos.dir > 0 ? b.high >= tp : b.low <= tp)) {
        close(pos.dir > 0 ? Math.max(b.open, tp) : Math.min(b.open, tp), i, 'target');
      }
    }

    // 3. Ask the strategy what it wants after this bar closes.
    if (i < bars.length - 1) {
      let sig;
      try { sig = signalFn(i); } catch (e) { throw new Error(`Strategy error at bar ${i}: ${e.message}`); }
      if (sig != null) {
        let target = typeof sig === 'number' ? Math.sign(sig) : DIR[sig];
        if (target === undefined) throw new Error(`Unknown signal "${sig}". Return 'long', 'short', 'flat' or null.`);
        if (target < 0 && !o.allowShort) target = 0;
        if ((pos?.dir ?? 0) !== target) pending = target;
      }
    }

    equity.push({ time: b.time, value: equityAt(b.close) });
  }

  if (pos) close(bars.at(-1).close, bars.length - 1, 'end');
  if (equity.length) equity[equity.length - 1].value = cash;

  return { trades, equity, markers, stats: stats(bars, trades, equity, o) };
}

function stats(bars, trades, equity, o) {
  const start = o.initialCapital;
  const end = equity.at(-1)?.value ?? start;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);

  let peak = start;
  let maxDD = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.value);
    maxDD = Math.max(maxDD, (peak - e.value) / peak);
  }

  const rets = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i].value / equity[i - 1].value - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(o.barsPerYear) : 0;

  const years = equity.length / o.barsPerYear;
  const cagr = years > 0 && end > 0 ? ((end / start) ** (1 / years) - 1) * 100 : 0;
  const first = bars[0]?.close;
  const last = bars.at(-1)?.close;

  return {
    netProfit: end - start,
    netProfitPct: ((end - start) / start) * 100,
    buyHoldPct: first ? ((last - first) / first) * 100 : 0,
    cagr,
    maxDrawdownPct: maxDD * 100,
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgTrade: trades.length ? (end - start) / trades.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    sharpe,
    avgBars: trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0,
    endEquity: end,
  };
}
