// Price chart: candles, volume, overlay indicators, an oscillator pane,
// backtest trade markers and paper-trading price lines.
import { createChart, CrosshairMode, LineStyle } from './vendor/lightweight-charts.mjs';
import * as ta from './ta.js';

// Show times in the viewer's own time zone (the library renders timestamps as UTC).
const TZ = -new Date().getTimezoneOffset() * 60;
const toChart = (t) => t + TZ;
export const fromChart = (t) => t - TZ;

export const INDICATORS = [
  { id: 'sma20', label: 'SMA 20', kind: 'overlay' },
  { id: 'sma50', label: 'SMA 50', kind: 'overlay' },
  { id: 'sma200', label: 'SMA 200', kind: 'overlay' },
  { id: 'ema20', label: 'EMA 20', kind: 'overlay' },
  { id: 'ema50', label: 'EMA 50', kind: 'overlay' },
  { id: 'bb', label: 'Bollinger Bands (20, 2)', kind: 'overlay' },
  { id: 'vwap', label: 'VWAP (intraday)', kind: 'overlay' },
  { id: 'supertrend', label: 'Supertrend (10, 3)', kind: 'overlay' },
  { id: 'rsi', label: 'RSI 14', kind: 'pane' },
  { id: 'macd', label: 'MACD (12, 26, 9)', kind: 'pane' },
];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * The browser's locale if Intl accepts it, else en-IN. Some browsers report
 * values like "en_US" or "" that make the chart library's date formatting throw.
 */
export const SAFE_LOCALE = (() => {
  try {
    const l = navigator.language;
    new Date().toLocaleString(l, { month: 'long' });
    return l || 'en-IN';
  } catch {
    return 'en-IN';
  }
})();

export function themeOptions() {
  const text = cssVar('--text-muted');
  const grid = cssVar('--grid');
  const bg = cssVar('--surface');
  return {
    localization: { locale: SAFE_LOCALE },
    layout: { background: { color: bg }, textColor: text, fontFamily: cssVar('--font-sans'), attributionLogo: true },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    rightPriceScale: { borderColor: grid },
    timeScale: { borderColor: grid },
    crosshair: { mode: CrosshairMode.Normal },
  };
}

