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
//        [--pivot P] [--revlow L] [--confirm] [--vol-trial] [--target T] [--equity E]
//   style 1 (pullback):  stop = zone_bottom − max(2×ATR14, bottom×5%)
//   style 2 (breakout):  REQUIRES --pivot; stop = min(pivot×0.99, bottom×0.95)
//                        (just under the pivot, honoring the 5% floor — never 2×ATR)
//   style 3 (reversal):  REQUIRES --revlow (reversal-day low); stop = min(revlow×0.99,
//                        bottom×0.95). Base-inside reversal-day entry (Rule 6b Style-3,
//                        added 2026-07-08); pilot 50% only, close < revlow = out. REQUIRES
//                        量 > 5日均量 (Rule 6j) unless --vol-trial (Rule 6j-A2 試行,
//                        added 2026-07-28): report-only paper track, 25% pilot, NEVER a buy.
//   style 3 --confirm (3c 延遲確認, added 2026-07-22): no --revlow; the CONFIRMATION-day
//                        low is read from the DB; stop = min(confirmLow×0.99, bottom×0.95).
//                        HARD-ERRORS unless the screening `continuation.qualified` is true
//                        — the script, not the model, decides 3c qualification.
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

// ---- #8 6q data-richness grade (A/B/C) ------------------------------------------------

// Same liquidity floor scan.mjs uses for its discovery sweep (--min-value default) — a stop
// on an illiquid name is fiction (Rule 6q check 5), so this is the honest shared threshold.
const LIQUIDITY_FLOOR = 100_000_000;

function dataGrade(db, code, rows, last, vol5avg, opts = {}) {
  const ohlcDepth = rows.length >= 60 ? 'pass' : rows.length >= 14 ? 'partial' : 'fail';
  const indicatorsComputable = 'pass'; // reached this point without erroring — script ran clean
  const quoteAvailable = opts.quoteOk ? 'pass' : 'partial';
  const eventDatesKnown = opts.eventsKnown ? 'pass' : 'partial';

  // 5-day avg turnover vs the liquidity floor; reuse market_snapshot.value (scan.mjs) when
  // present for this exact session, else derive from the local screen (close × vol5avg).
  const snap = db.prepare('SELECT value FROM market_snapshot WHERE code=? AND date=?').get(code, last.date);
  const turnover = snap?.value ?? (vol5avg != null ? last.close * vol5avg : null);
  const liquidity = turnover == null ? 'partial' : (turnover >= LIQUIDITY_FLOOR ? 'pass' : 'fail');

  const checks = { ohlcDepth, quoteAvailable, indicatorsComputable, eventDatesKnown, liquidity };
  const criticalGap = ohlcDepth === 'fail' || indicatorsComputable === 'fail' || liquidity === 'fail';
  const allPass = Object.values(checks).every((v) => v === 'pass');
  const grade = criticalGap ? 'C' : (allPass ? 'A' : 'B');

  // 6q forbids a bare C/B — every gap gets a concrete, actionable upgrade path.
  const gaps = [], upgradePath = [];
  if (ohlcDepth !== 'pass') {
    const need = Math.max(ohlcDepth === 'fail' ? 14 - rows.length : 60 - rows.length, 1);
    gaps.push(`ohlcDepth: ${ohlcDepth} (${rows.length} sessions)`);
    upgradePath.push(`另補 ${need} 個交易日後重評 (fetch-history.mjs --months N)`);
  }
  if (quoteAvailable !== 'pass') {
    gaps.push('quoteAvailable: unknown');
    upgradePath.push('確認即時報價可得後，帶 --quote-ok 重跑');
  }
  if (eventDatesKnown !== 'pass') {
    gaps.push('eventDatesKnown: unknown');
    upgradePath.push('查證財報/除權息日後，帶 --events-known 重跑');
  }
  if (liquidity !== 'pass') {
    gaps.push(`liquidity: ${liquidity}${turnover != null ? ` (NT$${Math.round(turnover)})` : ' (unknown)'}`);
    upgradePath.push(liquidity === 'fail'
      ? '流動性未達門檻（NT$1億/日），非本工具可補，觀察是否放量後重評'
      : '流動性數據不足（無 market_snapshot 且量能未知），補齊成交值後重評');
  }

  return { grade, checks, gaps, upgradePath };
}

