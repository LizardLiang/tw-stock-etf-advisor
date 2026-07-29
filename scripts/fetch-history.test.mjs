// fetch-history.test.mjs — golden cases for the TPEx parser (2026-07-29 endpoint migration).
//   node --experimental-sqlite --test scripts/fetch-history.test.mjs
//
// Why these exist: the retired `st43_result.php` path started serving an HTML 404, the old
// code called res.json() on it, and the per-month catch swallowed the throw as "(skipped)".
// Every 上櫃 stock then came back with 0 rows and no error — stuck at Rule 6q grade C for
// weeks. These tests pin the new shape, the 張→股 conversion, and the fail-loud contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTpexMonth } from './fetch-history.mjs';

const FIELDS = ['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤', '漲跌', '筆數'];
const wrap = (data) => ({ stat: 'ok', name: '信驊', tables: [{ fields: FIELDS, data, totalCount: data.length }] });

// Verbatim row observed from the live endpoint on 2026-07-29 (5274 信驊, 115/07/01).
const LIVE_ROW = ['115/07/01', '278', '4,840,252', '17,105.00', '17,780.00', '16,750.00', '17,145.00', '650.00', '6,525'];

test('parses a live TPEx row: ROC date, comma-stripped OHLC', () => {
  const [r] = parseTpexMonth(wrap([LIVE_ROW]));
  assert.equal(r.date, '2026-07-01');       // 115 + 1911
  assert.equal(r.open, 17105);
  assert.equal(r.high, 17780);
  assert.equal(r.low, 16750);
  assert.equal(r.close, 17145);
});

test('normalizes 張 (lots) to 股 (shares) — the 1000x trap', () => {
  const [r] = parseTpexMonth(wrap([LIVE_ROW]));
  // TWSE reports 成交股數; TPEx reports 成交張數. Rule 6j's 量比 and Rule 6q's liquidity
  // floor both read ohlc.volume, so the two markets must be in the same unit.
  assert.equal(r.volume, 278_000);
});

test('an empty month is empty, not an error', () => {
  assert.deepEqual(parseTpexMonth(wrap([])), []);
});

test('skips no-trade rows ("--" close) instead of writing NaN', () => {
  const noTrade = ['115/07/02', '--', '--', '--', '--', '--', '--', '--', '--'];
  const rows = parseTpexMonth(wrap([noTrade, LIVE_ROW]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-07-01');
});

test('keeps volume null (not NaN) when only 張數 is missing', () => {
  const partial = ['115/07/03', '--', '1,000', '100.00', '101.00', '99.00', '100.50', '0.50', '10'];
  const [r] = parseTpexMonth(wrap([partial]));
  assert.equal(r.volume, null);
  assert.equal(r.close, 100.5);
});

test('THROWS on the old aaData shape — silent degradation is the bug being fixed', () => {
  // The retired endpoint returned { aaData: [...] }. If anything ever feeds us that shape
  // again we must fail by name, not quietly return zero rows.
  assert.throws(() => parseTpexMonth({ aaData: [LIVE_ROW] }), /no tables\[\]/);
});

test('THROWS when the payload is not the expected object at all', () => {
  assert.throws(() => parseTpexMonth(null), /no tables\[\]/);
  assert.throws(() => parseTpexMonth('<!DOCTYPE html>'), /no tables\[\]/);
});

test('THROWS when stat is not ok', () => {
  assert.throws(() => parseTpexMonth({ stat: 'error', tables: [] }), /stat=error/);
});

test('accepts stat casing variants (TPEx "ok" vs TWSE "OK")', () => {
  assert.equal(parseTpexMonth({ stat: 'OK', tables: [{ data: [LIVE_ROW] }] }).length, 1);
});
