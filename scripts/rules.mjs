// rules.mjs — stateless rule-math calculators for the tw-stock-etf-advisor skill
// (rule-math-mechanization delta, 2026-07-20). Five inputs-in/verdict-out subcommands.
// The model supplies judgment inputs (event dates, anchors, assumption statuses, theme
// grouping) and reads the JSON back — it must NOT hand-compute any of these numbers.
// Zero dependency: built-in node:sqlite (earnings only, for the holidays table) + node:fs.
//
//   node --experimental-sqlite scripts/rules.mjs earnings --event YYYY-MM-DD [--from YYYY-MM-DD] [--sync-holidays]
//   node --experimental-sqlite scripts/rules.mjs band --style 1|2|3 --anchor A [--price P] [--breakout-pct N]
//   node --experimental-sqlite scripts/rules.mjs heat --json legs.json --equity E [--cap 2]
//   node --experimental-sqlite scripts/rules.mjs thesis --json thesis.json
//   node --experimental-sqlite scripts/rules.mjs deviate --a V1 --b V2 --kind price|weight|indicator|quote-vs-close
//
// House style: one JSON object per invocation on stdout, non-zero exit + stderr message on
// bad input. `earnings` is the only verb that opens the DB (for the `holidays` table); the
// other four are pure functions with no DB dependency, exported for testing.

import { readFileSync } from 'node:fs';
import {
  openDb, getHolidaySet, upsertHoliday,
  getOhlcDateRange, getTradingDatesInRange, deriveHolidaysFromOhlc,
  getVerifiedIntervals, isRangeFullyVerified, markYearSynced,
} from './db.mjs';

// ---- math helpers (mirrors screen.mjs's r1/r2 convention) --------------------------------

const r1 = (x) => x == null ? null : Math.round(x * 10) / 10;
const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextIsoDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isWeekend(iso) {
  const day = new Date(`${iso}T00:00:00`).getDay();
  return day === 0 || day === 6;
}

