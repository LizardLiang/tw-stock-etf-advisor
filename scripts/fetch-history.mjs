// fetch-history.mjs — pull daily OHLCV history into the DB. Node built-ins only (global fetch).
//
//   node --experimental-sqlite scripts/fetch-history.mjs 2330 --months 4
//   node --experimental-sqlite scripts/fetch-history.mjs 6488 --months 3 --market tpex
//   node --experimental-sqlite scripts/fetch-history.mjs 3017 --months 6 --force
//   node --experimental-sqlite scripts/fetch-history.mjs NVDA --months 6
//   node --experimental-sqlite scripts/fetch-history.mjs SPY --months 24        (seeds the US calendar)
//   node --experimental-sqlite scripts/fetch-history.mjs AAPL --source stooq    (explicit fallback)
//
// Source of truth for prices (Rule 1: fetch real data, never derive):
//   TWSE  STOCK_DAY     — listed (上市) stocks, one month of daily OHLCV per call, JSON.
//   TPEx  tradingStock  — OTC (上櫃) stocks, same idea, different shape.
//   Yahoo v8 chart      — US stocks/ETFs, whole range in one call, JSON (alphabetic tickers).
//   Stooq CSV           — US fallback, opt-in via --source stooq ONLY — never auto-fallback:
//                         silent source switching is the same degradation class as endpoint rot.
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

import { openDb, upsertStock, upsertOhlc, monthsPresent, marketForCode, deriveHolidaysFromOhlc } from './db.mjs';

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

// ---- US (Yahoo v8 chart / Stooq CSV) ------------------------------------------------------

/**
 * Parse a Yahoo v8 chart payload into OHLC rows. Pure — exported for golden tests.
 * Shape: { chart: { result: [{ meta, timestamp:[epochSec], indicators: { quote: [{open,high,
 * low,close,volume}] } }], error: null } }. Yahoo can answer HTTP 200 WITH an error object
 * (bad/delisted ticker), so chart.error is checked here, by name — never a silent 0 rows.
 *
 * Dates: epoch seconds → ISO via the exchange's OWN timezone (meta.exchangeTimezoneName,
 * America/New_York) — never UTC slicing, which lands an evening ET timestamp on the wrong day.
 * Prices: the raw quote arrays (split-adjusted by Yahoo; refetch after a split), NOT adjclose —
 * matches the TW convention of settled closes with dividends handled by Rule 6i, not restated.
 */
export function parseYahooChart(json) {
  if (!json || typeof json !== 'object' || !json.chart) {
    throw new Error('Yahoo: unexpected response shape (no chart) — endpoint or schema moved');
  }
  if (json.chart.error) {
    const e = json.chart.error;
    throw new Error(`Yahoo: chart.error ${e.code ?? '?'} — ${e.description ?? JSON.stringify(e)}`);
  }
  const result = json.chart.result?.[0];
  if (!result) throw new Error('Yahoo: chart.result[0] missing — empty result for this ticker/range');
  const q = result.indicators?.quote?.[0];
  if (!q) throw new Error('Yahoo: indicators.quote[0] missing — schema moved');
  const tz = result.meta?.exchangeTimezoneName || 'America/New_York';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const rows = [];
  const ts = result.timestamp ?? [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue; // null bar (holiday padding / halt) — skip, don't write NaN
    rows.push({
      date: fmt.format(new Date(ts[i] * 1000)),
      open: q.open?.[i] ?? null, high: q.high?.[i] ?? null, low: q.low?.[i] ?? null,
      close, volume: q.volume?.[i] ?? null,
    });
  }
  return { rows, name: result.meta?.longName || result.meta?.shortName || null };
}

