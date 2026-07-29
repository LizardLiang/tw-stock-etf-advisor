// rules.test.mjs — golden cases for rules.mjs (rule-math-mechanization, R7).
// node --experimental-sqlite --test scripts/rules.test.mjs
//
// earnings needs the `holidays` table (seeded automatically by openDb()); it runs against an
// ISOLATED temp DB via TW_STOCK_DB so these tests are deterministic and never touch the live
// stocks.db. band/heat/thesis/deviate are pure functions — no DB at all.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { earnings, band, heat, thesis, deviate, syncHolidays } from './rules.mjs';
import { openDb, upsertOhlc, getSyncedYears, markYearSynced } from './db.mjs';

let tmpDir, dbPath, db;

/** One weekday row per code across [from,to], skipping `closedDates` — mirrors a real TWSE
 * trading calendar (used to test ohlc-derived closures independent of the static holidays
 * table). Real dates below reproduce the two 2026-07-20 acceptance-gate findings:
 * 2026-04-06 (Tomb Sweeping make-up holiday) and 2026-07-10 (typhoon closure) — neither is in
 * the built-in holidays table, so only ohlc-derivation catches them. */
function seedTradingCalendar(db, code, from, to, closedDates) {
  let cursor = from;
  while (cursor <= to) {
    const day = new Date(`${cursor}T00:00:00`).getDay();
    if (day !== 0 && day !== 6 && !closedDates.has(cursor)) {
      upsertOhlc(db, code, { date: cursor, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 });
    }
    const d = new Date(`${cursor}T00:00:00`);
    d.setDate(d.getDate() + 1);
    cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'twstock-rules-test-'));
  dbPath = join(tmpDir, 'test.db');
  db = openDb(dbPath);
  // Real (per the 2026-07-20 acceptance-gate cross-check against the live DB) TWSE closures
  // within this span: 4/3+4/6 (long-weekend + make-up day), 5/1 (labor day), 6/19 (dragon
  // boat), 7/10 (typhoon) — 4/3/5/1/6/19 are ALSO in the static builtin table; 4/6 and 7/10
  // are NOT (that gap is exactly what this fix closes).
  const closed = new Set(['2026-04-03', '2026-04-06', '2026-05-01', '2026-06-19', '2026-07-10']);
  seedTradingCalendar(db, 'CALTEST', '2026-04-01', '2026-07-20', closed);
});

