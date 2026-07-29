// screen.test.mjs — golden cases for screen.mjs's rule-math extensions:
//   - Rule 6q dataGrade (A/B/C)
//   - Style-3 reclaim regression (the 2026-07-20 fix: declineDays/declineStart/reclaimed)
//   - Style-3c 延遲確認 continuation gate + trade plan (the 2026-07-22 2454 incident)
// node --experimental-sqlite --test scripts/screen.test.mjs
//
// Uses an ISOLATED temp DB (TW_STOCK_DB) seeded with synthetic OHLC — deterministic, and
// never touches the live stocks.db (that's the acceptance-gate's job, run separately).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertOhlc } from './db.mjs';
import { screenCode, tradePlan } from './screen.mjs';

let tmpDir, db;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'twstock-screen-test-'));
  db = openDb(join(tmpDir, 'test.db'));
});

after(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** N flat, unremarkable sessions (base=100, mild drift) ending on `lastDate`, ascending. */
function seedFlatHistory(db, code, n, lastDate, { volume = 5_000_000 } = {}) {
  const end = new Date(`${lastDate}T00:00:00`);
  const dates = [];
  const cursor = new Date(end);
  while (dates.length < n) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) dates.unshift(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`);
    cursor.setDate(cursor.getDate() - 1);
  }
  dates.forEach((date, i) => {
    const close = 100 + (i % 5) * 0.3; // small wiggle so ATR/MA aren't degenerate
    upsertOhlc(db, code, { date, open: close - 0.2, high: close + 0.5, low: close - 0.5, close, volume });
  });
}

// ---- #8 6q data-richness grade ---------------------------------------------------------------

test('dataGrade: >=60 sessions + liquid + both judgment flags -> grade A, five checks itemized', () => {
  seedFlatHistory(db, 'GRADEA', 74, '2026-07-20', { volume: 20_000_000 }); // 100*20M ~= NT$2B turnover
  const r = screenCode(db, 'GRADEA', null, { quoteOk: true, eventsKnown: true });
  assert.equal(r.dataGrade.grade, 'A');
  assert.deepEqual(Object.keys(r.dataGrade.checks).sort(),
    ['eventDatesKnown', 'indicatorsComputable', 'liquidity', 'ohlcDepth', 'quoteAvailable'].sort());
  for (const v of Object.values(r.dataGrade.checks)) assert.equal(v, 'pass');
});

test('dataGrade: 13-session history -> grade C with a concrete upgradePath', () => {
  seedFlatHistory(db, 'GRADEC', 13, '2026-07-20', { volume: 20_000_000 });
  const r = screenCode(db, 'GRADEC', null, { quoteOk: true, eventsKnown: true });
  assert.equal(r.dataGrade.grade, 'C');
  assert.equal(r.dataGrade.checks.ohlcDepth, 'fail');
  assert.ok(r.dataGrade.upgradePath.length > 0, 'C must never be bare — needs a concrete upgrade path');
  assert.ok(r.dataGrade.upgradePath.some((s) => /交易日/.test(s)));
});

test('dataGrade: 30-session history (Tier-2 boundary gap) -> the middle grade B branch, non-critical gap', () => {
  // 30 sessions is in the 14-59 "partial" band (not <14 fail, not >=60 pass) — the ONLY
  // non-pass check, so this exercises the `criticalGap ? C : (allPass ? A : B)` middle branch.
  seedFlatHistory(db, 'GRADEB', 30, '2026-07-20', { volume: 20_000_000 });
  const r = screenCode(db, 'GRADEB', null, { quoteOk: true, eventsKnown: true });
  assert.equal(r.dataGrade.grade, 'B');
  assert.equal(r.dataGrade.checks.ohlcDepth, 'partial');
  assert.equal(r.dataGrade.checks.liquidity, 'pass');
  assert.ok(r.dataGrade.gaps.length > 0);
});

// ---- Style-3 reclaim regression (2026-07-20 fix) -----------------------------------------

test('reversal (regression): 2-day decline correctly reports declineDays 2, not 1', () => {
  // Mirrors the real 1590 2026-07-20 session: 1365(up) 1350(down) 1265(down) 1335(up, reversal day).
  // The bug this pins: an earlier draft's loop returned declineDays 0 or 3 for this exact shape.
  const code = 'RECLAIM';
  const rows = [
    ['2026-07-13', 1360], ['2026-07-14', 1362], ['2026-07-15', 1365],
    ['2026-07-16', 1350], ['2026-07-17', 1265], ['2026-07-20', 1335],
  ];
  for (const [date, close] of rows) {
    upsertOhlc(db, code, { date, open: close, high: close + 5, low: close - 5, close, volume: 10_000_000 });
  }
  const r = screenCode(db, code, '2026-07-20');
  assert.equal(r.reversal.declineDays, 2);
  assert.equal(r.reversal.declineStart, 1365);
  assert.equal(r.reversal.reclaimed, false); // 1335 < 1365
});

// ---- Style-3c 延遲確認 (2026-07-22) -----------------------------------------------------
//
// Canonical incident: 2454 — 7/21 reversal day failed volume (0.84×) AND reclaim; 7/22
// delivered both (1.58×, close 3,850 > declineStart 3,740) but no legal entry path existed.

/** Seed explicit OHLCV bars: [date, open, high, low, close, volume][] */
function seedBars(db, code, bars) {
  for (const [date, open, high, low, close, volume] of bars) {
    upsertOhlc(db, code, { date, open, high, low, close, volume });
  }
}

// 12 preamble weekday sessions (mild downdrift so KD sits low pre-crash, making the
// bounce's golden cross robust), then the five real 2454 bars.
const T1_PREAMBLE_DATES = ['2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06',
  '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13', '2026-07-14', '2026-07-15'];
// Wiggling downdrift, ENDING ON AN UP-CLOSE (3720→3740): the decline-segment walk-back
// must stop at 7/15 so declineStart is 3740 — a monotonic preamble would extend the
// segment through the whole history (declineDays 14, declineStart 3900).
const T1_PREAMBLE_CLOSES = [3900, 3880, 3895, 3860, 3875, 3840, 3855, 3820, 3835, 3800, 3720, 3740];

function seed2454Shape(db, code, { confirmVolume = 15_660_000 } = {}) {
  seedBars(db, code, T1_PREAMBLE_DATES.map((d, i) => {
    const c = T1_PREAMBLE_CLOSES[i];
    return [d, c + 10, c + 20, c - 20, c, 10_000_000];
  }));
  seedBars(db, code, [
    // real 2454 bars; volumes tuned so 7/21 ratio = 0.84×, 7/22 ratio ≈ 1.58×
    ['2026-07-16', 3735, 3755, 3620, 3700, 8_000_000],
    ['2026-07-17', 3470, 3570, 3370, 3370, 12_000_000],
    ['2026-07-20', 3355, 3435, 3240, 3340, 11_000_000],
    ['2026-07-21', 3435, 3670, 3410, 3670, 8_570_000],   // reversal day: vol 0.84×, reclaim NOT met
    ['2026-07-22', 4000, 4000, 3830, 3850, confirmVolume], // confirmation day (fade: close < open)
  ]);
}

test('3c T1: 2454-shape confirmation day qualifies; the reversal day itself does not', () => {
  const code = 'C3C_T1';
  seed2454Shape(db, code);

  // 7/21 — the reversal day: Style-3 classic path's state, pinned (failed ONLY on volume+reclaim)
  const rev = screenCode(db, code, '2026-07-21');
  assert.equal(rev.reversal.isReversalDay, true);
  assert.equal(rev.reversal.declineDays, 3);            // 7/16, 7/17, 7/20
  assert.equal(rev.reversal.declineStart, 3740);
  assert.equal(rev.reversal.reclaimed, false);          // 3670 < 3740
  assert.equal(rev.signals.kdGolden, true, 'fixture must produce golden KD on the reversal day');
  assert.equal(rev.signals.volConfirmed, false);        // 0.84×
  assert.equal(rev.continuation.qualified, false);      // a reversal day is not a continuation day

  // 7/22 — the confirmation day: all 7 checks pass
  const r = screenCode(db, code, '2026-07-22');
  assert.equal(r.continuation.qualified, true);
  assert.deepEqual(r.continuation.failures, []);
  assert.equal(r.continuation.upRun, 2);
  assert.equal(r.continuation.reversalDate, '2026-07-21');
  assert.equal(r.continuation.reversalClose, 3670);
  assert.equal(r.continuation.reversalDayOfMove, 1);
  assert.equal(r.continuation.declineDays, 3);
  assert.equal(r.continuation.declineStart, 3740);
  for (const [k, v] of Object.entries(r.continuation.checks)) assert.equal(v, true, `check ${k}`);
  // fade-day clause: close (3850) < open (4000) yet it still qualifies — close-vs-prev-close rules
  assert.ok(r.close < r.open);
});

test('3c T2: volume without reclaim does not qualify (3189-shape)', () => {
  const code = 'C3C_T2';
  // gentle preamble ~870→845, 3-day decline, reversal day, then a 3× volume day that
  // still sits below the decline start 845
  seedBars(db, code, T1_PREAMBLE_DATES.map((d, i) => {
    const c = 870 - i * 2 - (i === 11 ? 3 : 0); // ends 845
    return [d, c + 2, c + 5, c - 5, c, 5_000_000];
  }));
  seedBars(db, code, [
    ['2026-07-16', 800, 805, 760, 770, 4_000_000],
    ['2026-07-17', 705, 711, 693, 693, 5_500_000],
    ['2026-07-20', 693, 724, 653, 679, 5_000_000],
    ['2026-07-21', 715, 746, 704, 746, 4_500_000],
    ['2026-07-22', 804, 819, 770, 796, 15_000_000],   // vol ≈ 3.1× but 796 < 845
  ]);
  const r = screenCode(db, code, '2026-07-22');
  assert.equal(r.continuation.checks.volConfirmed, true);
  assert.equal(r.continuation.checks.reclaimedNow, false);
  assert.equal(r.continuation.qualified, false);
  assert.ok(r.continuation.failures.includes('reclaimedNow'));
});

test('3c T3a: a down day between reversal and attempt resets the window; fresh-reversal and continuation are mutually exclusive', () => {
  const code = 'C3C_T3A';
  seedBars(db, code, T1_PREAMBLE_DATES.map((d, i) => [d, 1002, 1005, 995, 1000 - i * 0.5, 5_000_000]));
  seedBars(db, code, [
    ['2026-07-16', 990, 992, 945, 950, 5_000_000],   // down
    ['2026-07-17', 945, 950, 895, 900, 5_000_000],   // down
    ['2026-07-20', 905, 945, 900, 940, 5_000_000],   // up — reversal day 1
    ['2026-07-21', 935, 940, 915, 920, 5_000_000],   // DOWN — window resets
    ['2026-07-22', 930, 995, 925, 990, 12_000_000],  // up attempt: upRun 1
  ]);
  const r = screenCode(db, code, '2026-07-22');
  assert.equal(r.continuation.upRun, 1);
  assert.equal(r.continuation.checks.windowOk, false);
  assert.equal(r.continuation.qualified, false);
  // the same bar IS a fresh reversal day (yesterday was down) — the invariant: never both
  assert.equal(r.reversal.isReversalDay, true);
  assert.equal(r.reversal.declineDays, 1);
  assert.equal(r.reversal.declineStart, 940);
});

test('3c T3b: attempt on up-day 4 (yesterday was up-day 3) is outside the window', () => {
  const code = 'C3C_T3B';
  seedBars(db, code, T1_PREAMBLE_DATES.map((d, i) => [d, 1002, 1005, 995, 1000 - i * 0.5, 5_000_000]));
  seedBars(db, code, [
    ['2026-07-16', 990, 992, 895, 900, 5_000_000],   // down (the decline segment)
    ['2026-07-17', 895, 908, 880, 905, 5_000_000],   // up 1 — the reversal day
    ['2026-07-20', 905, 915, 900, 910, 5_000_000],   // up 2
    ['2026-07-21', 912, 925, 910, 920, 5_000_000],   // up 3
    ['2026-07-22', 925, 995, 922, 990, 12_000_000],  // up 4: attempt → upRun 4, window exceeded
  ]);
  const r = screenCode(db, code, '2026-07-22');
  assert.equal(r.continuation.upRun, 4);
  assert.equal(r.continuation.checks.windowOk, false);
  assert.equal(r.continuation.qualified, false);
  assert.ok(r.continuation.failures.includes('windowOk'));
});

test('3c T4: confirmation day without volume does not qualify', () => {
  const code = 'C3C_T4';
  seed2454Shape(db, code, { confirmVolume: 5_000_000 }); // ≈ 0.5× — below the 5-day avg
  const r = screenCode(db, code, '2026-07-22');
  assert.equal(r.continuation.checks.volConfirmed, false);
  assert.equal(r.continuation.qualified, false);
  assert.ok(r.continuation.failures.includes('volConfirmed'));
});

test('3c T5: KD not golden on the reversal day does not qualify', () => {
  const code = 'C3C_T5';
  // steep slide keeps K far below D; the day-1 bounce closes near the range LOW so RSV
  // stays tiny and K cannot cross D. Bars are well-formed (low ≤ open/close ≤ high).
  const closes = [500, 496, 499, 492, 495, 488, 491, 484, 487, 480, 472, 478]; // ends up-close
  seedBars(db, code, T1_PREAMBLE_DATES.map((d, i) => {
    const c = closes[i];
    return [d, c + 1, c + 6, c - 6, c, 5_000_000];
  }));
  seedBars(db, code, [
    ['2026-07-16', 476, 478, 458, 460, 5_000_000],
    ['2026-07-17', 458, 462, 438, 440, 5_000_000],
    ['2026-07-20', 438, 441, 396, 400, 5_000_000],   // capitulation
    ['2026-07-21', 400, 406, 396, 402, 4_000_000],   // feeble day-1 bounce — K stays below D
    ['2026-07-22', 404, 442, 402, 440, 12_000_000],  // strong day-2 with volume
  ]);
  const r = screenCode(db, code, '2026-07-22');
  assert.equal(r.continuation.checks.kdGoldenYesterday, false);
  assert.equal(r.continuation.qualified, false);
  assert.ok(r.continuation.failures.includes('kdGoldenYesterday'));
});

test('3c T6: tradePlan --confirm hard-errors on an unqualified day, naming the failures', () => {
  const plan = tradePlan(db, 'C3C_T2', { style: 3, confirm: true, zone: [770, 800], date: '2026-07-22' });
  assert.ok(plan.error, 'must refuse to plan');
  assert.match(plan.error, /continuation|3c/);
  assert.match(plan.error, /reclaimedNow/);
});

test('3c T7: stop math — confirmation-low branch (confirmLow×0.99 below the 5% floor)', () => {
  // bottom 4000 → floor 3800 > 3830×0.99 = 3791.7 → the confirm-low branch fires
  const plan = tradePlan(db, 'C3C_T1', { style: 3, confirm: true, zone: [4000, 4100], date: '2026-07-22' });
  assert.equal(plan.error, undefined);
  assert.equal(plan.stop, 3791.7);
  assert.ok(plan.notes.some((n) => /confirmation-day low/.test(n)));
});

test('3c T8: stop math — 5% floor branch (confirm-low stop tighter than the floor)', () => {
  // bottom 3740 → floor 3553 < 3791.7 → widened to the floor (Rule 6a-1)
  const plan = tradePlan(db, 'C3C_T1', { style: 3, confirm: true, zone: [3740, 3850], date: '2026-07-22' });
  assert.equal(plan.error, undefined);
  assert.equal(plan.stop, 3553);
  assert.ok(plan.notes.some((n) => /widened to/.test(n)));
});

test('3c T9: success output carries the 3c markers; --revlow is ignored, not fatal', () => {
  const plan = tradePlan(db, 'C3C_T1', { style: 3, confirm: true, revlow: 3410, zone: [4000, 4100], date: '2026-07-22' });
  assert.equal(plan.error, undefined);
  assert.equal(plan.style, 3);
  assert.equal(plan.variant, '3c');
  assert.equal(plan.confirmLow, 3830);
  assert.equal(plan.reversalDate, '2026-07-21');
  assert.equal(plan.revlow, null);
  assert.ok(plan.notes.some((n) => /3c/.test(n)));
  assert.ok(plan.notes.some((n) => /--revlow ignored/.test(n)));
  assert.equal(typeof plan.rr, 'number');
  assert.equal(typeof plan.rrPass, 'boolean');
});

test('3c T10: existing hard-errors still pinned; --confirm outside style 3 rejected', () => {
  const noRevlow = tradePlan(db, 'C3C_T1', { style: 3, zone: [3740, 3850], date: '2026-07-22' });
  assert.match(noRevlow.error, /revlow/);
  const noPivot = tradePlan(db, 'C3C_T1', { style: 2, zone: [3740, 3850], date: '2026-07-22' });
  assert.match(noPivot.error, /pivot/);
  const confirmS1 = tradePlan(db, 'C3C_T1', { style: 1, confirm: true, zone: [3740, 3850], date: '2026-07-22' });
  assert.match(confirmS1.error, /--confirm/);
});

// ---- Rule 6j-A2 試行 (2026-07-28) --------------------------------------------------------
//
// Why: 6j's 1.0× volume threshold showed NO discriminative power across 3 pre-registered
// samples (IS supports, OOS + 2018-2023 tiebreak both against — 2:1). User ruling A3→A2:
// a volume-failed Style-3 becomes a REPORT-ONLY paper track at 25% pilot, never a buy.
// The volume leg was previously prose-only in SKILL.md; these pin it as script-enforced.
// Reuses the 2454 fixture: 7/21 is a reversal day whose volume fails (0.84×).

const A2_ZONE = [3670, 3700];   // reversal-day close .. +1% band (Rule 6l style 3)

test('6j-A2 T1: volume-failed Style-3 hard-errors without --vol-trial, naming 6j + the ratio', () => {
  const code = 'A2_T1';
  seed2454Shape(db, code);
  const scr = screenCode(db, code, '2026-07-21');
  assert.equal(scr.signals.volConfirmed, false, 'fixture must fail 6j on the reversal day');
  assert.equal(scr.volRatio, 0.84);

  const r = tradePlan(db, code, { style: 3, zone: A2_ZONE, revlow: 3410, date: '2026-07-21' });
  assert.ok(r.error, 'must refuse to plan a volume-failed Style-3 by default');
  assert.match(r.error, /Rule 6j/);
  assert.match(r.error, /0\.84×/);
  assert.match(r.error, /--vol-trial/);
  assert.equal(r.stop, undefined, 'no plan fields when refusing');
});

test('6j-A2 T2: --vol-trial plans it as a tracked trial — variant/volTrial/pilotPct 25 + report-only notes', () => {
  const code = 'A2_T2';
  seed2454Shape(db, code);
  const r = tradePlan(db, code, { style: 3, zone: A2_ZONE, revlow: 3410, date: '2026-07-21', volTrial: true });
  assert.ok(!r.error);
  assert.equal(r.variant, '3-volTrial');
  assert.equal(r.volTrial, true);
  assert.equal(r.pilotPct, 25);
  assert.equal(r.volRatio, 0.84);
  // the trial must SAY it is not a buy — this is the whole point of the 試行 status
  assert.ok(r.notes.some((n) => n.includes('6j-A2 試行') && n.includes('不作買進建議')),
    'trial plan must carry the report-only disclaimer');
  // stop regime is untouched by A2: still the Style-3 reversal-low/5%-floor branch
  assert.equal(r.stop, Math.min(3410 * 0.99, A2_ZONE[0] * 0.95));
});

test('6j-A2 T3: --vol-trial is ignored (not fatal) when volume already confirms', () => {
  const code = 'A2_T3';
  seed2454Shape(db, code);
  const scr = screenCode(db, code, '2026-07-22');
  assert.equal(scr.signals.volConfirmed, true, 'fixture must pass 6j on the confirmation day');

  const r = tradePlan(db, code, { style: 3, zone: [3850, 3890], revlow: 3830, date: '2026-07-22', volTrial: true });
  assert.ok(!r.error);
  assert.equal(r.volTrial, false, 'a volume-confirmed day is a normal Style-3, never a trial');
  assert.equal(r.variant, null);
  assert.equal(r.pilotPct, 50);
  assert.ok(r.notes.some((n) => n.includes('--vol-trial ignored')));
});

test('6j-A2 T4: sizing carries the pilot split; 25% trial pilot is half the 50% normal pilot', () => {
  const code = 'A2_T4';
  seed2454Shape(db, code);
  const equity = 1_000_000;
  const trial = tradePlan(db, code, { style: 3, zone: A2_ZONE, revlow: 3410, date: '2026-07-21', volTrial: true, equity });
  assert.equal(trial.sizing.pilotPct, 25);
  assert.equal(trial.sizing.pilotShares, Math.floor(trial.sizing.shares * 0.25));
  assert.ok(trial.sizing.note.includes('halved by the 6j-A2 試行'));

  const normal = tradePlan(db, code, { style: 3, zone: [3850, 3890], revlow: 3830, date: '2026-07-22', equity });
  assert.equal(normal.sizing.pilotPct, 50);
  assert.equal(normal.sizing.pilotShares, Math.floor(normal.sizing.shares * 0.5));
  assert.ok(!normal.sizing.note.includes('6j-A2'));
});

test('6j-A2 T5: the trial is scoped to Style-3 only — Style-2 unaffected, 3c still gated by continuation', () => {
  const code = 'A2_T5';
  seed2454Shape(db, code);
  // Style-2 on the SAME volume-failed session still plans (6j-A2 does not touch the breakout path;
  // Style-2's volume confirmation stays a model judgment via gate.style2Partial.volConfirmed)
  const s2 = tradePlan(db, code, { style: 2, zone: A2_ZONE, pivot: 3740, date: '2026-07-21' });
  assert.ok(!s2.error, 'Style-2 must not inherit the Style-3 volume hard-error');
  assert.equal(s2.volTrial, false);
  assert.equal(s2.pilotPct, 50);
  assert.equal(s2.gate.style2Partial.volConfirmed, false, 'still reported for the model to judge');

  // 3c keeps its own continuation gate; --vol-trial must NOT unlock an unqualified 3c
  const s3c = tradePlan(db, code, { style: 3, zone: A2_ZONE, confirm: true, date: '2026-07-21', volTrial: true });
  assert.ok(s3c.error, '--vol-trial must not bypass the 3c continuation gate');
  assert.match(s3c.error, /continuation\.qualified/);
});
