// Forex reference rates from the European Central Bank via frankfurter.app (no key needed).
// ECB publishes one rate per business day, so only daily and weekly charts are available.
import { aggregate } from '../timeframes.js';

const API = 'https://api.frankfurter.app';
export const timeframes = ['1D', '1W'];
const WEEK_ALIGN = 345600; // Monday 00:00 UTC

const iso = (d) => d.toISOString().slice(0, 10);

async function fetchRates(base, quote, days) {
  const start = new Date(Date.now() - days * 86400000);
  const res = await fetch(`${API}/${iso(start)}..?from=${base}&to=${quote}`);
  if (!res.ok) throw new Error(`Forex rates ${res.status}`);
  const json = await res.json();
  return Object.entries(json.rates)
    .map(([date, r]) => ({ time: Date.parse(date + 'T00:00:00Z') / 1000, rate: r[quote] }))
    .sort((a, b) => a.time - b.time);
}

function ratesToBars(rates) {
  const bars = [];
  for (let i = 0; i < rates.length; i++) {
    const close = rates[i].rate;
    const open = i ? rates[i - 1].rate : close;
    bars.push({ time: rates[i].time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0 });
  }
  return bars;
}

export async function getCandles(sym, tf) {
  if (!timeframes.includes(tf)) throw new Error('Forex data is daily (ECB reference rates). Pick 1D or 1W.');
  const bars = ratesToBars(await fetchRates(sym.base, sym.quote, tf === '1W' ? 365 * 10 : 365 * 4));
  return tf === '1W' ? aggregate(bars, 604800, WEEK_ALIGN) : bars;
}

export function subscribeCandles() {
  return () => {}; // daily data: nothing streams intraday
}

export function subscribeTickers(syms, onTick) {
  let stopped = false;
  async function poll() {
    for (const s of syms) {
      try {
        const rates = await fetchRates(s.base, s.quote, 10);
        if (stopped || rates.length === 0) return;
        const last = rates.at(-1).rate;
        const prev = rates.length > 1 ? rates.at(-2).rate : last;
        onTick(s, { price: last, changePct: prev ? ((last - prev) / prev) * 100 : 0, ts: Date.now() });
      } catch { /* try again next poll */ }
    }
  }
  poll();
  const timer = setInterval(poll, 15 * 60 * 1000);
  return () => { stopped = true; clearInterval(timer); };
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'AUD', 'CAD', 'CHF', 'NZD', 'CNY', 'SGD', 'HKD', 'SEK', 'NOK', 'ZAR', 'MXN', 'KRW', 'TRY'];

export function makePair(base, quote) {
  return { market: 'forex', ticker: base + quote, name: `${base} / ${quote}`, base, quote };
}

export async function search(query) {
  const q = query.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (q.length < 3) return [];
  const out = [];
  for (const b of CURRENCIES) for (const c of CURRENCIES) {
    if (b !== c && (b + c).includes(q)) out.push(makePair(b, c));
  }
  return out.slice(0, 30);
}
