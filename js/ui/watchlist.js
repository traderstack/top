// Left sidebar: market tabs and a live watchlist per market.
import { $, h, store, fmtPrice, fmtPct, clsUpDown, fill } from '../util.js';
import { MARKETS, getWatchlist, setWatchlist, prices, symId } from '../data/markets.js';
import { isConfigured as upstoxConfigured, status as upstoxStatus, LOGIN_URL } from '../data/upstox.js';

export function initWatchlist(app) {
  const root = $('#watchlist');
  let market = store.get('wlMarket', app.sym.market);
  const rows = new Map(); // id -> {price, change}

  function render() {
    const list = getWatchlist(market);
    rows.clear();
    const indian = market === 'nse' || market === 'bse';
    const needsKey = indian && !upstoxConfigured();
    const needsLogin = indian && !needsKey && upstoxStatus.needsLogin;
    fill(root, 
      h('div', { class: 'wl-tabs', role: 'tablist' }, ...Object.values(MARKETS).map((m) => h('button', {
        role: 'tab', class: m.id === market ? 'active' : '',
        onclick: () => { market = m.id; store.set('wlMarket', market); render(); },
      }, m.label))),
      h('div', { class: 'wl-note' },
        h('span', {}, needsKey ? 'Not connected' : needsLogin ? 'Upstox session ended' : MARKETS[market].note),
        h('button', { class: 'btn small', onclick: () => app.emit('open-search', market) }, '+ Add')),
      needsKey
        ? h('div', { class: 'wl-note' }, h('button', { class: 'btn small primary', onclick: () => app.emit('open-settings') }, 'Connect Upstox'))
        : null,
      needsLogin
        ? h('div', { class: 'wl-note' }, h('a', { class: 'btn small primary', href: LOGIN_URL }, 'Log in with Upstox'))
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
  app.on('broker-config', () => { render(); prices.refresh(); });
  upstoxStatus.on('change', render);
  render();
}
