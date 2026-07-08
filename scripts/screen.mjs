// screen.mjs — deterministic rule math for the tw-stock-etf-advisor skill.
//
// Why this exists (2026-07 post-mortems): the model hand-computing ATR stops, R:R and
// gate thresholds produced two paralysis bugs (wrong stop regime → inflated 1R → false
// "wait"). All simple math now lives HERE. The model supplies only the judgment inputs
// (entry style, breakout pivot, buy zone); this script returns numbers and pass/fail
// signals deterministically. The model must NOT re-derive these by hand.
//
// Mode 1 — screening (indicators + gate eval, one JSON line per code):
//   node --experimental-sqlite scripts/screen.mjs <code> [<code>...] [--date YYYY-MM-DD]
//
// Mode 2 — trade plan (single code + judgment inputs; enforces Rule 6a-1 stop regime):
//   node --experimental-sqlite scripts/screen.mjs <code> --style 1|2|3 --zone LO-HI \
//        [--pivot P] [--revlow L] [--target T] [--equity E]
//   style 1 (pullback):  stop = zone_bottom − max(2×ATR14, bottom×5%)
//   style 2 (breakout):  REQUIRES --pivot; stop = min(pivot×0.99, bottom×0.95)
//                        (just under the pivot, honoring the 5% floor — never 2×ATR)
//   style 3 (reversal):  REQUIRES --revlow (reversal-day low); stop = min(revlow×0.99,
//                        bottom×0.95). Base-inside reversal-day entry (Rule 6b Style-3,
//                        added 2026-07-08); pilot 50% only, close < revlow = out.
//
// Indicators are computed from the local OHLC DB (TWSE settled closes). Values converge
// with Histock to ~±1–2 given the ~3-month warmup; Histock is a spot-check, not the
// source (see references/charting.md §9). Computed rows are cached into `indicators`.

import { openDb, getOhlc } from './db.mjs';

// ---- math helpers ------------------------------------------------------------------

const r1 = (x) => x == null ? null : Math.round(x * 10) / 10;
const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;

function sma(values, n, endIdx) {
  // simple mean of values[endIdx-n+1 .. endIdx]
  if (endIdx + 1 < n) return null;
  let s = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) s += values[i];
  return s / n;
}

/** EMA series seeded with the SMA of the first n values (standard MACD convention). */
function emaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let prev = sma(values, n, n - 1);
  out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI series over closes. */
function rsiSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / n, avgL = loss / n;
  out[n] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (n - 1) + Math.max(d, 0)) / n;
    avgL = (avgL * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/** Taiwan KD (9,3,3): RSV over 9-day H/L window; K=⅔K'+⅓RSV; D=⅔D'+⅓K; seeded at 50. */
function kdSeries(rows, n = 9) {
  const K = new Array(rows.length).fill(null);
  const D = new Array(rows.length).fill(null);
  let k = 50, d = 50;
  for (let i = n - 1; i < rows.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (rows[j].high > hi) hi = rows[j].high;
      if (rows[j].low < lo) lo = rows[j].low;
    }
    const rsv = hi === lo ? 50 : (rows[i].close - lo) / (hi - lo) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    K[i] = k; D[i] = d;
  }
  return { K, D };
}

