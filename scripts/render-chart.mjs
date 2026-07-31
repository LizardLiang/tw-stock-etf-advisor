// render-chart.mjs — turn cached DB data into a standalone Tokyo Night candlestick HTML file.
//
//   node --experimental-sqlite scripts/render-chart.mjs 3017 --days 60
//   node --experimental-sqlite scripts/render-chart.mjs 2330 --days 90 -o C:/tmp/2330.html
//
// It only reads the DB (ohlc + markers) and the chart-template.html asset, swaps the single
// __CHART_DATA__ token for a JSON literal, and writes the result. The output is fully
// self-contained — no server, no packages, double-click to open. Make sure history is present
// first (fetch-history.mjs) and markers are recorded (seed-from-obsidian.mjs / add-marker.mjs).

import { openDb, getOhlc, getMarkers } from './db.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(__dir, '..', 'assets', 'chart-template.html');

const arg = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };

/** ISO date `days` trading-ish days back. We over-shoot by calendar days; SQL filters to real rows. */
function sinceDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - Math.ceil(days * 1.6) - 5); // ~1.6 calendar days per trading day + buffer
  return d.toISOString().slice(0, 10);
}

/** First positional token, skipping flags AND their values — a naive "first alphabetic token"
 * would swallow `-o out.html`'s value as a US ticker. */
function positionalCode(argv) {
  const FLAGS_WITH_VALUE = new Set(['--days', '-o', '--out']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('-')) { if (FLAGS_WITH_VALUE.has(argv[i])) i++; continue; }
    return argv[i];
  }
  return null;
}

function main() {
  const raw = positionalCode(process.argv.slice(2));
  const isTw = raw != null && /^\d{4,6}$/.test(raw);
  const isUs = raw != null && /^[A-Za-z][A-Za-z.\-]{0,9}$/.test(raw);
  if (!isTw && !isUs) { console.error('Usage: render-chart.mjs <code|TICKER> [--days N] [-o out.html]'); process.exit(1); }
  const code = isTw ? raw : raw.toUpperCase();
  const days = Number(arg('--days')) || 60;
  const from = sinceDate(days);

  const db = openDb();
  const stock = db.prepare('SELECT name, market FROM stocks WHERE code=?').get(code) || {};
  let ohlc = getOhlc(db, code, from).map(r => ({
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
  // keep at most `days` sessions (trim oldest if SQL returned extra)
  if (ohlc.length > days) ohlc = ohlc.slice(ohlc.length - days);
  // Signals (forward triggers) carry a date that may sit at/after the latest candle; keep ALL of
  // them regardless of the OHLC window so pending conditions still render. Past events are filtered
  // to the visible range.
  const all = getMarkers(db, code).map(m => ({
    date: m.date, action: m.action, price: m.price, reason: m.reason, note_link: m.note_link,
    status: m.status, condition: m.condition, outcome: m.outcome,
  }));
  const firstDate = ohlc.length ? ohlc[0].date : from;
  const markers = all.filter(m => m.action === 'signal' || m.date >= firstDate);
  db.close();

  if (!ohlc.length) {
    console.error(`No OHLC for ${code} since ${from}. Run: node --experimental-sqlite scripts/fetch-history.mjs ${code} --months 4`);
    process.exit(2);
  }

  const payload = {
    code, name: stock.name || '', market: stock.market || 'twse',
    generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
    ohlc, markers,
  };
  // Replace the exact statement (not the bare token — that also appears in the file's comment).
  const tpl = readFileSync(TEMPLATE, 'utf8');
  if (!tpl.includes('const DATA = __CHART_DATA__;')) {
    console.error('Template missing `const DATA = __CHART_DATA__;` placeholder.'); process.exit(3);
  }
  const html = tpl.replace('const DATA = __CHART_DATA__;', `const DATA = ${JSON.stringify(payload)};`);

  const out = arg('-o') || arg('--out')
    || join(homedir(), 'personal', 'stocks', 'charts', `${code}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}.html`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf8');
  console.log(`Wrote ${resolve(out)}  (${ohlc.length} sessions, ${markers.length} markers)`);
}

if (process.argv[1]?.endsWith('render-chart.mjs')) main();
