// seed-from-obsidian.mjs — one-time (idempotent) import of past decisions into `markers`,
// so charts show real buy/sell/stop/watch history from day one instead of starting blank.
//
//   node --experimental-sqlite scripts/seed-from-obsidian.mjs
//   node --experimental-sqlite scripts/seed-from-obsidian.mjs --vault "C:/Users/.../Obisidian"
//   node --experimental-sqlite scripts/seed-from-obsidian.mjs --ledger <path> --note <path>
//
// What it reads (Obsidian remains the narrative source of truth — we only mirror structure):
//   1. Holdings ledger `## 交易明細` table → precise buy/sell markers (+ derived stop/target
//      from the 停損 / 停利目標 columns on buy rows). 備註 becomes the marker reason.
//   2. The newest analysis note's `### 觀察名單` lines `- <code> <name>：<trigger>` → watch
//      markers dated at the note's `created:` date, with the trigger text as the reason.
//
// Re-running is safe: markers are UNIQUE on (code,date,action,price) and inserted OR IGNORE.

import { openDb, addMarker } from './db.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };

const VAULT = arg('--vault') || process.env.STOCK_VAULT || join(homedir(), 'personal', 'Obisidian');
const NOTES_DIR = join(VAULT, 'Eliot', 'Notes');

const firstNum = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** Find the newest year subfolder under Eliot/Notes, falling back to NOTES_DIR itself. */
function newestNotesYearDir() {
  if (!existsSync(NOTES_DIR)) return null;
  const years = readdirSync(NOTES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name)).map(d => d.name).sort();
  return years.length ? join(NOTES_DIR, years[years.length - 1]) : NOTES_DIR;
}

function defaultLedgerPath() {
  const dir = newestNotesYearDir();
  return dir ? join(dir, 'stock-holdings.md') : null;
}

/** Newest file whose name contains "analysis" in the newest year dir. */
function defaultNotePath() {
  const dir = newestNotesYearDir();
  if (!dir || !existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => /analysis/i.test(f) && f.endsWith('.md')).sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}

/** Parse markdown table rows out of a `## <heading>` section. Returns array of cell arrays. */
function tableRows(md, heading) {
  const start = md.indexOf(heading);
  if (start < 0) return [];
  const tail = md.slice(start);
  const end = tail.indexOf('\n## ', 1);
  const block = end > 0 ? tail.slice(0, end) : tail;
  return block.split('\n')
    .filter(l => l.trim().startsWith('|'))
    .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()))
    .filter(cells => !cells.every(c => /^-{2,}$/.test(c) || c === '')) // drop separator row
    .filter(cells => !/^日期$/.test(cells[0])); // drop header row
}