after(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- #2 6h earnings blackout ---------------------------------------------------------------

test('earnings: 2026-07-20 -> 2026-07-28 is 6 trading days, not blackout', () => {
  const r = earnings(db, { event: '2026-07-28', from: '2026-07-20' });
  assert.equal(r.tradingDaysAway, 6);
  assert.equal(r.blackout, false);
});

test('earnings: 2026-07-21 -> 2026-07-28 is 5 trading days, blackout (<=5)', () => {
  const r = earnings(db, { event: '2026-07-28', from: '2026-07-21' });
  assert.equal(r.tradingDaysAway, 5);
  assert.equal(r.blackout, true);
});

test('earnings: range crossing an uncovered span emits a warning, never a silent count', () => {
  const r = earnings(db, { event: '2031-01-15', from: '2031-01-01' });
  assert.ok(r.warning, 'expected a warning naming the uncovered span');
  assert.equal(typeof r.tradingDaysAway, 'number'); // still computes a best-effort count, just flagged
});

test('earnings: event before from is an error, not a negative count', () => {
  const r = earnings(db, { event: '2026-07-01', from: '2026-07-20' });
  assert.ok(r.error);
});

// ---- ohlc-derived trading calendar (2026-07-20 fix — closes the R5 in-year gap) -----------

test('earnings: span crossing 2026-07-10 (typhoon closure, NOT in builtin table) excludes it', () => {
  // Weekdays strictly after 7/8 up to 7/13: 7/9, 7/10(closed), 7/13 (7/11-12 is the weekend).
  // Before this fix, 7/10 wasn't in the builtin table so it would have silently counted as a
  // trading day (tradingDaysAway 3, wrong) — this is the exact defect found in acceptance.
  const r = earnings(db, { event: '2026-07-13', from: '2026-07-08' });
  assert.equal(r.tradingDaysAway, 2, 'expected 7/10 to be excluded (2 trading days: 7/9, 7/13)');
  assert.ok(r.holidaysCrossed.includes('2026-07-10'));
  assert.ok(!r.warning, 'this span is fully inside the derived ohlc coverage — no warning expected');
});

test('earnings: span crossing 2026-04-06 (make-up holiday, NOT in builtin table) excludes it', () => {
  // Weekdays strictly after 4/2 up to 4/7: 4/3(builtin holiday), 4/6(closed, NOT builtin), 4/7.
  const r = earnings(db, { event: '2026-04-07', from: '2026-04-02' });
  assert.equal(r.tradingDaysAway, 1, 'expected only 4/7 to count (4/3 and 4/6 both closed)');
  assert.ok(r.holidaysCrossed.includes('2026-04-06'));
  assert.ok(r.holidaysCrossed.includes('2026-04-03'));
});

test('earnings: range extending past the derived+table coverage still warns', () => {
  const r = earnings(db, { event: '2031-01-15', from: '2031-01-01' });
  assert.ok(r.warning, 'expected a warning naming the uncovered span');
});

test('earnings: previously-passing cases stay green after the derived-calendar fix', () => {
  const clear = earnings(db, { event: '2026-07-28', from: '2026-07-20' });
  assert.equal(clear.tradingDaysAway, 6);
  assert.equal(clear.blackout, false);
  const blackout = earnings(db, { event: '2026-07-28', from: '2026-07-21' });
  assert.equal(blackout.tradingDaysAway, 5);
  assert.equal(blackout.blackout, true);
});

// ---- T1.1 fail-loud coverage (2026-07-20 Hermes review — the static table missed a THIRD and
// FOURTH real closure: 2026-02-27 and 2026-10-09, both now added to the builtin table, but the
// design change is that the table is no longer trusted to mark a range "verified" by itself) ---

test('earnings (T1.1 live repro): 2026-10-05 -> 2026-10-13 crosses 10/9 -> tradingDaysAway 5, blackout true', () => {
  // Weekdays strictly after 10/5 up to 10/13: 10/6,10/7,10/8,10/9(closed, now builtin),10/12,10/13.
  // Before this fix (10/9 absent from the table, no warning): tradingDaysAway 6, blackout false —
  // wrong, per the coordinator's live cross-check. After: 10/9 excluded -> 5, blackout true.
  const r = earnings(db, { event: '2026-10-13', from: '2026-10-05' });
  assert.equal(r.tradingDaysAway, 5);
  assert.equal(r.blackout, true);
  assert.ok(r.holidaysCrossed.includes('2026-10-09'));
  // Neither ohlc (ends 2026-07-20) nor any TWSE sync covers October -> must never claim verified.
  assert.equal(r.coverageVerified, false);
  assert.ok(r.warning, 'an unverified range must always warn, even when the count happens to be right');
});

test('earnings (T1.1): a range spanning a genuine GAP between verified intervals is NOT fully verified', () => {
  // Simulate a synced year far from the ohlc-derived span (...2026-07-20), creating two DISJOINT
  // verified intervals with a real gap between them. A min/max bounding-box union (the bug
  // Hermes flagged at rules.mjs:100-104) would wrongly treat anything between them as covered.
  markYearSynced(db, 2028);
  const r = earnings(db, { event: '2028-01-10', from: '2027-12-20' });
  assert.equal(r.coverageVerified, false, 'the range straddles the gap — no single verified interval contains it');
  assert.ok(r.warning);
});

test('earnings (T1.1): conservative blackout fires for a past, pre-ohlc-coverage gap treated as uncertain', () => {
  // Entirely before ohlc's earliest date (2026-04-01) and not in the static table — a genuine
  // "we have no record at all" gap, not an ordinary future date. 7 weekday candidates (3/17..25),
  // which optimistically would read tradingDaysAway 7 (> 5, clear) — the conservative check
  // must force blackout true because every one of those 7 days is an unconfirmed unknown.
  const r = earnings(db, { event: '2026-03-25', from: '2026-03-16' });
  assert.equal(r.tradingDaysAway, 7);
  assert.ok(r.uncertainCount > 0);
  assert.equal(r.blackout, true, 'conservative-under-uncertainty must force blackout despite tradingDaysAway > 5');
  assert.match(r.verdict, /conservative-under-uncertainty/);
});

// ---- T1.5/T1.6 --sync-holidays: empty parse must not mark a year verified; years sync in parallel

test('sync-holidays (T1.5): an empty TWSE parse (0 rows) does NOT mark the year verified', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ tables: [{ fields: ['日期', '說明'], data: [] }] }) });
  try {
    await syncHolidays(db, '2029-01-01', '2029-12-31');
  } finally {
    global.fetch = realFetch;
  }
  assert.ok(!getSyncedYears(db).has('2029'), 'an empty parse is a sync FAILURE, not a holiday-free year');
});