// ---- #2 6h earnings blackout ---------------------------------------------------------------
//
// PINNED counting convention (this is the whole rule — get it wrong and a trade decision
// flips): tradingDaysAway = trading sessions STRICTLY AFTER `from`, UP TO AND INCLUDING
// `event`. 2026-07-20 -> 2026-07-28 must equal 6 (7/21,22,23,24,27,28 — 7/25,26 are the
// weekend). `blackout` fires at tradingDaysAway <= 5 (Rule 6h).
//
// FAIL-LOUD coverage design (2026-07-20 review, user-approved — the static holidays table has
// now missed a real closure TWICE: 4/6+7/10 the first round, 2/27+10/9 this round. Taiwan
// make-up holidays and typhoon closures cannot be enumerated in advance, so the failure mode
// changes rather than patching the list again):
//   - VERIFIED coverage = ohlc-derived span UNION years actually synced from TWSE with a
//     non-empty parse (db.mjs getVerifiedIntervals). The static builtin table is a best-effort
//     ACCURACY AID ONLY — it never by itself marks a range verified.
//   - Any [from,event] range not FULLY inside verified coverage → `coverageVerified: false` +
//     an explicit `warning`, always — never silently trusted.
//   - Per-day classification, in priority order:
//       1. Inside the ohlc-derived span — AUTHORITATIVE (a weekday with zero rows anywhere is
//          a genuine closure). Self-updates as fetch-history.mjs pulls more.
//       2. In the `holidays` table (builtin/twse/derived, any source) — KNOWN closure.
//       3. Weekday strictly BEFORE the ohlc-derived span's start, not in the table — UNCERTAIN:
//          a past date we have no record for at all (a real data gap, not "hasn't happened
//          yet"). Counted optimistically in tradingDaysAway like before, but ALSO tallied so
//          the conservative check below can catch it.
//       4. Weekday strictly AFTER the ohlc-derived span's end (ordinary future date, not yet
//          fetched, not yet synced) — optimistic, uncounted as "uncertain": a typhoon 3 months
//          out is fundamentally unknowable in advance, and treating every unsynced future date
//          as a potential closure would make 6h fire blackout on almost every forward-looking
//          check, defeating the rule. `--sync-holidays` is the correct tool for verifying
//          future dates once TWSE has published them.
//   - Conservative blackout under uncertainty (case 3 only): if
//     `tradingDaysAway - uncertainPastCount <= 5`, force `blackout: true` and say so in
//     `verdict` — better a false blackout on a genuine data gap than a false all-clear.
export function earnings(db, { event, from, market = 'tw', holidaysCrossed: _unused } = {}) {
  if (!isIsoDate(event)) return { error: `--event must be an ISO date (YYYY-MM-DD), got "${event}"` };
  if (from != null && !isIsoDate(from)) return { error: `--from must be an ISO date (YYYY-MM-DD), got "${from}"` };
  if (market !== 'tw' && market !== 'us') return { error: `--market must be tw or us, got "${market}"` };
  const fromDate = from ?? isoToday();
  if (event < fromDate) return { error: `--event (${event}) must be on or after --from (${fromDate})` };

  // Self-updating: persist any newly-observed closure inside ohlc's current span (idempotent).
  // Market-scoped (US delta): each market has its own calendar — NYSE trades right through
  // 春節, and Thanksgiving is a normal TWSE session.
  deriveHolidaysFromOhlc(db, market);

  const ohlcRange = getOhlcDateRange(db, market);
  const tradingDates = (ohlcRange.from && ohlcRange.to)
    ? getTradingDatesInRange(db, ohlcRange.from, ohlcRange.to, market) : new Set();
  const holidaySet = getHolidaySet(db, fromDate, event, market); // fallback table (builtin/derived)

  const crossed = [];
  let tradingDaysAway = 0;
  let uncertainCount = 0;
  let cursor = nextIsoDay(fromDate);
  while (cursor <= event) {
    if (!isWeekend(cursor)) {
      const withinOhlc = ohlcRange.from && ohlcRange.to && cursor >= ohlcRange.from && cursor <= ohlcRange.to;
      if (withinOhlc) {
        if (tradingDates.has(cursor)) tradingDaysAway++;
        else crossed.push(cursor);
      } else if (holidaySet.has(cursor)) {
        crossed.push(cursor);
      } else {
        tradingDaysAway++; // optimistic either way — see cases 3/4 above
        const isPastUnverifiedGap = ohlcRange.from != null && cursor < ohlcRange.from;
        if (isPastUnverifiedGap) uncertainCount++;
      }
    }
    cursor = nextIsoDay(cursor);
  }

  const blackout = (tradingDaysAway - uncertainCount) <= 5;
  const conservative = uncertainCount > 0 && tradingDaysAway > 5 && blackout;
  const verdict = blackout
    ? `blackout — 距財報 ${tradingDaysAway} 個交易日（≤5），財報前不建議新進場`
      + (conservative ? `（含 ${uncertainCount} 個資料缺口日，conservative-under-uncertainty 保守認定）` : '')
    : `clear — 距財報 ${tradingDaysAway} 個交易日`
      + (uncertainCount > 0 ? `（含 ${uncertainCount} 個資料缺口日，尚未驗證）` : '');

  const out = {
    eventDate: event, fromDate, tradingDaysAway, blackout, verdict, holidaysCrossed: crossed,
    uncertainCount,
  };

  // R5 / T1.1: never silently trust an unverified range. coverageVerified is a machine-readable
  // flag; warning is the human-readable explanation. Real interval union (db.mjs mergeIntervals)
  // — NOT a min/max bounding box, which would hide a genuine GAP between the ohlc-derived span
  // and a synced year.
  const verified = getVerifiedIntervals(db, market);
  const coverageVerified = isRangeFullyVerified(verified, fromDate, event);
  out.coverageVerified = coverageVerified;
  if (!coverageVerified) {
    out.warning = market === 'us'
      ? `[${fromDate}, ${event}] is not fully inside VERIFIED US coverage (the US-scoped `
        + `ohlc-derived span is the ONLY verified source — no NYSE sync endpoint exists). `
        + `Verified intervals: ${JSON.stringify(verified)}. Extend coverage with `
        + `fetch-history.mjs SPY --months 24 (SPY trades every NYSE session).`
      : `[${fromDate}, ${event}] is not fully inside VERIFIED coverage (ohlc-derived `
        + `span + TWSE-synced years only — the static builtin table alone never counts as `
        + `verified). Verified intervals: ${JSON.stringify(verified)}. Run --sync-holidays to `
        + `verify the years this range touches.`;
  }
  return out;
}

// ---- #3 6l trigger validity band -----------------------------------------------------------

export function band({ style, anchor, price, breakoutPct } = {}) {
  if (![1, 2, 3].includes(style)) return { error: '--style must be 1 (generic anchor), 2 (breakout pivot), or 3 (reversal close)' };
  if (typeof anchor !== 'number' || !(anchor > 0)) return { error: '--anchor must be a positive number' };

  const bandPct = style === 1 ? 2 : style === 2 ? (breakoutPct ?? 3) : 1;
  const bandLo = anchor;
  const bandHi = r2(anchor * (1 + bandPct / 100));
  const out = { anchor, bandLo, bandHi, bandPct };

  if (price != null) {
    if (typeof price !== 'number' || !(price > 0)) return { error: '--price must be a positive number' };
    const fired = price >= bandLo;
    const lateFire = price > bandHi;
    out.fired = fired;
    out.lateFire = lateFire;
    // excessPct is relative to the band's OUTER edge (bandHi), not the raw anchor — this is
    // what "超出有效帶 X%" (Rule 6l) means: how far beyond the valid band the fire landed.
    out.excessPct = lateFire ? r2((price - bandHi) / bandHi * 100) : null;
  }
  return out;
}