async function fetchYahooRange(code, months) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - Math.round(months * 31 * 86400); // generous month bound; upsert dedupes
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}`
    + `?period1=${period1}&period2=${period2}&interval=1d&events=split`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const j = await readJson(res, 'Yahoo', url);
  return parseYahooChart(j);
}

/**
 * Parse a Stooq daily CSV into OHLC rows. Pure — exported for golden tests. The header line is
 * the CSV analogue of readJson's content-type assertion: Stooq answers "No data" (or an HTML
 * page) on bad tickers, and that must fail by name, not parse into zero rows.
 */
export function parseStooqCsv(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/);
  if (lines[0] !== 'Date,Open,High,Low,Close,Volume') {
    // Observed live (2026-07-31): Stooq can answer a JS browser-challenge page to plain fetch.
    // Truncate the junk — the point is the named failure, not the HTML dump.
    const got = String(lines[0] ?? '').slice(0, 60);
    throw new Error(`Stooq: unexpected CSV header "${got}…" — endpoint moved, JS challenge, or ticker unknown`);
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const [date, open, high, low, close, volume] = line.split(',');
    const c = num(close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || c == null) continue;
    rows.push({ date, open: num(open), high: num(high), low: num(low), close: c, volume: num(volume) });
  }
  return rows;
}

async function fetchStooqRange(code, months) {
  const d2 = new Date();
  const d1 = new Date();
  d1.setMonth(d1.getMonth() - months);
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const url = `https://stooq.com/q/d/l/?s=${code.toLowerCase()}.us&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  return { rows: parseStooqCsv(await res.text()), name: null };
}

/**
 * US history: one ranged call (no per-month loop), upserted idempotently. Unlike the TW loop
 * there is NO per-month catch — a failed US fetch throws all the way out, loudly, with the
 * --source stooq escape hatch named in the hint. After a successful fetch the US-scoped
 * trading calendar is re-derived so Rule 6h's NYSE counter self-updates (SPY = full calendar).
 */
export async function fetchUsHistory(db, code, { months = 4, source = 'yahoo' } = {}) {
  let fetched;
  try {
    fetched = source === 'stooq' ? await fetchStooqRange(code, months) : await fetchYahooRange(code, months);
  } catch (e) {
    e.message += source === 'stooq' ? '' : ' — retry with --source stooq if Yahoo is blocking';
    throw e;
  }
  const { rows, name } = fetched;
  for (const row of rows) upsertOhlc(db, code, row);
  upsertStock(db, code, name, 'us');
  const derived = deriveHolidaysFromOhlc(db, 'us');
  process.stderr.write(`  ${source}: ${rows.length} rows; US calendar derived +${derived.added} closures\n`);
  return rows.length;
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

/** First positional token (flags AND their values skipped) — a US ticker like "AAPL" must not
 * be shadowed by a flag value, and a flag value like "--months 6" must not be read as a code. */
const FLAGS_WITH_VALUE = new Set(['--months', '--market', '--source']);
function positionalCode(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (FLAGS_WITH_VALUE.has(argv[i])) i++; continue; }
    return argv[i];
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const usage = 'Usage: fetch-history.mjs <code|TICKER> [--months N] [--market twse|tpex|us] [--source yahoo|stooq] [--force]';
  const raw = positionalCode(argv);
  const isTw = raw != null && /^\d{4,6}$/.test(raw);
  const isUs = raw != null && /^[A-Za-z][A-Za-z.\-]{0,9}$/.test(raw);
  if (!isTw && !isUs) { console.error(usage); process.exit(1); }
  const code = isTw ? raw : raw.toUpperCase();
  const months = Number(argv[argv.indexOf('--months') + 1]) || 4;
  const family = marketForCode(code);
  const market = argv.includes('--market') ? argv[argv.indexOf('--market') + 1]
    : family === 'us' ? 'us' : 'twse';
  const source = argv.includes('--source') ? argv[argv.indexOf('--source') + 1] : 'yahoo';
  const force = argv.includes('--force');
  // A numeric code routed to Yahoo (or a ticker to TWSE) would silently fetch the wrong
  // instrument's calendar/history — refuse the mismatch by name instead.
  if ((family === 'us') !== (market === 'us')) {
    console.error(`fetch-history: code "${code}" is a ${family} instrument but --market is "${market}" — mismatch refused`);
    process.exit(1);
  }

  const db = openDb();
  process.stderr.write(`Fetching ${code} (${market}), ${months} months...\n`);
  const n = market === 'us'
    ? await fetchUsHistory(db, code, { months, source })
    : await fetchHistory(db, code, { months, market, force });
  const span = db.prepare('SELECT min(date) lo, max(date) hi, count(*) c FROM ohlc WHERE code=?').get(code);
  console.log(`${code}: upserted ${n} rows; DB now holds ${span.c} sessions ${span.lo}…${span.hi}`);
  db.close();
}

// The US path throws loudly (no per-month catch) — surface it as the named error + exit 1,
// never an unhandled-rejection stack trace.
if (process.argv[1]?.endsWith('fetch-history.mjs')) {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