// ---- screening (mode 1) --------------------------------------------------------------

export function screenCode(db, code, dateOpt, gradeOpts) {
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

  // Rule 6b Style-3 reclaim test (revised 2026-07-20): the reversal day must close ABOVE
  // the decline segment's starting close. The segment is the unbroken run of down-closes
  // immediately preceding this session; its start is the close just before that run.
  // Replaces the old fixed "last 3+ sessions' closes" window, which was too strict on
  // 1-2 day shakeouts and too loose on long slides. Mechanized because hand-reading it
  // caused a mis-call on 2026-07-20 (an overlooked down-close halved the segment length).
  let reversal = null;
  if (idx >= 2) {
    const isDown = i => i > 0 && rows[i].close < rows[i - 1].close;
    const isReversalDay = !isDown(idx);            // an up/flat close is the only reversal candidate
    // The run ends at today when today is still falling, otherwise at the bar before it.
    let end = isDown(idx) ? idx : idx - 1;
    let j = end;
    while (j > 0 && isDown(j)) j--;                // j lands on the bar BEFORE the run's first down bar
    const declineDays = end - j;
    // Segment start = the close just before the first down bar of the run.
    const declineStart = declineDays > 0 ? rows[j].close : null;
    reversal = {
      isReversalDay,
      declineDays,
      declineStart,
      // reclaimed only means something on a reversal day that actually follows a decline
      reclaimed: (isReversalDay && declineStart != null) ? last.close > declineStart : false,
      // how far the reclaim still has to go, as % of the current close
      reclaimGapPct: declineStart != null ? r2((declineStart - last.close) / last.close * 100) : null,
    };
  }

  // Rule 6b Style-3c 延遲確認 (added 2026-07-22): the session immediately after a day-1/2
  // reversal candidate qualifies as an entry when ALL confirmations are present TODAY.
  // Born from the 2454 2026-07-22 incident: the 7/21 reversal day failed volume (0.84×)
  // AND reclaim; both arrived on 7/22 (1.58×, close 3,850 > declineStart 3,740) with no
  // legal entry path — 4th instance of the "mechanically correct gate emits 等 in a regime
  // it wasn't designed for" defect class. NOTE the `reversal` object above only identifies
  // up-day 1 (declineDays=0 on any later up day), so this block counts the up-run itself.
  // Fresh-reversal-day and continuation are mutually exclusive by the shared isDown
  // predicate: fresh needs yesterday DOWN, continuation needs yesterday NOT-down.
  let continuation = null;
  if (idx >= 3) {
    const isDown = i => i > 0 && rows[i].close < rows[i - 1].close;
    // upRun = consecutive not-down closes ending today (today included). A flat close
    // counts as not-down for candidacy (matches the reversal block's convention), but a
    // flat close TODAY still fails closeAboveReversal below (strict >) — intentional.
    let upRun = 0;
    for (let i = idx; i > 0 && !isDown(i); i--) upRun++;
    // decline segment immediately preceding the up-run (same walk-back as `reversal`)
    const runStart = idx - upRun;                  // bar just before the up-run
    let dj = runStart;
    while (dj > 0 && isDown(dj)) dj--;             // dj lands on the bar BEFORE the decline run
    const cDeclineDays = runStart - dj;
    const cDeclineStart = cDeclineDays > 0 ? rows[dj].close : null;
    // Window (D3): yesterday must be up-day 1 or 2 of the move → upRun ∈ {2,3} as of
    // today. upRun ≥ 4 = yesterday was up-day 3+ (late per 6b Style-3) → never qualifies.
    const windowOk = (upRun === 2 || upRun === 3) && cDeclineDays >= 1;
    const kdGoldenYesterday = K[idx - 1] != null && D[idx - 1] != null && K[idx - 2] != null
      && K[idx - 1] > D[idx - 1] && K[idx - 1] > K[idx - 2];
    const checks = {
      windowOk,
      kdGoldenYesterday,                                        // candidacy as-of idx−1
      closeAboveReversal: last.close > rows[idx - 1].close,     // holds the reversal
      reclaimedNow: cDeclineStart != null && last.close > cDeclineStart,
      volConfirmed: volRatio != null && volRatio > 1,           // Rule 6j, same strict >
      kdGoldenToday: kdGolden,                                  // golden persists
      rsi6LE80: rsi6 != null && rsi6 <= 80,
    };
    const cFailures = Object.keys(checks).filter(k => !checks[k]);
    continuation = {
      upRun,
      reversalDate: rows[idx - 1].date,            // the candidate being confirmed (always yesterday, D3)
      reversalClose: rows[idx - 1].close,
      reversalDayOfMove: upRun - 1,                // 1 or 2 when windowOk; raw otherwise
      declineDays: cDeclineDays,
      declineStart: cDeclineStart,                 // the reclaim anchor
      checks,
      qualified: cFailures.length === 0,
      failures: cFailures,
    };
  }

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
    reversal,
    continuation,
    gate: {
      style1: { pass: failures.length === 0, failures },
      style2Partial: {
        volConfirmed: volRatio != null && volRatio > 1,
        kdGolden, macdRising,
        rsi6LE80: rsi6 != null && rsi6 <= 80,
      },
      histockSpotCheck,
    },
    dataGrade: dataGrade(db, code, rows, last, vol5avg, gradeOpts),
  };
}

