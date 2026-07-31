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

// ---- market classification (US-market delta, 2026-07-31) ---------------------------------
//
// TW codes are numeric (2330, 00892); US tickers are alphabetic (NVDA, BRK.B). The two shapes
// never collide, so every table stays keyed on `code` alone and the market FAMILY is derived
// from the code's shape. This function is the single owner of that classification — every
// script imports it; nobody re-derives it with an ad-hoc regex. ('tw' is the family; the
// finer 'twse' | 'tpex' | 'us' venue lives in stocks.market.)
export function marketForCode(code) {
  return /^\d/.test(String(code)) ? 'tw' : 'us';
}

// Per-market SQL fragments. Table names cannot be bound as parameters, so the market value is
// validated HERE and anything unknown throws by name — never a silent fall-through to the
// wrong market's calendar (the same silent-degradation class as endpoint rot).
function marketSql(market) {
  if (market === 'tw') return { glob: '[0-9]*', holidayTable: 'holidays' };
  if (market === 'us') return { glob: '[A-Z]*', holidayTable: 'holidays_us' };
  throw new Error(`unknown market "${market}" — expected 'tw' or 'us'`);
}

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
      market TEXT DEFAULT 'twse'          -- 'twse' | 'tpex' | 'us'
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
    -- Whole-market daily quotes (scan.mjs). One row per stock per session, BOTH markets,
    -- so the market scan can compute volume ratios / streaks without per-stock fetches.
    CREATE TABLE IF NOT EXISTS market_snapshot (
      code    TEXT NOT NULL,
      date    TEXT NOT NULL,              -- ISO 'YYYY-MM-DD'
      market  TEXT,                       -- 'twse' | 'tpex'
      name    TEXT,
      close   REAL,
      chg_pct REAL,                       -- % change vs prior close (null when unparseable, e.g. 除息)
      volume  INTEGER,                    -- shares
      value   INTEGER,                    -- NTD traded (liquidity floor input, Rule 6q check 5)
      PRIMARY KEY (code, date)
    );
    -- Per-stock 三大法人 daily nets (scan.mjs). Shares; positive = net buy.
    CREATE TABLE IF NOT EXISTS inst_flows (
      code        TEXT NOT NULL,
      date        TEXT NOT NULL,          -- ISO 'YYYY-MM-DD'
      foreign_net INTEGER,
      trust_net   INTEGER,
      dealer_net  INTEGER,
      PRIMARY KEY (code, date)
    );
    -- Structured mirror of the holdings ledger's "## 持有中" table (rule-math-mechanization).
    -- Obsidian stays the narrative source; this is the machine-readable source for positions.mjs.
    CREATE TABLE IF NOT EXISTS positions (
      code TEXT PRIMARY KEY,
      name TEXT,
      shares REAL NOT NULL,
      cost_avg REAL NOT NULL,
      opened_at TEXT NOT NULL,          -- ISO date of first buy
      stop REAL,                        -- NULL when none
      stop_status TEXT NOT NULL          -- 'active' | 'reunderwritten' | 'void'
        DEFAULT 'active',
      stop_set_at TEXT,                  -- ISO date the CURRENT stop was set/last moved
                                          -- (Rule 6d trails it to breakeven/5MA) — breach-check
                                          -- only scans ohlc from here, never from opened_at,
                                          -- or a trailed-up stop reads old pre-trail history as
                                          -- a breach (2026-07-20 review finding)
      target_lo REAL, target_hi REAL,
      theme TEXT,                        -- correlation group for 6e-3 / 6e-4 (model-supplied)
      thesis_note TEXT,                  -- [[slug]] of the thesis note
      updated_at TEXT
    );
    -- Weekday non-trading days (Taiwan). Seeded with a best-effort built-in table
    -- (source='builtin'); --sync-holidays refreshes/extends it from TWSE (source='twse').
    -- R5: 6h's earnings-blackout count must never be silently wrong outside this table's
    -- coverage — see holidays_builtin_from/to in meta and rules.mjs earnings' warning field.
    CREATE TABLE IF NOT EXISTS holidays (
      date TEXT PRIMARY KEY,             -- ISO, non-trading weekday only
      name TEXT,
      source TEXT                        -- 'builtin' | 'twse' | 'derived' (from ohlc gaps)
    );
    -- Weekday non-trading days (US / NYSE+Nasdaq). Same doctrine as holidays above: the builtin
    -- list is a best-effort accuracy aid; VERIFIED US coverage comes only from the US-scoped
    -- ohlc-derived span (there is no TWSE-style sync source for NYSE — seed the calendar by
    -- fetching SPY history, which trades every NYSE session).
    CREATE TABLE IF NOT EXISTS holidays_us (
      date TEXT PRIMARY KEY,             -- ISO, non-trading weekday only
      name TEXT,
      source TEXT                        -- 'builtin' | 'derived' (from ohlc gaps)
    );
  `);
  migrate(db);  // add post-mortem columns to markers if an older DB predates them
  db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
    .run('schema_version', SCHEMA_VERSION);
  seedBuiltinHolidays(db);
}

// ---- holidays (Rule 6h / R5) ------------------------------------------------------------

// Best-effort built-in Taiwan (TWSE/TPEx) weekday market holidays for 2026. Weekend dates are
// deliberately omitted — the trading-day counter already treats Sat/Sun as non-trading; only
// WEEKDAY closures need to be listed here. Dates are approximate where the official calendar
// wasn't confirmable at authoring time (2026-07-20) — refresh with `--sync-holidays` (rules.mjs)
// for authoritative dates; that is the ONLY network call anywhere in this delta, and it is
// opt-in by design (R5).
const BUILTIN_HOLIDAYS_2026 = [
  ['2026-01-01', '元旦'],
  ['2026-02-16', '春節（除夕）'],
  ['2026-02-17', '春節（初一）'],
  ['2026-02-18', '春節（初二）'],
  ['2026-02-19', '春節（初三）'],
  ['2026-02-20', '春節（初四，調整）'],
  ['2026-02-27', '228和平紀念日調整（2/28 為週六）'],
  ['2026-04-03', '兒童節／民族掃墓節（調整）'],
  ['2026-05-01', '勞動節'],
  ['2026-06-19', '端午節'],
  ['2026-09-25', '中秋節'],
  ['2026-10-09', '國慶日調整（10/10 為週六）'],
];
const BUILTIN_HOLIDAYS_COVERAGE = { from: '2026-01-01', to: '2026-12-31' };

// Built-in NYSE/Nasdaq full-day market holidays for 2026. Weekday closures only (weekends are
// already non-trading). Unlike Taiwan there are no make-up workdays, but half-days (e.g. the
// day after Thanksgiving) still produce ohlc rows and are deliberately NOT listed.
const BUILTIN_US_HOLIDAYS_2026 = [
  ['2026-01-01', "New Year's Day"],
  ['2026-01-19', 'Martin Luther King Jr. Day'],
  ['2026-02-16', "Washington's Birthday"],
  ['2026-04-03', 'Good Friday'],
  ['2026-05-25', 'Memorial Day'],
  ['2026-06-19', 'Juneteenth'],
  ['2026-07-03', 'Independence Day (observed — 7/4 is a Saturday)'],
  ['2026-09-07', 'Labor Day'],
  ['2026-11-26', 'Thanksgiving Day'],
  ['2026-12-25', 'Christmas Day'],
];
const BUILTIN_US_HOLIDAYS_COVERAGE = { from: '2026-01-01', to: '2026-12-31' };

/** Idempotent: seeds both markets' built-in holiday lists and records coverage in `meta`. */
function seedBuiltinHolidays(db) {
  const ins = db.prepare(`INSERT INTO holidays(date,name,source) VALUES(?,?,'builtin')
                           ON CONFLICT(date) DO NOTHING`);
  for (const [date, name] of BUILTIN_HOLIDAYS_2026) ins.run(date, name);
  db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
    .run('holidays_builtin_from', BUILTIN_HOLIDAYS_COVERAGE.from);
  db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
    .run('holidays_builtin_to', BUILTIN_HOLIDAYS_COVERAGE.to);
  const insUs = db.prepare(`INSERT INTO holidays_us(date,name,source) VALUES(?,?,'builtin')
                             ON CONFLICT(date) DO NOTHING`);
  for (const [date, name] of BUILTIN_US_HOLIDAYS_2026) insUs.run(date, name);
  db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
    .run('holidays_us_builtin_from', BUILTIN_US_HOLIDAYS_COVERAGE.from);
  db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
    .run('holidays_us_builtin_to', BUILTIN_US_HOLIDAYS_COVERAGE.to);
}

/** Current holiday-table coverage range, as recorded in `meta` (extended by --sync-holidays). */
export function getHolidayCoverage(db) {
  const from = db.prepare('SELECT value FROM meta WHERE key=?').get('holidays_builtin_from');
  const to = db.prepare('SELECT value FROM meta WHERE key=?').get('holidays_builtin_to');
  return { from: from?.value ?? null, to: to?.value ?? null };
}

/** Extend the recorded coverage range to include [from, to] (used by --sync-holidays). */
export function extendHolidayCoverage(db, from, to) {
  const cur = getHolidayCoverage(db);
  const newFrom = cur.from && cur.from < from ? cur.from : from;
  const newTo = cur.to && cur.to > to ? cur.to : to;
  db.prepare(`INSERT INTO meta(key,value) VALUES('holidays_builtin_from',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(newFrom);
  db.prepare(`INSERT INTO meta(key,value) VALUES('holidays_builtin_to',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(newTo);
}

/** Set of ISO holiday dates in [from, to] inclusive, for the trading-day counter. */
export function getHolidaySet(db, from, to, market = 'tw') {
  const { holidayTable } = marketSql(market);
  return new Set(
    db.prepare(`SELECT date FROM ${holidayTable} WHERE date>=? AND date<=?`).all(from, to).map(r => r.date)
  );
}

// ---- verified coverage (2026-07-20 review fix — fail-loud, T1.1) -------------------------
//
// The static builtin table has now missed real holidays twice (2026-04-06/07-10 the first
// round; 2026-02-27/10-09 this round). Taiwan make-up holidays and typhoon closures cannot be
// enumerated in advance, so the table is downgraded to a best-effort ACCURACY AID only — it
// must never by itself mark a date range "verified". Verified coverage is strictly:
//   (a) the ohlc-derived span (authoritative, see getOhlcDateRange), UNION
//   (b) years actually synced from TWSE with a NON-EMPTY parse (see markYearSynced) —
//       an empty parse is a sync FAILURE, not evidence of a holiday-free year (T1.5).

/** Years successfully synced from TWSE with a non-empty parse — see markYearSynced. */
export function getSyncedYears(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get('holidays_synced_years');
  return new Set(row?.value ? row.value.split(',').filter(Boolean) : []);
}

/** Record year `y` as verified (--sync-holidays MUST only call this after a non-empty parse). */
export function markYearSynced(db, y) {
  const years = getSyncedYears(db);
  years.add(String(y));
  const csv = [...years].sort().join(',');
  db.prepare(`INSERT INTO meta(key,value) VALUES('holidays_synced_years',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(csv);
}

function nextIsoDayLocal(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Merge a list of {from,to} ISO-date intervals, combining overlapping/adjacent ones. Real
 * interval union — NOT a min/max bounding box, which would silently paper over a genuine gap
 * BETWEEN two verified spans (the exact bug Hermes flagged at rules.mjs:100-104). */
export function mergeIntervals(intervals) {
  const sorted = [...intervals]
    .filter((iv) => iv.from && iv.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.from <= nextIsoDayLocal(last.to)) {
      if (iv.to > last.to) last.to = iv.to;
    } else {
      merged.push({ from: iv.from, to: iv.to });
    }
  }
  return merged;
}

/** VERIFIED coverage intervals (merged): the market-scoped ohlc-derived span, plus (TW only)
 * every TWSE-synced year. The builtin tables' nominal ranges are deliberately excluded — they
 * are not a coverage guarantee. US has no sync source, so its ONLY verified coverage is the
 * ohlc span of fetched US history (seed it with SPY, which trades every NYSE session). */
export function getVerifiedIntervals(db, market = 'tw') {
  const intervals = [];
  const ohlcRange = getOhlcDateRange(db, market);
  if (ohlcRange.from && ohlcRange.to) intervals.push({ from: ohlcRange.from, to: ohlcRange.to });
  if (market === 'tw') {
    for (const y of getSyncedYears(db)) intervals.push({ from: `${y}-01-01`, to: `${y}-12-31` });
  }
  return mergeIntervals(intervals);
}

/** True only if [from,to] is FULLY inside a single merged verified interval — a range that
 * straddles a gap between two verified spans is NOT fully verified. */
export function isRangeFullyVerified(mergedIntervals, from, to) {
  return mergedIntervals.some((iv) => from >= iv.from && to <= iv.to);
}

// ---- ohlc-derived trading calendar (2026-07-20 fix — R5 gap) -----------------------------
//
// The `holidays` table (builtin/twse) is a static, hand-maintained list — it missed a real
// make-up holiday (2026-04-06, Tomb Sweeping observance) and a typhoon closure (2026-07-10)
// that a static table can never predict. Where we already hold TWSE's own settled OHLC
// history locally, THAT is the authoritative trading calendar — a weekday with zero `ohlc`
// rows across every tracked code, inside the DB's own covered span, is a genuine closure.
// This is free, needs no network, and self-updates as `fetch-history.mjs` pulls more history.

/** [min(date), max(date)] across the given MARKET's `ohlc` rows — the span we can derive
 * from. Market-scoped since the US delta: TW and US calendars differ, so one market's rows
 * must never count as trading evidence for the other (春節 is a normal NYSE week). */
export function getOhlcDateRange(db, market = 'tw') {
  const { glob } = marketSql(market);
  const row = db.prepare('SELECT min(date) minD, max(date) maxD FROM ohlc WHERE code GLOB ?').get(glob);
  return { from: row?.minD ?? null, to: row?.maxD ?? null };
}

/** Distinct dates with at least one `ohlc` row (given market) in [from, to] — trading days. */
export function getTradingDatesInRange(db, from, to, market = 'tw') {
  const { glob } = marketSql(market);
  return new Set(
    db.prepare('SELECT DISTINCT date FROM ohlc WHERE code GLOB ? AND date>=? AND date<=?')
      .all(glob, from, to).map((r) => r.date)
  );
}

/**
 * Persist any weekday within `ohlc`'s current covered span that has NO rows for any code as
 * a holiday with source='derived' (idempotent — ON CONFLICT DO NOTHING never downgrades an
 * existing 'builtin'/'twse' entry's provenance). Self-updating: re-running after a fresh
 * `fetch-history.mjs` pull picks up any newly-observed closures automatically.
 */
export function deriveHolidaysFromOhlc(db, market = 'tw') {
  const { holidayTable } = marketSql(market);
  const { from, to } = getOhlcDateRange(db, market);
  if (!from || !to) return { from: null, to: null, added: 0 };
  const trading = getTradingDatesInRange(db, from, to, market);
  const ins = db.prepare(`INSERT INTO ${holidayTable}(date,name,source) VALUES(?,?,'derived')
                           ON CONFLICT(date) DO NOTHING`);
  let added = 0;
  let cursor = from;
  while (cursor <= to) {
    const day = new Date(`${cursor}T00:00:00`).getDay();
    if (day !== 0 && day !== 6 && !trading.has(cursor)) {
      const res = ins.run(cursor, `derived closure (no ohlc rows across any ${market} code on this weekday)`);
      if (res.changes > 0) added++;
    }
    const d = new Date(`${cursor}T00:00:00`);
    d.setDate(d.getDate() + 1);
    cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return { from, to, added };
}

export function upsertHoliday(db, date, name, source = 'twse') {
  db.prepare(`INSERT INTO holidays(date,name,source) VALUES(?,?,?)
              ON CONFLICT(date) DO UPDATE SET name=COALESCE(excluded.name,name),
                                              source=excluded.source`)
    .run(date, name ?? null, source);
}

// ---- positions (Rule 6e-4 / 6n / Action C) -----------------------------------------------

export function upsertPosition(db, p) {
  // p: { code, name?, shares, cost_avg, opened_at, stop?, stop_status?, stop_set_at?,
  //      target_lo?, target_hi?, theme?, thesis_note? }
  // stop_set_at defaults to opened_at when omitted — the honest default when the caller
  // (e.g. a ledger backfill) has no record of when the CURRENT stop was actually set.
  db.prepare(`INSERT INTO positions(code,name,shares,cost_avg,opened_at,stop,stop_status,
                stop_set_at,target_lo,target_hi,theme,thesis_note,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(code) DO UPDATE SET
                name=COALESCE(excluded.name,name),
                shares=excluded.shares, cost_avg=excluded.cost_avg,
                opened_at=excluded.opened_at,
                stop=excluded.stop, stop_status=excluded.stop_status,
                stop_set_at=excluded.stop_set_at,
                target_lo=excluded.target_lo, target_hi=excluded.target_hi,
                theme=COALESCE(excluded.theme,theme),
                thesis_note=COALESCE(excluded.thesis_note,thesis_note),
                updated_at=datetime('now')`)
    .run(p.code, p.name ?? null, p.shares, p.cost_avg, p.opened_at,
         p.stop ?? null, p.stop_status ?? 'active', p.stop_set_at ?? p.opened_at,
         p.target_lo ?? null, p.target_hi ?? null,
         p.theme ?? null, p.thesis_note ?? null);
}

export function getPosition(db, code) {
  return db.prepare('SELECT * FROM positions WHERE code=?').get(code);
}

export function getAllPositions(db) {
  return db.prepare('SELECT * FROM positions ORDER BY code').all();
}

export function getPositionsByTheme(db, theme) {
  return db.prepare('SELECT * FROM positions WHERE theme=? ORDER BY code').all(theme);
}

/** Remove a position — used by seed-from-obsidian.mjs's ledger reconciliation (a sold-out
 * position must not linger forever and get reported as a phantom holding, 2026-07-20 review). */
export function deletePosition(db, code) {
  db.prepare('DELETE FROM positions WHERE code=?').run(code);
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
  // 2026-07-20 review finding: positions created before stop_set_at existed need it backfilled
  // so breach-check doesn't scan a trailed stop against pre-trail history (opened_at is the
  // honest default — the same value a fresh insert would get when the caller doesn't pass one).
  const pcols = new Set(db.prepare('PRAGMA table_info(positions)').all().map(c => c.name));
  if (!pcols.has('stop_set_at')) {
    db.exec(`ALTER TABLE positions ADD COLUMN stop_set_at TEXT`);
    db.exec(`UPDATE positions SET stop_set_at = opened_at WHERE stop_set_at IS NULL`);
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
