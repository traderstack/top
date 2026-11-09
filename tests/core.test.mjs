import * as ta from '../js/ta.js';
import { compileStrategy, runBacktest } from '../js/backtest/engine.js';
import { TEMPLATES } from '../js/backtest/strategies.js';
import { aggregate, bucketStart } from '../js/timeframes.js';
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
// indicators
const s = ta.sma([1,2,3,4,5], 3); assert(isNaN(s[1]) && s[2]===2 && s[4]===4, 'sma');
const e = ta.ema([1,2,3,4,5,6], 3); assert(e[2]===2 && Math.abs(e[3]-3)<1e-9, 'ema seeds with sma');
const r = ta.rsi(Array.from({length:30},(_, i)=>i), 14); assert(r[29]===100, 'rsi all gains = 100');
assert(ta.crossover([1,3],[2,2],1) && !ta.crossover([3,3],[2,2],1), 'crossover');
// synthetic sine-wave market
let price = 100; const bars = [];
for (let i = 0; i < 2000; i++) { const c = 100 + 20*Math.sin(i/40) + i*0.01; bars.push({time: 1700000000 + i*3600, open: price, high: Math.max(price,c)+0.5, low: Math.min(price,c)-0.5, close: c, volume: 10}); price = c; }
for (const t of TEMPLATES) {
  const st = compileStrategy(t.code);
  const params = Object.fromEntries(st.params.map(p => [p.name, p.default]));
  const res = runBacktest(bars, st.build(bars, params), { initialCapital: 100000, commissionPct: 0.05, allowShort: true, barsPerYear: 8760 });
  const sumPnl = res.trades.reduce((a, t) => a + t.pnl, 0);
  assert(Math.abs(100000 + sumPnl - res.stats.endEquity) < 1e-6, `${t.name}: trades=${res.stats.trades} ret=${res.stats.netProfitPct.toFixed(1)}% dd=${res.stats.maxDrawdownPct.toFixed(1)}% equity reconciles`);
}
// no lookahead: entry happens at next bar open
const st = compileStrategy("return (i) => i === 10 ? 'long' : (i === 20 ? 'flat' : null);");
const res = runBacktest(bars, st.build(bars, {}), { initialCapital: 1000, commissionPct: 0, slippagePct: 0 });
assert(res.trades[0].entryTime === bars[11].time && res.trades[0].entryPrice === bars[11].open, 'fills at next open');
assert(res.trades[0].exitTime === bars[21].time, 'exit at next open');
// stop loss
const st2 = compileStrategy("return (i) => i === 0 ? 'long' : null;");
const down = [{time:0,open:100,high:100,low:100,close:100},{time:1,open:100,high:101,low:100,close:100},{time:2,open:100,high:100,low:80,close:85},{time:3,open:85,high:86,low:84,close:85}];
const r2 = runBacktest(down, st2.build(down, {}), { initialCapital: 1000, commissionPct: 0, stopLossPct: 5 });
assert(r2.trades[0].reason === 'stop' && r2.trades[0].exitPrice === 95, 'stop loss fills at stop');
// syntax error message
try { compileStrategy('return (i) => {'); assert(false, 'syntax error'); } catch (err) { assert(/Strategy code error/.test(err.message), 'syntax error reported'); }
// aggregation
const agg = aggregate([{time:0,open:1,high:2,low:0.5,close:1.5,volume:1},{time:3600,open:1.5,high:3,low:1,close:2,volume:2}], 7200);
assert(agg.length===1 && agg[0].high===3 && agg[0].close===2 && agg[0].volume===3, 'aggregate');
assert(bucketStart(1700000000, 86400, 66600) % 86400 === 66600, 'IST day bucket');