// ---- trade plan (mode 2) ---------------------------------------------------------------

/** TWSE/TPEx tick size for a given price level. Orders can only sit on a tick. */
export function tickSize(price) {
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}
/** Highest tick-aligned price <= p (tick chosen from the resulting level, not from p). */
function floorToTick(p) {
  for (const probe of [p, p - 1e-9]) {
    const t = tickSize(probe);
    const v = Math.floor(probe / t + 1e-9) * t;
    if (tickSize(v) === t) return Math.round(v / t) * t;
  }
  const t = tickSize(p);
  return Math.round(Math.floor(p / t) * t / t) * t;
}

/**
 * Rule 6l-1 — the AUTHORISED ENTRY SET: the intersection of the 6l validity band and the
 * prices where R:R >= 1.5, then aligned to the exchange tick.
 *
 * Why this is mechanical and not the model's job: the band is a fixed percentage, but the
 * R:R cost of that percentage scales with stop width, so the two constraints cross at a
 * price nobody can eyeball. On 3504 (2026-07-29) the band was 68.6-69.29 while R:R only
 * held to 68.68 — and after tick alignment (0.1 at that level) the authorised set was the
 * single price 68.6. Reporting the band alone reads as a buy zone that is 85% unbuyable.
 *
 * The stop is held FIXED: it is structural (anchored to the pivot / reversal low / support),
 * so filling higher inside the zone does NOT move it — that asymmetry is the whole point.
 */
