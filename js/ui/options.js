// Option chain: calls and puts by strike for NSE/BSE index and stock options,
// with OI, volume, IV and delta. Click a price to chart the contract; B/S place a
// one-lot paper order.
import { h, fill, store, fmtPrice, fmtPct, clsUpDown, toast } from '../util.js';
import { OPTION_UNDERLYINGS, optionExpiries, optionChain, optionSymbol, fmtExpiry } from '../data/upstox.js';
import { prices } from '../data/markets.js';
import { broker } from '../paper/broker.js';

const REFRESH_MS = 5000;

const compact = (n) => {
  if (!n) return '—';
  const a = Math.abs(n);
  if (a >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
  if (a >= 1e5) return (n / 1e5).toFixed(2) + 'L';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};

/** Strike at which option buyers' total payout is smallest. */
export function maxPain(rows) {
  let best = null;
  let bestLoss = Infinity;
  for (const { strike: k } of rows) {
    let loss = 0;
    for (const r of rows) {
      loss += (r.ce?.oi || 0) * Math.max(0, k - r.strike) + (r.pe?.oi || 0) * Math.max(0, r.strike - k);
    }
    if (loss < bestLoss) { bestLoss = loss; best = k; }
  }
  return best;
}

export function initOptions(app) {
  const root = document.querySelector('[data-panel="options"]');
  const saved = store.get('options', {});
  let underlying = OPTION_UNDERLYINGS.find((u) => u.key === saved.key) ?? OPTION_UNDERLYINGS[0];
  let expiries = [];
  let expiry = null;
  let lotSize = 1;
  let range = saved.range ?? 10;
  let chain = null;
  let timer = null;
  let loading = false;
  let seq = 0;

  const underlyingSel = h('select', { 'aria-label': 'Underlying' });
  const expirySel = h('select', { 'aria-label': 'Expiry' });
  const rangeSel = h('select', { 'aria-label': 'Strikes shown' },
    ...[[10, '±10 strikes'], [20, '±20 strikes'], [0, 'All strikes']].map(([v, l]) => h('option', { value: v, selected: v === range }, l)));
  const summary = h('div', { class: 'oc-summary' });
  const body = h('div', { class: 'oc-body' });

  function underlyingChoices() {
    const list = [...OPTION_UNDERLYINGS];
    const s = app.sym;
    if (s?.key && /^NSE_EQ\|/.test(s.key) && !list.some((u) => u.key === s.key)) {
      list.push({ label: s.ticker, key: s.key, exchange: 'NSE', stock: true });
    }
    if (!list.some((u) => u.key === underlying.key)) list.push(underlying);
    return list;
  }

  function renderUnderlyings() {
    const list = underlyingChoices();
    fill(underlyingSel, ...list.map((u) => h('option', { value: u.key, selected: u.key === underlying.key }, u.stock ? `${u.label} (stock)` : u.label)));
    underlyingSel.onchange = () => {
      underlying = list.find((u) => u.key === underlyingSel.value);
      store.set('options', { key: underlying.key, range });
      loadExpiries();
    };
  }

  async function loadExpiries() {
    const my = ++seq;
    chain = null;
    expiries = [];
    fill(expirySel);
    fill(body, h('div', { class: 'empty' }, 'Loading expiries…'));
    try {
      const r = await optionExpiries(underlying.key);
      if (my !== seq) return;
      expiries = r.expiries;
      lotSize = r.lotSize;
      if (!expiries.length) { fill(body, h('div', { class: 'empty' }, `No options are listed for ${underlying.label}.`)); return; }
      expiry = expiries[0];
      fill(expirySel, ...expiries.map((d) => h('option', { value: d }, fmtExpiry(d) + ' ' + d.slice(0, 4))));
      await loadChain();
    } catch (e) {
      if (my === seq) fill(body, h('div', { class: 'empty' }, e.message));
    }
  }

  async function loadChain(quiet = false) {
    if (!expiry || loading) return;
    const my = seq;
    loading = true;
    if (!quiet) fill(body, h('div', { class: 'empty' }, 'Loading option chain…'));
    try {
      const r = await optionChain(underlying.key, expiry);
      if (my !== seq) return;
      chain = r;
      render();
    } catch (e) {
      if (my === seq && !quiet) fill(body, h('div', { class: 'empty' }, e.message));
    } finally {
      loading = false;
    }
  }

  function contractSym(row, type) {
    const c = type === 'CE' ? row.ce : row.pe;
    const sym = optionSymbol(underlying, expiry, row.strike, type, c, lotSize);
    if (c.ltp) prices.push(sym, c.ltp, c.close ? ((c.ltp - c.close) / c.close) * 100 : undefined);
    return sym;
  }

  function trade(row, type, sideName) {
    const sym = contractSym(row, type);
    try {
      broker.placeOrder({ sym, side: sideName, qty: lotSize, note: `1 lot ${sym.ticker}` });
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function render() {
    const { spot, rows: all } = chain;
    if (!all.length) { fill(body, h('div', { class: 'empty' }, 'Upstox returned no strikes for this expiry.')); return; }
    const atmIdx = all.reduce((best, r, i) => (Math.abs(r.strike - spot) < Math.abs(all[best].strike - spot) ? i : best), 0);
    const rows = range ? all.slice(Math.max(0, atmIdx - range), atmIdx + range + 1) : all;

    const ceOi = all.reduce((s, r) => s + (r.ce?.oi || 0), 0);
    const peOi = all.reduce((s, r) => s + (r.pe?.oi || 0), 0);
    const maxOi = Math.max(1, ...rows.map((r) => Math.max(r.ce?.oi || 0, r.pe?.oi || 0)));

    fill(summary,
      h('span', {}, 'Spot ', h('b', {}, fmtPrice(spot))),
      h('span', {}, 'PCR ', h('b', {}, ceOi ? (peOi / ceOi).toFixed(2) : '—')),
      h('span', {}, 'Max pain ', h('b', {}, fmtPrice(maxPain(all), 0))),
      h('span', {}, 'Lot ', h('b', {}, lotSize)),
      h('span', { class: 'muted' }, `Updates every ${REFRESH_MS / 1000}s`));

    const cell = (row, type, field) => {
      const c = type === 'CE' ? row.ce : row.pe;
      if (!c) return h('td', { class: 'r muted' }, '—');
      switch (field) {
        case 'oi': return h('td', { class: `r oi${type === 'PE' ? ' pe' : ''}`, style: `--w:${Math.round((c.oi / maxOi) * 100)}%` }, compact(c.oi));
        case 'chgOi': return h('td', { class: `r ${clsUpDown(c.oi - c.prevOi)}` }, c.prevOi ? compact(c.oi - c.prevOi) : '—');
        case 'vol': return h('td', { class: 'r' }, compact(c.volume));
        case 'iv': return h('td', { class: 'r' }, c.iv ? c.iv.toFixed(1) : '—');
        case 'delta': return h('td', { class: 'r' }, c.delta ? c.delta.toFixed(2) : '—');
        case 'ltp': {
          const chg = c.close ? ((c.ltp - c.close) / c.close) * 100 : null;
          return h('td', { class: 'r ltp' },
            h('span', { class: 'trade' },
              h('button', { class: 'b', title: `Buy 1 lot (${lotSize})`, onclick: () => trade(row, type, 'buy') }, 'B'),
              h('button', { class: 's', title: `Sell 1 lot (${lotSize})`, onclick: () => trade(row, type, 'sell') }, 'S')),
            h('a', { href: '#', title: 'Open chart', onclick: (e) => { e.preventDefault(); app.setSymbol(contractSym(row, type)); } },
              h('b', {}, fmtPrice(c.ltp, 2))),
            chg != null ? h('div', { class: `chg ${clsUpDown(chg)}` }, fmtPct(chg, 1)) : null);
        }
      }
    };

    const ceCols = ['oi', 'chgOi', 'vol', 'iv', 'delta', 'ltp'];
    const peCols = ['ltp', 'delta', 'iv', 'vol', 'chgOi', 'oi'];
    const label = { oi: 'OI', chgOi: 'Chg OI', vol: 'Volume', iv: 'IV', delta: 'Delta', ltp: 'LTP' };

    fill(body, h('table', { class: 'grid oc' },
      h('thead', {},
        h('tr', {}, h('th', { colspan: 6, class: 'side' }, 'CALLS'), h('th', {}), h('th', { colspan: 6, class: 'side' }, 'PUTS')),
        h('tr', {}, ...ceCols.map((c) => h('th', { class: 'r' }, label[c])), h('th', { class: 'strike' }, 'Strike'), ...peCols.map((c) => h('th', { class: 'r' }, label[c])))),
      h('tbody', {}, ...rows.map((row) => h('tr', { class: row.strike === all[atmIdx].strike ? 'atm' : '' },
        ...ceCols.map((f) => { const td = cell(row, 'CE', f); if (row.strike < spot) td.classList.add('itm'); return td; }),
        h('td', { class: 'strike' }, fmtPrice(row.strike, row.strike % 1 ? 2 : 0)),
        ...peCols.map((f) => { const td = cell(row, 'PE', f); if (row.strike > spot) td.classList.add('itm'); return td; }),
      )))));

    if (!render.scrolled) {
      body.querySelector('tr.atm')?.scrollIntoView({ block: 'center' });
      render.scrolled = true;
    }
  }

  expirySel.onchange = () => { expiry = expirySel.value; render.scrolled = false; loadChain(); };
  rangeSel.onchange = () => { range = +rangeSel.value; store.set('options', { key: underlying.key, range }); render.scrolled = false; if (chain) render(); };

  fill(root,
    h('div', { class: 'st-row oc-bar' },
      h('label', { class: 'field' }, 'Underlying', underlyingSel),
      h('label', { class: 'field' }, 'Expiry', expirySel),
      h('label', { class: 'field' }, 'Show', rangeSel),
      summary),
    body);

  // Only load and refresh while the tab is open.
  let started = false;
  const visible = () => !root.hidden && !document.hidden && !document.getElementById('bottom').classList.contains('collapsed');
  function start() {
    renderUnderlyings();
    if (!started) { started = true; loadExpiries(); }
    clearInterval(timer);
    timer = setInterval(() => { if (visible()) loadChain(true); }, REFRESH_MS);
  }
  app.on('tab', (t) => { if (t === 'options') start(); else clearInterval(timer); });
  app.on('symbol', () => { if (started) renderUnderlyings(); });
}
