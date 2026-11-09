// Symbol search dialog across all markets.
import { $, h, debounce, fill } from '../util.js';
import { MARKETS, getWatchlist, setWatchlist, symId } from '../data/markets.js';

export function initSearch(app) {
  const dlg = $('#searchDialog');
  let market = app.sym.market;
  let results = [];
  let sel = 0;
  let seq = 0;

  const input = h('input', { class: 'q', placeholder: 'Search symbol, e.g. RELIANCE, BTC, EURUSD', 'aria-label': 'Search symbols', autocomplete: 'off' });
  const chips = h('div', { class: 'chips' });
  const list = h('div', { class: 'search-results', role: 'listbox' });
  dlg.append(h('div', { class: 'd-body' }, input, chips, list));

  function renderChips() {
    fill(chips, ...Object.values(MARKETS).map((m) => h('button', {
      class: m.id === market ? 'on' : '',
      onclick: () => { market = m.id; renderChips(); run(); input.focus(); },
    }, m.label)));
  }

  // Move the highlight without rebuilding rows, so a click always lands on the row it started on.
  function highlight(i) {
    sel = i;
    [...list.children].forEach((row, j) => row.classList.toggle('sel', j === sel));
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  }

  function renderResults(msg) {
    if (msg) { fill(list, h('div', { class: 'empty' }, msg)); return; }
    fill(list, ...results.map((s, i) => h('div', {
      class: `r${i === sel ? ' sel' : ''}`, role: 'option',
      onclick: () => choose(s),
      onmouseenter: () => highlight(i),
    }, h('div', {}, h('b', {}, s.name || s.ticker), ' ', h('span', { class: 'm' }, s.desc && s.desc !== s.name ? s.desc : s.ticker)),
    h('span', { class: 'm' }, MARKETS[s.market].label))));
  }

  const run = debounce(async () => {
    const q = input.value;
    const my = ++seq;
    if (!q.trim()) {
      results = getWatchlist(market);
      sel = 0;
      renderResults(results.length ? null : 'Type to search');
      return;
    }
    renderResults('Searching…');
    try {
      const r = await MARKETS[market].search(q);
      if (my !== seq) return;
      results = r;
      sel = 0;
      renderResults(r.length ? null : 'No matches');
    } catch (e) {
      if (my === seq) renderResults(e.message);
    }
  }, 250);

  function choose(s) {
    const wl = getWatchlist(s.market);
    if (!wl.some((x) => symId(x) === symId(s))) {
      setWatchlist(s.market, [...wl, s]);
      app.emit('watchlist-changed');
    }
    dlg.close();
    app.setSymbol(s);
  }

  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { highlight(Math.min(results.length - 1, sel + 1)); e.preventDefault(); }
    if (e.key === 'ArrowUp') { highlight(Math.max(0, sel - 1)); e.preventDefault(); }
    if (e.key === 'Enter' && results[sel]) choose(results[sel]);
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  function open(m) {
    market = m || app.sym.market;
    input.value = '';
    renderChips();
    run();
    dlg.showModal();
    input.focus();
  }

  $('#symbolBtn').addEventListener('click', () => open());
  app.on('open-search', open);
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select') && !dlg.open) { e.preventDefault(); open(); }
  });
}