test('sync-holidays (T1.6): years sync independently — a good year is marked even if another year is empty', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const isGoodYear = String(url).includes('date=2030');
    return {
      ok: true,
      json: async () => ({ tables: [{ fields: ['日期', '說明'], data: isGoodYear ? [['115/06/19', '端午節']] : [] }] }),
    };
  };
  try {
    await syncHolidays(db, '2030-01-01', '2031-12-31');
  } finally {
    global.fetch = realFetch;
  }
  assert.ok(getSyncedYears(db).has('2030'));
  assert.ok(!getSyncedYears(db).has('2031'));
});

// ---- #3 6l trigger validity band -----------------------------------------------------------

test('band: style 3, anchor 1335, price 1348 -> in band (not late)', () => {
  const r = band({ style: 3, anchor: 1335, price: 1348 });
  assert.equal(r.fired, true);
  assert.equal(r.lateFire, false);
});

test('band: style 3, anchor 1335, price 1400 -> lateFire true, excess ~3.8%', () => {
  const r = band({ style: 3, anchor: 1335, price: 1400 });
  assert.equal(r.lateFire, true);
  assert.ok(Math.abs(r.excessPct - 3.83) < 0.05, `expected ~3.8%, got ${r.excessPct}`);
});

test('band: style 1, anchor 776, price 817 (2026-07-08 case) -> lateFire true', () => {
  const r = band({ style: 1, anchor: 776, price: 817 });
  assert.equal(r.lateFire, true);
});

test('band: boundary — price exactly equal to bandHi is in-band, NOT late (Tier-2 boundary gap)', () => {
  // style 1: bandHi = 100 * 1.02 = 102 exactly.
  const r = band({ style: 1, anchor: 100, price: 102 });
  assert.equal(r.fired, true);
  assert.equal(r.lateFire, false, 'lateFire is defined as price > bandHi, so price === bandHi must not be late');
  assert.equal(r.excessPct, null);
});

// ---- #7 6o thesis health score ---------------------------------------------------------------

test('thesis: thesis-tracking.md worked example (1 black, 1 yellow, 3 green, no red lines)', () => {
  const r = thesis({
    assumptions: [
      { name: 'a1', status: 'black' },
      { name: 'a2', status: 'yellow' },
      { name: 'a3', status: 'green' },
      { name: 'a4', status: 'green' },
      { name: 'a5', status: 'green' },
    ],
    redLines: [{ name: 'ATR stop breach', triggered: false }],
  });
  assert.equal(r.health, 6);
  assert.equal(r.breakdown, '10 − 3×1(⚫) − 1×1(🟡) = 6');
  assert.equal(r.action, 'reduce');
  assert.equal(r.forcedBinary, false);
});

test('thesis: any triggered red line forces the 6n binary despite a high score', () => {
  const r = thesis({
    assumptions: [
      { name: 'a1', status: 'green' }, { name: 'a2', status: 'green' },
      { name: 'a3', status: 'green' }, { name: 'a4', status: 'green' },
      { name: 'a5', status: 'green' },
    ],
    redLines: [{ name: 'ATR stop breach', triggered: true }],
  });
  assert.equal(r.forcedBinary, true);
  assert.equal(r.action, 'exit or formal re-underwrite (Rule 6n binary)');
  assert.ok(r.health > 3, `expected a score above the ≤3 auto-threshold, got ${r.health}`);
});

test('thesis: malformed redLines is a house {error}, not a raw thrown exception (Tier-2 finding)', () => {
  const green = [{ name: 'a1', status: 'green' }];
  assert.ok(thesis({ assumptions: green, redLines: 'not-an-array' }).error);
  assert.ok(thesis({ assumptions: green, redLines: [{ name: 'x', triggered: 'yes' }] }).error);
  assert.ok(thesis({ assumptions: green, redLines: ['just-a-string'] }).error);
});

