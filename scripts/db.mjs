// db.mjs — SQLite layer for tw-stock-etf-advisor (zero npm deps, Node built-ins only).
//
// Run with the experimental flag so node:sqlite is enabled across Node 22.x patches:
//   node --experimental-sqlite scripts/db.mjs --show-path
//   node --experimental-sqlite scripts/db.mjs --init
//
// This module is the single place that knows WHERE the DB lives and WHAT shape it has.
// Everything else (fetch-history, add-marker, seed, render) imports openDb() from here so
// the path-resolution and schema rules never drift between scripts.
//
// Why a "complement, not replace" design: Obsidian (via Eliot) stays the human-readable
// source of truth for the *narrative* (why we bought/sold). This DB is the *structured*
// mirror used for charting and queries — OHLC history + decision markers. The reason text
// on a marker is a one-line echo of the Obsidian note, not a second master copy.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SCHEMA_VERSION = '1';

// The built-in default. The user picked the project folder so the DB sits next to the
// data they already work with. Override wins via env or Profile.md (see resolveDbPath).
const DEFAULT_DB_PATH = join(homedir(), 'personal', 'stocks', 'stocks.db');

// Where the skill already keeps user config. We read (never write) a `stock_db_path:` line
// from here so the user can repoint the DB — e.g. into OneDrive — without touching code.
const DEFAULT_PROFILE = join(homedir(), 'personal', 'Obisidian', 'Eliot', 'Profile.md');

/**
 * Resolve the DB file path. Order, most specific first:
 *   1. env TW_STOCK_DB         — per-invocation override, good for testing/CI
 *   2. Profile.md stock_db_path — durable user choice (point at OneDrive to sync)
 *   3. built-in default         — project folder
 * The chosen path is returned even if the file doesn't exist yet; openDb() creates it.
 */