export function authorisedEntry({ style, stop, target, bottom, close, pivot, breakoutPct = 3 }) {
  const RR_MIN = 1.5;
  // Highest entry where (T - E) / (E - S) >= RR_MIN.
  //  fixed target T      -> E <= (T + RR*S) / (1 + RR)
  //  default target E*1.15 -> E <= RR*S / (RR - 0.15)
  // FLOOR to 2dp, never round: rounding the ceiling UP yields a price that fails the very
  // test it claims to satisfy (68.6666 -> 68.67 -> R:R 1.4993). A ceiling must be inclusive.
  const floor2 = (v) => Math.floor(v * 100 + 1e-9) / 100;
  const maxEntryForRR = floor2(target != null
    ? (target + RR_MIN * stop) / (1 + RR_MIN)
    : (RR_MIN * stop) / (RR_MIN - 0.15));

  let anchor, bandHi, anchorSource;
  if (style === 2) {
    anchor = pivot; bandHi = pivot * (1 + breakoutPct / 100);
    anchorSource = `breakout pivot ${pivot} +${breakoutPct}% (Rule 6l)`;
  } else if (style === 3) {
    anchor = close; bandHi = close * 1.01;
    anchorSource = `reversal/confirmation close ${close} +1% (Rule 6l)`;
  } else {
    anchor = bottom; bandHi = bottom * 1.02;
    anchorSource = `zone bottom (support anchor) ${r1(bottom)} +2% (Rule 6l)`;
  }

  const lo = anchor, hi = Math.min(bandHi, maxEntryForRR);
  const empty = hi < lo;
  const tickHi = empty ? null : floorToTick(hi);
  const tickEmpty = !empty && tickHi < lo;      // no tick sits inside the interval
  const tick = tickSize(anchor);
  const singlePoint = !empty && !tickEmpty && Math.abs(tickHi - lo) < tick / 2;

  const binding = empty || maxEntryForRR < bandHi ? 'rr' : 'band';
  const notes = [];
  if (empty) notes.push(`授權集合為空：R:R 上限 ${r2(maxEntryForRR)} 低於有效帶下緣 ${r1(lo)} — 這個 setup 在任何合法價位都不划算，不是可買標的`);
  else if (tickEmpty) notes.push(`授權區間 ${r2(lo)}-${r2(hi)} 內沒有任何合法檔位（檔位 ${tick}）— 實務上無法下單`);
  else if (singlePoint) notes.push(`唯一合法進場價 ${r2(tickHi)}（單一價位，非區間）— 有效帶 ${r1(lo)}-${r1(bandHi)} ∩ R:R≤${r2(maxEntryForRR)}，再對齊檔位 ${tick}`);
  else notes.push(`合法進場區間 ${r2(lo)}-${r2(tickHi)}（檔位 ${tick}）— 綁死的是 ${binding === 'rr' ? 'R:R 上限' : '有效帶上緣'}`);
  notes.push('有效帶下緣之下 fired:false（觸發未成立，非折價買點）；上緣之上為遲到觸發。兩側皆非進場（Rule 6l-1）');

  return {
    band: { lo: r1(lo), hi: r1(bandHi), anchor: r1(anchor), anchorSource },
    maxEntryForRR,
    tick,
    lo: empty || tickEmpty ? null : r2(lo),
    hi: empty || tickEmpty ? null : r2(tickHi),
    singlePoint, empty: empty || tickEmpty, binding, notes,
  };
}

