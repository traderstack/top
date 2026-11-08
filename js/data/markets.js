// Market registry: routes every symbol to its data provider and keeps live prices.
import * as binance from './binance.js';
import * as forex from './forex.js';
import * as angel from './angel.js';
import { Emitter, store } from '../util.js';

export const MARKETS = {
  nse: {
    id: 'nse', label: 'NSE', ccy: 'INR', provider: angel, intQty: true,
    align: angel.align, search: (q) => angel.search(q, 'NSE'),
    note: 'Live via Angel One SmartAPI',
  },
  bse: {
    id: 'bse', label: 'BSE', ccy: 'INR', provider: angel, intQty: true,
    align: angel.align, search: (q) => angel.search(q, 'BSE'),
    note: 'Live via Angel One SmartAPI',
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

const nse = (ticker, token, name) => ({ market: 'nse', ticker, token, exchange: 'NSE', name: name ?? ticker.replace(/-EQ$/, '') });
const bse = (ticker, token, name) => ({ market: 'bse', ticker, token, exchange: 'BSE', name: name ?? ticker });
const cr = (ticker, name) => ({ market: 'crypto', ticker, name, quote: 'USDT' });

export const DEFAULT_WATCHLISTS = {
  nse: [
    nse('Nifty 50', '99926000', 'NIFTY 50'),
    nse('Nifty Bank', '99926009', 'NIFTY BANK'),
    nse('RELIANCE-EQ', '2885'),
    nse('HDFCBANK-EQ', '1333'),
    nse('ICICIBANK-EQ', '4963'),
    nse('INFY-EQ', '1594'),
    nse('TCS-EQ', '11536'),
    nse('SBIN-EQ', '3045'),
    nse('ITC-EQ', '1660'),
    nse('LT-EQ', '11483'),
    nse('BHARTIARTL-EQ', '10604'),
  ],
  bse: [
    bse('SENSEX', '99919000', 'SENSEX'),
    bse('RELIANCE', '500325'),
    bse('HDFCBANK', '500180'),
    bse('ICICIBANK', '532174'),
    bse('INFY', '500209'),
    bse('TCS', '532540'),
    bse('SBIN', '500112'),
  ],
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

export function getWatchlist(market) {
  return store.get(`watch.${market}`, DEFAULT_WATCHLISTS[market]);
}
export function setWatchlist(market, list) {
  store.set(`watch.${market}`, list);
}

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
      if (MARKETS[market].provider === angel && !angel.isConfigured()) { this.subs.delete(market); continue; }
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
