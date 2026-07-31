// db.test.mjs — golden cases for the market-aware foundation (US-market delta, 2026-07-31).
//   node --experimental-sqlite --test scripts/db.test.mjs
//
// The load-bearing case here is CALENDAR POLLUTION: the ohlc-derived trading calendar
// (2026-07-20 R5 fix) used to scan `ohlc` across ALL codes. The moment one US ticker's rows
// land in `ohlc`, a TW holiday on which the US traded (春節 is a normal NYSE week) stops
// being derivable as a TW closure — Rule 6h's trading-day counter silently over-counts.
// These tests pin the market scoping that prevents that.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, upsertOhlc, marketForCode,
  getOhlcDateRange, getTradingDatesInRange, deriveHolidaysFromOhlc,
  getHolidaySet, getVerifiedIntervals, markYearSynced,
} from './db.mjs';

let tmpDir, db;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'twstock-db-test-'));
  db = openDb(join(tmpDir, 'test.db'));

  // TW code 2330 trades Mon 2026-03-02 .. Fri 2026-03-06 EXCEPT Wed 3/4 (a synthetic TW-only
  // closure). US ticker NVDA trades all five weekdays including 3/4.
  for (const date of ['2026-03-02', '2026-03-03', '2026-03-05', '2026-03-06']) {
    upsertOhlc(db, '2330', { date, open: 1000, high: 1010, low: 990, close: 1005, volume: 20_000_000 });
  }
  for (const date of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']) {
    upsertOhlc(db, 'NVDA', { date, open: 120, high: 122, low: 118, close: 121, volume: 200_000_000 });
  }
});

after(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- marketForCode — the single owner of market classification ---------------------------

test('marketForCode: numeric TW codes vs alphabetic US tickers', () => {
  assert.equal(marketForCode('2330'), 'tw');
  assert.equal(marketForCode('00892'), 'tw');   // 5-digit ETF
  assert.equal(marketForCode('5274'), 'tw');    // TPEx — still family 'tw'
  assert.equal(marketForCode('NVDA'), 'us');
  assert.equal(marketForCode('BRK.B'), 'us');   // dotted share class
  assert.equal(marketForCode('SPY'), 'us');
});

// ---- calendar pollution regression -------------------------------------------------------

test('TW closure still derived when a US code traded that day', () => {
  const res = deriveHolidaysFromOhlc(db, 'tw');
  assert.equal(res.from, '2026-03-02');
  assert.equal(res.to, '2026-03-06');
  // 3/4 has NVDA rows but no TW rows — it must still be recorded as a TW closure.
  const twHolidays = getHolidaySet(db, '2026-03-02', '2026-03-06', 'tw');
  assert.ok(twHolidays.has('2026-03-04'), '2026-03-04 must be a derived TW closure despite NVDA trading');
});

test('US calendar derives NO closure from the TW-only gap', () => {
  deriveHolidaysFromOhlc(db, 'us');
  // NVDA traded every weekday in the span — the US table must not inherit TW's 3/4 closure.
  const usHolidays = getHolidaySet(db, '2026-03-02', '2026-03-06', 'us');
  assert.ok(!usHolidays.has('2026-03-04'), '2026-03-04 must NOT appear as a US closure');
});

test('ohlc range and trading dates are market-scoped', () => {
  assert.deepEqual(getOhlcDateRange(db, 'tw'), { from: '2026-03-02', to: '2026-03-06' });
  assert.deepEqual(getOhlcDateRange(db, 'us'), { from: '2026-03-02', to: '2026-03-06' });
  const twDates = getTradingDatesInRange(db, '2026-03-02', '2026-03-06', 'tw');
  const usDates = getTradingDatesInRange(db, '2026-03-02', '2026-03-06', 'us');
  assert.ok(!twDates.has('2026-03-04'));
  assert.ok(usDates.has('2026-03-04'));
});

test('unknown market throws by name — never a silent wrong-calendar fall-through', () => {
  assert.throws(() => getOhlcDateRange(db, 'jp'), /unknown market "jp"/);
  assert.throws(() => deriveHolidaysFromOhlc(db, 'nasdaq'), /unknown market/);
});

// ---- verified coverage scoping -----------------------------------------------------------

test('TWSE-synced years count as verified for TW only, never for US', () => {
  markYearSynced(db, 2025);
  const tw = getVerifiedIntervals(db, 'tw');
  const us = getVerifiedIntervals(db, 'us');
  assert.ok(tw.some((iv) => iv.from === '2025-01-01' && iv.to === '2025-12-31'),
    'synced year 2025 must appear in TW verified coverage');
  // US verified coverage is strictly the US-scoped ohlc span — no sync source exists.
  assert.deepEqual(us, [{ from: '2026-03-02', to: '2026-03-06' }]);
});

// ---- builtin US holiday seeding ----------------------------------------------------------

test('holidays_us seeded with NYSE 2026 builtins + coverage meta', () => {
  const us2026 = getHolidaySet(db, '2026-01-01', '2026-12-31', 'us');
  assert.ok(us2026.has('2026-07-03'), 'Independence Day observed (7/4 is a Saturday)');
  assert.ok(us2026.has('2026-11-26'), 'Thanksgiving');
  assert.ok(!us2026.has('2026-02-17'), '春節 must not leak into the US table');
  const from = db.prepare('SELECT value FROM meta WHERE key=?').get('holidays_us_builtin_from');
  const to = db.prepare('SELECT value FROM meta WHERE key=?').get('holidays_us_builtin_to');
  assert.equal(from.value, '2026-01-01');
  assert.equal(to.value, '2026-12-31');
});

test('TW holiday table is untouched by US seeding', () => {
  const tw2026 = getHolidaySet(db, '2026-01-01', '2026-12-31', 'tw');
  assert.ok(tw2026.has('2026-02-17'), '春節（初一） stays in the TW table');
  assert.ok(!tw2026.has('2026-11-26'), 'Thanksgiving must not leak into the TW table');
});