// ---- #4 6e-3 per-theme heat cap -------------------------------------------------------------

export function heat({ legs, equity, cap } = {}) {
  if (!Array.isArray(legs) || !legs.length) return { error: '--json must contain a non-empty legs[] array' };
  if (typeof equity !== 'number' || !(equity > 0)) return { error: '--equity must be a positive number' };
  const capPct = cap ?? 2;

  const outLegs = [];
  for (const leg of legs) {
    if (leg.code == null || typeof leg.entry !== 'number' || typeof leg.stop !== 'number') {
      return { error: `each leg needs {code, entry, stop}; got ${JSON.stringify(leg)}` };
    }
    const oneR = leg.entry - leg.stop;
    if (!(oneR > 0)) return { error: `leg ${leg.code}: entry (${leg.entry}) must be greater than stop (${leg.stop})` };
    // Rule 6e-2 default sizing when a leg doesn't already state its shares.
    const shares = leg.shares ?? Math.floor((equity * 0.01) / oneR);
    const riskAmt = r1(shares * oneR);
    const riskPct = r2(riskAmt / equity * 100);
    outLegs.push({ code: leg.code, oneR: r1(oneR), riskAmt, riskPct, shares });
  }

  const themeHeatPct = r2(outLegs.reduce((s, l) => s + l.riskPct, 0));
  const overCap = themeHeatPct > capPct;
  const scaleFactor = overCap ? r2(capPct / themeHeatPct) : 1;
  for (const l of outLegs) l.sharesAtCap = overCap ? Math.floor(l.shares * scaleFactor) : l.shares;

  return { legs: outLegs, themeHeatPct, cap: capPct, overCap, scaleFactor };
}

// ---- #7 6o thesis health score ---------------------------------------------------------------

const STATUS_WEIGHT = { black: 3, red: 2, yellow: 1, green: 0 };
const STATUS_LABEL = { black: '⚫', red: '🔴', yellow: '🟡' };

export function thesis({ assumptions, redLines } = {}) {
  if (!Array.isArray(assumptions) || !assumptions.length) return { error: '--json must contain a non-empty assumptions[] array' };
  const counts = { green: 0, yellow: 0, red: 0, black: 0 };
  for (const a of assumptions) {
    if (a == null || typeof a !== 'object') return { error: `each assumptions[] entry must be an object with {name, status}, got ${JSON.stringify(a)}` };
    if (!(a.status in counts)) return { error: `assumption "${a.name}": status must be green|yellow|red|black, got "${a.status}"` };
    counts[a.status]++;
  }
  if (redLines != null) {
    if (!Array.isArray(redLines)) return { error: `redLines must be an array when provided, got ${JSON.stringify(redLines)}` };
    for (const r of redLines) {
      if (r == null || typeof r !== 'object') return { error: `each redLines[] entry must be an object with {name, triggered}, got ${JSON.stringify(r)}` };
      if (typeof r.triggered !== 'boolean') return { error: `redLine "${r.name}": triggered must be a boolean, got ${JSON.stringify(r.triggered)}` };
    }
  }
  const redLinesTriggered = (redLines ?? []).filter(r => r.triggered).length;

  const health = 10 - 3 * counts.black - 2 * counts.red - 1 * counts.yellow - 5 * redLinesTriggered;

  // Compact breakdown, e.g. "10 − 3×1(⚫) − 1×1(🟡) = 6" (thesis-tracking.md §2) — only
  // nonzero terms are shown; never a silent total.
  const terms = [];
  for (const key of ['black', 'red', 'yellow']) {
    if (counts[key] > 0) terms.push(`${STATUS_WEIGHT[key]}×${counts[key]}(${STATUS_LABEL[key]})`);
  }
  if (redLinesTriggered > 0) terms.push(`5×${redLinesTriggered}(red lines)`);
  const breakdown = terms.length ? `10 − ${terms.join(' − ')} = ${health}` : `10 = ${health}`;

  // A triggered red line forces the Rule 6n binary regardless of score — it does not soften.
  const forcedBinary = redLinesTriggered > 0 || health <= 3;
  const action = forcedBinary
    ? 'exit or formal re-underwrite (Rule 6n binary)'
    : health >= 9 ? 'hold/add-eligible'
    : health >= 7 ? 'hold'
    : 'reduce';

  return { counts, redLinesTriggered, health, breakdown, action, forcedBinary };
}

