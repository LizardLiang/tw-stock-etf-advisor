// add-marker.mjs — record one decision marker or forward signal (the annotation the chart shows).
//
//   node --experimental-sqlite scripts/add-marker.mjs <code> <date> <action> [price] [reason] [note_link] \
//        [--status S] [--condition "..."] [--outcome "..."]
//
//   action ∈ buy | sell | hold | watch | signal | stop | target
//   status ∈ pending | met | open | closed | stopped | invalidated   (drives the chart colour)
//
// Examples:
//   # an executed buy that is now held
//   add-marker.mjs 3017 2026-06-01 buy 2820 "AI 散熱 進場（略高於買區）" "[[note]]" --status open
//   # a forward signal: a condition to check, drawn as a flagged threshold line at the level
//   add-marker.mjs 2454 2026-06-30 signal 4329 "進場觀察：聯發科" --status pending \
//        --condition "站回 20MA(4,329) 連 2 日 + KD 轉金叉"
//   # close it out later (idempotent upsert fills in the outcome)
//   add-marker.mjs 3017 2026-06-26 stop 2550 --status stopped --outcome "跌停 -20% 自成本，停損出場"
//
// See references/charting.md for the marker glyph/colour map and the review-panel semantics.

import { openDb, addMarker } from './db.mjs';

const VALID = new Set(['buy', 'sell', 'hold', 'watch', 'signal', 'stop', 'target']);
const STATUS = new Set(['pending', 'met', 'open', 'closed', 'stopped', 'invalidated']);

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  // positionals are the args before any -- flag
  const cut = argv.findIndex(a => a.startsWith('--'));
  const pos = cut === -1 ? argv : argv.slice(0, cut);
  const [code, date, action, price, reason, note] = pos;

  if (!code || !date || !action) {
    console.error('Usage: add-marker.mjs <code> <date> <action> [price] [reason] [note_link] [--status S] [--condition ...] [--outcome ...]');
    console.error(`  action ∈ ${[...VALID].join('|')}`);
    process.exit(1);
  }
  if (!VALID.has(action)) { console.error(`Bad action "${action}". Use ${[...VALID].join('|')}`); process.exit(1); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`Bad date "${date}". Use YYYY-MM-DD`); process.exit(1); }
  const status = flag('--status');
  if (status && !STATUS.has(status)) { console.error(`Bad status "${status}". Use ${[...STATUS].join('|')}`); process.exit(1); }

  const db = openDb();
  addMarker(db, {
    code, date, action,
    price: price != null && price !== '' ? Number(price) : null,
    reason: reason ?? null,
    note_link: note ?? null,
    status: status ?? null,
    condition: flag('--condition'),
    outcome: flag('--outcome'),
  });
  console.log(`marker: ${code} ${date} ${action}${price ? ' @' + price : ''}${status ? ' [' + status + ']' : ''}`);
  db.close();
}

if (process.argv[1]?.endsWith('add-marker.mjs')) main();
