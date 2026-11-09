// Paper-trading broker: virtual cash, positions, market/limit/stop orders and
// strategy bots. State is saved in this browser's localStorage.
import { Emitter, store, uid, fmtPrice, fmtQty } from '../util.js';
import { prices, symId, ccyOf, marketOf, getCandles, subscribeCandles } from '../data/markets.js';
import { compileStrategy } from '../backtest/engine.js';

const START_CASH = { INR: 1000000, USD: 100000 };

function freshState() {
  return {
    accounts: Object.fromEntries(Object.entries(START_CASH).map(([c, v]) => [c, { cash: v, start: v, realized: 0 }])),
    positions: {}, // id -> {sym, qty (signed), avgPrice, realized}
    orders: [], // pending: {id, sym, side, type, qty, price, created, botId}
    history: [], // fills: {id, sym, side, qty, price, fee, time, pnl, botId, note}
    bots: [], // {id, name, sym, tf, code, params, sizePct, running, lastSignal, created}
    commissionPct: 0.03,
  };
}

/** Which account a symbol trades in. Only INR and USD accounts exist. */
export function accountFor(sym) {
  const c = ccyOf(sym);
  return c === 'INR' ? 'INR' : c === 'USD' || c === 'USDT' ? 'USD' : null;
}

class PaperBroker extends Emitter {
  constructor() {
    super();
    this.state = store.get('paper', null) ?? freshState();
    this.botRuntimes = new Map();
    prices.on('price', (id, p) => this.#onPrice(id, p.price));
    this.#watch();
  }

  save() {
    store.set('paper', this.state);
    this.#watch();
    this.emit('change');
  }

  reset() {
    for (const id of this.botRuntimes.keys()) this.stopBot(id, false);
    this.state = freshState();
    this.save();
  }

  setCommission(pct) { this.state.commissionPct = Math.max(0, +pct || 0); this.save(); }

  /** Keep live prices flowing for every symbol with a position or working order. */
  #watch() {
    const syms = new Map();
    for (const p of Object.values(this.state.positions)) syms.set(symId(p.sym), p.sym);
    for (const o of this.state.orders) syms.set(symId(o.sym), o.sym);
    prices.watch('paper', [...syms.values()]);
  }

  lastPrice(sym) { return prices.get(symId(sym))?.price; }

  equity(ccy) {
    const a = this.state.accounts[ccy];
    let value = a.cash;
    let unrealized = 0;
    for (const p of Object.values(this.state.positions)) {
      if (accountFor(p.sym) !== ccy) continue;
      const px = this.lastPrice(p.sym) ?? p.avgPrice;
      value += p.qty * px;
      unrealized += p.qty * (px - p.avgPrice);
    }
    return { cash: a.cash, equity: value, unrealized, realized: a.realized, start: a.start };
  }

  /** Place an order. side: 'buy'|'sell'; type: 'market'|'limit'|'stop'. */
  placeOrder({ sym, side, type = 'market', qty, price, botId, note }) {
    qty = +qty;
    if (!(qty > 0)) throw new Error('Enter a quantity above zero.');
    if (marketOf(sym).intQty && !Number.isInteger(qty)) throw new Error('Stocks trade in whole shares.');
    if (sym.lot > 1 && qty % sym.lot !== 0) throw new Error(`${sym.ticker} trades in lots of ${sym.lot}. Use a multiple of ${sym.lot}.`);
    const ccy = accountFor(sym);
    if (!ccy) throw new Error(`Paper trading supports INR and USD-quoted symbols; ${sym.ticker} is quoted in ${ccyOf(sym)}.`);
    if (type !== 'market' && !(+price > 0)) throw new Error('Enter a price for limit and stop orders.');

    if (type === 'market') {
      const px = this.lastPrice(sym);
      if (!px) throw new Error('No live price yet for this symbol. Wait for a quote, or use a limit order.');
      this.#fill({ sym, side, qty, price: px, botId, note });
    } else {
      this.state.orders.push({ id: uid(), sym, side, type, qty, price: +price, created: Date.now(), botId });
      this.save();
      const px = this.lastPrice(sym);
      if (px) this.#onPrice(symId(sym), px);
    }
  }

  cancelOrder(id) {
    this.state.orders = this.state.orders.filter((o) => o.id !== id);
    this.save();
  }