// ---- #9 3a cross-source deviation ------------------------------------------------------------

export function deviate({ a, b, kind, market = 'tw' } = {}) {
  if (typeof a !== 'number' || typeof b !== 'number') return { error: '--a and --b must both be numbers' };
  if (market !== 'tw' && market !== 'us') return { error: `--market must be tw or us, got "${market}"` };
  const deltaAbs = r2(Math.abs(a - b));
  const rawPct = b !== 0 ? Math.abs(a - b) / b * 100 : null;
  const deltaPct = rawPct != null ? r2(rawPct) : null;
  // b=0 with a disagreeing nonzero a is very likely a failed/zero fetch (a stale scrape, a
  // parse miss) masquerading as the baseline — NOT genuine agreement. Percentage deviation is
  // undefined here (div-by-zero), so treat it as maximal, not 'ok' (2026-07-20 review finding —
  // a $0 baseline must never read as perfect agreement).
  const zeroBaseline = b === 0 && a !== 0;

  let threshold, verdict, note;
  if (kind === 'price' || kind === 'weight') {
    threshold = { flag: 1, block: 5 };
    if (zeroBaseline) {
      verdict = '封鎖';
      note = 'b=0 with a≠0 — cannot compute a meaningful %; treated as maximal deviation, not agreement';
    } else {
      // Compare on the 1-decimal DISPLAY value (matches how the rule reads in practice — a
      // reading that rounds to "1.0%" is flagged, not silently let through by fp fuzz just
      // under the raw 1.000% line).
      const p1 = rawPct != null ? r1(rawPct) : null;
      verdict = p1 == null ? 'ok' : p1 >= 5 ? '封鎖' : p1 >= 1 ? '標註' : 'ok';
    }
  } else if (kind === 'indicator') {
    threshold = { flag: 3 };
    verdict = deltaAbs > 3 ? '標註' : 'ok';
  } else if (kind === 'quote-vs-close') {
    // Plausibility bound per market: TW 10% = the 漲跌停 daily limit, so a bigger gap can
    // only be a bad fetch. US has no daily limit (LULD halts are intraday only) and real
    // earnings gaps of 10-18% happen (NVDA/META precedents) — a 10% bound would flag real
    // moves as fetch errors and stall Action C. 20% still catches wrong-ticker/stale-page.
    const bound = market === 'us' ? 20 : 10;
    threshold = { refetch: bound };
    // Timing exemption (Rule 3a): a live-vs-T-1-close gap beyond the plausibility bound is a
    // suspect fetch, not a conflict — 'refetch', never '封鎖'. A zero baseline is the same
    // "suspect fetch" story, so it also resolves to 'refetch', not a false 'ok'.
    if (zeroBaseline) { verdict = 'refetch'; note = 'b=0 with a≠0 — suspect fetch, not agreement'; }
    else verdict = rawPct != null && rawPct > bound ? 'refetch' : 'ok';
  } else {
    return { error: `--kind must be price|weight|indicator|quote-vs-close, got "${kind}"` };
  }
  return { a, b, deltaAbs, deltaPct, threshold, verdict, ...(note && { note }) };
}

// ---- --sync-holidays (the ONLY network call in this delta; opt-in) ---------------------------

async function fetchTwseHolidayYear(year) {
  const url = `https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?date=${year}&response=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 tw-stock-etf-advisor/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const table = (j.tables || []).find(t => (t.fields || []).some(f => /日期/.test(f)));
  if (!table) return [];
  const rows = [];
  for (const r of table.data || []) {
    const dateCell = r.find(c => /^\d{2,3}\/\d{1,2}\/\d{1,2}$/.test(String(c).trim()));
    if (!dateCell) continue;
    const m = String(dateCell).trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
    const iso = `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const nameCell = r.find(c => c !== dateCell && /[一-鿿]/.test(String(c)));
    rows.push({ date: iso, name: nameCell ? String(nameCell).trim() : `${year} holiday` });
  }
  return rows;
}

