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
