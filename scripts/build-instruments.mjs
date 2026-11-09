// Builds data/instruments/NSE.json and BSE.json from Upstox's public instrument
// files. Each output row is [tradingSymbol, name, instrumentKey, type].
// Run by .github/workflows/instruments.yml every week; run locally with:
//   node scripts/build-instruments.mjs
import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SRC = (ex) => `https://assets.upstox.com/market-quote/instruments/exchange/${ex}.json.gz`;

// Indices sometimes live in a separate file; make sure the main ones are always there.
const FIXED_INDICES = {
  NSE: [['NIFTY 50', 'Nifty 50', 'NSE_INDEX|Nifty 50', 'INDEX'], ['NIFTY BANK', 'Nifty Bank', 'NSE_INDEX|Nifty Bank', 'INDEX']],
  BSE: [['SENSEX', 'SENSEX', 'BSE_INDEX|SENSEX', 'INDEX']],
};

for (const ex of ['NSE', 'BSE']) {
  const res = await fetch(SRC(ex));
  if (!res.ok) throw new Error(`${ex}: HTTP ${res.status}`);
  const all = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
  const rows = [];
  const seen = new Set();
  for (const i of all) {
    const isEq = i.segment === `${ex}_EQ`;
    const isIdx = i.segment === `${ex}_INDEX`;
    if (!isEq && !isIdx) continue;
    if (!i.instrument_key || seen.has(i.instrument_key)) continue;
    seen.add(i.instrument_key);
    const symbol = isIdx ? String(i.name || i.trading_symbol).toUpperCase() : i.trading_symbol;
    rows.push([symbol, i.name || i.trading_symbol, i.instrument_key, isIdx ? 'INDEX' : 'EQ']);
  }
  for (const r of FIXED_INDICES[ex]) if (!seen.has(r[2])) rows.push(r);
  rows.sort((a, b) => (a[3] === b[3] ? a[0].localeCompare(b[0]) : a[3] === 'INDEX' ? -1 : 1));
  mkdirSync('data/instruments', { recursive: true });
  writeFileSync(`data/instruments/${ex}.json`, JSON.stringify({ rows }));
  console.log(`${ex}: ${rows.length} instruments`);
}
