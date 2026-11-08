// Left sidebar: market tabs and a live watchlist per market.
import { $, h, store, fmtPrice, fmtPct, clsUpDown, fill } from '../util.js';
import { MARKETS, getWatchlist, setWatchlist, prices, symId } from '../data/markets.js';
import { isConfigured as angelConfigured } from '../data/angel.js';

export function initWatchlist(app) {
  const root = $('#watchlist');
  let market = store.get('wlMarket', app.sym.market);
  const rows = new Map(); // id -> {price, change}

  function render() {
    const list = getWatchlist(market);
    rows.clear();
    const needsAngel = (market === 'nse' || market === 'bse') && !angelConfigured();
    fill(root, 
      h('div', { class: 'wl-tabs', role: 'tablist' }, ...Object.values(MARKETS).map((m) => h('button', {
        role: 'tab', class: m.id === market ? 'active' : '',
        onclick: () => { market = m.id; store.set('wlMarket', market); render(); },
      }, m.label))),
      h('div', { class: 'wl-note' },
        h('span', {}, needsAngel ? 'Not connected' : MARKETS[market].note),
        h('button', { class: 'btn small', onclick: () => app.emit('open-search', market) }, '+ Add')),
      needsAngel
        ? h('div', { class: 'wl-note' }, h('button', { class: 'btn small primary', onclick: () => app.emit('open-settings') }, 'Connect Angel One'))
        : null,
      ...list.map((s) => {
        const id = symId(s);
        const p = prices.get(id);
        const price = h('div', { class: 'p' }, p ? fmtPrice(p.price) : '—');
        const change = h('div', { class: `c ${clsUpDown(p?.changePct)}` }, p ? fmtPct(p.changePct) : '');
        const row = h('div', {
          class: `wl-row${id === symId(app.sym) ? ' active' : ''}`,
          tabindex: 0,
          dataset: { id },
          onclick: () => app.setSymbol(s),
          onkeydown: (e) => { if (e.key === 'Enter') app.setSymbol(s); },
        },
        h('div', { class: 't' }, s.name || s.ticker), price,
        h('div', { class: 'n' }, s.ticker), change,
        h('button', {
          class: 'rm', title: 'Remove from watchlist', 'aria-label': `Remove ${s.ticker}`,
          onclick: (e) => {
            e.stopPropagation();
            setWatchlist(market, getWatchlist(market).filter((x) => symId(x) !== id));
            render();
          },
        }, '✕'));
        rows.set(id, { row, price, change, last: p?.price });
        return row;
      }),
    );
    prices.watch('watchlist', list);
  }

  prices.on('price', (id, p) => {
    const r = rows.get(id);
    if (!r) return;
    r.price.textContent = fmtPrice(p.price);
    if (p.changePct != null) {
      r.change.textContent = fmtPct(p.changePct);
      r.change.className = `c ${clsUpDown(p.changePct)}`;
    }
    if (r.last != null && p.price !== r.last) {
      r.row.classList.remove('flash-up', 'flash-down');
      void r.row.offsetWidth;
      r.row.classList.add(p.price > r.last ? 'flash-up' : 'flash-down');
    }
    r.last = p.price;
  });

  app.on('symbol', (sym) => {
    if (sym.market !== market) { market = sym.market; store.set('wlMarket', market); render(); return; }
    for (const [id, r] of rows) r.row.classList.toggle('active', id === symId(sym));
  });
  app.on('watchlist-changed', render);
  app.on('angel-config', () => { render(); prices.refresh(); });
  render();
}