test('thesis: action-map boundaries — health 9/8/7/4/3(no redline)', () => {
  const mk = (black, red, yellow, green) => {
    const a = [];
    for (let i = 0; i < black; i++) a.push({ name: `b${i}`, status: 'black' });
    for (let i = 0; i < red; i++) a.push({ name: `r${i}`, status: 'red' });
    for (let i = 0; i < yellow; i++) a.push({ name: `y${i}`, status: 'yellow' });
    for (let i = 0; i < green; i++) a.push({ name: `g${i}`, status: 'green' });
    return a;
  };
  const cases = [
    [0, 0, 1, 4, 9, 'hold/add-eligible', false],
    [0, 0, 2, 3, 8, 'hold', false],
    [1, 0, 0, 4, 7, 'hold', false],
    [1, 1, 1, 2, 4, 'reduce', false],
    [1, 2, 0, 2, 3, 'exit or formal re-underwrite (Rule 6n binary)', true],
  ];
  for (const [b, r, y, g, wantHealth, wantAction, wantForced] of cases) {
    const res = thesis({ assumptions: mk(b, r, y, g), redLines: [] });
    assert.equal(res.health, wantHealth, `health mismatch for [${b},${r},${y},${g}]`);
    assert.equal(res.action, wantAction, `action mismatch at health ${wantHealth}`);
    assert.equal(res.forcedBinary, wantForced, `forcedBinary mismatch at health ${wantHealth}`);
  }
});

// ---- #9 3a cross-source deviation ------------------------------------------------------------

test('deviate: 42873 vs 42449.7, kind price -> ~1.0%, 標註', () => {
  const r = deviate({ a: 42873, b: 42449.7, kind: 'price' });
  assert.equal(r.deltaPct, 1);
  assert.equal(r.verdict, '標註');
});

test('deviate: live vs settled close -12%, quote-vs-close -> refetch, not 封鎖', () => {
  const r = deviate({ a: 88, b: 100, kind: 'quote-vs-close' });
  assert.equal(r.verdict, 'refetch');
  assert.notEqual(r.verdict, '封鎖');
});

test('deviate: indicator kind uses absolute delta, not percentage', () => {
  const ok = deviate({ a: 62, b: 60, kind: 'indicator' });   // Δ2 <= 3
  const flag = deviate({ a: 65, b: 60, kind: 'indicator' }); // Δ5 > 3
  assert.equal(ok.verdict, 'ok');
  assert.equal(flag.verdict, '標註');
});

test('deviate: b=0 with a nonzero a must NOT read as agreement (Tier-2 finding)', () => {
  const price = deviate({ a: 42873, b: 0, kind: 'price' });
  assert.notEqual(price.verdict, 'ok');
  assert.equal(price.verdict, '封鎖');
  const quote = deviate({ a: 2135, b: 0, kind: 'quote-vs-close' });
  assert.notEqual(quote.verdict, 'ok');
  assert.equal(quote.verdict, 'refetch');
});

test('deviate: a=0 and b=0 together is genuine agreement, still ok', () => {
  const r = deviate({ a: 0, b: 0, kind: 'price' });
  assert.equal(r.verdict, 'ok');
});

// ---- #4 6e-3 per-theme heat cap -------------------------------------------------------------

test('heat: 2 same-chain legs at default 1% each stay within the 2% cap', () => {
  const r = heat({
    equity: 1_000_000, cap: 2,
    legs: [
      { code: 'A', entry: 100, stop: 90 },
      { code: 'B', entry: 200, stop: 180 },
    ],
  });
  assert.equal(r.overCap, false);
  assert.equal(r.scaleFactor, 1);
  assert.ok(r.themeHeatPct <= 2);
});

test('heat: overCap legs report sharesAtCap scaled down to the theme cap', () => {
  const r = heat({
    equity: 1_000_000, cap: 2,
    legs: [
      { code: 'A', entry: 100, stop: 90, shares: 1000 },  // 1R=10, risk=10000 (1.0%)
      { code: 'B', entry: 200, stop: 180, shares: 500 },  // 1R=20, risk=10000 (1.0%)
      { code: 'C', entry: 50, stop: 45, shares: 2000 },   // 1R=5, risk=10000 (1.0%)
    ],
  });
  assert.equal(r.overCap, true);
  assert.ok(r.themeHeatPct > 2);
  for (const leg of r.legs) assert.ok(leg.sharesAtCap < leg.shares, `${leg.code} should scale down`);
});
