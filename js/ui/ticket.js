// Right sidebar: paper order ticket for the symbol on the chart.
import { $, h, fmtMoney, fmtPrice, fmtQty, fill } from '../util.js';
import { broker, accountFor } from '../paper/broker.js';
import { prices, symId, marketOf, ccyOf } from '../data/markets.js';

export function initTicket(app) {
  const root = $('#ticket');
  let side = 'buy';
  let type = 'market';
  let qtyVal = '';
  let priceVal = '';

  function render() {
    const sym = app.sym;
    const ccy = accountFor(sym);
    const last = prices.get(symId(sym))?.price;
    const pos = broker.state.positions[symId(sym)];

    if (!ccy) {
      fill(root, h('h3', {}, 'Paper order'), h('p', { class: 'hint' }, `Paper trading supports INR and USD-quoted symbols. ${sym.ticker} is quoted in ${ccyOf(sym)}.`));
      return;
    }
    const acct = broker.equity(ccy);
    const lot = sym.lot > 1 ? sym.lot : 0;
    const qty = h('input', { type: 'number', min: 0, step: lot || (marketOf(sym).intQty ? 1 : 'any'), value: qtyVal, placeholder: lot ? `Multiple of ${lot} (1 lot)` : marketOf(sym).intQty ? 'Shares' : 'Units', oninput: () => { qtyVal = qty.value; renderCost(); } });
    const price = h('input', { type: 'number', min: 0, step: 'any', value: priceVal, placeholder: last ? fmtPrice(last).replace(/,/g, '') : 'Price', oninput: () => { priceVal = price.value; renderCost(); } });
    const cost = h('b', {}, '—');
    const renderCost = () => {
      const p = type === 'market' ? last : +priceVal;
      cost.textContent = p && +qtyVal ? fmtMoney(p * +qtyVal, ccy) : '—';
    };

    const pctBtn = (pct) => h('button', {
      onclick: () => {
        const p = type === 'market' ? last : +priceVal || last;
        if (!p) return;
        let q = (acct.equity * pct / 100) / p;
        q = lot ? Math.floor(q / lot) * lot : marketOf(sym).intQty ? Math.floor(q) : Math.floor(q * 1e6) / 1e6;
        qtyVal = String(q);
        render();
      },
    }, `${pct}%`);

    const submit = () => {
      try {
        broker.placeOrder({ sym, side, type, qty: +qtyVal, price: type === 'market' ? undefined : +priceVal });
        if (type !== 'market') broker.emit('notice', `${type} ${side} order placed for ${qtyVal} ${sym.ticker}`, 'ok');
      } catch (e) {
        broker.emit('notice', e.message, 'error');
      }
    };

    fill(root, 
      h('h3', {}, 'Paper order'),
      h('div', { class: 'kv' }, h('span', {}, sym.name || sym.ticker), h('b', {}, last ? fmtPrice(last) : 'waiting for price')),
      h('div', { class: 'side-toggle' },
        h('button', { class: `buy${side === 'buy' ? ' on' : ''}`, onclick: () => { side = 'buy'; render(); } }, 'Buy'),
        h('button', { class: `sell${side === 'sell' ? ' on' : ''}`, onclick: () => { side = 'sell'; render(); } }, 'Sell')),
      h('div', { class: 'seg' }, ...['market', 'limit', 'stop'].map((t) => h('button', { class: t === type ? 'on' : '', onclick: () => { type = t; render(); } }, t[0].toUpperCase() + t.slice(1)))),
      type !== 'market' ? h('label', { class: 'field' }, type === 'limit' ? 'Limit price' : 'Stop (trigger) price', price) : null,
      h('label', { class: 'field' }, lot ? `Quantity (lot size ${lot})` : 'Quantity', qty),
      lot ? h('div', { class: 'seg' }, ...[1, 2, 5, 10].map((n) => h('button', { onclick: () => { qtyVal = String(n * lot); render(); } }, `${n} lot${n > 1 ? 's' : ''}`))) : null,
      h('div', { class: 'seg' }, pctBtn(10), pctBtn(25), pctBtn(50), pctBtn(100)),
      h('div', { class: 'kv' }, h('span', {}, 'Order value'), cost),
      h('button', { class: `btn ${side}`, onclick: submit }, `${side === 'buy' ? 'Buy' : 'Sell'} ${sym.ticker}`),
      h('div', { class: 'section-title' }, `${ccy} paper account`),
      h('div', { class: 'kv' }, h('span', {}, 'Equity'), h('b', {}, fmtMoney(acct.equity, ccy))),
      h('div', { class: 'kv' }, h('span', {}, 'Cash'), h('b', {}, fmtMoney(acct.cash, ccy))),
      pos ? h('div', { class: 'kv' }, h('span', {}, 'Position'), h('b', { class: pos.qty > 0 ? 'up' : 'down' }, `${pos.qty > 0 ? 'Long' : 'Short'} ${fmtQty(Math.abs(pos.qty))} @ ${fmtPrice(pos.avgPrice)}`)) : null,
      pos ? h('button', { class: 'btn', onclick: () => { try { broker.closePosition(symId(sym)); } catch (e) { broker.emit('notice', e.message, 'error'); } } }, 'Close position') : null,
      h('p', { class: 'hint' }, 'Fake money, live prices. Market orders fill at the last price; limit and stop orders fill when the live price crosses them.'),
    );
    renderCost();
  }

  // Only re-render when the price changes and the user isn't typing in the ticket.
  let timer = null;
  prices.on('price', (id) => {
    if (id !== symId(app.sym) || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
      render();
    }, 1000);
  });
  broker.on('change', render);
  app.on('symbol', () => { qtyVal = ''; priceVal = ''; render(); });
  render();
}
