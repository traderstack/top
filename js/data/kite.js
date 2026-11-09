// NSE / BSE market data from Zerodha Kite Connect.
//
// Your Kite API secret and daily access token never reach the browser. They live
// in Supabase: the `kite-callback` function handles the daily Zerodha login and
// stores the token privately, and the `kite` function serves candles, quotes and
// search to callers that send your private access key. Live prices are polled
// every few seconds, so the access token (which can place orders) stays on the server.
import { aggregate, bucketStart, tfSec } from '../timeframes.js';
import { Emitter, store } from '../util.js';

export const timeframes = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

const PLAN = {
  '1m': { interval: 'minute', days: 30 },
  '5m': { interval: '5minute', days: 95 },
  '15m': { interval: '15minute', days: 190 },
  '1h': { interval: '60minute', days: 390 },
  '4h': { interval: '60minute', days: 390, agg: 14400 },
  '1D': { interval: 'day', days: 1990 },
  '1W': { interval: 'day', days: 1990, agg: 604800 },
};

const POLL_MS = 3000;

/** Bucket alignment for Indian sessions (09:15 IST open, IST calendar days). */
export function align(sec) {
  if (sec >= 604800) return 325800; // Monday 00:00 IST
  if (sec >= 86400) return 66600; // 00:00 IST
  return 13500 % sec; // 09:15 IST
}

// Public endpoints of the TraderStack backend. The ACCESS_KEY is what protects them.
const PROJECT = 'https://jdhqomlblzzrctuntvik.supabase.co/functions/v1';
const DEFAULT_ANON = 'sb_publishable_gFFbgzD8Ps_0ALgUpCl9Cw_LmMie46y';
export const LOGIN_URL = `${PROJECT}/kite-callback`;

export function getConfig() {
  const c = store.get('kite', {});
  return { url: c.url || `${PROJECT}/kite`, anonKey: c.anonKey || DEFAULT_ANON, accessKey: c.accessKey || '' };
}
export function setConfig(cfg) {
  store.set('kite', cfg);
  status.needsLogin = false;
  poller?.restart();
}
export const isConfigured = () => !!getConfig().accessKey;

/** Session state shared with the UI ("needs-login" when Zerodha's daily session ends). */
export const status = new (class extends Emitter {
  needsLogin = false;
  set(v) {
    if (this.needsLogin === v) return;
    this.needsLogin = v;
    this.emit('change', v);
  }
})();

export async function call(action, payload = {}) {
  const cfg = getConfig();
  if (!cfg.accessKey) throw new Error('NSE/BSE data is not connected yet. Open Settings and enter your access key.');
  const headers = { 'Content-Type': 'application/json', 'x-access-key': cfg.accessKey };
  if (cfg.anonKey) {
    headers.apikey = cfg.anonKey;
    if (cfg.anonKey.startsWith('eyJ')) headers.Authorization = `Bearer ${cfg.anonKey}`;
  }
  const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }) });
  const json = await res.json().catch(() => ({}));
  if (json.needsLogin) status.set(true);
  if (!res.ok || json.error) {
    const err = new Error(json.error || `Zerodha backend ${res.status}`);
    err.needsLogin = !!json.needsLogin;
    throw err;
  }
  if (action !== 'status') status.set(false);
  return json.data;
}

const pad = (n) => String(n).padStart(2, '0');
/** Kite wants "yyyy-MM-dd HH:mm:ss" in IST. */
function istString(ms) {
  const d = new Date(ms + 19800000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

export async function getCandles(sym, tf) {
  const plan = PLAN[tf];
  if (!plan) throw new Error(`Timeframe ${tf} not supported`);
  const now = Date.now();
  const bars = await call('candles', {
    exchange: sym.exchange,
    symbol: sym.ticker,
    interval: plan.interval,
    from: istString(now - plan.days * 86400000),
    to: istString(now),
  });
  return plan.agg ? aggregate(bars, plan.agg, align(plan.agg)) : bars;
}

export async function search(query, exchange) {
  if (query.trim().length < 2) return [];
  const rows = await call('search', { exchange, query });
  const market = exchange.toLowerCase();
  return rows.map((r) => ({ market, src: 'kite', ticker: r.symbol, name: r.type === 'INDEX' ? r.symbol : r.symbol, exchange: r.exchange, desc: r.name }));
}

// ---------------------------------------------------------------------------
// Live prices: one shared poller for every subscribed instrument.

class KitePoller {
  constructor() {
    this.listeners = new Map(); // "NSE:INFY" -> Set(fn)
    this.timer = null;
    this.busy = false;
  }
  add(sym, fn) {
    const k = `${sym.exchange}:${sym.ticker}`;
    if (!this.listeners.has(k)) this.listeners.set(k, new Set());
    this.listeners.get(k).add(fn);
    this.ensure();
    return () => {
      this.listeners.get(k)?.delete(fn);
      if (!this.listeners.get(k)?.size) this.listeners.delete(k);
      if (!this.listeners.size) this.stop();
    };
  }
  ensure() {
    if (this.timer || !isConfigured()) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    setTimeout(() => this.poll(), 50);
  }
  async poll() {
    if (this.busy || !this.listeners.size || status.needsLogin || document.hidden) return;
    this.busy = true;
    try {
      const quotes = await call('quote', { instruments: [...this.listeners.keys()] });
      const now = Date.now();
      for (const q of quotes) {
        for (const fn of this.listeners.get(q.key) ?? []) fn({ price: q.ltp, changePct: q.changePct, ts: now });
      }
    } catch (e) {
      console.warn('Zerodha quote poll failed:', e.message);
    } finally {
      this.busy = false;
    }
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  restart() { this.stop(); if (this.listeners.size) this.ensure(); }
}

let poller;
const getPoller = () => (poller ??= new KitePoller());
status.on('change', (needs) => { if (!needs) getPoller().poll(); });

export function subscribeTickers(syms, onTick) {
  const offs = syms.map((s) => getPoller().add(s, (d) => onTick(s, d)));
  return () => offs.forEach((f) => f());
}

/** Build the live bar for the current timeframe from polled prices. */
export function subscribeCandles(sym, tf, onBar, _onStatus, lastBar) {
  const sec = tfSec(tf);
  const al = align(sec);
  let cur = lastBar ? { ...lastBar } : null;
  return getPoller().add(sym, ({ price, ts }) => {
    if (!isFinite(price) || price <= 0) return;
    // Outside market hours the last price doesn't move; don't invent new bars.
    if (cur && price === cur.close && Math.floor(ts / 1000) - cur.time >= sec) return;
    const t = bucketStart(Math.floor(ts / 1000), sec, al);
    if (!cur || t > cur.time) {
      if (cur) onBar({ ...cur, closed: true });
      cur = { time: t, open: price, high: price, low: price, close: price, volume: 0 };
    } else if (t === cur.time) {
      cur.high = Math.max(cur.high, price);
      cur.low = Math.min(cur.low, price);
      cur.close = price;
    } else return;
    onBar({ ...cur, closed: false });
  });
}