export function resolveDbPath() {
  const env = process.env.TW_STOCK_DB;
  if (env && env.trim()) return env.trim();

  const profile = process.env.ELIOT_PROFILE || DEFAULT_PROFILE;
  if (existsSync(profile)) {
    try {
      const txt = readFileSync(profile, 'utf8');
      // Match `stock_db_path: <path>` (optionally indented / quoted). Lives anywhere in Profile.md.
      const m = txt.match(/^\s*stock_db_path\s*:\s*["']?(.+?)["']?\s*$/m);
      if (m && m[1].trim()) return m[1].trim();
    } catch { /* unreadable profile → fall through to default */ }
  }
  return DEFAULT_DB_PATH;
}

/**
 * Open (creating if needed) the DB at the resolved path and ensure the schema exists.
 * Idempotent: safe to call on every script run. Returns the live DatabaseSync handle.
 */
export function openDb(pathOverride) {
  const dbPath = pathOverride || resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  initSchema(db);
  return db;
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stocks (
      code   TEXT PRIMARY KEY,
      name   TEXT,
      market TEXT DEFAULT 'twse'          -- 'twse' | 'tpex'
    );
    CREATE TABLE IF NOT EXISTS ohlc (
      code   TEXT NOT NULL,
      date   TEXT NOT NULL,               -- ISO 'YYYY-MM-DD'
      open   REAL, high REAL, low REAL, close REAL,
      volume INTEGER,                     -- shares
      PRIMARY KEY (code, date)
    );
    CREATE TABLE IF NOT EXISTS indicators (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      ma5 REAL, ma10 REAL, ma20 REAL,
      k9 REAL, d9 REAL, rsi6 REAL, rsi12 REAL, macd REAL,
      PRIMARY KEY (code, date)
    );
    CREATE TABLE IF NOT EXISTS markers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL,
      date       TEXT NOT NULL,           -- ISO date the marker sits on
      action     TEXT NOT NULL,           -- buy | sell | hold | watch | signal | stop | target
      price      REAL,                    -- price level: fill (buy/sell) OR trigger level (signal/stop/target)
      reason     TEXT,                    -- the thesis — why we acted / are watching (echo of the note)
      note_link  TEXT,                    -- [[note-slug]] back-reference into the vault
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (code, date, action, price)  -- re-seeding is idempotent
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  migrate(db);  // add post-mortem columns to markers if an older DB predates them
  db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
    .run('schema_version', SCHEMA_VERSION);
}

// Forward-compatible column adds — so a chart can act as a review/post-mortem reference:
//   status    : pending | met | open | closed | stopped | invalidated  (lifecycle of the decision)
//   condition : the trigger to watch FOR a signal (e.g. "站回 20MA 連 2 日 + KD 金叉")
//   outcome   : what actually happened (realized P&L, "停損出場", etc.) — the post-mortem note
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(markers)').all().map(c => c.name));
  for (const [name, decl] of [['status', 'TEXT'], ['condition', 'TEXT'], ['outcome', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE markers ADD COLUMN ${name} ${decl}`);
  }
}

// ---- small upsert/query helpers shared by the other scripts ----------------------------

export function upsertStock(db, code, name, market = 'twse') {
  db.prepare(`INSERT INTO stocks(code,name,market) VALUES(?,?,?)
              ON CONFLICT(code) DO UPDATE SET name=COALESCE(excluded.name,name),
                                              market=excluded.market`)
    .run(code, name ?? null, market);
}

export function upsertOhlc(db, code, row) {
  // row: { date, open, high, low, close, volume }
  db.prepare(`INSERT INTO ohlc(code,date,open,high,low,close,volume)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(code,date) DO UPDATE SET
                open=excluded.open, high=excluded.high, low=excluded.low,
                close=excluded.close, volume=excluded.volume`)
    .run(code, row.date, row.open, row.high, row.low, row.close, row.volume ?? null);
}

export function addMarker(db, m) {
  // m: { code, date, action, price?, reason?, note_link?, status?, condition?, outcome? }
  // ON CONFLICT update lets us enrich an existing marker (e.g. fill in `outcome`/`status` later)
  // without creating a duplicate — important for the post-mortem lifecycle (pending → met → closed).
  db.prepare(`INSERT INTO markers(code,date,action,price,reason,note_link,status,condition,outcome)
              VALUES(?,?,?,?,?,?,?,?,?)
              ON CONFLICT(code,date,action,price) DO UPDATE SET
                reason=COALESCE(excluded.reason,reason),
                note_link=COALESCE(excluded.note_link,note_link),
                status=COALESCE(excluded.status,status),
                condition=COALESCE(excluded.condition,condition),
                outcome=COALESCE(excluded.outcome,outcome)`)
    .run(m.code, m.date, m.action, m.price ?? null, m.reason ?? null, m.note_link ?? null,
         m.status ?? null, m.condition ?? null, m.outcome ?? null);
}

export function getOhlc(db, code, fromDate) {
  const stmt = fromDate
    ? db.prepare('SELECT * FROM ohlc WHERE code=? AND date>=? ORDER BY date')
    : db.prepare('SELECT * FROM ohlc WHERE code=? ORDER BY date');
  return fromDate ? stmt.all(code, fromDate) : stmt.all(code);
}

export function getMarkers(db, code, fromDate) {
  const stmt = fromDate
    ? db.prepare('SELECT * FROM markers WHERE code=? AND date>=? ORDER BY date')
    : db.prepare('SELECT * FROM markers WHERE code=? ORDER BY date');
  return fromDate ? stmt.all(code, fromDate) : stmt.all(code);
}

/** Months (YYYY-MM) that already have at least one ohlc row — so fetch can skip them. */
export function monthsPresent(db, code) {
  return new Set(
    db.prepare("SELECT DISTINCT substr(date,1,7) AS ym FROM ohlc WHERE code=?")
      .all(code).map(r => r.ym)
  );
}

// ---- CLI -------------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--show-path')) {
    console.log(resolveDbPath());
    return;
  }
  if (args.includes('--init')) {
    const db = openDb();
    const v = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version');
    console.log(`Initialized DB at ${resolveDbPath()} (schema v${v.value})`);
    db.close();
    return;
  }
  console.log('Usage: node --experimental-sqlite scripts/db.mjs [--show-path | --init]');
}

// Run main() only when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('db.mjs')) {
  main();
}
