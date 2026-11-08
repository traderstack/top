// NSE / BSE market data from Angel One SmartAPI.
//
// Your Angel One credentials never reach the browser. They live as secrets in a
// Supabase Edge Function (supabase/functions/angel), which logs in, fetches candles
// and quotes, and hands the browser a market-data-only feed token for the live
// WebSocket. The function only answers callers that send your private access key.
import { aggregate, bucketStart, tfSec } from '../timeframes.js';
import { ReconnectingSocket, store } from '../util.js';

export const timeframes = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

// Angel interval and how many days of history to request (stays under Angel's per-request caps).
const PLAN = {
  '1m': { interval: 'ONE_MINUTE', days: 25 },
  '5m': { interval: 'FIVE_MINUTE', days: 90 },
  '15m': { interval: 'FIFTEEN_MINUTE', days: 180 },
  '1h': { interval: 'ONE_HOUR', days: 380 },
  '4h': { interval: 'ONE_HOUR', days: 380, agg: 14400 },
  '1D': { interval: 'ONE_DAY', days: 1990 },
  '1W': { interval: 'ONE_DAY', days: 1990, agg: 604800 },
};

const EXCHANGE_TYPE = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, CDS: 13 };

/** Bucket alignment for Indian sessions (09:15 IST open, IST calendar days). */
export function align(sec) {
  if (sec >= 604800) return 325800; // Monday 00:00 IST
  if (sec >= 86400) return 66600; // 00:00 IST
  return 13500 % sec; // 09:15 IST
}

// Public endpoint of the TraderStack backend (safe to publish; the ACCESS_KEY is what protects it).
const DEFAULT_URL = 'https://jdhqomlblzzrctuntvik.supabase.co/functions/v1/angel';
const DEFAULT_ANON = 'sb_publishable_gFFbgzD8Ps_0ALgUpCl9Cw_LmMie46y';

export function getConfig() {
  const c = store.get('angel', {});
  return { url: c.url || DEFAULT_URL, anonKey: c.anonKey || DEFAULT_ANON, accessKey: c.accessKey || '' };
}
export function setConfig(cfg) {
  store.set('angel', cfg);
  feed?.restart();
}
export const isConfigured = () => {
  const c = getConfig();
  return !!(c.url && c.accessKey);
};