export class ChartView {
  constructor(main, pane) {
    this.mainEl = main;
    this.paneEl = pane;
    this.bars = [];
    this.active = new Set(['ema20', 'ema50']);
    this.overlays = new Map(); // id -> [series]
    this.paneSeries = [];
    this.priceLines = [];
    this.markers = [];
    this.tzOffset = 0;

    this.chart = createChart(main, {
      ...themeOptions(),
      autoSize: true,
      timeScale: { ...themeOptions().timeScale, timeVisible: true, secondsVisible: false, rightOffset: 6 },
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: cssVar('--up'), downColor: cssVar('--down'),
      wickUpColor: cssVar('--up'), wickDownColor: cssVar('--down'), borderVisible: false,
    });
    this.volume = this.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    this.pane = createChart(pane, {
      ...themeOptions(),
      autoSize: true,
      timeScale: { visible: false },
      rightPriceScale: { ...themeOptions().rightPriceScale, minimumWidth: 70 },
    });
    this.chart.priceScale('right').applyOptions({ minimumWidth: 70 });

    // Keep the oscillator pane scrolled in step with the main chart.
    let syncing = false;
    const sync = (from, to) => (range) => {
      if (syncing || !range) return;
      syncing = true;
      to.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    };
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(sync(this.chart, this.pane));
    this.pane.timeScale().subscribeVisibleLogicalRangeChange(sync(this.pane, this.chart));

    this.legend = document.createElement('div');
    this.legend.className = 'chart-legend';
    main.append(this.legend);
    this.chart.subscribeCrosshairMove((p) => this.#updateLegend(p));
  }

  applyTheme() {
    const o = themeOptions();
    this.chart.applyOptions(o);
    this.pane.applyOptions({ ...o, timeScale: { visible: false } });
    this.candles.applyOptions({ upColor: cssVar('--up'), downColor: cssVar('--down'), wickUpColor: cssVar('--up'), wickDownColor: cssVar('--down') });
    this.#renderIndicators();
  }

  setPrecision(decimals) {
    const minMove = 1 / 10 ** decimals;
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: decimals, minMove } });
  }

  setData(bars, { tzOffset = 0 } = {}) {
    this.bars = bars.slice();
    this.tzOffset = tzOffset;
    this.candles.setData(this.bars.map((b) => ({ ...b, time: toChart(b.time) })));
    this.volume.setData(this.bars.map((b) => this.#volBar(b)));
    this.markers = [];
    this.candles.setMarkers([]);
    this.#renderIndicators();
    this.chart.timeScale().fitContent();
    const n = this.bars.length;
    if (n > 200) this.chart.timeScale().setVisibleLogicalRange({ from: n - 200, to: n + 6 });
    this.#updateLegend();
  }

  update(bar) {
    const last = this.bars.at(-1);
    if (last && bar.time < last.time) return;
    if (last && bar.time === last.time) this.bars[this.bars.length - 1] = bar;
    else this.bars.push(bar);
    this.candles.update({ ...bar, time: toChart(bar.time) });
    this.volume.update(this.#volBar(bar));
    this.#scheduleIndicators();
    this.#updateLegend();
  }

  #volBar(b) {
    const up = b.close >= b.open;
    return { time: toChart(b.time), value: b.volume || 0, color: up ? cssVar('--up-soft') : cssVar('--down-soft') };
  }

  setIndicators(ids) {
    this.active = new Set(ids);
    this.#renderIndicators();
  }

  #scheduleIndicators() {
    if (this.indTimer) return;
    this.indTimer = setTimeout(() => { this.indTimer = null; this.#renderIndicators(); }, 500);
  }

  #line(target, color, opts = {}) {
    return target.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts });
  }

  #renderIndicators() {
    for (const list of this.overlays.values()) list.forEach((s) => this.chart.removeSeries(s));
    this.overlays.clear();
    this.paneSeries.forEach((s) => this.pane.removeSeries(s));
    this.paneSeries = [];

    const bars = this.bars;
    const close = bars.map((b) => b.close);
    const high = bars.map((b) => b.high);
    const low = bars.map((b) => b.low);
    const data = (arr) => arr.map((v, i) => (isNaN(v) ? { time: toChart(bars[i].time) } : { time: toChart(bars[i].time), value: v }));
    const colors = [cssVar('--c1'), cssVar('--c2'), cssVar('--c3'), cssVar('--c4'), cssVar('--c5')];
    let ci = 0;
    const next = () => colors[ci++ % colors.length];

    for (const id of this.active) {
      const add = (arr, color, opts) => {
        const s = this.#line(this.chart, color, opts);
        s.setData(data(arr));
        (this.overlays.get(id) ?? this.overlays.set(id, []).get(id)).push(s);
      };
      const m = /^(sma|ema)(\d+)$/.exec(id);
      if (m) add(ta[m[1]](close, +m[2]), next());
      else if (id === 'bb') {
        const b = ta.bollinger(close, 20, 2);
        const c = next();
        add(b.upper, c, { lineWidth: 1 });
        add(b.middle, c, { lineWidth: 1, lineStyle: LineStyle.Dashed });
        add(b.lower, c, { lineWidth: 1 });
      } else if (id === 'vwap') add(ta.vwap(bars, this.tzOffset), next());
      else if (id === 'supertrend') {
        const st = ta.supertrend(high, low, close, 10, 3);
        const up = st.line.map((v, i) => (st.dir[i] === 1 ? v : NaN));
        const dn = st.line.map((v, i) => (st.dir[i] === -1 ? v : NaN));
        add(up, cssVar('--up'));
        add(dn, cssVar('--down'));
      }
    }

    const hasPane = this.active.has('rsi') || this.active.has('macd');
    this.paneEl.hidden = !hasPane;
    if (this.active.has('rsi')) {
      const s = this.#line(this.pane, cssVar('--c3'), { lastValueVisible: true });
      s.setData(data(ta.rsi(close, 14)));
      s.createPriceLine({ price: 70, color: cssVar('--grid-strong'), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      s.createPriceLine({ price: 30, color: cssVar('--grid-strong'), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      this.paneSeries.push(s);
    }
    if (this.active.has('macd')) {
      const md = ta.macd(close);
      const hist = this.pane.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      hist.setData(md.hist.map((v, i) => (isNaN(v) ? { time: toChart(bars[i].time) } : { time: toChart(bars[i].time), value: v, color: v >= 0 ? cssVar('--up-soft') : cssVar('--down-soft') })));
      const l1 = this.#line(this.pane, cssVar('--c1'));
      l1.setData(data(md.macd));
      const l2 = this.#line(this.pane, cssVar('--c2'));
      l2.setData(data(md.signal));
      this.paneSeries.push(hist, l1, l2);
    }
    if (hasPane) {
      const r = this.chart.timeScale().getVisibleLogicalRange();
      if (r) this.pane.timeScale().setVisibleLogicalRange(r);
    }
  }

  /** markers: [{time, side: 'buy'|'sell', text}] */
  setMarkers(markers) {
    this.markers = markers;
    this.candles.setMarkers(markers
      .map((m) => ({
        time: toChart(m.time),
        position: m.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: m.side === 'buy' ? cssVar('--up') : cssVar('--down'),
        shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: m.text,
      }))
      .sort((a, b) => a.time - b.time));
  }

  /** lines: [{price, title, kind: 'position'|'order'|'stop'}] */
  setPriceLines(lines) {
    this.priceLines.forEach((l) => this.candles.removePriceLine(l));
    this.priceLines = lines.map((l) => this.candles.createPriceLine({
      price: l.price,
      title: l.title,
      color: l.kind === 'position' ? cssVar('--accent') : cssVar('--text-muted'),
      lineStyle: l.kind === 'position' ? LineStyle.Solid : LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: true,
    }));
  }

  #updateLegend(param) {
    let bar;
    if (param?.time != null) bar = this.bars.find((b) => toChart(b.time) === param.time);
    bar ??= this.bars.at(-1);
    if (!bar) { this.legend.textContent = ''; return; }
    const fmt = (v) => this.candles.priceFormatter().format(v);
    const chg = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    const cls = bar.close >= bar.open ? 'up' : 'down';
    this.legend.innerHTML = '';
    for (const [k, v] of [['O', bar.open], ['H', bar.high], ['L', bar.low], ['C', bar.close]]) {
      const span = document.createElement('span');
      span.innerHTML = `${k} <b class="${cls}">${fmt(v)}</b>`;
      this.legend.append(span);
    }
    const c = document.createElement('span');
    c.className = cls;
    c.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    this.legend.append(c);
  }

  fit() { this.chart.timeScale().fitContent(); }
}

