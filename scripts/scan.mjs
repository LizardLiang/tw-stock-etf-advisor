// scan.mjs — whole-market opportunity scan (the 市場掃描 pool source). Node built-ins only.
//
//   node --experimental-sqlite scripts/scan.mjs                 # sync + scan, JSON to stdout
//   node --experimental-sqlite scripts/scan.mjs --no-sync       # scan from cached data only
//   node --experimental-sqlite scripts/scan.mjs --sync-only     # refresh caches, no scan output
//   node --experimental-sqlite scripts/scan.mjs --top 20 --min-value 50000000 --rev-yoy 50
//
// Why this exists: the ETF-union pool only ever contains index constituents — names no
// index committee picked can never surface. This scan sweeps EVERY listed (上市) and OTC
// (上櫃) common stock through three opportunity signals and hands the survivors to the
// normal Action A machinery (fetch-history → screen.mjs gates → Rule 6q rating). It widens
// DISCOVERY only; it decides nothing about entry.
//
// Signals (each produces its own ranked list; hits on 2+ lists are highlighted):
//   momentum  量價突擊 — chg% ≥ --chg AND volume ≥ --vol-ratio × its own 5-session average
//   trustBuy  投信連買 — 投信 net-buying ≥ --trust-days consecutive sessions
//   revenue   營收YoY  — latest monthly revenue YoY ≥ --rev-yoy %
//
// Hard floor before any signal: 成交值 ≥ --min-value (default NT$100M). A stop on an
// illiquid name is fiction (Rule 6q check 5) — this floor is the honest replacement for
// the "professionals already filtered it" safety that ETF membership provided.
//
// Sources (all plain JSON, no browser; dates are ROC/民國 — Gregorian = ROC + 1911):
//   TWSE MI_INDEX (rwd)        — all-上市 daily quotes, per date  → market_snapshot
//   TPEx stk_wn1430 (rwd)      — all-上櫃 daily quotes, per date  → market_snapshot
//   TWSE T86 (rwd)             — per-stock 三大法人 nets, per date → inst_flows
//   TPEx 3itrade_hedge (rwd)   — same for 上櫃                    → inst_flows
//   TWSE openapi t187ap05_L    — monthly revenue, 上市 (YoY precomputed) — fetched fresh
//   TPEx openapi mopsfin_t187ap05_O — monthly revenue, 上櫃           — fetched fresh
//
// Caching: snapshot/institutional dates already in the DB are never re-fetched, so a
// daily run costs ~6 HTTP calls. First run backfills --backfill calendar days (default 10,
// ≈ 6-7 sessions) so volume ratios and 連買 streaks work immediately.

import { openDb } from './db.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) tw-stock-etf-advisor/1.0';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const num = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').replace(/\s/g, '');
  if (t === '' || t === '--' || t === '----') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// Common stocks only: 4-digit code not starting with 0. Excludes ETF/ETN (00xx…),
// warrants/bonds (5-6 digits or letters), and TDRs (91xxxx).
const isCommonStock = (code) => /^[1-9]\d{3}$/.test(String(code).trim());

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const yyyymmdd = (iso) => iso.replaceAll('-', '');
const rocSlash = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(y) - 1911}/${m}/${d}`; };
/** ROC "11506" → "2026-06" */
const rocYmToIso = (roc) => { const s = String(roc).trim(); return `${Number(s.slice(0, -2)) + 1911}-${s.slice(-2)}`; };

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// ---- per-date fetchers (each returns [] on non-trading days / unpublished dates) --------

async function fetchTwseDay(iso) {
  const j = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${yyyymmdd(iso)}&type=ALLBUT0999&response=json`);
  if (j.stat !== 'OK') return [];
  const t = (j.tables || []).find(t => (t.fields || []).includes('證券代號') && (t.fields || []).includes('收盤價'));
  if (!t) return [];
  const rows = [];
  for (const r of t.data || []) {
    if (!isCommonStock(r[0])) continue;
    const close = num(r[8]);
    if (close == null) continue;
    // r[9] is HTML like "<p style= color:red>+</p>" (red = up in TW); r[10] the unsigned delta.
    const sign = /\+/.test(r[9]) ? 1 : /-/.test(r[9]) ? -1 : 0;
    const chg = sign * (num(r[10]) ?? 0);
    const prev = close - chg;
    rows.push({
      code: r[0].trim(), name: r[1].trim(), market: 'twse', close,
      chg_pct: prev > 0 ? +(chg / prev * 100).toFixed(2) : null,
      volume: num(r[2]), value: num(r[4]),
    });
  }
  return rows;
}

