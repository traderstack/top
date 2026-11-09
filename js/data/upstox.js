// NSE / BSE market data from the Upstox API.
//
// Your Upstox API secret and daily access token never reach the browser. They live
// in Supabase: the `upstox-callback` function handles the daily Upstox login and
// stores the token privately, and the `upstox` function serves candles and quotes to
// callers that send your private access key. Live prices are polled every few
// seconds, so the access token (which can place orders) stays on the server.
import { aggregate, bucketStart, tfSec } from '../timeframes.js';
import { Emitter, store } from '../util.js';

export const timeframes = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

const PLAN = {
  '1m': { unit: 'minutes', interval: 1, days: 25 },
  '5m': { unit: 'minutes', interval: 5, days: 85 },
  '15m': { unit: 'minutes', interval: 15, days: 170 },
  '1h': { unit: 'hours', interval: 1, days: 360 },
  '4h': { unit: 'hours', interval: 1, days: 360, agg: 14400 },
  '1D': { unit: 'days', interval: 1, days: 1825 },
  '1W': { unit: 'weeks', interval: 1, days: 3650 },
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
export const LOGIN_URL = `${PROJECT}/upstox-callback`;

export function getConfig() {
  const c = store.get('upstox', {});
  return { url: c.url || `${PROJECT}/upstox`, anonKey: c.anonKey || DEFAULT_ANON, accessKey: c.accessKey || '' };
}
export function setConfig(cfg) {
  store.set('upstox', cfg);
  status.set(false);
  poller?.restart();
}
export const isConfigured = () => !!getConfig().accessKey;

/** Session state shared with the UI: needsLogin turns true when the daily Upstox session ends. */
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
    const err = new Error(json.error || `Upstox backend ${res.status}`);
    err.needsLogin = !!json.needsLogin;
    throw err;
  }
  if (action === 'quote') status.set(false);
  if (action === 'status') status.set(!json.data?.connected);
  return json.data;
}

const day = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10); // IST date

export async function getCandles(sym, tf) {
  const plan = PLAN[tf];
  if (!plan) throw new Error(`Timeframe ${tf} not supported`);
  if (!sym.key) throw new Error(`No Upstox instrument key for ${sym.ticker}. Remove it and add it again from search.`);
  const now = Date.now();
  const bars = await call('candles', {
    key: sym.key, unit: plan.unit, interval: plan.interval,
    from: day(now - plan.days * 86400000), to: day(now),
  });
  return plan.agg ? aggregate(bars, plan.agg, align(plan.agg)) : bars;
}

// ---------------------------------------------------------------------------
// Symbol search: a static list built weekly by .github/workflows/instruments.yml

const lists = {};
async function loadList(exchange) {
  lists[exchange] ??= fetch(`data/instruments/${exchange}.json`).then((r) => {
    if (!r.ok) throw new Error('The NSE/BSE symbol list has not been built yet. Run the "Update NSE/BSE symbol list" GitHub Action.');
    return r.json();
  }).then((j) => j.rows).catch((e) => { delete lists[exchange]; throw e; });
  return lists[exchange];
}

export async function search(query, exchange) {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const rows = await loadList(exchange);
  const score = ([sym, name, , type]) =>
    (sym === q ? 0 : sym.startsWith(q) ? 1 : name.toUpperCase().startsWith(q) ? 2 : 3) - (type === 'INDEX' ? 0.5 : 0);
  return rows
    .filter(([sym, name]) => sym.includes(q) || name.toUpperCase().includes(q))
    .sort((a, b) => score(a) - score(b) || a[0].length - b[0].length)
    .slice(0, 30)
    .map(([sym, name, key, type]) => ({
      market: exchange.toLowerCase(), src: 'upstox', exchange, ticker: sym, key,
      name: type === 'INDEX' ? name : sym, desc: name,
    }));
}

// ---------------------------------------------------------------------------
// Live prices: one shared poller for every subscribed instrument.

class Poller {
  constructor() {
    this.listeners = new Map(); // instrument key -> Set(fn)
    this.timer = null;
    this.busy = false;
  }
  add(sym, fn) {
    const k = sym.key;
    if (!k) return () => {};
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
      const quotes = await call('quote', { keys: [...this.listeners.keys()] });
      const now = Date.now();
      for (const q of quotes) {
        for (const fn of this.listeners.get(q.key) ?? []) fn({ price: q.ltp, changePct: q.changePct, ts: now });
      }
    } catch (e) {
      console.warn('Upstox quote poll failed:', e.message);
    } finally {
      this.busy = false;
    }
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  restart() { this.stop(); if (this.listeners.size) this.ensure(); }
}

let poller;
const getPoller = () => (poller ??= new Poller());
status.on('change', (needs) => { if (!needs) poller?.poll(); });

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
    // Outside market hours the price doesn't move; don't invent new bars.
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