/** ATR14 per Rule 6a: simple mean of the last 14 TRs ending at endIdx. */
function atr14At(rows, endIdx) {
  if (endIdx < 14) return { atr: null, provisional: true };
  let s = 0;
  for (let i = endIdx - 13; i <= endIdx; i++) {
    const c = rows[i], p = rows[i - 1];
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return { atr: s / 14, provisional: false };
}

// ---- screening (mode 1) --------------------------------------------------------------

function screenCode(db, code, dateOpt) {
  const rows = getOhlc(db, code);            // ascending by date
  if (!rows.length) return { code, error: 'no OHLC rows — run fetch-history.mjs first' };

  let idx = rows.length - 1;
  if (dateOpt) {
    idx = rows.findIndex(r => r.date === dateOpt);
    if (idx === -1) return { code, error: `no OHLC row on ${dateOpt}` };
  }
  const last = rows[idx], prev = idx > 0 ? rows[idx - 1] : null;

  const closes = rows.map(r => r.close);
  const ma5 = sma(closes, 5, idx), ma10 = sma(closes, 10, idx), ma20 = sma(closes, 20, idx);

  // consecutive sessions (ending at idx) closing above that day's MA20 — "站回20MA連N日"
  let streak = 0;
  for (let i = idx; i >= 19; i--) {
    const m = sma(closes, 20, i);
    if (closes[i] > m) streak++; else break;
  }

  const { atr, provisional } = atr14At(rows, idx);
  const vol5avg = idx >= 5
    ? rows.slice(idx - 5, idx).reduce((s, r) => s + (r.volume ?? 0), 0) / 5
    : null;
  const volRatio = vol5avg ? last.volume / vol5avg : null;

  const rsi6S = rsiSeries(closes, 6), rsi12S = rsiSeries(closes, 12);
  const { K, D } = kdSeries(rows);
  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const difS = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const difVals = difS.filter(v => v != null);
  const sigTail = emaSeries(difVals, 9);                    // signal over the non-null DIF tail
  const nullHead = difS.length - difVals.length;
  const sigS = difS.map((_, i) => i >= nullHead ? sigTail[i - nullHead] : null);

  const k9 = K[idx], d9 = D[idx], kPrev = idx > 0 ? K[idx - 1] : null, dPrev = idx > 0 ? D[idx - 1] : null;
  const rsi6 = rsi6S[idx], rsi12 = rsi12S[idx];
  const dif = difS[idx], macdSig = sigS[idx];
  const difPrev = idx > 0 ? difS[idx - 1] : null;
  const osc = (dif != null && macdSig != null) ? dif - macdSig : null;

  const chgPct = prev ? (last.close - prev.close) / prev.close * 100 : null;
  const dev20 = ma20 ? (last.close - ma20) / ma20 * 100 : null;

  const kdGolden = k9 != null && kPrev != null && k9 > d9 && k9 > kPrev;
  const kdDeath = k9 != null && kPrev != null && k9 < d9 && k9 < kPrev;
  const macdRising = dif != null && difPrev != null && dif > difPrev;

  // cache into the indicators table (idempotent upsert)
  db.prepare(`INSERT INTO indicators(code,date,ma5,ma10,ma20,k9,d9,rsi6,rsi12,macd)
              VALUES(?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(code,date) DO UPDATE SET
                ma5=excluded.ma5, ma10=excluded.ma10, ma20=excluded.ma20,
                k9=excluded.k9, d9=excluded.d9, rsi6=excluded.rsi6,
                rsi12=excluded.rsi12, macd=excluded.macd`)
    .run(code, last.date, r1(ma5), r1(ma10), r1(ma20), r2(k9), r2(d9), r2(rsi6), r2(rsi12), r2(dif));

  // Rule 6b Style-1 gate: all four must be clean
  const failures = [];
  if (rsi6 != null && rsi6 > 70) failures.push('RSI6>70');
  if (k9 != null && k9 > 80) failures.push('K9>80');
  if (dev20 != null && dev20 > 10) failures.push('>10% above 20MA');
  if (kdDeath) failures.push('KD死叉');

  // Histock spot-check hint: any reading within ±3 of a gate threshold
  const near = (v, t) => v != null && Math.abs(v - t) <= 3;
  const histockSpotCheck = near(rsi6, 70) || near(rsi6, 80) || near(k9, 80) || near(dev20, 10);

  return {
    code, date: last.date,
    open: last.open, high: last.high, low: last.low, close: last.close,
    chgPct: r2(chgPct), volume: last.volume, vol5avg: vol5avg ? Math.round(vol5avg) : null,
    volRatio: r2(volRatio),
    ma5: r1(ma5), ma10: r1(ma10), ma20: r1(ma20), devFrom20Pct: r2(dev20),
    maAligned: (ma5 && ma10 && ma20) ? (ma5 > ma10 && ma10 > ma20 ? 'bull' : (ma5 < ma10 && ma10 < ma20 ? 'bear' : 'mixed')) : null,
    aboveMA20Streak: streak,
    atr14: r1(atr), atrPct: (atr && last.close) ? r2(atr / last.close * 100) : null,
    atrProvisional: provisional,
    // Rule 6m (2026-07-08): ATR > 6% makes the 2×ATR Style-1 stop fail R:R across almost
    // the whole zone by construction — declare the regime instead of serial R:R fails.
    atrHot: (atr && last.close) ? atr / last.close * 100 > 6 : false,
    k9: r2(k9), d9: r2(d9), rsi6: r2(rsi6), rsi12: r2(rsi12),
    dif: r2(dif), macdSignal: r2(macdSig), osc: r2(osc),
    signals: {
      kdGolden, kdDeath, macdRising,
      rsi6Gt70: rsi6 != null && rsi6 > 70,
      rsi6Gt80: rsi6 != null && rsi6 > 80,
      k9Gt80: k9 != null && k9 > 80,
      extendedGt10: dev20 != null && dev20 > 10,
      dayGainGt3: chgPct != null && chgPct > 3,
      volConfirmed: volRatio != null && volRatio > 1,
      volStrong: volRatio != null && volRatio >= 1.5,
    },
    gate: {
      style1: { pass: failures.length === 0, failures },
      style2Partial: {
        volConfirmed: volRatio != null && volRatio > 1,
        kdGolden, macdRising,
        rsi6LE80: rsi6 != null && rsi6 <= 80,
      },
      histockSpotCheck,
    },
  };
}

// ---- trade plan (mode 2) ---------------------------------------------------------------

function tradePlan(db, code, opts) {
  const scr = screenCode(db, code, opts.date);
  if (scr.error) return { code, error: scr.error };

  const [lo, hi] = opts.zone;
  const bottom = lo, mid = (lo + hi) / 2;
  const notes = [];
  let stop;

  if (opts.style === 1) {
    // Rule 6a / 6a-1 Style-1: bottom − max(2×ATR14, bottom×5%)
    if (scr.atr14 == null) return { code, error: 'ATR14 unavailable (insufficient history) — cannot compute a Style-1 stop' };
    if (scr.atrProvisional) notes.push('ATR14 provisional (<15 sessions) — do NOT reject on R:R from this alone (Rule 6a)');
    const atrDist = 2 * scr.atr14, floorDist = bottom * 0.05;
    stop = bottom - Math.max(atrDist, floorDist);
    notes.push(atrDist >= floorDist
      ? `stop width = 2×ATR14 (${r1(atrDist)}) > 5% floor (${r1(floorDist)})`
      : `stop widened to the 5% floor (${r1(floorDist)}) — 2×ATR14 (${r1(atrDist)}) was tighter`);
    if (scr.atrHot) notes.push(`Rule 6m: ATR ${scr.atrPct}% > 6% — pullback path is regime-closed; only the zone bottom can pass R:R. Prefer Style-2 breakout or Style-3 reversal until ATR contracts.`);
  } else if (opts.style === 3) {
    // Rule 6b Style-3 (2026-07-08): reversal-day entry inside an established base.
    // Structural stop just under the reversal-day low, honoring the 5% floor.
    if (opts.revlow == null) {
      return { code, error: 'Style-3 requires --revlow (the reversal day\'s low). Refusing to guess — the stop IS the thesis (close back below the reversal low kills it).' };
    }
    const revStop = opts.revlow * 0.99, floorStop = bottom * 0.95;
    stop = Math.min(revStop, floorStop);
    notes.push(revStop <= floorStop
      ? `stop = just under reversal-day low ${opts.revlow} (${r1(revStop)})`
      : `reversal-low stop ${r1(revStop)} tighter than the 5% floor — widened to ${r1(floorStop)} (Rule 6a-1)`);
    notes.push('Style-3: pilot 50% ONLY; add only after the base top breaks out (then Style-2 rules take over); close < reversal low = out, no averaging (Rule 6b Style-3)');
  } else {
    // Rule 6a-1 Style-2: structural stop just under the pivot, honoring the 5% floor.
    // NEVER 2×ATR — mis-applying the pullback width was the 2026-07-03 paralysis bug.
    if (opts.pivot == null) {
      return { code, error: 'Style-2 requires --pivot (breakout pivot = base top / reclaimed high). Refusing to fall back to 2×ATR — that was the 2026-07-03 bug (Rule 6a-1).' };
    }
    const pivotStop = opts.pivot * 0.99, floorStop = bottom * 0.95;
    stop = Math.min(pivotStop, floorStop);
    notes.push(pivotStop <= floorStop
      ? `stop = just under pivot ${opts.pivot} (${r1(pivotStop)})`
      : `pivot stop ${r1(pivotStop)} tighter than the 5% floor — widened to ${r1(floorStop)} (Rule 6a-1)`);
  }

  const oneR = mid - stop;
  const tp1 = mid * 1.08, tp2 = mid * 1.15;
  const target = opts.target ?? tp2;
  if (opts.target == null) notes.push('reward target defaulted to TP2 (+15%); pass --target for a measured-move/prior-high target');
  const rr = (target - mid) / oneR;
  const rrPass = rr >= 1.5;

  const out = {
    code, date: scr.date, close: scr.close, style: opts.style,
    zone: { bottom: lo, top: hi, mid: r1(mid) },
    pivot: opts.pivot ?? null,
    revlow: opts.revlow ?? null,
    atr14: scr.atr14, atrProvisional: scr.atrProvisional, atrHot: scr.atrHot,
    stop: r1(stop), stopPctBelowBottom: r2((bottom - stop) / bottom * 100),
    tp1: r1(tp1), tp2: r1(tp2), rewardTarget: r1(target),
    oneR: r1(oneR), rr: r2(rr), rrPass,
    notes,
  };
  if (opts.equity != null) {
    const shares = Math.floor((opts.equity * 0.01) / oneR);
    out.sizing = {
      equity: opts.equity, riskPerShare: r1(oneR), shares,
      riskDollars: r1(shares * oneR),
      note: 'per-position 1% risk cap (6e-2); apply the 2% per-theme heat cap across correlated picks (6e-3)',
    };
  }
  out.gate = scr.gate; // carry the screen gate so one call shows both views
  return out;
}

// ---- CLI --------------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const codes = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    codes.push(argv[i]);
  }
  if (!codes.length) {
    console.error('Usage: screen.mjs <code> [<code>...] [--date YYYY-MM-DD]                    # screening');
    console.error('       screen.mjs <code> --style 1|2|3 --zone LO-HI [--pivot P] [--revlow L] [--target T] [--equity E]   # trade plan');
    process.exit(1);
  }

  const style = flag('--style') ? Number(flag('--style')) : null;
  const db = openDb();
  try {
    if (style != null) {
      if (codes.length !== 1) { console.error('trade-plan mode takes exactly one code'); process.exit(1); }
      if (style !== 1 && style !== 2 && style !== 3) { console.error('--style must be 1 (pullback), 2 (breakout), or 3 (reversal)'); process.exit(1); }
      const zoneRaw = flag('--zone');
      const m = zoneRaw && zoneRaw.match(/^([\d.]+)-([\d.]+)$/);
      if (!m) { console.error('--zone LO-HI is required for a trade plan (e.g. --zone 5940-6080)'); process.exit(1); }
      const zone = [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
      const plan = tradePlan(db, codes[0], {
        style, zone,
        pivot: flag('--pivot') ? Number(flag('--pivot')) : null,
        revlow: flag('--revlow') ? Number(flag('--revlow')) : null,
        target: flag('--target') ? Number(flag('--target')) : null,
        equity: flag('--equity') ? Number(flag('--equity')) : null,
        date: flag('--date'),
      });
      if (plan.error) { console.error(`${plan.code}: ${plan.error}`); process.exit(1); }
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const date = flag('--date');
      let hadError = false;
      for (const code of codes) {
        const res = screenCode(db, code, date);
        if (res.error) hadError = true;
        console.log(JSON.stringify(res));
      }
      if (hadError) process.exit(1);
    }
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith('screen.mjs')) main();
