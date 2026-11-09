// Drawing tools on top of the price chart: trend lines, rays, horizontal and
// vertical lines, rectangles, Fibonacci retracements, text notes and a measure
// tool. Drawings are stored per symbol as {time, price} points so they stay put
// when the timeframe or the visible range changes.
import { store, fmtPrice } from './util.js';
import { symId } from './data/markets.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const POINTS_NEEDED = { trend: 2, ray: 2, hline: 1, vline: 1, rect: 2, fib: 2, channel: 3, long: 1, short: 1, text: 1, measure: 2 };
const POSITION_DEFAULTS = { targetPct: 2, stopPct: 1, bars: 20 };

// Toolbar definition. Icons are simple inline SVG paths drawn for TraderStack.
const icon = (d, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}${extra}</svg>`;
export const TOOLS = [
  { id: 'cursor', label: 'Cursor', key: 'Escape', svg: icon('<path d="M12 3v18M3 12h18"/>') },
  { id: 'trend', label: 'Trend line', key: 'T', svg: icon('<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.8"/><circle cx="19" cy="5" r="1.8"/>') },
  { id: 'ray', label: 'Ray', key: 'R', svg: icon('<path d="M5 18L21 6"/><circle cx="5" cy="18" r="1.8"/><path d="M17 5l4 1-1 4"/>') },
  { id: 'hline', label: 'Horizontal line', key: 'H', svg: icon('<path d="M3 12h18"/><circle cx="12" cy="12" r="1.8"/>') },
  { id: 'vline', label: 'Vertical line', key: 'V', svg: icon('<path d="M12 3v18"/><circle cx="12" cy="12" r="1.8"/>') },
  { id: 'rect', label: 'Rectangle', key: 'B', svg: icon('<rect x="4" y="6" width="16" height="12" rx="1"/>') },
  { id: 'fib', label: 'Fibonacci retracement', key: 'F', svg: icon('<path d="M3 5h18M3 9.5h18M3 13h18M3 19h18" /><path d="M5 19L19 5" stroke-dasharray="2 2"/>') },
  { id: 'channel', label: 'Parallel channel', key: 'P', svg: icon('<path d="M3 15L15 4M9 20L21 9"/><path d="M6 17.5L18 6.5" stroke-dasharray="2 2.5" stroke-opacity=".7"/>') },
  { id: 'long', label: 'Long position', key: 'L', svg: icon('<rect x="4" y="4" width="16" height="9" rx="1" fill="currentColor" fill-opacity=".18"/><rect x="4" y="13" width="16" height="7" rx="1"/><path d="M12 11V6M9.5 8.5L12 6l2.5 2.5"/>') },
  { id: 'short', label: 'Short position', key: 'S', svg: icon('<rect x="4" y="4" width="16" height="7" rx="1"/><rect x="4" y="11" width="16" height="9" rx="1" fill="currentColor" fill-opacity=".18"/><path d="M12 13v5M9.5 15.5L12 18l2.5-2.5"/>') },
  { id: 'text', label: 'Text note', key: 'N', svg: icon('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>') },
  { sep: true },
  { id: 'measure', label: 'Measure', key: 'M', svg: icon('<path d="M4 17L17 4l3 3L7 20z"/><path d="M8 13l2 2M11 10l2 2M14 7l2 2"/>') },
  { id: 'fit', label: 'Reset zoom', action: true, svg: icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8M8 10.5h5M10.5 8v5"/>') },
  { sep: true },
  { id: 'magnet', label: 'Magnet: snap to candle open/high/low/close', toggle: true, svg: icon('<path d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z"/><path d="M6 8h4M14 8h4"/>') },
  { id: 'lock', label: 'Lock drawings', toggle: true, svg: icon('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>') },
  { id: 'hide', label: 'Hide drawings', toggle: true, svg: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>') },
  { id: 'clear', label: 'Delete all drawings on this symbol', action: true, svg: icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>') },
];

const el = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};

export class DrawingTools {
  constructor(view, bar, app) {
    this.view = view;
    this.chart = view.chart;
    this.series = view.candles;
    this.bar = bar;
    this.app = app;
    this.tool = 'cursor';
    this.flags = store.get('draw.flags', { magnet: false, lock: false, hide: false });
    this.drawings = [];
    this.draft = null; // drawing being placed
    this.measure = null;
    this.selected = null;
    this.drag = null;
    this.key = null;

    this.svg = el('svg', { class: 'draw-layer' });
    view.mainEl.append(this.svg);
    this.#buildBar();
    this.#bindEvents();
    this.#loop();
  }

  // ---------------------------------------------------------------------------
  // Coordinates: drawings store real time + price; the chart works in logical
  // bar indexes. Convert through the loaded bars, extrapolating past either end.

  #step() {
    const b = this.view.bars;
    if (b.length < 2) return 60;
    const diffs = [];
    for (let i = Math.max(1, b.length - 50); i < b.length; i++) diffs.push(b[i].time - b[i - 1].time);
    diffs.sort((x, y) => x - y);
    return diffs[Math.floor(diffs.length / 2)] || 60;
  }

  #logicalToTime(l) {
    const b = this.view.bars;
    if (!b.length) return 0;
    const n = b.length;
    if (l <= 0) return b[0].time + l * this.#step();
    if (l >= n - 1) return b[n - 1].time + (l - (n - 1)) * this.#step();
    const i = Math.floor(l);
    return b[i].time + (l - i) * (b[i + 1].time - b[i].time);
  }

  #timeToLogical(t) {
    const b = this.view.bars;
    if (!b.length) return 0;
    const n = b.length;
    if (t <= b[0].time) return (t - b[0].time) / this.#step();
    if (t >= b[n - 1].time) return n - 1 + (t - b[n - 1].time) / this.#step();
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid].time <= t) lo = mid; else hi = mid;
    }
    return lo + (t - b[lo].time) / (b[hi].time - b[lo].time || 1);
  }

  #toXY(p) {
    const x = this.chart.timeScale().logicalToCoordinate(this.#timeToLogical(p.time));
    const y = this.series.priceToCoordinate(p.price);
    return x == null || y == null ? null : { x, y };
  }

  #fromXY(x, y, snap = this.flags.magnet) {
    let logical = this.chart.timeScale().coordinateToLogical(x);
    let price = this.series.coordinateToPrice(y);
    if (logical == null || price == null) return null;
    if (snap) {
      const i = Math.round(logical);
      const bar = this.view.bars[i];
      if (bar) {
        logical = i;
        price = [bar.open, bar.high, bar.low, bar.close].reduce((best, v) => (Math.abs(v - price) < Math.abs(best - price) ? v : best));
      }
    }
    return { time: this.#logicalToTime(logical), price };
  }

  #paneSize() {
    const width = this.view.mainEl.clientWidth - this.chart.priceScale('right').width();
    const height = this.view.mainEl.clientHeight - this.chart.timeScale().height();
    return { width: Math.max(0, width), height: Math.max(0, height) };
  }

  // ---------------------------------------------------------------------------
  // Storage

  setSymbol(sym) {
    this.key = `draw.${symId(sym)}`;
    this.drawings = store.get(this.key, []);
    this.selected = null;
    this.draft = null;
    this.measure = null;
  }

  #save() { if (this.key) store.set(this.key, this.drawings); }

  // ---------------------------------------------------------------------------
  // Toolbar

  #buildBar() {
    this.bar.replaceChildren(...TOOLS.map((t) => {
      if (t.sep) return Object.assign(document.createElement('hr'), { className: 'draw-sep' });
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'draw-btn';
      b.dataset.tool = t.id;
      b.title = t.key ? `${t.label} (${t.key === 'Escape' ? 'Esc' : `Shift+${t.key}`})` : t.label;
      b.setAttribute('aria-label', t.label);
      b.innerHTML = t.svg;
      b.addEventListener('click', () => this.#onToolClick(t));
      return b;
    }));
    this.#syncBar();
  }

  #syncBar() {
    for (const b of this.bar.querySelectorAll('.draw-btn')) {
      const id = b.dataset.tool;
      const t = TOOLS.find((x) => x.id === id);
      const on = t.toggle ? !!this.flags[id] : id === this.tool;
      b.classList.toggle('on', on);
      if (t.toggle || !t.action) b.setAttribute('aria-pressed', on);
    }
    this.svg.classList.toggle('placing', this.tool !== 'cursor');
    this.svg.classList.toggle('locked', !!this.flags.lock);
    this.svg.style.display = this.flags.hide ? 'none' : '';
  }

  #onToolClick(t) {
    if (t.toggle) {
      this.flags[t.id] = !this.flags[t.id];
      store.set('draw.flags', this.flags);
      if (t.id === 'lock' || t.id === 'hide') this.selected = null;
    } else if (t.id === 'fit') {
      this.chart.timeScale().fitContent();
      this.chart.priceScale('right').applyOptions({ autoScale: true });
    } else if (t.id === 'clear') {
      if (this.drawings.length && confirm(`Delete all ${this.drawings.length} drawing(s) on this symbol?`)) {
        this.drawings = [];
        this.selected = null;
        this.#save();
      }
    } else {
      this.setTool(t.id === this.tool ? 'cursor' : t.id);
    }
    this.#syncBar();
  }

  setTool(id) {
    this.tool = id;
    this.draft = null;
    if (id !== 'measure') this.measure = null;
    this.selected = null;
    // While placing points, clicks belong to the tool rather than to chart panning.
    const placing = id !== 'cursor';
    this.chart.applyOptions({ handleScroll: !placing, handleScale: !placing });
    this.#syncBar();
  }

  // ---------------------------------------------------------------------------
  // Pointer handling

  #local(e) {
    const r = this.view.mainEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #bindEvents() {
    this.svg.addEventListener('pointerdown', (e) => {
      const { x, y } = this.#local(e);
      if (this.tool !== 'cursor') { this.#place(x, y); e.preventDefault(); return; }
      if (this.flags.lock) return;
      const target = e.target.closest('[data-id]');
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const d = this.drawings.find((v) => v.id === target.dataset.id);
      if (!d) return;
      this.selected = d.id;
      const start = this.#fromXY(x, y, false);
      this.drag = { id: d.id, handle: target.dataset.handle != null ? +target.dataset.handle : null, start, orig: d.points.map((p) => ({ ...p })) };
      this.chart.applyOptions({ handleScroll: false, handleScale: false });
      this.svg.setPointerCapture(e.pointerId);
    });

    this.svg.addEventListener('pointermove', (e) => {
      const { x, y } = this.#local(e);
      if (this.draft) { this.draft.hover = this.#fromXY(x, y); return; }
      if (this.measure && !this.measure.done) { this.measure.hover = this.#fromXY(x, y); return; }
      if (!this.drag) return;
      const d = this.drawings.find((v) => v.id === this.drag.id);
      const p = this.#fromXY(x, y, this.drag.handle != null && this.flags.magnet);
      if (!d || !p || !this.drag.start) return;
      if (this.drag.handle != null && (d.type === 'long' || d.type === 'short') && this.drag.handle > 0) {
        // Target and stop share the box's right edge; each handle sets its own price.
        d.points[this.drag.handle] = p;
        d.points[this.drag.handle === 1 ? 2 : 1].time = p.time;
      } else if (this.drag.handle != null) {
        d.points[this.drag.handle] = p;
      } else {
        const dl = this.#timeToLogical(p.time) - this.#timeToLogical(this.drag.start.time);
        const dp = p.price - this.drag.start.price;
        d.points = this.drag.orig.map((q) => ({ time: this.#logicalToTime(this.#timeToLogical(q.time) + dl), price: q.price + dp }));
      }
    });

    const endDrag = () => {
      if (!this.drag) return;
      this.drag = null;
      this.#save();
      if (this.tool === 'cursor') this.chart.applyOptions({ handleScroll: true, handleScale: true });
    };
    this.svg.addEventListener('pointerup', endDrag);
    this.svg.addEventListener('pointercancel', endDrag);

    // Clicking empty chart space clears the selection.
    this.chart.subscribeClick(() => { if (this.tool === 'cursor' && !this.drag) this.selected = null; });

    document.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, select, dialog')) return;
      if (e.key === 'Escape') { this.setTool('cursor'); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
        this.drawings = this.drawings.filter((d) => d.id !== this.selected);
        this.selected = null;
        this.#save();
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = TOOLS.find((x) => x.key && x.key.toLowerCase() === e.key.toLowerCase() && x.key !== 'Escape');
      if (t && e.shiftKey) { this.setTool(t.id); e.preventDefault(); }
    });
  }

  #place(x, y) {
    const p = this.#fromXY(x, y);
    if (!p) return;
    const type = this.tool;

    if (type === 'measure') {
      if (!this.measure || this.measure.done) this.measure = { points: [p], hover: p };
      else { this.measure.points.push(p); this.measure.done = true; }
      return;
    }

    const draft = this.draft ?? { id: Math.random().toString(36).slice(2, 10), type, points: [] };
    draft.points.push(p);
    if (type === 'long' || type === 'short') {
      // One click sets the entry; target, stop and width start from defaults and are dragged into place.
      const dir = type === 'long' ? 1 : -1;
      const end = this.#logicalToTime(this.#timeToLogical(p.time) + POSITION_DEFAULTS.bars);
      draft.points = [
        p,
        { time: end, price: p.price * (1 + dir * POSITION_DEFAULTS.targetPct / 100) },
        { time: end, price: p.price * (1 - dir * POSITION_DEFAULTS.stopPct / 100) },
      ];
    }
    if (draft.points.length < POINTS_NEEDED[type]) { this.draft = draft; draft.hover = p; return; }

    if (type === 'text') {
      const text = prompt('Note text');
      if (!text) { this.draft = null; return; }
      draft.text = text.slice(0, 200);
    }
    delete draft.hover;
    this.drawings.push(draft);
    this.draft = null;
    this.selected = draft.id;
    this.#save();
    this.setTool('cursor');
    this.selected = draft.id;
  }

  // ---------------------------------------------------------------------------
  // Rendering (every animation frame, so drawings track scrolling and autoscale)

  #loop() {
    const frame = () => {
      try { this.#render(); } catch (e) { console.error(e); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  #render() {
    const { width, height } = this.#paneSize();
    this.svg.setAttribute('width', width);
    this.svg.setAttribute('height', height);
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const color = css('--c1');
    const accent = css('--accent');
    const textColor = css('--text');
    const nodes = [];

    const all = [...this.drawings];
    if (this.draft) all.push({ ...this.draft, points: [...this.draft.points, this.draft.hover].filter(Boolean), preview: true });

    for (const d of all) {
      const pts = d.points.map((p) => this.#toXY(p));
      if (pts.some((p) => !p)) continue;
      const sel = d.id === this.selected;
      const stroke = sel ? accent : color;
      const g = el('g', { 'data-id': d.preview ? null : d.id, class: 'drawing' });
      const line = (x1, y1, x2, y2, extra = {}) => {
        g.append(el('line', { x1, y1, x2, y2, class: 'hit' }));
        g.append(el('line', { x1, y1, x2, y2, stroke, 'stroke-width': 1.6, ...extra }));
      };
      const label = (x, y, text, anchor = 'start') => {
        const t = el('text', { x, y, fill: stroke, 'font-size': 11, 'text-anchor': anchor, class: 'draw-label' });
        t.textContent = text;
        g.append(t);
      };

      if (d.type === 'trend' && pts.length >= 2) line(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      if (d.type === 'trend' && pts.length === 1) line(pts[0].x, pts[0].y, pts[0].x, pts[0].y);
      if (d.type === 'ray' && pts.length >= 2) {
        const [a, b] = pts;
        const dx = b.x - a.x || 0.0001;
        const k = Math.max(0, (dx > 0 ? width - a.x : -a.x) / dx);
        line(a.x, a.y, a.x + dx * k, a.y + (b.y - a.y) * k);
      }
      if (d.type === 'hline') {
        line(0, pts[0].y, width, pts[0].y);
        label(width - 4, pts[0].y - 4, fmtPrice(d.points[0].price), 'end');
      }
      if (d.type === 'vline') line(pts[0].x, 0, pts[0].x, height);
      if (d.type === 'rect' && pts.length >= 2) {
        const [a, b] = pts;
        const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
        g.append(el('rect', { ...r, class: 'hit-fill' }));
        g.append(el('rect', { ...r, stroke, 'stroke-width': 1.4, fill: stroke, 'fill-opacity': 0.12 }));
      }
      if (d.type === 'fib' && pts.length >= 2) {
        const [a, b] = d.points;
        const x1 = Math.min(pts[0].x, pts[1].x);
        const x2 = Math.max(pts[0].x, pts[1].x);
        for (const lvl of FIB_LEVELS) {
          const price = b.price + (a.price - b.price) * lvl;
          const y = this.series.priceToCoordinate(price);
          if (y == null) continue;
          line(x1, y, x2, y, { 'stroke-opacity': lvl === 0 || lvl === 1 ? 1 : 0.75 });
          // Labels go right of the levels, or left when they would run off the chart.
          const roomRight = width - x2 > 130;
          label(roomRight ? x2 + 4 : x1 - 4, y + 4, `${(lvl * 100).toFixed(1)}%  ${fmtPrice(price)}`, roomRight ? 'start' : 'end');
        }
        line(pts[0].x, pts[0].y, pts[1].x, pts[1].y, { 'stroke-dasharray': '3 3', 'stroke-opacity': 0.6 });
      }
      if (d.type === 'channel' && pts.length >= 2) {
        const [a, b] = pts;
        line(a.x, a.y, b.x, b.y);
        if (pts.length >= 3) {
          // The third point sets the offset of the parallel line (in price, at its own time).
          const [pa, pb, pc] = d.points;
          const la = this.#timeToLogical(pa.time);
          const lb = this.#timeToLogical(pb.time);
          const lc = this.#timeToLogical(pc.time);
          const baseAtC = lb === la ? pa.price : pa.price + ((pb.price - pa.price) * (lc - la)) / (lb - la);
          const dp = pc.price - baseAtC;
          const a2 = this.#toXY({ time: pa.time, price: pa.price + dp });
          const b2 = this.#toXY({ time: pb.time, price: pb.price + dp });
          const am = this.#toXY({ time: pa.time, price: pa.price + dp / 2 });
          const bm = this.#toXY({ time: pb.time, price: pb.price + dp / 2 });
          if (a2 && b2 && am && bm) {
            const poly = `${a.x},${a.y} ${b.x},${b.y} ${b2.x},${b2.y} ${a2.x},${a2.y}`;
            g.append(el('polygon', { points: poly, class: 'hit-fill' }));
            g.append(el('polygon', { points: poly, fill: stroke, 'fill-opacity': 0.1 }));
            line(a2.x, a2.y, b2.x, b2.y);
            line(am.x, am.y, bm.x, bm.y, { 'stroke-dasharray': '4 4', 'stroke-opacity': 0.6 });
          }
        }
      }
      if ((d.type === 'long' || d.type === 'short') && pts.length >= 3) {
        const [entry, target, stop] = d.points;
        const [pe, pt, ps] = pts;
        const x1 = Math.min(pe.x, pt.x);
        const w = Math.max(2, Math.abs(pt.x - pe.x));
        const upC = css('--up');
        const downC = css('--down');
        const box = (yA, yB, c) => {
          const r = { x: x1, y: Math.min(yA, yB), width: w, height: Math.max(1, Math.abs(yB - yA)) };
          g.append(el('rect', { ...r, class: 'hit-fill' }));
          g.append(el('rect', { ...r, fill: c, 'fill-opacity': 0.16, stroke: c, 'stroke-opacity': sel ? 0.9 : 0.5 }));
        };
        box(pe.y, pt.y, upC);
        box(pe.y, ps.y, downC);
        g.append(el('line', { x1, y1: pe.y, x2: x1 + w, y2: pe.y, stroke: textColor, 'stroke-width': 1.2 }));

        const pct = (v) => ((v - entry.price) / entry.price) * 100;
        const risk = Math.abs(entry.price - stop.price);
        const reward = Math.abs(target.price - entry.price);
        const rr = risk ? reward / risk : 0;

        // Did price reach the target or the stop first, after entry and within the box?
        const bars = this.view.bars;
        const from = Math.max(0, Math.ceil(this.#timeToLogical(entry.time)));
        const to = Math.min(bars.length - 1, Math.floor(this.#timeToLogical(target.time)));
        const long = d.type === 'long';
        let outcome = 'Open';
        for (let i = from; i <= to; i++) {
          const k = bars[i];
          const hitStop = long ? k.low <= stop.price : k.high >= stop.price;
          const hitTarget = long ? k.high >= target.price : k.low <= target.price;
          if (hitStop) { outcome = 'Stopped out'; break; }
          if (hitTarget) { outcome = 'Target hit'; break; }
        }
        const tag = (x, y, text, c, anchor = 'start') => {
          const t = el('text', { x, y, fill: c, 'font-size': 11, 'font-weight': 600, 'text-anchor': anchor, class: 'draw-label' });
          t.textContent = text;
          g.append(t);
        };
        // Labels sit inside the box, or to its left when the box is near the right edge.
        const roomRight = x1 + 240 < width;
        const anchor = roomRight ? 'start' : 'end';
        const tx = roomRight ? x1 + 6 : x1 - 6;
        const above = (y1, y2) => Math.min(y1, y2);
        tag(tx, (long ? above(pe.y, pt.y) : Math.max(pe.y, pt.y)) + (long ? 14 : -6), `Target ${fmtPrice(target.price)} (${pct(target.price) >= 0 ? '+' : ''}${pct(target.price).toFixed(2)}%)`, upC, anchor);
        tag(tx, (long ? Math.max(pe.y, ps.y) : above(pe.y, ps.y)) + (long ? -6 : 14), `Stop ${fmtPrice(stop.price)} (${pct(stop.price) >= 0 ? '+' : ''}${pct(stop.price).toFixed(2)}%)`, downC, anchor);
        tag(tx, pe.y - 5, `${long ? 'Long' : 'Short'} ${fmtPrice(entry.price)} · R:R ${rr.toFixed(2)} · ${outcome}`, textColor, anchor);
      }
      if (d.type === 'text' && d.text) {
        const t = el('text', { x: pts[0].x, y: pts[0].y, fill: sel ? accent : textColor, 'font-size': 13, 'font-weight': 600, class: 'draw-text' });
        t.textContent = d.text;
        g.append(t);
      }

      if (sel && !this.flags.lock) {
        pts.forEach((p, i) => g.append(el('circle', { cx: p.x, cy: p.y, r: 5, class: 'handle', 'data-handle': i, fill: css('--surface'), stroke: accent, 'stroke-width': 2 })));
      }
      nodes.push(g);
    }

    if (this.measure) {
      const ps = [...this.measure.points, this.measure.done ? null : this.measure.hover].filter(Boolean);
      if (ps.length === 2) {
        const [a, b] = ps.map((p) => this.#toXY(p));
        if (a && b) {
          const up = ps[1].price >= ps[0].price;
          const c = up ? css('--up') : css('--down');
          const g = el('g', { class: 'measure' });
          g.append(el('rect', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), fill: c, 'fill-opacity': 0.15, stroke: c }));
          const dp = ps[1].price - ps[0].price;
          const pct = (dp / ps[0].price) * 100;
          const bars = Math.round(this.#timeToLogical(ps[1].time) - this.#timeToLogical(ps[0].time));
          const secs = Math.abs(ps[1].time - ps[0].time);
          const dur = secs >= 86400 ? `${(secs / 86400).toFixed(1)}d` : secs >= 3600 ? `${(secs / 3600).toFixed(1)}h` : `${Math.round(secs / 60)}m`;
          const t = el('text', { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 8, 'text-anchor': 'middle', fill: c, 'font-size': 12, 'font-weight': 600 });
          t.textContent = `${dp >= 0 ? '+' : ''}${fmtPrice(dp)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bars} bars · ${dur}`;
          g.append(t);
          nodes.push(g);
        }
      }
    }

    this.svg.replaceChildren(...nodes);
  }
}
