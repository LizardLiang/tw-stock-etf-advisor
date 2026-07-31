// seed-from-obsidian.test.mjs — golden cases for the positions backfill/reconciliation (T1.4,
// 2026-07-20 Hermes review). node --experimental-sqlite --test scripts/seed-from-obsidian.test.mjs
//
// Uses an isolated temp DB + a synthetic ledger markdown file (matching the real
// `## 交易明細` / `## 持有中` table shapes) so reconciliation behavior is deterministic and
// never touches the live Obsidian vault or stocks.db.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getAllPositions } from './db.mjs';
import { seedPositions } from './seed-from-obsidian.mjs';

let tmpDir, db, ledgerPath;

const TX_HEADER = '## 交易明細 Transactions\n'
  + '| 日期 | 動作 | 股號 | 股名 | 股數 | 成交價 | 金額 | 停損 | 停利目標 | 備註 |\n'
  + '|------|------|------|------|------|--------|------|------|----------|------|\n';

const POS_HEADER = '## 持有中 Current Positions\n'
  + '| 股號 | 股名 | 股數 | 成本均價 | 投入金額 | 停損 | 停利目標 |\n'
  + '|------|------|------|----------|----------|------|----------|\n';

function ledgerWithTwoPositions() {
  return TX_HEADER
    + '| 2026-06-01 | 買 | 1111 | Test1 | 1 | 100 | 100 | 90 | 120~130 | note |\n'
    + '| 2026-06-02 | 買 | 2222 | Test2 | 1 | 200 | 200 | 180 | 220~230 | note |\n\n'
    + POS_HEADER
    + '| 1111 | Test1 | 1 | 100 | 100 | 90 | 120~130 |\n'
    + '| 2222 | Test2 | 1 | 200 | 200 | 180 | 220~230 |\n';
}

function ledgerWithOnePositionSoldOut() {
  // 2222 sold — a 賣 row added, and removed from "## 持有中".
  return TX_HEADER
    + '| 2026-06-01 | 買 | 1111 | Test1 | 1 | 100 | 100 | 90 | 120~130 | note |\n'
    + '| 2026-06-02 | 買 | 2222 | Test2 | 1 | 200 | 200 | 180 | 220~230 | note |\n'
    + '| 2026-07-10 | 賣 | 2222 | Test2 | 1 | 250 | 250 | — | — | 停利出場 |\n\n'
    + POS_HEADER
    + '| 1111 | Test1 | 1 | 100 | 100 | 90 | 120~130 |\n';
}

function ledgerWithEmptyPositionsTable() {
  // Heading present but ZERO data rows — the parse-failure case (e.g. reformatted table).
  return TX_HEADER
    + '| 2026-06-01 | 買 | 1111 | Test1 | 1 | 100 | 100 | 90 | 120~130 | note |\n\n'
    + POS_HEADER; // header + separator only, no data rows
}

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'twstock-seed-test-'));
  db = openDb(join(tmpDir, 'test.db'));
  ledgerPath = join(tmpDir, 'stock-holdings.md');
});

