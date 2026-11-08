// Paper-trading panels: accounts, positions, working orders, bots and history.
import { h, fmtMoney, fmtPrice, fmtPct, fmtQty, fmtTime, clsUpDown, fill } from '../util.js';
import { broker, accountFor } from '../paper/broker.js';
import { MARKETS, symId } from '../data/markets.js';

export function initPaper(app) {
  const paperEl = document.querySelector('[data-panel="paper"]');
  const botsEl = document.querySelector('[data-panel="bots"]');
  const historyEl = document.querySelector('[data-panel="history"]');

  const symLink = (sym) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.setSymbol(sym); } },
    h('b', {}, sym.name || sym.ticker), ' ', h('span', { class: 'muted' }, MARKETS[sym.market].label));

  function renderPaper() {
    const accts = Object.keys(broker.state.accounts).map((ccy) => {
      const e = broker.equity(ccy);
      const ret = ((e.equity - e.start) / e.start) * 100;
      return h('div', { class: 'acct' },
        h('h4', {}, ccy === 'INR' ? 'INR account · NSE / BSE' : 'USD account · Crypto / Forex'),
        h('div', { class: `big ${clsUpDown(ret)}` }, fmtMoney(e.equity, ccy)),
        h('div', { class: 'row' }, h('span', {}, 'Return'), h('span', { class: clsUpDown(ret) }, fmtPct(ret))),
        h('div', { class: 'row' }, h('span', {}, 'Cash'), h('span', {}, fmtMoney(e.cash, ccy))),
        h('div', { class: 'row' }, h('span', {}, 'Unrealized'), h('span', { class: clsUpDown(e.unrealized) }, fmtMoney(e.unrealized, ccy))),
        h('div', { class: 'row' }, h('span', {}, 'Realized'), h('span', { class: clsUpDown(e.realized) }, fmtMoney(e.realized, ccy))));
    });

    const positions = Object.entries(broker.state.positions);
    const posTable = positions.length
      ? h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ...['Symbol', 'Side', 'Qty', 'Avg price', 'Last', 'Value', 'Unrealized P&L', ''].map((c, i) => h('th', { class: i >= 2 && i <= 6 ? 'r' : '' }, c)))),
        h('tbody', {}, ...positions.map(([id, p]) => {
          const ccy = accountFor(p.sym);
          const last = broker.lastPrice(p.sym);
          const px = last ?? p.avgPrice;
          const upl = p.qty * (px - p.avgPrice);
          const uplPct = ((px - p.avgPrice) / p.avgPrice) * 100 * Math.sign(p.qty);
          return h('tr', {},
            h('td', {}, symLink(p.sym)),
            h('td', { class: p.qty > 0 ? 'up' : 'down' }, p.qty > 0 ? 'Long' : 'Short'),
            h('td', { class: 'r' }, fmtQty(Math.abs(p.qty))),
            h('td', { class: 'r' }, fmtPrice(p.avgPrice)),
            h('td', { class: 'r' }, last ? fmtPrice(last) : h('span', { class: 'muted' }, 'waiting')),
            h('td', { class: 'r' }, fmtMoney(Math.abs(p.qty) * px, ccy)),
            h('td', { class: `r ${clsUpDown(upl)}` }, `${fmtMoney(upl, ccy)} (${fmtPct(uplPct)})`),
            h('td', { class: 'r' }, h('button', { class: 'btn small', onclick: () => tryDo(() => broker.closePosition(id)) }, 'Close')));
        })))
      : h('div', { class: 'empty' }, 'No open positions. Use the order ticket on the right to place a paper trade.');

    const orders = broker.state.orders;
    const ordersTable = orders.length
      ? h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ...['Symbol', 'Side', 'Type', 'Qty', 'Price', 'Placed', ''].map((c, i) => h('th', { class: i >= 3 && i <= 4 ? 'r' : '' }, c)))),
        h('tbody', {}, ...orders.map((o) => h('tr', {},
          h('td', {}, symLink(o.sym)),
          h('td', { class: o.side === 'buy' ? 'up' : 'down' }, o.side.toUpperCase()),
          h('td', {}, o.type),
          h('td', { class: 'r' }, fmtQty(o.qty)),
          h('td', { class: 'r' }, fmtPrice(o.price)),
          h('td', { class: 'muted' }, fmtTime(o.created / 1000)),
          h('td', { class: 'r' }, h('button', { class: 'btn small', onclick: () => broker.cancelOrder(o.id) }, 'Cancel'))))))
      : h('div', { class: 'empty' }, 'No working orders.');

    fill(paperEl, 
      h('div', { class: 'acct-cards' }, ...accts),
      h('div', { class: 'section-title' }, `Positions (${positions.length})`), posTable,
      h('div', { class: 'section-title' }, `Working orders (${orders.length})`), ordersTable,
      h('p', { class: 'hint' }, 'Paper trades use live prices but fake money, and are saved in this browser. Orders only fill while this page is open.'),
    );
  }

  function renderBots() {
    const bots = broker.state.bots;
    fill(botsEl, 
      h('p', { class: 'hint', style: 'margin:0 0 10px' }, 'A strategy bot runs a strategy on live candles and trades it in your paper account. Start one from the Strategy tester with "Paper trade this strategy". Bots run while this page is open and resume when you come back.'),
      bots.length ? h('div', { class: 'bots' }, ...bots.map((b) => {
        const running = broker.botRuntimes.has(b.id);
        const trades = broker.state.history.filter((t) => t.botId === b.id);
        const pnl = trades.reduce((s, t) => s + t.pnl - t.fee, 0);
        const ccy = accountFor(b.sym);
        return h('div', { class: 'bot' },
          h('div', { class: 'bot-head' },
            h('span', { class: `dot${running ? ' on' : ''}`, title: running ? 'Running' : 'Stopped' }),
            h('b', {}, b.name),
            running
              ? h('button', { class: 'btn small', onclick: () => broker.stopBot(b.id) }, 'Stop')
              : h('button', { class: 'btn small', onclick: () => broker.startBot(b.id) }, 'Start'),
            h('button', { class: 'btn small ghost', onclick: () => { if (confirm(`Delete bot "${b.name}"?`)) broker.removeBot(b.id); } }, 'Delete')),
          h('div', { class: 'kv' }, h('span', {}, symLink(b.sym)), h('b', {}, b.tf)),
          h('div', { class: 'kv' }, h('span', {}, 'Size per trade'), h('b', {}, `${b.sizePct}% of equity`)),
          h('div', { class: 'kv' }, h('span', {}, 'Params'), h('b', {}, Object.entries(b.params).map(([k, v]) => `${k}=${v}`).join(', ') || '—')),
          h('div', { class: 'kv' }, h('span', {}, `Fills: ${trades.length}`), h('b', { class: clsUpDown(pnl) }, `Realized ${fmtMoney(pnl, ccy)}`)),
          h('div', { class: 'bot-log' }, ...(b.log ?? []).map((l) => h('div', {}, `${new Date(l.t).toLocaleTimeString('en-IN')} ${l.msg}`))));
      })) : h('div', { class: 'empty' }, 'No strategy bots yet.'),
    );
  }

  function renderHistory() {
    const hist = broker.state.history;
    fill(historyEl, hist.length
      ? h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ...['Time', 'Symbol', 'Side', 'Qty', 'Price', 'Fee', 'Realized P&L', 'Note'].map((c, i) => h('th', { class: i >= 3 && i <= 6 ? 'r' : '' }, c)))),
        h('tbody', {}, ...hist.map((t) => {
          const ccy = accountFor(t.sym);
          return h('tr', {},
            h('td', { class: 'muted' }, fmtTime(t.time / 1000)),
            h('td', {}, symLink(t.sym)),
            h('td', { class: t.side === 'buy' ? 'up' : 'down' }, t.side.toUpperCase()),
            h('td', { class: 'r' }, fmtQty(t.qty)),
            h('td', { class: 'r' }, fmtPrice(t.price)),
            h('td', { class: 'r muted' }, fmtMoney(t.fee, ccy)),
            h('td', { class: `r ${clsUpDown(t.pnl)}` }, t.pnl ? fmtMoney(t.pnl, ccy) : '—'),
            h('td', { class: 'muted' }, t.note || ''));
        })))
      : h('div', { class: 'empty' }, 'No paper trades yet.'));
  }

  function tryDo(fn) {
    try { fn(); } catch (e) { broker.emit('notice', e.message, 'error'); }
  }

  function renderAll() {
    renderPaper(); renderBots(); renderHistory();
    updateChartLines();
  }

  function updateChartLines() {
    const id = symId(app.sym);
    const lines = [];
    const p = broker.state.positions[id];
    if (p) lines.push({ price: p.avgPrice, title: `${p.qty > 0 ? 'Long' : 'Short'} ${fmtQty(Math.abs(p.qty))}`, kind: 'position' });
    for (const o of broker.state.orders) {
      if (symId(o.sym) === id) lines.push({ price: o.price, title: `${o.side} ${o.type} ${fmtQty(o.qty)}`, kind: 'order' });
    }
    app.chart.setPriceLines(lines);
  }

  // Re-render live P&L at most twice a second.
  let pending = false;
  broker.on('tick', () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; if (!paperEl.hidden) renderPaper(); }, 500);
  });
  broker.on('change', renderAll);
  app.on('symbol', updateChartLines);
  app.on('tab', (t) => { if (t === 'paper') renderPaper(); if (t === 'bots') renderBots(); });
  renderAll();
}
