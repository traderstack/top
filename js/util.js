// Small DOM, formatting and storage helpers shared by every module.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element: h('div', {class: 'x', onclick}, 'text', child) */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') node[k] = !!v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Replace an element's children, skipping null/false entries. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

/** localStorage wrapper that never throws (private mode, blocked storage). */
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('ts.' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('ts.' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  del(key) {
    try { localStorage.removeItem('ts.' + key); } catch { /* ignore */ }
  },
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function decimalsFor(price) {
  const a = Math.abs(price);
  if (!isFinite(a) || a === 0) return 2;
  if (a >= 1000) return 2;
  if (a >= 1) return a >= 100 ? 2 : 4;
  if (a >= 0.01) return 5;
  return 8;
}

export function fmtPrice(v, decimals) {
  if (v == null || !isFinite(v)) return '—';
  const d = decimals ?? decimalsFor(v);
  return v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

const CCY_SYMBOL = { INR: '₹', USD: '$', USDT: '$', EUR: '€', GBP: '£', JPY: '¥' };
export function fmtMoney(v, ccy = 'INR') {
  if (v == null || !isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const s = CCY_SYMBOL[ccy] ?? '';
  return sign + s + Math.abs(v).toLocaleString(ccy === 'INR' ? 'en-IN' : 'en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }) + (s ? '' : ' ' + ccy);
}

export function fmtPct(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(digits) + '%';
}

export function fmtQty(v) {
  if (v == null || !isFinite(v)) return '—';
  return Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { maximumFractionDigits: 6 });
}

export function fmtTime(sec, withTime = true) {
  const d = new Date(sec * 1000);
  const opts = withTime
    ? { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { day: '2-digit', month: 'short', year: 'numeric' };
  return d.toLocaleString('en-IN', opts);
}

export const clsUpDown = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export class Emitter {
  #handlers = new Map();
  on(evt, fn) {
    if (!this.#handlers.has(evt)) this.#handlers.set(evt, new Set());
    this.#handlers.get(evt).add(fn);
    return () => this.#handlers.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    for (const fn of this.#handlers.get(evt) ?? []) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }
}

let toastBox;
export function toast(message, kind = 'info', ms = 4000) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: `toast ${kind}` }, message);
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** WebSocket that reconnects with backoff until closed by the caller. */
export class ReconnectingSocket {
  constructor(getUrl, { onOpen, onMessage, onStatus, binary = false } = {}) {
    this.getUrl = getUrl;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.binary = binary;
    this.closed = false;
    this.attempt = 0;
    this.connect();
  }
  async connect() {
    if (this.closed) return;
    let url;
    try { url = await this.getUrl(); } catch (e) { this.onStatus?.('error', e); return this.retry(); }
    if (this.closed) return;
    const ws = new WebSocket(url);
    if (this.binary) ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.onStatus?.('open'); this.onOpen?.(ws); };
    ws.onmessage = (e) => this.onMessage?.(e.data, ws);
    ws.onclose = () => { this.onStatus?.('closed'); if (!this.closed) this.retry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  retry() {
    if (this.closed) return;
    const delay = Math.min(30000, 1000 * 2 ** this.attempt++);
    this.timer = setTimeout(() => this.connect(), delay);
  }
  send(data) { if (this.ws?.readyState === 1) this.ws.send(data); }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
