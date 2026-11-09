// Market registry: routes every symbol to its data provider and keeps live prices.
import * as binance from './binance.js';
import * as forex from './forex.js';
import * as kite from './kite.js';
import { Emitter, store } from '../util.js';

export const MARKETS = {
  nse: {
    id: 'nse', label: 'NSE', ccy: 'INR', provider: kite, intQty: true,
    align: kite.align, search: (q) => kite.search(q, 'NSE'),
    note: 'Live via Zerodha Kite Connect',
  },
  bse: {
    id: 'bse', label: 'BSE', ccy: 'INR', provider: kite, intQty: true,
    align: kite.align, search: (q) => kite.search(q, 'BSE'),
    note: 'Live via Zerodha Kite Connect',
  },
  crypto: {
    id: 'crypto', label: 'Crypto', ccy: 'USD', provider: binance, intQty: false,
    align: (sec) => (sec >= 604800 ? 345600 : 0), search: binance.search,
    note: 'Live via Binance public feed',
  },
  forex: {
    id: 'forex', label: 'Forex', ccy: 'USD', provider: forex, intQty: false,
    align: (sec) => (sec >= 604800 ? 345600 : 0), search: forex.search,
    note: 'ECB daily reference rates',
  },
};

// Indian symbols use Zerodha trading symbols (src: 'kite').
const nse = (ticker) => ({ market: 'nse', src: 'kite', ticker, exchange: 'NSE', name: ticker });
const bse = (ticker) => ({ market: 'bse', src: 'kite', ticker, exchange: 'BSE', name: ticker });
const cr = (ticker, name) => ({ market: 'crypto', ticker, name, quote: 'USDT' });

export const DEFAULT_WATCHLISTS = {
  nse: ['NIFTY 50', 'NIFTY BANK', 'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'ITC', 'LT', 'BHARTIARTL'].map(nse),
  bse: ['SENSEX', 'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN'].map(bse),
  crypto: [
    cr('BTCUSDT', 'Bitcoin'), cr('ETHUSDT', 'Ethereum'), cr('SOLUSDT', 'Solana'),
    cr('BNBUSDT', 'BNB'), cr('XRPUSDT', 'XRP'), cr('DOGEUSDT', 'Dogecoin'),
    cr('ADAUSDT', 'Cardano'), cr('AVAXUSDT', 'Avalanche'), cr('LINKUSDT', 'Chainlink'),
    cr('LTCUSDT', 'Litecoin'),
  ],
  forex: [
    ['EUR', 'USD'], ['GBP', 'USD'], ['USD', 'JPY'], ['USD', 'INR'], ['EUR', 'INR'],
    ['GBP', 'INR'], ['AUD', 'USD'], ['USD', 'CAD'], ['USD', 'CHF'], ['EUR', 'GBP'],
  ].map(([b, q]) => forex.makePair(b, q)),
};

export const symId = (s) => `${s.market}:${s.ticker}`;
export const marketOf = (s) => MARKETS[s.market];
export const ccyOf = (s) => (s.market === 'forex' ? s.quote : MARKETS[s.market].ccy);
export const timeframesOf = (s) => marketOf(s).provider.timeframes;

export function getCandles(sym, tf) {
  return marketOf(sym).provider.getCandles(sym, tf);
}

export function subscribeCandles(sym, tf, onBar, onStatus, lastBar) {
  return marketOf(sym).provider.subscribeCandles(sym, tf, onBar, onStatus, lastBar);
}

// ---------------------------------------------------------------------------
// Watchlists (persisted per market)

// Indian watchlists moved from Angel One to Zerodha symbols, so they use a new key.
const wlKey = (market) => (market === 'nse' || market === 'bse' ? `watch.kite.${market}` : `watch.${market}`);
export function getWatchlist(market) {
  return store.get(wlKey(market), DEFAULT_WATCHLISTS[market]);
}
export function setWatchlist(market, list) {
  store.set(wlKey(market), list);
}

/** True for a saved Indian symbol from before the switch to Zerodha. */
export const isStaleIndian = (s) => (s.market === 'nse' || s.market === 'bse') && s.src !== 'kite';

// ---------------------------------------------------------------------------
// Price hub: one live subscription per symbol, shared by every component.

class PriceHub extends Emitter {
  constructor() {
    super();
    this.prices = new Map(); // id -> {price, changePct, ts}
    this.owners = new Map(); // owner -> Map(id -> sym)
    this.subs = new Map(); // market -> {key, off}
  }
  get(id) { return this.prices.get(id); }

  /** Each owner declares the full set of symbols it needs; the hub keeps the union subscribed. */
  watch(owner, syms) {
    this.owners.set(owner, new Map(syms.map((s) => [symId(s), s])));
    clearTimeout(this.t);
    this.t = setTimeout(() => this.#resubscribe(), 30);
  }

  /** Let a component push a price it already has (e.g. the live candle). */
  push(sym, price, changePct) {
    const id = symId(sym);
    const prev = this.prices.get(id);
    const next = { price, changePct: changePct ?? prev?.changePct, ts: Date.now() };
    this.prices.set(id, next);
    this.emit('price', id, next, sym);
  }

  #resubscribe() {
    const byMarket = {};
    for (const m of this.owners.values()) for (const [id, s] of m) (byMarket[s.market] ??= new Map()).set(id, s);
    for (const market of Object.keys(MARKETS)) {
      const wanted = byMarket[market] ?? new Map();
      const key = [...wanted.keys()].sort().join(',');
      const cur = this.subs.get(market);
      if (cur?.key === key) continue;
      cur?.off();
      if (!wanted.size) { this.subs.delete(market); continue; }
      if (MARKETS[market].provider === kite && !kite.isConfigured()) { this.subs.delete(market); continue; }
      const off = MARKETS[market].provider.subscribeTickers([...wanted.values()], (sym, d) => {
        if (!isFinite(d.price)) return;
        const id = symId(sym);
        const prev = this.prices.get(id);
        const next = { price: d.price, changePct: d.changePct ?? prev?.changePct, ts: d.ts };
        this.prices.set(id, next);
        this.emit('price', id, next, sym);
      });
      this.subs.set(market, { key, off });
    }
  }

  refresh() {
    for (const s of this.subs.values()) s.off();
    this.subs.clear();
    this.#resubscribe();
  }
}

export const prices = new PriceHub();
