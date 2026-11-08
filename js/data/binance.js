// Crypto market data from Binance's public market-data endpoints (no key needed).
import { ReconnectingSocket } from '../util.js';

const REST = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision';
const INTERVAL = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' };

export const timeframes = Object.keys(INTERVAL);

const toBar = (k) => ({
  time: Math.floor(k[0] / 1000),
  open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
});

export async function getCandles(sym, tf, limit = 1500) {
  const interval = INTERVAL[tf];
  if (!interval) throw new Error(`Timeframe ${tf} not supported for crypto`);
  let bars = [];
  let endTime;
  while (bars.length < limit) {
    const n = Math.min(1000, limit - bars.length);
    const url = `${REST}/klines?symbol=${sym.ticker}&interval=${interval}&limit=${n}` + (endTime ? `&endTime=${endTime}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) break;
    bars = rows.map(toBar).concat(bars);
    if (rows.length < n) break;
    endTime = rows[0][0] - 1;
  }
  return bars;
}

export function subscribeCandles(sym, tf, onBar, onStatus) {
  const stream = `${sym.ticker.toLowerCase()}@kline_${INTERVAL[tf]}`;
  const sock = new ReconnectingSocket(() => `${WS}/ws/${stream}`, {
    onStatus,
    onMessage(raw) {
      const m = JSON.parse(raw);
      const k = m.k;
      if (!k) return;
      onBar({
        time: Math.floor(k.t / 1000),
        open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
        closed: k.x,
      });
    },
  });
  return () => sock.close();
}

/** Live last price and 24h change for a list of symbols. */
export function subscribeTickers(syms, onTick) {
  if (!syms.length) return () => {};
  const byTicker = new Map(syms.map((s) => [s.ticker, s]));
  const streams = [...byTicker.keys()].map((t) => `${t.toLowerCase()}@miniTicker`).join('/');
  const sock = new ReconnectingSocket(() => `${WS}/stream?streams=${streams}`, {
    onMessage(raw) {
      const d = JSON.parse(raw).data;
      if (!d) return;
      const sym = byTicker.get(d.s);
      if (!sym) return;
      const price = +d.c;
      const open = +d.o;
      onTick(sym, { price, changePct: open ? ((price - open) / open) * 100 : 0, ts: d.E });
    },
  });
  return () => sock.close();
}

let symbolCache;
export async function search(query) {
  if (!symbolCache) {
    const res = await fetch(`${REST}/exchangeInfo?permissions=SPOT`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const info = await res.json();
    symbolCache = info.symbols
      .filter((s) => s.status === 'TRADING' && ['USDT', 'FDUSD', 'USDC', 'BTC', 'INR'].includes(s.quoteAsset))
      .map((s) => ({ market: 'crypto', ticker: s.symbol, name: `${s.baseAsset} / ${s.quoteAsset}`, quote: s.quoteAsset }));
  }
  const q = query.trim().toUpperCase();
  if (!q) return [];
  return symbolCache
    .filter((s) => s.ticker.includes(q))
    .sort((a, b) => (a.ticker.startsWith(q) ? 0 : 1) - (b.ticker.startsWith(q) ? 0 : 1) || a.ticker.length - b.ticker.length)
    .slice(0, 30);
}