export function tradePlan(db, code, opts) {
  const scr = screenCode(db, code, opts.date, opts);
  if (scr.error) return { code, error: scr.error };
  if (opts.confirm && opts.style !== 3) {
    return { code, error: '--confirm is only valid with --style 3 (Rule 6b Style-3c 延遲確認)' };
  }

  const [lo, hi] = opts.zone;
  const bottom = lo, mid = (lo + hi) / 2;
  const notes = [];
  let stop;
  let volTrial = false;          // Rule 6j-A2 試行 (2026-07-28) — set only on the Style-3 trial path
  let pilotPct = 50;             // Rule 6e-5: first entry is always a 50% pilot; A2 halves it again

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
  } else if (opts.style === 3 && opts.confirm) {
    // Rule 6b Style-3c (2026-07-22): delayed-confirmation continuation entry. The script,
    // not the model, decides qualification — refuse to plan when today is not a valid +1
    // confirmation day (same refuse-to-guess policy as the --pivot/--revlow hard errors).
    if (!scr.continuation?.qualified) {
      const why = scr.continuation
        ? `failures: ${scr.continuation.failures.join(', ')}`
        : 'continuation unavailable (<4 sessions of history)';
      return { code, error: `Style-3c requires continuation.qualified — today is not a valid +1 confirmation day (${why}). Refusing to plan an unqualified 3c entry.` };
    }
    if (opts.revlow != null) notes.push('--revlow ignored — Style-3c reads the confirmation-day low from the DB (Rule 6a-1)');
    // Stop (D2): just under the CONFIRMATION-day low, honoring the 5% floor. The
    // reversal-day low is deliberately NOT used — after a strong day-2 it sits ~10%+
    // below entry, inflating 1R and recreating the paralysis (2454 2026-07-22: −12.3%).
    const confirmLow = scr.low;
    const confStop = confirmLow * 0.99, floorStop = bottom * 0.95;
    stop = Math.min(confStop, floorStop);
    notes.push(confStop <= floorStop
      ? `stop = just under confirmation-day low ${confirmLow} (${r1(confStop)})`
      : `confirmation-low stop ${r1(confStop)} tighter than the 5% floor — widened to ${r1(floorStop)} (Rule 6a-1)`);
    notes.push(`Style-3c 延遲確認: confirms reversal day ${scr.continuation.reversalDate} (close ${scr.continuation.reversalClose}); reclaim anchor ${scr.continuation.declineStart}; vol ${scr.volRatio}× (Rule 6b Style-3c)`);
    notes.push(`Style-3c: pilot 50% ONLY; close below confirmation-day low ${confirmLow} = out, no averaging; validity band = confirmation-day close +1% (rules.mjs band --style 3 --anchor ${scr.close})`);
  } else if (opts.style === 3) {
    // Rule 6b Style-3 (2026-07-08): reversal-day entry inside an established base.
    // Structural stop just under the reversal-day low, honoring the 5% floor.
    if (opts.revlow == null) {
      return { code, error: 'Style-3 requires --revlow (the reversal day\'s low). Refusing to guess — the stop IS the thesis (close back below the reversal low kills it).' };
    }
    // Rule 6j volume leg, mechanized 2026-07-28. It was previously prose-only in SKILL.md,
    // so a volume-failed Style-3 could still be planned by hand. Now the script decides.
    // --vol-trial opts into the Rule 6j-A2 試行 path (report-only paper track, NOT a buy).
    if (!scr.signals.volConfirmed) {
      if (!opts.volTrial) {
        return { code, error: `Style-3 requires 量 > 5日均量 (Rule 6j) — volRatio ${scr.volRatio ?? 'n/a'}×. Pass --vol-trial to plan this as a Rule 6j-A2 試行 paper track (report-only, 25% pilot, never a buy recommendation).` };
      }
      volTrial = true;
      pilotPct = 25;
    } else if (opts.volTrial) {
      notes.push(`--vol-trial ignored — volume already confirms (${scr.volRatio}× > 1); this is a normal Style-3, not a 6j-A2 試行`);
    }
    const revStop = opts.revlow * 0.99, floorStop = bottom * 0.95;
    stop = Math.min(revStop, floorStop);
    notes.push(revStop <= floorStop
      ? `stop = just under reversal-day low ${opts.revlow} (${r1(revStop)})`
      : `reversal-low stop ${r1(revStop)} tighter than the 5% floor — widened to ${r1(floorStop)} (Rule 6a-1)`);
    notes.push('Style-3: pilot 50% ONLY; add only after the base top breaks out (then Style-2 rules take over); close < reversal low = out, no averaging (Rule 6b Style-3)');
    if (volTrial) {
      notes.push(`Rule 6j-A2 試行 (2026-07-28): 量 ${scr.volRatio}× ≤ 1× 5日均量 — 6j's 1.0× threshold showed no discriminative power across 3 samples (2:1 against), so this is TRACKED, not vetoed.`);
      notes.push('6j-A2 試行: 報告用途，**不作買進建議**. Record a paper track (entry = this close, stop/TP as planned) in the analysis note; pilot is 25% (half the Style-3 50%) if the user promotes it. Promotion review after 3-5 tracked instances.');
    }
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

  // Use the REPORTED (rounded) stop, not the raw one: a reader must be able to reproduce
  // maxEntryForRR from the numbers printed in this same object.
  const entryAuthorised = authorisedEntry({
    style: opts.style, stop: r1(stop), target: opts.target, bottom, close: scr.close,
    pivot: opts.pivot, breakoutPct: opts.breakoutPct ?? 3,
  });

  const is3c = opts.style === 3 && opts.confirm;
  const out = {
    code, date: scr.date, close: scr.close, style: opts.style,
    variant: is3c ? '3c' : (volTrial ? '3-volTrial' : null),
    volTrial, pilotPct,
    volRatio: scr.volRatio,
    zone: { bottom: lo, top: hi, mid: r1(mid) },
    pivot: opts.pivot ?? null,
    revlow: is3c ? null : (opts.revlow ?? null),  // 3c ignores --revlow (noted above)
    confirmLow: is3c ? scr.low : null,
    reversalDate: is3c ? scr.continuation.reversalDate : null,
    atr14: scr.atr14, atrProvisional: scr.atrProvisional, atrHot: scr.atrHot,
    stop: r1(stop), stopPctBelowBottom: r2((bottom - stop) / bottom * 100),
    tp1: r1(tp1), tp2: r1(tp2), rewardTarget: r1(target),
    oneR: r1(oneR), rr: r2(rr), rrPass,
    entryAuthorised,
    notes,
  };
  if (opts.equity != null) {
    const shares = Math.floor((opts.equity * 0.01) / oneR);
    const pilotShares = Math.floor(shares * pilotPct / 100);
    out.sizing = {
      equity: opts.equity, riskPerShare: r1(oneR), shares,
      riskDollars: r1(shares * oneR),
      pilotPct, pilotShares, pilotRiskDollars: r1(pilotShares * oneR),
      note: `per-position 1% risk cap (6e-2); first entry is the ${pilotPct}% pilot (6e-5${volTrial ? ', halved by the 6j-A2 試行' : ''}); apply the 2% per-theme heat cap across correlated picks (6e-3)`,
    };
  }
  out.gate = scr.gate; // carry the screen gate so one call shows both views
  return out;
}