after(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('seedPositions: backfills both positions from a 2-row ## 持有中 table', () => {
  writeFileSync(ledgerPath, ledgerWithTwoPositions(), 'utf8');
  const n = seedPositions(db, ledgerPath);
  assert.equal(n, 2);
  const codes = getAllPositions(db).map((p) => p.code).sort();
  assert.deepEqual(codes, ['1111', '2222']);
});

test('seedPositions (T1.4): re-seeding with a sold-out position removes it, keeps the rest', () => {
  writeFileSync(ledgerPath, ledgerWithOnePositionSoldOut(), 'utf8');
  seedPositions(db, ledgerPath);
  const codes = getAllPositions(db).map((p) => p.code).sort();
  assert.deepEqual(codes, ['1111'], '2222 was sold out of ## 持有中 and must be removed, not linger forever');
});

test('seedPositions (T1.4): a ledger that re-adds a position after removal still backfills it', () => {
  // Sanity: reconciliation isn't a one-way ratchet — re-seeding with 2222 back in restores it.
  writeFileSync(ledgerPath, ledgerWithTwoPositions(), 'utf8');
  seedPositions(db, ledgerPath);
  const codes = getAllPositions(db).map((p) => p.code).sort();
  assert.deepEqual(codes, ['1111', '2222']);
});

test('seedPositions (T1.4): a ZERO-row ## 持有中 parse is a FAILURE — existing positions untouched', () => {
  const before1 = getAllPositions(db).map((p) => p.code).sort();
  assert.deepEqual(before1, ['1111', '2222'], 'precondition: portfolio has 2 positions before the bad parse');

  writeFileSync(ledgerPath, ledgerWithEmptyPositionsTable(), 'utf8');
  const n = seedPositions(db, ledgerPath);
  assert.equal(n, 0);

  const after1 = getAllPositions(db).map((p) => p.code).sort();
  assert.deepEqual(after1, ['1111', '2222'], 'an empty parse must NEVER silently empty the portfolio');
});

// ---- US delta: separate US ledger + market-scoped reconciliation --------------------------

function usLedger() {
  return TX_HEADER
    + '| 2026-07-01 | 買 | NVDA | NVIDIA | 10 | 160 | 1600 | 145 | 180~195 | ai capex |\n'
    + '| 2026-07-02 | 買 | BRK.B | Berkshire | 5 | 470 | 2350 | 440 | 520~540 | value |\n\n'
    + POS_HEADER
    + '| NVDA | NVIDIA | 10 | 160 | 1600 | 145 | 180~195 |\n'
    + '| BRK.B | Berkshire | 5 | 470 | 2350 | 440 | 520~540 |\n';
}

test('seedPositions (US): alphabetic tickers (incl. dotted BRK.B) parse from a US ledger', () => {
  const usPath = join(tmpDir, 'us-stock-holdings.md');
  writeFileSync(usPath, usLedger(), 'utf8');
  const n = seedPositions(db, usPath, 'us');
  assert.equal(n, 2);
  const nvda = getAllPositions(db).find((p) => p.code === 'NVDA');
  assert.equal(nvda.cost_avg, 160);
  assert.equal(nvda.opened_at, '2026-07-01');
});

test('seedPositions (US regression): re-seeding the TW ledger must NOT delete US positions', () => {
  writeFileSync(ledgerPath, ledgerWithTwoPositions(), 'utf8');
  seedPositions(db, ledgerPath, 'tw');
  const codes = getAllPositions(db).map((p) => p.code).sort();
  assert.deepEqual(codes, ['1111', '2222', 'BRK.B', 'NVDA'],
    'TW reconciliation is scoped to TW codes — the US book survives a TW re-seed');
});

test('seedPositions (US regression): re-seeding the US ledger must NOT delete TW positions', () => {
  const usPath = join(tmpDir, 'us-stock-holdings.md');
  writeFileSync(usPath, usLedger(), 'utf8');
  seedPositions(db, usPath, 'us');
  const codes = getAllPositions(db).map((p) => p.code).sort();
  assert.deepEqual(codes, ['1111', '2222', 'BRK.B', 'NVDA']);
});

test('seedPositions: a wrong-market code in a ledger is skipped, never seeded under that book', () => {
  // A US ticker filed in the TW ledger would later be deleted by the US reconciliation pass
  // (absent from the US file) — so it must not seed from the TW file at all.
  const mixedPath = join(tmpDir, 'mixed-holdings.md');
  writeFileSync(mixedPath, TX_HEADER + '\n' + POS_HEADER
    + '| 1111 | Test1 | 1 | 100 | 100 | 90 | 120~130 |\n'
    + '| TSLA | Tesla | 3 | 250 | 750 | 220 | 300~330 |\n', 'utf8');
  const n = seedPositions(db, mixedPath, 'tw');
  assert.equal(n, 1, 'only the TW row seeds from a tw-market pass');
  assert.equal(getAllPositions(db).find((p) => p.code === 'TSLA'), undefined);
});
