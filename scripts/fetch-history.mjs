// fetch-history.mjs — pull daily OHLCV history into the DB. Node built-ins only (global fetch).
//
//   node --experimental-sqlite scripts/fetch-history.mjs 2330 --months 4
//   node --experimental-sqlite scripts/fetch-history.mjs 6488 --months 3 --market tpex
//   node --experimental-sqlite scripts/fetch-history.mjs 3017 --months 6 --force
//
// Source of truth for prices (Rule 1: fetch real data, never derive):
//   TWSE  STOCK_DAY     — listed (上市) stocks, one month of daily OHLCV per call, JSON.
//   TPEx  tradingStock  — OTC (上櫃) stocks, same idea, different shape.
//
// Three gotchas that bite every Taiwan-data scraper, handled here:
//   1. Dates are ROC/民國 ("115/06/02"). Gregorian year = ROC year + 1911.
//   2. Numbers carry thousands commas ("12,345,678") and prices may be "--" on no-trade days.
//   3. **TPEx reports volume in 張 (lots), TWSE in 股 (shares).** We normalize TPEx to shares
//      (×1000) so `ohlc.volume` means the same thing in both markets — Rule 6j's 量比 and
//      Rule 6q's liquidity check both read that column and would be off by 1000× otherwise.
//
// Endpoint-rot guard (2026-07-29): both fetchers assert a JSON content-type before parsing.
// TPEx retired `web/stock/aftertrading/daily_trading_info/st43_result.php` and now serves an
// HTML 404 page there; the old code called res.json() on it, threw, and the per-month catch
// printed "(skipped)" — so every 上櫃 stock silently came back with 0 rows and got stuck at
// Rule 6q grade C. Same silent-degradation class as the 2026-07-28 TWSE `exchangeReport`
// cache bug. A moved endpoint must now fail loudly and by name.
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

/** Throw a named error when a data endpoint starts serving HTML (moved/retired path). */
async function readJson(res, label, url) {
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!/json/i.test(ct)) {
    throw new Error(`${label} returned non-JSON (content-type: ${ct || 'none'}) — endpoint likely moved: ${url}`);
  }
  return res.json();
}

/**
 * Parse a TPEx `tradingStock` payload into OHLC rows. Pure — exported for golden tests.
 * Shape: { stat:'ok', tables:[{ fields:[日期,成交張數,成交仟元,開盤,最高,最低,收盤,漲跌,筆數], data:[[...]] }] }
 * Volume arrives in 張 and is normalized to 股 (×1000) to match TWSE.
 */
export function parseTpexMonth(json) {
  if (!json || !Array.isArray(json.tables)) {
    throw new Error('TPEx: unexpected response shape (no tables[]) — endpoint or schema moved');
  }
  if (json.stat && String(json.stat).toLowerCase() !== 'ok') {
    throw new Error(`TPEx: stat=${json.stat}`);
  }
  const data = json.tables[0]?.data ?? [];
  const rows = [];
  for (const r of data) {
    const date = rocToIso(r[0]);
    const close = num(r[6]);
    if (!date || close == null) continue; // skip no-trade / malformed rows
    const lots = num(r[1]);
    rows.push({
      date,
      open: num(r[3]), high: num(r[4]), low: num(r[5]), close,
      volume: lots == null ? null : lots * 1000, // 張 → 股 (gotcha 3)
    });
  }
  return rows;
}

async function fetchTwseMonth(code, year, mm) {
  // `rwd/zh/afterTrading` is the current path (the legacy `exchangeReport` one served a stale
  // cached month on 2026-07-28 — 3037/2330 silently came back without that day's settled bar,
  // which then degrades ATR/KD/量比 downstream with no error). Cache-buster for the same reason.
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?response=json&date=${year}${mm}01&stockNo=${code}&_=${Date.now()}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
  const j = await readJson(res, 'TWSE', url);
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
  // Current path (the legacy `web/stock/aftertrading/daily_trading_info/st43_result.php` was
  // retired and now serves an HTML 404). Unlike the old one, `date` is GREGORIAN (2026/07/01)
  // even though the rows inside still carry ROC dates ("115/07/01").
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${year}/${mm}/01&id=&response=json`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
  const j = await readJson(res, 'TPEx', url);
  return { rows: parseTpexMonth(j), name: j.name || null };
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
