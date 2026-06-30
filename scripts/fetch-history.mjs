// fetch-history.mjs — pull daily OHLCV history into the DB. Node built-ins only (global fetch).
//
//   node --experimental-sqlite scripts/fetch-history.mjs 2330 --months 4
//   node --experimental-sqlite scripts/fetch-history.mjs 6488 --months 3 --market tpex
//   node --experimental-sqlite scripts/fetch-history.mjs 3017 --months 6 --force
//
// Source of truth for prices (Rule 1: fetch real data, never derive):
//   TWSE  STOCK_DAY     — listed (上市) stocks, one month of daily OHLCV per call, JSON.
//   TPEx  st43_result   — OTC (上櫃) stocks, same idea, different shape.
//
// Two gotchas that bite every Taiwan-data scraper, handled here:
//   1. Dates are ROC/民國 ("115/06/02"). Gregorian year = ROC year + 1911.
//   2. Numbers carry thousands commas ("12,345,678") and prices may be "--" on no-trade days.
//
// We cache aggressively: months already populated in `ohlc` are skipped unless --force,
// so re-running to "top up" the latest month is cheap and TWSE-friendly (it rate-limits).

import { openDb, upsertStock, upsertOhlc, monthsPresent } from './db.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) tw-stock-etf-advisor/1.0';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '--' || t === 'X0.00') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** ROC "115/06/02" (or "115/6/2") → "2026-06-02". Returns null if unparseable. */
function rocToIso(roc) {
  const m = String(roc).trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** Last N months as ['YYYY','MM'] pairs, newest first, anchored on today. */
function recentMonths(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push([d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0')]);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

async function fetchTwseMonth(code, year, mm) {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${year}${mm}01&stockNo=${code}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TWSE HTTP ${res.status}`);
  const j = await res.json();
  if (j.stat !== 'OK' || !Array.isArray(j.data)) return { rows: [], name: null };
  // fields: 日期,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數,(註記)
  const rows = [];
  for (const r of j.data) {
    const date = rocToIso(r[0]);
    const close = num(r[6]);
    if (!date || close == null) continue; // skip no-trade / malformed rows
    rows.push({ date, open: num(r[3]), high: num(r[4]), low: num(r[5]), close, volume: num(r[1]) });
  }
  // title looks like "115年06月 2330 台積電 各日成交資訊" — pull the name if present.
  const name = j.title ? (j.title.match(/\d{4,6}\s+(\S+)\s+各日/)?.[1] ?? null) : null;
  return { rows, name };
}

async function fetchTpexMonth(code, year, mm) {
  // TPEx wants the ROC year. d=115/06 ; returns aaData rows: [日期,成交股數,成交金額,開盤,最高,最低,收盤,漲跌,筆數]
  const roc = year - 1911;
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${roc}/${mm}&stkno=${code}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TPEx HTTP ${res.status}`);
  const j = await res.json();
  const data = j.aaData || j.data || [];
  const rows = [];
  for (const r of data) {
    const date = rocToIso(r[0]);
    const close = num(r[6]);
    if (!date || close == null) continue;
    rows.push({ date, open: num(r[3]), high: num(r[4]), low: num(r[5]), close, volume: num(r[1]) });
  }
  return { rows, name: null };
}

export async function fetchHistory(db, code, { months = 4, market = 'twse', force = false } = {}) {
  const have = force ? new Set() : monthsPresent(db, code);
  const target = recentMonths(months);
  let total = 0, name = null;
  for (const [year, mm] of target) {
    const ym = `${year}-${mm}`;
    // Always refetch the current (newest) month so the latest sessions top up; skip older cached ones.
    const isCurrent = ym === target[0].join('-');
    if (!force && !isCurrent && have.has(ym)) continue;
    try {
      const { rows, name: n } = market === 'tpex'
        ? await fetchTpexMonth(code, year, mm)
        : await fetchTwseMonth(code, year, mm);
      if (n) name = n;
      for (const row of rows) { upsertOhlc(db, code, row); total++; }
      process.stderr.write(`  ${ym}: ${rows.length} rows\n`);
    } catch (e) {
      process.stderr.write(`  ${ym}: ${e.message} (skipped)\n`);
    }
    await sleep(1200); // be gentle; TWSE blocks rapid hits
  }
  upsertStock(db, code, name, market);
  return total;
}

async function main() {
  const argv = process.argv.slice(2);
  const code = argv.find(a => /^\d{4,6}$/.test(a));
  if (!code) { console.error('Usage: fetch-history.mjs <code> [--months N] [--market twse|tpex] [--force]'); process.exit(1); }
  const months = Number(argv[argv.indexOf('--months') + 1]) || 4;
  const market = argv.includes('--market') ? argv[argv.indexOf('--market') + 1] : 'twse';
  const force = argv.includes('--force');

  const db = openDb();
  process.stderr.write(`Fetching ${code} (${market}), ${months} months...\n`);
  const n = await fetchHistory(db, code, { months, market, force });
  const span = db.prepare('SELECT min(date) lo, max(date) hi, count(*) c FROM ohlc WHERE code=?').get(code);
  console.log(`${code}: upserted ${n} rows; DB now holds ${span.c} sessions ${span.lo}…${span.hi}`);
  db.close();
}

if (process.argv[1]?.endsWith('fetch-history.mjs')) main();