// ---- CLI --------------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  // Boolean flags take no value — the positional collector must NOT skip the next token
  // after them (the old unconditional i++ silently dropped a code after --quote-ok).
  const BOOL_FLAGS = new Set(['--quote-ok', '--events-known', '--confirm', '--vol-trial']);
  const codes = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (!BOOL_FLAGS.has(argv[i])) i++; continue; }
    codes.push(argv[i]);
  }
  if (!codes.length) {
    console.error('Usage: screen.mjs <code> [<code>...] [--date YYYY-MM-DD]                    # screening');
    console.error('       screen.mjs <code> --style 1|2|3 --zone LO-HI [--pivot P] [--revlow L] [--confirm] [--vol-trial] [--target T] [--equity E]   # trade plan');
    process.exit(1);
  }

  const style = flag('--style') ? Number(flag('--style')) : null;
  // Rule 6q judgment-input flags: presence = confirmed ('pass'); absence = unknown ('partial').
  const gradeOpts = { quoteOk: argv.includes('--quote-ok'), eventsKnown: argv.includes('--events-known') };
  const db = openDb();
  try {
    if (style != null) {
      if (codes.length !== 1) { console.error('trade-plan mode takes exactly one code'); process.exit(1); }
      if (style !== 1 && style !== 2 && style !== 3) { console.error('--style must be 1 (pullback), 2 (breakout), or 3 (reversal; add --confirm for 3c delayed confirmation)'); process.exit(1); }
      const zoneRaw = flag('--zone');
      const m = zoneRaw && zoneRaw.match(/^([\d.]+)-([\d.]+)$/);
      if (!m) { console.error('--zone LO-HI is required for a trade plan (e.g. --zone 5940-6080)'); process.exit(1); }
      const zone = [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
      const plan = tradePlan(db, codes[0], {
        style, zone,
        pivot: flag('--pivot') ? Number(flag('--pivot')) : null,
        revlow: flag('--revlow') ? Number(flag('--revlow')) : null,
        confirm: argv.includes('--confirm'),
        volTrial: argv.includes('--vol-trial'),
        target: flag('--target') ? Number(flag('--target')) : null,
        breakoutPct: flag('--breakout-pct') ? Number(flag('--breakout-pct')) : 3,
        equity: flag('--equity') ? Number(flag('--equity')) : null,
        date: flag('--date'),
        ...gradeOpts,
      });
      if (plan.error) { console.error(`${plan.code}: ${plan.error}`); process.exit(1); }
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const date = flag('--date');
      let hadError = false;
      for (const code of codes) {
        const res = screenCode(db, code, date, gradeOpts);
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