  closePosition(id) {
    const p = this.state.positions[id];
    if (!p) return;
    this.placeOrder({ sym: p.sym, side: p.qty > 0 ? 'sell' : 'buy', qty: Math.abs(p.qty), note: 'Close' });
  }

  #onPrice(id, px) {
    let filled = false;
    for (const o of [...this.state.orders]) {
      if (symId(o.sym) !== id) continue;
      const hit = o.type === 'limit'
        ? (o.side === 'buy' ? px <= o.price : px >= o.price)
        : (o.side === 'buy' ? px >= o.price : px <= o.price);
      if (!hit) continue;
      this.state.orders = this.state.orders.filter((x) => x.id !== o.id);
      try {
        // Limit orders fill at the limit price or better; stops fill at market.
        const fillPx = o.type === 'limit' ? (o.side === 'buy' ? Math.min(px, o.price) : Math.max(px, o.price)) : px;
        this.#fill({ sym: o.sym, side: o.side, qty: o.qty, price: fillPx, botId: o.botId, note: `${o.type} order`, silent: true });
        filled = true;
      } catch (e) {
        this.emit('notice', `Order for ${o.sym.ticker} rejected: ${e.message}`, 'error');
      }
    }
    if (filled) this.save();
    else if (this.state.positions[id]) this.emit('tick', id);
  }

  #fill({ sym, side, qty, price, botId, note, silent }) {
    const ccy = accountFor(sym);
    const acct = this.state.accounts[ccy];
    const id = symId(sym);
    const dir = side === 'buy' ? 1 : -1;
    const fee = qty * price * (this.state.commissionPct / 100);
    const pos = this.state.positions[id] ?? { sym, qty: 0, avgPrice: 0, realized: 0 };

    // Buying power: new exposure may not exceed account equity (no leverage).
    const newQty = pos.qty + dir * qty;
    const added = Math.max(0, Math.abs(newQty) - Math.abs(pos.qty));
    if (added > 0) {
      const { equity } = this.equity(ccy);
      let exposure = 0;
      for (const p of Object.values(this.state.positions)) {
        if (accountFor(p.sym) === ccy && symId(p.sym) !== id) exposure += Math.abs(p.qty) * (this.lastPrice(p.sym) ?? p.avgPrice);
      }
      if (exposure + Math.abs(newQty) * price + fee > equity * 1.0000001) {
        throw new Error(`Not enough buying power in your ${ccy} account.`);
      }
    }

    let pnl = 0;
    if (pos.qty !== 0 && Math.sign(pos.qty) !== dir) {
      const closing = Math.min(qty, Math.abs(pos.qty));
      pnl = closing * (price - pos.avgPrice) * Math.sign(pos.qty);
    }
    if (newQty === 0) {
      pos.avgPrice = 0;
    } else if (pos.qty === 0 || Math.sign(pos.qty) === dir) {
      pos.avgPrice = (Math.abs(pos.qty) * pos.avgPrice + qty * price) / Math.abs(newQty);
    } else if (Math.sign(newQty) !== Math.sign(pos.qty)) {
      pos.avgPrice = price; // flipped through zero
    }
    pos.qty = Math.round(newQty * 1e8) / 1e8;
    pos.realized += pnl - fee;
    acct.cash -= dir * qty * price + fee;
    acct.realized += pnl - fee;

    if (pos.qty === 0) delete this.state.positions[id];
    else this.state.positions[id] = pos;

    this.state.history.unshift({ id: uid(), sym, side, qty, price, fee, pnl, time: Date.now(), botId, note });
    this.state.history = this.state.history.slice(0, 500);
    this.save();
    this.emit('notice', `${silent ? 'Order filled: ' : ''}${side === 'buy' ? 'Bought' : 'Sold'} ${fmtQty(qty)} ${sym.ticker} @ ${fmtPrice(price)}`, 'ok');
  }

  // -------------------------------------------------------------------------
  // Strategy bots: run a strategy on live bars and trade it on paper.

  addBot({ name, sym, tf, code, params, sizePct }) {
    const bot = { id: uid(), name, sym, tf, code, params, sizePct: +sizePct || 20, running: false, lastSignal: null, created: Date.now(), log: [] };
    compileStrategy(code); // validate
    this.state.bots.push(bot);
    this.save();
    this.startBot(bot.id);
    return bot;
  }

  removeBot(id) {
    this.stopBot(id, false);
    this.state.bots = this.state.bots.filter((b) => b.id !== id);
    this.save();
  }

  #botLog(bot, msg) {
    bot.log = [{ t: Date.now(), msg }, ...(bot.log ?? [])].slice(0, 30);
  }

  async startBot(id) {
    const bot = this.state.bots.find((b) => b.id === id);
    if (!bot || this.botRuntimes.has(id)) return;
    bot.running = true;
    this.#botLog(bot, 'Started');
    this.save();
    const rt = { bars: [], off: null };
    this.botRuntimes.set(id, rt);
    try {
      const strat = compileStrategy(bot.code);
      rt.bars = await getCandles(bot.sym, bot.tf);
      if (!this.botRuntimes.has(id)) return;
      const evaluate = () => {
        const fn = strat.build(rt.bars, bot.params);
        // Evaluate on the last CLOSED bar.
        const sig = fn(rt.bars.length - 1);
        if (sig == null) return;
        this.#botAct(bot, sig);
      };
      rt.off = subscribeCandles(bot.sym, bot.tf, (bar) => {
        const last = rt.bars.at(-1);
        if (last && bar.time > last.time) {
          // A new bar started: the previous one is final.
          evaluate();
          rt.bars.push(bar);
        } else if (last && bar.time === last.time) {
          rt.bars[rt.bars.length - 1] = bar;
        }
        if (bar.closed) { /* evaluated when the next bar opens */ }
      }, undefined, rt.bars.at(-1));
      // Make sure the bot's symbol keeps a live price for market fills.
      prices.watch(`bot:${id}`, [bot.sym]);
      this.#botLog(bot, `Loaded ${rt.bars.length} bars; waiting for the next ${bot.tf} bar to close`);
      this.save();
    } catch (e) {
      this.#botLog(bot, `Error: ${e.message}`);
      this.stopBot(id);
      this.emit('notice', `Bot "${bot.name}" stopped: ${e.message}`, 'error');
    }
  }

  #botAct(bot, sig) {
    const map = { long: 1, short: -1, flat: 0 };
    const target = map[sig];
    if (target === undefined) return;
    const id = symId(bot.sym);
    const pos = this.state.positions[id];
    const cur = Math.sign(pos?.qty ?? 0);
    if (cur === target) return;
    bot.lastSignal = sig;
    try {
      if (pos && cur !== 0) {
        this.placeOrder({ sym: bot.sym, side: cur > 0 ? 'sell' : 'buy', qty: Math.abs(pos.qty), botId: bot.id, note: `Bot ${bot.name}: exit` });
      }
      if (target !== 0) {
        const px = this.lastPrice(bot.sym);
        const ccy = accountFor(bot.sym);
        const { equity } = this.equity(ccy);
        let qty = (equity * bot.sizePct / 100) / px;
        qty = bot.sym.lot > 1 ? Math.floor(qty / bot.sym.lot) * bot.sym.lot : marketOf(bot.sym).intQty ? Math.floor(qty) : Math.floor(qty * 1e6) / 1e6;
        if (qty > 0) {
          this.placeOrder({ sym: bot.sym, side: target > 0 ? 'buy' : 'sell', qty, botId: bot.id, note: `Bot ${bot.name}: ${sig}` });
        }
      }
      this.#botLog(bot, `Signal ${sig}`);
    } catch (e) {
      this.#botLog(bot, `Order failed: ${e.message}`);
      this.emit('notice', `Bot "${bot.name}": ${e.message}`, 'error');
    }
    this.save();
  }

  stopBot(id, persist = true) {
    const rt = this.botRuntimes.get(id);
    rt?.off?.();
    this.botRuntimes.delete(id);
    prices.watch(`bot:${id}`, []);
    const bot = this.state.bots.find((b) => b.id === id);
    if (bot && persist) {
      bot.running = false;
      this.#botLog(bot, 'Stopped');
      this.save();
    }
  }

  /** Restart bots that were running when the page was last open. */
  resumeBots() {
    for (const b of this.state.bots) if (b.running) { b.running = false; this.startBot(b.id); }
  }
}

export const broker = new PaperBroker();