async function fetchTpexDay(iso) {
  const j = await getJson(`https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${rocSlash(iso)}&se=EW`);
  const data = (j.tables && j.tables[0] && j.tables[0].data) || j.aaData || [];
  const rows = [];
  for (const r of data) {
    if (!isCommonStock(r[0])) continue;
    const close = num(r[2]);
    if (close == null) continue;
    const chg = num(r[3]);           // signed string ("+0.02"/"-1.42"); null on 除息/no-trade
    const prev = chg != null ? close - chg : null;
    rows.push({
      code: r[0].trim(), name: r[1].trim(), market: 'tpex', close,
      chg_pct: prev > 0 ? +(chg / prev * 100).toFixed(2) : null,
      volume: num(r[7]), value: num(r[8]),
    });
  }
  return rows;
}

async function fetchTwseInst(iso) {
  const j = await getJson(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${yyyymmdd(iso)}&selectType=ALLBUT0999&response=json`);
  if (j.stat !== 'OK') return [];
  // fields: 4=外陸資買賣超, 7=外資自營買賣超, 10=投信買賣超, 11=自營商買賣超(合計)
  return (j.data || []).filter(r => isCommonStock(r[0])).map(r => ({
    code: r[0].trim(),
    foreign_net: (num(r[4]) ?? 0) + (num(r[7]) ?? 0),
    trust_net: num(r[10]) ?? 0,
    dealer_net: num(r[11]) ?? 0,
  }));
}

async function fetchTpexInst(iso) {
  const j = await getJson(`https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d=${rocSlash(iso)}`);
  const data = (j.tables && j.tables[0] && j.tables[0].data) || [];
  // cols: 10=外資及陸資合計買賣超, 13=投信買賣超, 22=自營商合計買賣超
  return data.filter(r => isCommonStock(r[0])).map(r => ({
    code: r[0].trim(),
    foreign_net: num(r[10]) ?? 0,
    trust_net: num(r[13]) ?? 0,
    dealer_net: num(r[22]) ?? 0,
  }));
}

async function fetchRevenue() {
  const out = new Map(); // code → { yoy, mom, month }
  for (const url of [
    'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O',
  ]) {
    try {
      for (const r of await getJson(url)) {
        const code = String(r['公司代號'] || '').trim();
        if (!isCommonStock(code)) continue;
        const yoy = num(r['營業收入-去年同月增減(%)']);
        if (yoy == null) continue;
        out.set(code, { yoy: +yoy.toFixed(1), mom: num(r['營業收入-上月比較增減(%)']), month: rocYmToIso(r['資料年月']) });
      }
    } catch (e) { process.stderr.write(`  revenue ${url.includes('tpex') ? 'tpex' : 'twse'}: ${e.message} (skipped)\n`); }
    await sleep(800);
  }
  return out;
}

// ---- sync: fill market_snapshot + inst_flows for recent dates not yet cached ------------

async function sync(db, backfillDays) {
  const dates = [];
  const d = new Date();
  for (let i = 0; i < backfillDays; i++) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) dates.push(isoDate(d)); // skip weekends
    d.setDate(d.getDate() - 1);
  }

  const haveSnap = new Set(db.prepare('SELECT DISTINCT date FROM market_snapshot').all().map(r => r.date));
  const haveInst = new Set(db.prepare('SELECT DISTINCT date FROM inst_flows').all().map(r => r.date));
  const upSnap = db.prepare(`INSERT INTO market_snapshot(code,date,market,name,close,chg_pct,volume,value)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(code,date) DO UPDATE SET market=excluded.market,
    name=excluded.name, close=excluded.close, chg_pct=excluded.chg_pct,
    volume=excluded.volume, value=excluded.value`);
  const upInst = db.prepare(`INSERT INTO inst_flows(code,date,foreign_net,trust_net,dealer_net)
    VALUES(?,?,?,?,?) ON CONFLICT(code,date) DO UPDATE SET foreign_net=excluded.foreign_net,
    trust_net=excluded.trust_net, dealer_net=excluded.dealer_net`);

  for (const iso of dates) {
    if (!haveSnap.has(iso)) {
      try {
        const rows = [...await fetchTwseDay(iso), ...(await sleep(1200), await fetchTpexDay(iso))];
        for (const r of rows) upSnap.run(r.code, iso, r.market, r.name, r.close, r.chg_pct, r.volume, r.value);
        process.stderr.write(`  snapshot ${iso}: ${rows.length} stocks${rows.length ? '' : ' (holiday/unpublished)'}\n`);
      } catch (e) { process.stderr.write(`  snapshot ${iso}: ${e.message} (skipped)\n`); }
      await sleep(1200);
    }
    if (!haveInst.has(iso)) {
      try {
        const twse = await fetchTwseInst(iso);
        await sleep(1200);
        const tpex = await fetchTpexInst(iso);
        for (const r of [...twse, ...tpex]) upInst.run(r.code, iso, r.foreign_net, r.trust_net, r.dealer_net);
        if (twse.length + tpex.length) process.stderr.write(`  inst     ${iso}: ${twse.length + tpex.length} stocks\n`);
      } catch (e) { process.stderr.write(`  inst     ${iso}: ${e.message} (skipped)\n`); }
      await sleep(1200);
    }
  }
}

// ---- scan: compute the three signal lists from cached data ------------------------------

function scan(db, revenue, opt) {
  const latest = db.prepare('SELECT max(date) d FROM market_snapshot').get().d;
  if (!latest) return { error: 'market_snapshot is empty — run without --no-sync first' };

  const today = db.prepare('SELECT * FROM market_snapshot WHERE date=?').all(latest);
  const liquid = today.filter(r => (r.value ?? 0) >= opt.minValue);

  // Prior-session volumes per code (up to 5 sessions before `latest`), one query.
  const prior = new Map();
  for (const r of db.prepare(`SELECT code, volume FROM market_snapshot WHERE date < ? AND date >= ?
      ORDER BY date DESC`).all(latest, db.prepare(
        'SELECT min(date) d FROM (SELECT DISTINCT date FROM market_snapshot WHERE date < ? ORDER BY date DESC LIMIT 5)'
      ).get(latest).d ?? latest)) {
    if (!prior.has(r.code)) prior.set(r.code, []);
    const a = prior.get(r.code);
    if (a.length < 5 && r.volume != null) a.push(r.volume);
  }
  const snapshotDepth = db.prepare('SELECT count(DISTINCT date) c FROM market_snapshot').get().c;

  // -- momentum 量價突擊
  const momentum = [];
  for (const r of liquid) {
    if ((r.chg_pct ?? -99) < opt.chg) continue;
    const vols = prior.get(r.code) || [];
    const volRatio = vols.length >= 3 ? +(r.volume / (vols.reduce((s, v) => s + v, 0) / vols.length)).toFixed(2) : null;
    if (volRatio != null && volRatio < opt.volRatio) continue;
    momentum.push({ code: r.code, name: r.name, market: r.market, close: r.close, chgPct: r.chg_pct,
      value: r.value, volRatio, ...(volRatio == null && { provisional: '量比不足3個快照日' }) });
  }
  momentum.sort((a, b) => (b.volRatio ?? 0) - (a.volRatio ?? 0) || b.chgPct - a.chgPct);

  // -- trustBuy 投信連買 (consecutive sessions ending at the latest inst date)
  const instLatest = db.prepare('SELECT max(date) d FROM inst_flows').get().d;
  const trustBuy = [];
  if (instLatest) {
    const instDates = db.prepare('SELECT DISTINCT date FROM inst_flows ORDER BY date DESC LIMIT 10').all().map(r => r.date);
    const flows = new Map();
    for (const r of db.prepare(`SELECT code, date, trust_net FROM inst_flows WHERE date >= ?`)
        .all(instDates[instDates.length - 1])) {
      if (!flows.has(r.code)) flows.set(r.code, new Map());
      flows.get(r.code).set(r.date, r.trust_net);
    }
    const liquidByCode = new Map(liquid.map(r => [r.code, r]));
    for (const [code, byDate] of flows) {
      const snap = liquidByCode.get(code);
      if (!snap) continue;                       // fails liquidity floor or not in latest snapshot
      let streak = 0, streakNet = 0;
      for (const d of instDates) {
        const net = byDate.get(d);
        if (net == null || net <= 0) break;
        streak++; streakNet += net;
      }
      if (streak < opt.trustDays) continue;
      trustBuy.push({ code, name: snap.name, market: snap.market, close: snap.close, chgPct: snap.chg_pct,
        value: snap.value, streak, streakNet, todayNet: byDate.get(instDates[0]) ?? 0,
        ...(streak >= instDates.length && { provisional: `連買日數受限於快照深度(${instDates.length}日)` }) });
    }
    trustBuy.sort((a, b) => b.streak - a.streak || b.streakNet - a.streakNet);
  }

  // -- revenue 營收YoY
  const revList = [];
  for (const r of liquid) {
    const rev = revenue.get(r.code);
    if (!rev || rev.yoy < opt.revYoy) continue;
    revList.push({ code: r.code, name: r.name, market: r.market, close: r.close, chgPct: r.chg_pct,
      value: r.value, revYoY: rev.yoy, revMoM: rev.mom != null ? +rev.mom.toFixed(1) : null, revMonth: rev.month });
  }
  revList.sort((a, b) => b.revYoY - a.revYoY);

  // -- multi-signal highlight
  const hits = new Map();
  for (const [list, name] of [[momentum, 'momentum'], [trustBuy, 'trustBuy'], [revList, 'revenue']])
    for (const r of list) { if (!hits.has(r.code)) hits.set(r.code, { code: r.code, name: r.name, market: r.market, signals: [] }); hits.get(r.code).signals.push(name); }
  const multiSignal = [...hits.values()].filter(h => h.signals.length >= 2)
    .sort((a, b) => b.signals.length - a.signals.length);

  const cap = (a) => a.slice(0, opt.top);
  return {
    asOf: { snapshot: latest, inst: instLatest, revenueMonth: revList[0]?.revMonth ?? [...revenue.values()][0]?.month ?? null },
    params: { minValue: opt.minValue, chg: opt.chg, volRatio: opt.volRatio, trustDays: opt.trustDays, revYoy: opt.revYoy, top: opt.top },
    universe: { total: today.length, afterLiquidityFloor: liquid.length, snapshotDepth },
    multiSignal,
    momentum: cap(momentum), momentumTotal: momentum.length,
    trustBuy: cap(trustBuy), trustBuyTotal: trustBuy.length,
    revenue: cap(revList), revenueTotal: revList.length,
  };
}

// ---- CLI --------------------------------------------------------------------------------

function arg(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = {
    top: arg(argv, '--top', 15),
    minValue: arg(argv, '--min-value', 100_000_000),   // NT$100M/day traded
    chg: arg(argv, '--chg', 3),                        // momentum: min % gain
    volRatio: arg(argv, '--vol-ratio', 1.5),           // momentum: min volume vs 5-session avg
    trustDays: arg(argv, '--trust-days', 3),           // trustBuy: min consecutive net-buy sessions
    revYoy: arg(argv, '--rev-yoy', 30),                // revenue: min YoY %
    backfill: arg(argv, '--backfill', 10),             // calendar days of history to ensure
  };

  const db = openDb();
  if (!argv.includes('--no-sync')) {
    process.stderr.write('Syncing market data...\n');
    await sync(db, opt.backfill);
  }
  if (argv.includes('--sync-only')) { db.close(); return; }

  process.stderr.write('Fetching monthly revenue...\n');
  const revenue = await fetchRevenue();
  console.log(JSON.stringify(scan(db, revenue, opt), null, 2));
  db.close();
}

if (process.argv[1]?.endsWith('scan.mjs')) main();