export async function syncHolidays(db, fromIso, toIso) {
  const fromYear = Number(fromIso.slice(0, 4)), toYear = Number(toIso.slice(0, 4));
  const years = [];
  for (let y = fromYear; y <= toYear; y++) years.push(y);
  // T1.6: independent per-year fetches — parallelize rather than serialize.
  await Promise.all(years.map(async (y) => {
    try {
      const rows = await fetchTwseHolidayYear(y);
      // T1.5: an empty parse (HTTP 200, 0 rows — e.g. a TWSE markup change) is a sync FAILURE,
      // not evidence the year has no holidays. Marking it "verified" here would permanently
      // suppress the R5/T1.1 warning for a year we never actually confirmed.
      if (!rows.length) {
        process.stderr.write(`  holidays ${y}: sync FAILED — TWSE returned 0 parsed rows (markup change? empty response?) — year NOT marked verified\n`);
        return;
      }
      for (const r of rows) upsertHoliday(db, r.date, r.name, 'twse');
      markYearSynced(db, y);
      process.stderr.write(`  holidays ${y}: ${rows.length} rows synced from TWSE — marked verified\n`);
    } catch (e) {
      process.stderr.write(`  holidays ${y}: ${e.message} (skipped — year NOT marked verified)\n`);
    }
  }));
}

// ---- CLI ---------------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

function readJsonFlag(flags) {
  if (!flags.json) return { error: '--json <path> is required' };
  try {
    return JSON.parse(readFileSync(flags.json, 'utf8'));
  } catch (e) {
    return { error: `failed to read/parse --json ${flags.json}: ${e.message}` };
  }
}

async function main() {
  try {
    await dispatch();
  } catch (e) {
    // Top-level safety net: any thrown error (e.g. malformed --json shapes that slip past a
    // field-level check) becomes the house {error}+exit-1 pattern, never a raw Node stack
    // trace (2026-07-20 review finding — thesis() validated assumptions but not redLines).
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

async function dispatch() {
  const [verb, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  const emit = (result) => {
    if (result && result.error) { console.error(`${verb}: ${result.error}`); process.exit(1); }
    console.log(JSON.stringify(result, null, 2));
  };

  if (verb === 'earnings') {
    const market = typeof flags.market === 'string' ? flags.market : 'tw';
    if (flags['sync-holidays'] && market === 'us') {
      // No keyless NYSE calendar JSON exists (Nager.Date serves US *federal* holidays —
      // Good Friday missing, Columbus Day wrongly present — silently wrong for markets).
      console.error('earnings: --sync-holidays has no US source — US verified coverage comes '
        + 'from fetched OHLC. Run: node --experimental-sqlite scripts/fetch-history.mjs SPY --months 24');
      process.exit(1);
    }
    const db = openDb();
    try {
      if (flags['sync-holidays']) {
        const from = typeof flags.from === 'string' ? flags.from : isoToday();
        const event = typeof flags.event === 'string' ? flags.event : from;
        await syncHolidays(db, from, event);
      }
      emit(earnings(db, {
        event: typeof flags.event === 'string' ? flags.event : undefined,
        from: typeof flags.from === 'string' ? flags.from : undefined,
        market,
      }));
    } finally { db.close(); }
  } else if (verb === 'band') {
    emit(band({
      style: flags.style != null ? Number(flags.style) : undefined,
      anchor: flags.anchor != null ? Number(flags.anchor) : undefined,
      price: flags.price != null ? Number(flags.price) : undefined,
      breakoutPct: flags['breakout-pct'] != null ? Number(flags['breakout-pct']) : undefined,
    }));
  } else if (verb === 'heat') {
    const input = readJsonFlag(flags);
    if (input.error) { emit(input); return; }
    emit(heat({ legs: input, equity: flags.equity != null ? Number(flags.equity) : undefined, cap: flags.cap != null ? Number(flags.cap) : undefined }));
  } else if (verb === 'thesis') {
    const input = readJsonFlag(flags);
    if (input.error) { emit(input); return; }
    emit(thesis(input));
  } else if (verb === 'deviate') {
    emit(deviate({
      a: flags.a != null ? Number(flags.a) : undefined,
      b: flags.b != null ? Number(flags.b) : undefined,
      kind: typeof flags.kind === 'string' ? flags.kind : undefined,
      market: typeof flags.market === 'string' ? flags.market : 'tw',
    }));
  } else {
    console.error('Usage: rules.mjs earnings --event YYYY-MM-DD [--from YYYY-MM-DD] [--market tw|us] [--sync-holidays]');
    console.error('       rules.mjs band --style 1|2|3 --anchor A [--price P] [--breakout-pct N]');
    console.error('       rules.mjs heat --json legs.json --equity E [--cap 2]');
    console.error('       rules.mjs thesis --json thesis.json');
    console.error('       rules.mjs deviate --a V1 --b V2 --kind price|weight|indicator|quote-vs-close [--market tw|us]');
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('rules.mjs')) main();
