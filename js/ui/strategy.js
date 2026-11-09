// Strategy tester: edit strategy code, set parameters, backtest on the chart's data.
import { $, h, store, uid, fmtMoney, fmtPct, fmtPrice, fmtTime, fmtQty, clsUpDown, toast, fill } from '../util.js';
import { createChart } from '../vendor/lightweight-charts.mjs';
import { SAFE_LOCALE } from '../chart.js';
import { TEMPLATES, BLANK } from '../backtest/strategies.js';
import { compileStrategy, parseParams, runBacktest } from '../backtest/engine.js';
import { barsPerYear } from '../timeframes.js';
import { ccyOf, marketOf } from '../data/markets.js';
import { broker, accountFor } from '../paper/broker.js';

const TZ = -new Date().getTimezoneOffset() * 60;

export function getSavedStrategies() { return store.get('strategies', []); }

export function initStrategy(app) {
  const root = document.querySelector('[data-panel="strategy"]');
  let saved = getSavedStrategies();
  let current = store.get('strategy.current', { source: 'template', id: TEMPLATES[0].id });
  let code = loadCode(current);
  let paramValues = store.get('strategy.params', {});
  let lastResult = null;
  let equityChart = null;

  function loadCode(ref) {
    if (ref.source === 'saved') return saved.find((s) => s.id === ref.id)?.code ?? BLANK;
    return TEMPLATES.find((t) => t.id === ref.id)?.code ?? TEMPLATES[0].code;
  }
  const currentName = () => (current.source === 'saved'
    ? saved.find((s) => s.id === current.id)?.name
    : TEMPLATES.find((t) => t.id === current.id)?.name) ?? 'Strategy';

  const opts = store.get('strategy.opts', { positionPct: 100, commissionPct: 0.05, slippagePct: 0.02, stopLossPct: 0, takeProfitPct: 0, allowShort: false });

  // ---- left side
  const select = h('select', { 'aria-label': 'Strategy' });
  const codeArea = h('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Strategy code' });
  const paramsBox = h('div', { class: 'params' });
  const errorBox = h('div', { class: 'error-box', hidden: true });
  const capital = h('input', { type: 'number', min: 1, step: 1000 });
  const num = (key, label, step = 0.01) => {
    const input = h('input', { type: 'number', step, min: 0, value: opts[key], onchange: () => { opts[key] = +input.value || 0; store.set('strategy.opts', opts); } });
    return h('label', { class: 'field' }, label, input);
  };
  const shortBox = h('input', { type: 'checkbox', checked: opts.allowShort, onchange: () => { opts.allowShort = shortBox.checked; store.set('strategy.opts', opts); } });

  function renderSelect() {
    fill(select, 
      h('optgroup', { label: 'Built-in' }, ...TEMPLATES.map((t) => h('option', { value: `template:${t.id}`, selected: current.source === 'template' && current.id === t.id }, t.name))),
      saved.length ? h('optgroup', { label: 'My strategies' }, ...saved.map((s) => h('option', { value: `saved:${s.id}`, selected: current.source === 'saved' && current.id === s.id }, s.name))) : null,
    );
  }
  select.addEventListener('change', () => {
    const [source, id] = select.value.split(':');
    current = { source, id };
    store.set('strategy.current', current);
    code = loadCode(current);
    codeArea.value = code;
    renderParams();
    updateButtons();
  });

  function renderParams() {
    const specs = parseParams(code);
    fill(paramsBox, ...specs.map((p) => {
      const key = `${p.name}`;
      const val = paramValues[key] ?? p.default;
      const input = h('input', {
        type: 'number', value: val, min: p.min, max: p.max, step: p.step ?? 'any',
        onchange: () => { paramValues[key] = +input.value; store.set('strategy.params', paramValues); },
      });
      return h('label', { class: 'field' }, p.label, input);
    }));
    if (!specs.length) fill(paramsBox, h('span', { class: 'hint' }, 'Add "// @param name default min max step Label" lines to get inputs here.'));
  }

  codeArea.addEventListener('input', () => { code = codeArea.value; renderParams(); updateButtons(); });
  codeArea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = codeArea;
      codeArea.setRangeText('  ', s, en, 'end');
      code = codeArea.value;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
  });

  const saveBtn = h('button', { class: 'btn', onclick: saveStrategy }, 'Save');
  const deleteBtn = h('button', { class: 'btn ghost', onclick: deleteStrategy }, 'Delete');

  function updateButtons() {
    const dirty = code !== loadCode(current);
    saveBtn.textContent = current.source === 'saved' ? (dirty ? 'Save changes' : 'Saved') : 'Save as mine';
    saveBtn.disabled = current.source === 'saved' && !dirty;
    deleteBtn.hidden = current.source !== 'saved';
  }

  function saveStrategy() {
    try { compileStrategy(code); } catch (e) { return showError(e.message); }
    if (current.source === 'saved') {
      saved = saved.map((s) => (s.id === current.id ? { ...s, code } : s));
    } else {
      const name = prompt('Name your strategy', `${currentName()} (custom)`);
      if (!name) return;
      const s = { id: uid(), name, code };
      saved.push(s);
      current = { source: 'saved', id: s.id };
      store.set('strategy.current', current);
    }
    store.set('strategies', saved);
    renderSelect();
    updateButtons();
    toast('Strategy saved', 'ok');
  }

  function deleteStrategy() {
    if (!confirm(`Delete "${currentName()}"?`)) return;
    saved = saved.filter((s) => s.id !== current.id);
    store.set('strategies', saved);
    current = { source: 'template', id: TEMPLATES[0].id };
    store.set('strategy.current', current);
    code = loadCode(current);
    codeArea.value = code;
    renderSelect(); renderParams(); updateButtons();
  }

  function showError(msg) {
    errorBox.hidden = !msg;
    errorBox.textContent = msg || '';
  }

  function currentParams() {
    const out = {};
    for (const p of parseParams(code)) out[p.name] = paramValues[p.name] ?? p.default;
    return out;
  }

  // ---- right side
  const results = h('div', { class: 'st-right' }, h('div', { class: 'empty' }, 'Pick a strategy and press Run backtest. It runs on the candles loaded in the chart above.'));

  function run() {
    showError('');
    const bars = app.bars;
    if (!bars.length) return showError('No chart data loaded yet.');
    let result;
    try {
      const strat = compileStrategy(code);
      const fn = strat.build(bars, currentParams());
      result = runBacktest(bars, fn, {
        ...opts,
        initialCapital: +capital.value || 100000,
        intQty: marketOf(app.sym).intQty,
        barsPerYear: barsPerYear(app.tf, app.sym.market),
      });
    } catch (e) {
      return showError(e.message);
    }
    lastResult = { ...result, sym: app.sym, tf: app.tf, ccy: ccyOf(app.sym), name: currentName() };
    app.chart.setMarkers(result.markers);
    renderResults();
  }

  function renderResults() {
    const r = lastResult;
    if (!r) return;
    const s = r.stats;
    const money = (v) => fmtMoney(v, r.ccy === 'USDT' ? 'USD' : r.ccy);
    const stat = (k, v, cls = '') => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}` }, v));
    const pf = isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞';
    const eqBox = h('div', { class: 'equity-chart' });
    const tradesTable = h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ...['#', 'Side', 'Entry', 'Exit', 'Qty', 'P&L', '%', 'Exit by'].map((c, i) => h('th', { class: i > 3 ? 'r' : '' }, c)))),
      h('tbody', {}, ...r.trades.slice().reverse().map((t, idx) => h('tr', {},
        h('td', {}, r.trades.length - idx),
        h('td', { class: t.dir > 0 ? 'up' : 'down' }, t.dir > 0 ? 'Long' : 'Short'),
        h('td', {}, `${fmtTime(t.entryTime)} @ ${fmtPrice(t.entryPrice)}`),
        h('td', {}, `${fmtTime(t.exitTime)} @ ${fmtPrice(t.exitPrice)}`),
        h('td', { class: 'r' }, fmtQty(+t.qty.toFixed(6))),
        h('td', { class: `r ${clsUpDown(t.pnl)}` }, money(t.pnl)),
        h('td', { class: `r ${clsUpDown(t.pnl)}` }, fmtPct(t.pnlPct)),
        h('td', { class: 'r muted' }, t.reason),
      ))));

    fill(results, 
      h('div', { class: 'st-row' },
        h('b', {}, `${r.name} · ${r.sym.name || r.sym.ticker} · ${r.tf}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => { app.chart.setMarkers([]); } }, 'Clear markers'),
      ),
      h('div', { class: 'stats' },
        stat('Net profit', `${money(s.netProfit)}`, clsUpDown(s.netProfit)),
        stat('Return', fmtPct(s.netProfitPct), clsUpDown(s.netProfitPct)),
        stat('Buy & hold', fmtPct(s.buyHoldPct), clsUpDown(s.buyHoldPct)),
        stat('Max drawdown', fmtPct(-s.maxDrawdownPct), 'down'),
        stat('Trades', s.trades),
        stat('Win rate', `${s.winRate.toFixed(1)}%`),
        stat('Profit factor', pf),
        stat('Sharpe', s.sharpe.toFixed(2)),
        stat('CAGR', fmtPct(s.cagr), clsUpDown(s.cagr)),
        stat('Avg trade', money(s.avgTrade), clsUpDown(s.avgTrade)),
      ),
      eqBox,
      r.trades.length ? tradesTable : h('div', { class: 'empty' }, 'No trades. Try other parameters or a longer timeframe.'),
    );

    equityChart?.remove();
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    equityChart = createChart(eqBox, {
      autoSize: true,
      localization: { locale: SAFE_LOCALE },
      layout: { background: { color: css('--surface') }, textColor: css('--text-muted'), attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--grid') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      handleScroll: false, handleScale: false,
    });
    const area = equityChart.addAreaSeries({
      lineColor: css('--c1'), topColor: 'rgba(76,141,255,.35)', bottomColor: 'rgba(76,141,255,0)', lineWidth: 2,
      priceLineVisible: false,
    });
    area.setData(r.equity.map((e) => ({ time: e.time + TZ, value: e.value })));
    equityChart.timeScale().fitContent();
  }

  function startBot() {
    if (!accountFor(app.sym)) return toast(`Paper bots support INR and USD-quoted symbols.`, 'error');
    try { compileStrategy(code); } catch (e) { return showError(e.message); }
    const sizePct = prompt(`Run "${currentName()}" on ${app.sym.ticker} (${app.tf}) with paper money.\nWhat % of the ${accountFor(app.sym)} paper account should each trade use?`, '20');
    if (sizePct == null) return;
    try {
      broker.addBot({ name: currentName(), sym: app.sym, tf: app.tf, code, params: currentParams(), sizePct: +sizePct });
      toast('Strategy bot started — see the Strategy bots tab', 'ok');
    } catch (e) { showError(e.message); }
  }

  function setCapitalDefault() {
    const ccy = ccyOf(app.sym);
    capital.value = ccy === 'INR' ? 1000000 : 100000;
  }

  root.append(h('div', { class: 'st-grid' },
    h('div', { class: 'st-left' },
      h('div', { class: 'st-row' }, select, saveBtn, deleteBtn,
        h('button', { class: 'btn ghost', onclick: () => { current = { source: 'template', id: '__blank' }; code = BLANK; codeArea.value = code; renderParams(); updateButtons(); } }, 'New')),
      codeArea,
      paramsBox,
      h('div', { class: 'settings-grid' },
        h('label', { class: 'field' }, 'Capital', capital),
        num('positionPct', 'Position size %', 1),
        num('commissionPct', 'Commission %'),
        num('slippagePct', 'Slippage %'),
        num('stopLossPct', 'Stop loss %', 0.1),
        num('takeProfitPct', 'Take profit %', 0.1),
        h('label', { class: 'check' }, shortBox, 'Allow shorts'),
      ),
      errorBox,
      h('div', { class: 'st-row' },
        h('button', { class: 'btn primary', onclick: run, title: 'Ctrl+Enter' }, 'Run backtest'),
        h('button', { class: 'btn', onclick: startBot }, 'Paper trade this strategy'),
        h('span', { class: 'hint' }, 'Signals act at the next bar\'s open.'),
      ),
    ),
    results,
  ));

  codeArea.value = code;
  renderSelect();
  renderParams();
  updateButtons();
  setCapitalDefault();

  app.on('symbol', () => { setCapitalDefault(); app.chart.setMarkers([]); });
  app.on('theme', () => renderResults());
}
