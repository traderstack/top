// App bootstrap: owns the selected symbol/timeframe and wires every panel together.
import { $, $$, h, store, Emitter, decimalsFor, fmtPrice, fmtPct, clsUpDown, toast, fill } from './util.js';
import { TIMEFRAMES } from './timeframes.js';
import { ChartView, INDICATORS } from './chart.js';
import { MARKETS, DEFAULT_WATCHLISTS, getCandles, subscribeCandles, prices, symId, timeframesOf, marketOf } from './data/markets.js';
import { isConfigured as angelConfigured } from './data/angel.js';
import { initWatchlist } from './ui/watchlist.js';
import { initSearch } from './ui/search.js';
import { initSettings } from './ui/settings.js';
import { initStrategy } from './ui/strategy.js';
import { initPaper } from './ui/paper.js';
import { initTicket } from './ui/ticket.js';
import { broker } from './paper/broker.js';

class App extends Emitter {
  constructor() {
    super();
    this.sym = store.get('symbol', DEFAULT_WATCHLISTS.crypto[0]);
    this.tf = store.get('tf', '1h');
    this.bars = [];
    this.loadSeq = 0;
    this.offLive = null;
  }

  setSymbol(sym) {
    this.sym = sym;
    store.set('symbol', sym);
    const tfs = timeframesOf(sym);
    if (!tfs.includes(this.tf)) this.tf = tfs.includes('1D') ? '1D' : tfs[0];
    this.load();
  }

  setTimeframe(tf) {
    this.tf = tf;
    store.set('tf', tf);
    this.load();
  }

  async load() {
    const seq = ++this.loadSeq;
    const sym = this.sym;
    const tf = this.tf;
    this.offLive?.();
    this.offLive = null;
    this.bars = [];
    renderHeader();
    this.emit('symbol', sym, tf);
    prices.watch('chart', [sym]);

    if ((sym.market === 'nse' || sym.market === 'bse') && !angelConfigured()) {
      showStatus(h('div', { class: 'card' },
        h('h3', {}, `Connect Angel One to see ${MARKETS[sym.market].label} data`),
        h('p', {}, 'NSE and BSE prices come from your Angel One SmartAPI account through your private backend. Add it in Settings. Crypto and forex work right away.'),
        h('button', { class: 'btn primary', onclick: () => this.emit('open-settings') }, 'Open settings')));
      chart.setData([]);
      return;
    }

    showStatus(h('div', { class: 'muted' }, 'Loading chart…'));
    try {
      const bars = await getCandles(sym, tf);
      if (seq !== this.loadSeq) return;
      this.bars = bars;
      if (!bars.length) {
        showStatus(h('div', { class: 'card' }, h('h3', {}, 'No data'), h('p', {}, 'The data source returned no candles for this symbol and timeframe.')));
      } else showStatus(null);
      const last = bars.at(-1)?.close ?? 0;
      chart.setPrecision(decimalsFor(last));
      chart.setData(bars, { tzOffset: sym.market === 'nse' || sym.market === 'bse' ? 19800 : 0 });
      if (last && !prices.get(symId(sym))) prices.push(sym, last);
      this.emit('bars', bars);
      this.offLive = subscribeCandles(sym, tf, (bar) => {
        if (seq !== this.loadSeq) return;
        chart.update(bar);
        const lastBar = this.bars.at(-1);
        if (lastBar && bar.time === lastBar.time) this.bars[this.bars.length - 1] = bar;
        else if (!lastBar || bar.time > lastBar.time) this.bars.push(bar);
        if (sym.market === 'crypto') prices.push(sym, bar.close);
      }, undefined, bars.at(-1));
    } catch (e) {
      if (seq !== this.loadSeq) return;
      console.error(e);
      chart.setData([]);
      showStatus(h('div', { class: 'card' },
        h('h3', {}, 'Could not load chart'),
        h('p', {}, e.message),
        h('button', { class: 'btn', onclick: () => this.load() }, 'Try again')));
    }
  }
}

const app = new App();
const chart = new ChartView($('#chartMain'), $('#chartPane'));
app.chart = chart;

function showStatus(node) {
  const el = $('#chartStatus');
  fill(el, ...(node ? [node] : []));
}

// ---------------------------------------------------------------------------
// Header: symbol, live quote, timeframe buttons, indicators, theme

function renderHeader() {
  $('#symbolName').textContent = app.sym.name || app.sym.ticker;
  $('#symbolMarket').textContent = `${MARKETS[app.sym.market].label} · ${app.sym.ticker}`;
  document.title = `${app.sym.name || app.sym.ticker} — TraderStack`;
  const tfs = timeframesOf(app.sym);
  fill($('#tfGroup'), ...TIMEFRAMES.map((t) => h('button', {
    class: t.id === app.tf ? 'active' : '',
    disabled: !tfs.includes(t.id),
    title: tfs.includes(t.id) ? `${t.label} candles` : `${marketOf(app.sym).label} data has no ${t.label} candles`,
    onclick: () => app.setTimeframe(t.id),
  }, t.label)));
  renderQuote();
}

function renderQuote() {
  const p = prices.get(symId(app.sym));
  const q = $('#headerQuote');
  if (!p) { fill(q, h('span', { class: 'muted' }, marketOf(app.sym).note)); return; }
  fill(q, 
    h('b', { class: clsUpDown(p.changePct) }, fmtPrice(p.price)),
    p.changePct != null ? h('span', { class: clsUpDown(p.changePct) }, fmtPct(p.changePct)) : null,
    h('span', { class: 'muted', title: marketOf(app.sym).note }, '●'),
  );
}
prices.on('price', (id) => { if (id === symId(app.sym)) renderQuote(); });

const savedInd = store.get('indicators', ['ema20', 'ema50']);
chart.setIndicators(savedInd);
fill($('#indicatorMenu'), ...INDICATORS.map((ind) => h('label', {},
  h('input', {
    type: 'checkbox', checked: savedInd.includes(ind.id),
    onchange: () => {
      const ids = $$('#indicatorMenu input').filter((i) => i.checked).map((i) => i.dataset.id);
      chart.setIndicators(ids);
      store.set('indicators', ids);
    },
    dataset: { id: ind.id },
  }), ind.label)));
$('#indicatorBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#indicatorMenu').hidden = !$('#indicatorMenu').hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) $('#indicatorMenu').hidden = true;
});

$('#themeBtn').addEventListener('click', () => {
  const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  chart.applyTheme();
  app.emit('theme');
});

// Bottom panel tabs
$$('.tabs [role=tab]').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tabs [role=tab]').forEach((t) => t.classList.toggle('active', t === tab));
  $$('.tab-body').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  $('#bottom').classList.remove('collapsed');
  app.emit('tab', tab.dataset.tab);
}));
$('#bottomToggle').addEventListener('click', () => {
  const c = $('#bottom').classList.toggle('collapsed');
  $('#bottomToggle').textContent = c ? '▴' : '▾';
});

$('#tradeBtn').addEventListener('click', () => $('#ticket').classList.toggle('show'));

broker.on('notice', (msg, kind) => toast(msg, kind));

// ---------------------------------------------------------------------------

initWatchlist(app);
initSearch(app);
initSettings(app);
initStrategy(app);
initPaper(app);
initTicket(app);

renderHeader();
app.load();
broker.resumeBots();

window.traderstack = app; // handy for debugging in the console