function seedLedger(db, ledgerPath) {
  if (!ledgerPath || !existsSync(ledgerPath)) { console.error(`  ledger not found: ${ledgerPath}`); return 0; }
  const md = readFileSync(ledgerPath, 'utf8');
  const rows = tableRows(md, '## 交易明細')
    .map(c => ({ date: c[0], act: c[1], code: c[2], name: c[3], fill: c[4 + 1], stop: c[7], target: c[8], note: c[9] }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && /^\d{4,6}$/.test(r.code));

  // A code is "closed" for post-mortem purposes if it has both a buy and a later sell.
  const sells = {}; for (const r of rows) if (r.act.includes('賣')) sells[r.code] = r;
  let n = 0;
  for (const r of rows) {
    const reason = r.note && r.note !== '—' ? r.note : null;
    if (r.act.includes('買')) {
      const closed = sells[r.code];
      addMarker(db, {
        code: r.code, date: r.date, action: 'buy', price: firstNum(r.fill),
        reason: reason || `買進 ${r.name}`,
        status: closed ? 'closed' : 'open',
        outcome: closed ? (closed.note && closed.note !== '—' ? `平倉(${closed.date})：${closed.note}` : `已於 ${closed.date} 平倉`) : null,
      }); n++;
      const s = firstNum(r.stop);
      if (s) { addMarker(db, { code: r.code, date: r.date, action: 'stop', price: s, reason: '停損價', condition: `跌破 ${r.stop} → 停損出場`, status: 'pending' }); n++; }
      const t = firstNum(r.target);
      if (t) { addMarker(db, { code: r.code, date: r.date, action: 'target', price: t, reason: '停利目標', condition: `達 ${r.target} → 分批停利`, status: 'pending' }); n++; }
    } else if (r.act.includes('賣')) {
      addMarker(db, {
        code: r.code, date: r.date, action: 'sell', price: firstNum(r.fill),
        reason: reason || `賣出 ${r.name}`, status: 'closed', outcome: reason,
      }); n++;
    }
  }
  console.error(`  ledger: ${n} markers from ${rows.length} rows`);
  return n;
}

/**
 * Pull the trigger PRICE out of a watchlist condition so the chart can draw it as a line.
 * Anchor on an MA level — "20MA(4,329)" / "20MA(602)" — since that is the actionable price,
 * not the KD numbers in parens like "(55.4<63.8)". Fall back to the largest price-like number.
 */
function triggerLevel(cond) {
  const N = (s) => Number(String(s).replace(/,/g, ''));
  // 1. MA anchor — "20MA(4,329)" is the actionable level (ignore KD numbers in (55<63))
  const ma = cond.match(/MA\d*\(([\d,]+(?:\.\d+)?)\)/);
  if (ma) return N(ma[1]);
  // 2. buy-zone — "買區 4,820~4,950" → upper edge (the entry ceiling you wait to fall back into)
  const zone = cond.match(/買區\s*([\d,]+(?:\.\d+)?)\s*[~～－-]\s*([\d,]+(?:\.\d+)?)/);
  if (zone) return N(zone[2]);
  // 3. explicit level verb — "站上 7,056" / "守穩 602" / "跌破 2,550"
  const lvl = cond.match(/(?:站上|站回|守穩|站穩|突破|跌破|回測)\s*([\d,]+(?:\.\d+)?)/);
  if (lvl) return N(lvl[1]);
  // 4. fallback — strip full-width-paren annotations (usually "今收 X" current price), take largest >50
  const nums = [...cond.replace(/（[^）]*）/g, '').matchAll(/([\d,]+(?:\.\d+)?)/g)]
    .map(x => N(x[1])).filter(x => x > 50);
  return nums.length ? Math.max(...nums) : null;
}

function seedWatchlist(db, notePath) {
  if (!notePath || !existsSync(notePath)) { console.error(`  note not found: ${notePath}`); return 0; }
  const md = readFileSync(notePath, 'utf8');
  const created = md.match(/^created:\s*(\d{4}-\d{2}-\d{2})/m)?.[1]
    || md.match(/^id:\s*(\d{4})(\d{2})(\d{2})/m)?.slice(1, 4).join('-')
    || new Date().toISOString().slice(0, 10);
  const noteSlug = notePath.split(/[\\/]/).pop().replace(/\.md$/, '');
  const start = md.indexOf('### 觀察名單');
  if (start < 0) { console.error('  no 觀察名單 section'); return 0; }
  const block = md.slice(start).split('\n## ')[0];
  let n = 0;
  for (const line of block.split('\n')) {
    // - 3711 日月光：等 KD 由死叉...轉金叉 + 守穩 20MA(602)
    const m = line.match(/^-\s*(\d{4,6})\s+(\S+?)[：:]\s*(.+)$/);
    if (!m) continue;
    const cond = m[3].trim();
    // A watchlist item is a FORWARD signal: a condition to check, drawn at its trigger level.
    addMarker(db, {
      code: m[1], date: created, action: 'signal', price: triggerLevel(cond),
      reason: `進場觀察：${m[2]}`, condition: cond, status: 'pending',
      note_link: `[[${noteSlug}]]`,
    });
    n++;
  }
  console.error(`  watchlist: ${n} signal markers dated ${created}`);
  return n;
}

function main() {
  const ledger = arg('--ledger') || defaultLedgerPath();
  const note = arg('--note') || defaultNotePath();
  const db = openDb();
  console.error(`Seeding from vault: ${VAULT}`);
  const a = seedLedger(db, ledger);
  const b = seedWatchlist(db, note);
  console.log(`Seeded ${a + b} markers (ledger ${a}, watchlist ${b}).`);
  db.close();
}

if (process.argv[1]?.endsWith('seed-from-obsidian.mjs')) main();