async function call(action, payload = {}) {
  const cfg = getConfig();
  if (!cfg.url || !cfg.accessKey) {
    throw new Error('NSE/BSE data is not connected yet. Open Settings and add your Angel One backend.');
  }
  const headers = { 'Content-Type': 'application/json', 'x-access-key': cfg.accessKey };
  if (cfg.anonKey) {
    headers.apikey = cfg.anonKey;
    if (cfg.anonKey.startsWith('eyJ')) headers.Authorization = `Bearer ${cfg.anonKey}`; // legacy JWT anon key
  }
  const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Angel backend ${res.status}`);
  return json.data;
}

const pad = (n) => String(n).padStart(2, '0');
/** Angel wants "yyyy-MM-dd HH:mm" in IST. */
function istString(ms) {
  const d = new Date(ms + 19800000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export async function getCandles(sym, tf) {
  const plan = PLAN[tf];
  if (!plan) throw new Error(`Timeframe ${tf} not supported`);
  const now = Date.now();
  const bars = await call('candles', {
    exchange: sym.exchange,
    token: sym.token,
    interval: plan.interval,
    from: istString(now - plan.days * 86400000),
    to: istString(now),
  });
  return plan.agg ? aggregate(bars, plan.agg, align(plan.agg)) : bars;
}

export async function search(query, exchange) {
  const q = query.trim();
  if (q.length < 2) return [];
  const rows = await call('search', { exchange, query: q });
  const market = exchange.toLowerCase();
  return rows
    .filter((r) => exchange !== 'NSE' || /-(EQ|BE)$/.test(r.tradingsymbol) || !r.tradingsymbol.includes('-'))
    .slice(0, 30)
    .map((r) => ({
      market,
      ticker: r.tradingsymbol,
      name: r.tradingsymbol.replace(/-EQ$/, ''),
      exchange: r.exchange,
      token: r.symboltoken,
    }));
}

// ---------------------------------------------------------------------------
// Live feed: Angel SmartStream WebSocket, falling back to polling quotes.

function parseTick(buf) {
  const v = new DataView(buf);
  if (buf.byteLength < 51) return null;
  const mode = v.getInt8(0);
  const exType = v.getInt8(1);
  let token = '';
  for (let i = 2; i < 27; i++) {
    const c = v.getUint8(i);
    if (c === 0) break;
    token += String.fromCharCode(c);
  }
  const divisor = exType === EXCHANGE_TYPE.CDS ? 1e7 : 100;
  const num = (o) => Number(v.getBigInt64(o, true));
  const tick = { mode, exType, token, ts: num(35), ltp: num(43) / divisor };
  if (mode >= 2 && buf.byteLength >= 123) {
    tick.volume = num(67);
    tick.open = num(91) / divisor;
    tick.high = num(99) / divisor;
    tick.low = num(107) / divisor;
    tick.prevClose = num(115) / divisor;
  }
  return tick;
}

class AngelFeed {
  constructor() {
    this.listeners = new Map(); // key "EX:token" -> Set(fn)
    this.prevClose = new Map();
    this.sock = null;
    this.pollTimer = null;
    this.mode = 'idle';
  }
  key(exchange, token) { return `${exchange}:${token}`; }

  add(sym, fn) {
    const k = this.key(sym.exchange, sym.token);
    if (!this.listeners.has(k)) this.listeners.set(k, new Set());
    this.listeners.get(k).add(fn);
    this.sync();
    return () => {
      this.listeners.get(k)?.delete(fn);
      if (!this.listeners.get(k)?.size) this.listeners.delete(k);
      this.sync();
    };
  }

  emit(exchange, token, data) {
    for (const fn of this.listeners.get(this.key(exchange, token)) ?? []) fn(data);
  }

  sync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.#sync(), 50);
  }

  #sync() {
    if (!this.listeners.size || !isConfigured()) return this.stop();
    if (!this.sock && this.mode !== 'poll') this.start();
    else if (this.sock) this.subscribeAll();
    if (this.mode === 'poll') this.pollNow();
  }

  start() {
    this.mode = 'ws';
    let opened = false;
    let failures = 0;
    this.sock = new ReconnectingSocket(async () => {
      const s = await call('session');
      return `wss://smartapisocket.angelone.in/smart-stream?clientCode=${encodeURIComponent(s.clientCode)}&feedToken=${encodeURIComponent(s.feedToken)}&apiKey=${encodeURIComponent(s.apiKey)}`;
    }, {
      binary: true,
      onStatus: (st) => {
        if (st === 'open') { opened = true; failures = 0; }
        if (st === 'closed' || st === 'error') {
          failures++;
          // If the socket never comes up, fall back to polling quotes through the backend.
          if (!opened && failures >= 2) this.fallbackToPolling();
        }
      },
      onOpen: () => {
        this.subscribed = new Set();
        this.subscribeAll();
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.sock?.send('ping'), 25000);
      },
      onMessage: (data) => {
        if (typeof data === 'string') return; // "pong"
        const t = parseTick(data);
        if (!t || !t.token) return;
        const exchange = Object.keys(EXCHANGE_TYPE).find((k) => EXCHANGE_TYPE[k] === t.exType);
        if (t.prevClose) this.prevClose.set(this.key(exchange, t.token), t.prevClose);
        const pc = this.prevClose.get(this.key(exchange, t.token));
        this.emit(exchange, t.token, {
          price: t.ltp,
          changePct: pc ? ((t.ltp - pc) / pc) * 100 : undefined,
          ts: t.ts || Date.now(),
          volume: t.volume,
        });
      },
    });
  }

  subscribeAll() {
    if (!this.sock) return;
    this.subscribed ??= new Set();
    const groups = {};
    for (const k of this.listeners.keys()) {
      if (this.subscribed.has(k)) continue;
      const [ex, token] = k.split(':');
      (groups[EXCHANGE_TYPE[ex]] ??= []).push(token);
      this.subscribed.add(k);
    }
    const tokenList = Object.entries(groups).map(([exchangeType, tokens]) => ({ exchangeType: +exchangeType, tokens }));
    if (tokenList.length) {
      this.sock.send(JSON.stringify({ correlationID: 'ts' + Date.now().toString(36).slice(-6), action: 1, params: { mode: 2, tokenList } }));
    }
  }

  fallbackToPolling() {
    this.sock?.close();
    this.sock = null;
    clearInterval(this.heartbeat);
    this.mode = 'poll';
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollNow(), 4000);
    this.pollNow();
  }

  async pollNow() {
    if (this.polling || !this.listeners.size) return;
    this.polling = true;
    try {
      const exchangeTokens = {};
      for (const k of this.listeners.keys()) {
        const [ex, token] = k.split(':');
        (exchangeTokens[ex] ??= []).push(token);
      }
      const quotes = await call('quote', { exchangeTokens });
      for (const q of quotes) {
        this.emit(q.exchange, q.token, { price: q.ltp, changePct: q.changePct, ts: Date.now() });
      }
    } catch (e) {
      console.warn('Angel quote poll failed', e);
    } finally {
      this.polling = false;
    }
  }

  stop() {
    this.sock?.close();
    this.sock = null;
    clearInterval(this.heartbeat);
    clearInterval(this.pollTimer);
    this.mode = 'idle';
  }

  restart() {
    this.stop();
    this.sync();
  }
}

let feed;
const getFeed = () => (feed ??= new AngelFeed());

export function subscribeTickers(syms, onTick) {
  const offs = syms.map((s) => getFeed().add(s, (d) => onTick(s, d)));
  return () => offs.forEach((f) => f());
}

/** Build live bars for the current timeframe from ticks. */
export function subscribeCandles(sym, tf, onBar, _onStatus, lastBar) {
  const sec = tfSec(tf);
  const al = align(sec);
  let cur = lastBar ? { ...lastBar } : null;
  return getFeed().add(sym, ({ price, ts }) => {
    if (!isFinite(price) || price <= 0) return;
    const t = bucketStart(Math.floor((ts || Date.now()) / 1000), sec, al);
    if (!cur || t > cur.time) {
      if (cur) onBar({ ...cur, closed: true });
      cur = { time: t, open: price, high: price, low: price, close: price, volume: 0 };
    } else if (t === cur.time) {
      cur.high = Math.max(cur.high, price);
      cur.low = Math.min(cur.low, price);
      cur.close = price;
    } else {
      return; // late tick for an older bar
    }
    onBar({ ...cur, closed: false });
  });
}
