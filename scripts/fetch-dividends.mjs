#!/usr/bin/env node
// fetch-dividends.mjs — sync ex-dividend events into the `dividends` table (Rule 6i).
//
//   node --experimental-sqlite scripts/fetch-dividends.mjs --months 4
//   node --experimental-sqlite scripts/fetch-dividends.mjs --from 2026-04-01 --to 2026-07-31
//
// Sources (both official, plain JSON, no browser — same doctrine as scan.mjs):
//   TWSE  TWT49U  — historical range query, market-wide, one call per chunk.
//                   Fields: 資料日期(ROC) 股票代號 股票名稱 除權息前收盤價 除權息參考價
//                   權值+息值 權/息 …
//   TPEx  exDailyQ — FORWARD-LOOKING 預告 window only (the range params are ignored by the
//                   server, verified 2026-07-31). Each sync captures the upcoming few days;
//                   history accumulates over daily runs. This asymmetry is a documented
//                   limitation: TPEx codes may have missing PAST events, and screen.mjs
//                   treats dividend data as best-effort (absence of a row ≠ no dividend).
//
// Rows are market-wide (all codes), so a single sync serves every tracked stock. ~1 call
// per month chunk + 1 TPEx call; throttled like fetch-history.

import { openDb } from './db.mjs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
let from = flag('from'), to = flag('to');
if (!from) {
  const months = Number(flag('months') ?? 4);
  const d = new Date(today); d.setMonth(d.getMonth() - months);
  from = iso(d);
}
if (!to) to = iso(today);

const rocToIso = (s) => {
  // '115年07月30日' or '115/07/30' → '2026-07-30'
  const m = String(s).match(/(\d{2,3})[年/](\d{1,2})[月/](\d{1,2})/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
};
const num = (s) => { const v = Number(String(s).replace(/,/g, '')); return isFinite(v) ? v : null; };
// common-stock filter, same as scan.mjs: 4-digit codes not starting with 0
const isCommon = (c) => /^[1-9]\d{3}$/.test(c);

async function readJson(url) {
  const r = await fetch(url, { headers: UA });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.includes('json')) throw new Error(`${url.slice(0, 60)}… → HTTP ${r.status} ${ct.slice(0, 30)} (endpoint rot?)`);
  return r.json();
}

const db = openDb();
const upsert = db.prepare(`INSERT INTO dividends(code,exdate,amount,kind,source) VALUES(?,?,?,?,?)
  ON CONFLICT(code,exdate) DO UPDATE SET amount=excluded.amount, kind=excluded.kind, source=excluded.source`);

let twseRows = 0, tpexRows = 0;

// ---- TWSE: chunk the range by calendar month (server accepts arbitrary ranges but keep
// chunks small to stay under response caps) --------------------------------------------------
const chunks = [];
{
  let cur = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cur <= end) {
    const cEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    chunks.push([iso(cur), iso(cEnd > end ? end : cEnd)]);
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
}
for (const [a, b] of chunks) {
  const url = `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${a.replaceAll('-', '')}&endDate=${b.replaceAll('-', '')}&response=json`;
  try {
    const j = await readJson(url);
    if (j.stat !== 'OK') { console.log(`TWSE ${a}~${b}: stat=${j.stat} (skipped)`); continue; }
    for (const row of j.data ?? []) {
      const exdate = rocToIso(row[0]); const code = String(row[1]).trim();
      const amount = num(row[5]); const kind = String(row[6] ?? '').trim() || null;
      if (!exdate || !isCommon(code) || amount == null || amount <= 0) continue;
      upsert.run(code, exdate, amount, kind, 'twse');
      twseRows++;
    }
  } catch (e) { console.error(`TWSE ${a}~${b}: ${e.message}`); }
  await new Promise(r => setTimeout(r, 1200));
}

// ---- TPEx: forward window only (range params ignored by server) ----------------------------
try {
  const j = await readJson('https://www.tpex.org.tw/web/stock/exright/dailyquo/exDailyQ_result.php?l=zh-tw');
  const t = j.tables?.[0];
  if (!t) throw new Error('no tables[] — endpoint rot?');
  const f = t.fields ?? [];
  const di = f.indexOf('除權息日期'), ci = f.indexOf('代號'), ai = f.indexOf('權值+息值'), ki = f.indexOf('權/息');
  if (di < 0 || ci < 0 || ai < 0) throw new Error(`fields moved: ${JSON.stringify(f).slice(0, 120)}`);
  for (const row of t.data ?? []) {
    const exdate = rocToIso(row[di]); const code = String(row[ci]).trim();
    const amount = num(row[ai]); const kind = String(row[ki] ?? '').trim() || null;
    if (!exdate || !isCommon(code) || amount == null || amount <= 0) continue;
    upsert.run(code, exdate, amount, kind, 'tpex-forward');
    tpexRows++;
  }
} catch (e) { console.error(`TPEx forward window: ${e.message}`); }

const total = db.prepare('SELECT COUNT(*) n FROM dividends').get().n;
console.log(`dividends sync ${from}~${to}: TWSE +${twseRows} rows, TPEx(forward) +${tpexRows} rows; table now ${total} rows`);
