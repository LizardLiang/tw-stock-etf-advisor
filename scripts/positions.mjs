// positions.mjs — portfolio-state rule math (rule-math-mechanization, 2026-07-20).
// Needs the `positions` table + OHLC history — this is what distinguishes it from rules.mjs's
// stateless calculators. Zero dependency: built-in node:sqlite only, no network.
//
//   node --experimental-sqlite scripts/positions.mjs theme-stop --theme "AI鏈" --price 3017=2135 [--price code=P ...]
//   node --experimental-sqlite scripts/positions.mjs breach-check [--price code=P ...]
//   node --experimental-sqlite scripts/positions.mjs review [--price code=P ...]
//
// R4 is load-bearing throughout: `stop_status` distinguishes a MISSING stop from a
// CONSCIOUSLY RE-UNDERWRITTEN one (Rule 6n). A re-underwritten/void position never reports a
// breach — it reports P&L only, with a note explaining why the check was skipped.

import { openDb, getOhlc, getAllPositions, getPositionsByTheme } from './db.mjs';

const r1 = (x) => x == null ? null : Math.round(x * 10) / 10;
const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Reject a non-finite/non-positive --price (e.g. "3017=50,50" parses to NaN) rather than let
 * it flow silently into a confident-looking all-clear (2026-07-20 review finding, T1.3). */
function findInvalidPrice(prices) {
  for (const [code, price] of prices) {
    if (!Number.isFinite(price) || price <= 0) return { code, price };
  }
  return null;
}

// ---- #5 6e-4 theme-level stop ----------------------------------------------------------------

export function themeStop(db, theme, prices) {
  if (!theme) return { error: '--theme is required' };
  const bad = findInvalidPrice(prices);
  if (bad) return { error: `invalid --price for ${bad.code}: "${bad.price}" is not a finite positive number` };
  const legs = getPositionsByTheme(db, theme);
  if (!legs.length) return { error: `no positions found for theme "${theme}"` };
  const missing = legs.filter((l) => !prices.has(l.code));
  if (missing.length) return { error: `missing --price for: ${missing.map((l) => l.code).join(', ')}` };

  let invested = 0, liveValue = 0;
  const legsOut = legs.map((l) => {
    const price = prices.get(l.code);
    const inv = l.shares * l.cost_avg;
    const val = l.shares * price;
    invested += inv; liveValue += val;
    const unrealized = val - inv;
    return {
      code: l.code, name: l.name, shares: l.shares, costAvg: l.cost_avg, price,
      invested: r1(inv), unrealized: r1(unrealized), unrealizedPct: inv ? r2(unrealized / inv * 100) : null,
    };
  });

  const unrealized = r1(liveValue - invested);
  const unrealizedPct = invested ? r2(unrealized / invested * 100) : null;

  // Rule 6e-4 tiers: −10% halve, −15% keep strongest only, −20% exit all + lockout.
  const tier = unrealizedPct != null && unrealizedPct <= -20 ? '-20'
    : unrealizedPct != null && unrealizedPct <= -15 ? '-15'
    : unrealizedPct != null && unrealizedPct <= -10 ? '-10'
    : null;
  // Leg-count aware — "-15%: exit 2 of 3" hardcoded a 3-leg theme; generalize to N legs (2026-07-20
  // review finding). Rule 6e-4's intent is "keep only the strongest", i.e. exit all but one.
  const action = tier === '-20'
    ? 'exit ALL positions, 100% cash; do not re-enter until the sector ETF reclaims its 50MA AND 2+ weeks have passed (6e-4)'
    : tier === '-15' ? `exit ${Math.max(legs.length - 1, 0)} of ${legs.length} leg(s), keep only the strongest (6e-4)`
    : tier === '-10' ? 'halve all positions — sell the weakest leg first (6e-4)'
    : 'no theme-stop action — within tolerance';

  const weakestLeg = legsOut.reduce((w, l) => (l.unrealizedPct != null && (!w || l.unrealizedPct < w.unrealizedPct)) ? l : w, null)?.code ?? null;

  return { theme, legs: legsOut, invested: r1(invested), unrealized, unrealizedPct, tier, action, weakestLeg };
}

// ---- #6 6n breach counter ----------------------------------------------------------------------

function breachCheckOne(db, p, livePrice) {
  const base = { code: p.code, stop: p.stop, stopStatus: p.stop_status };
  if (p.stop_status !== 'active') {
    return {
      ...base, breached: false, firstBreachDate: null, sessionsSinceBreach: 0, forcedBinary: false,
      note: p.stop_status === 'reunderwritten'
        ? 'stop re-underwritten (Rule 6n) — no active stop; breach check skipped, P&L only'
        : 'stop void — no active stop; breach check skipped',
    };
  }
  if (p.stop == null) {
    return {
      ...base, breached: false, firstBreachDate: null, sessionsSinceBreach: 0, forcedBinary: false,
      note: 'stop_status is active but no stop price is recorded — cannot check breach (data gap, not a discharge)',
    };
  }

  // T1.2 (2026-07-20 review): scan from stop_set_at, NOT opened_at. Rule 6d prescribes trailing
  // the stop up (breakeven at TP1, then 5MA) — scanning the whole position history against the
  // CURRENT (raised) stop makes a winning, correctly-managed position read as an ancient breach.
  // stop_set_at falls back to opened_at only as a last resort (should never happen post-migrate).
  const scanFrom = p.stop_set_at || p.opened_at;
  const series = getOhlc(db, p.code, scanFrom).map((r) => ({ date: r.date, close: r.close }));
  if (livePrice != null) {
    const today = isoToday();
    if (!series.length || series[series.length - 1].date < today) series.push({ date: today, close: livePrice });
  }

  let firstBreachDate = null;
  for (const row of series) { if (row.close <= p.stop) { firstBreachDate = row.date; break; } }
  const breached = firstBreachDate != null;
  const sessionsSinceBreach = breached ? series.filter((r) => r.date >= firstBreachDate).length : 0;
  // Rule 6n: an unexecuted breach at N >= 2 sessions forces the execute-or-re-underwrite binary.
  const forcedBinary = breached && sessionsSinceBreach >= 2;

  return {
    ...base, breached, firstBreachDate, sessionsSinceBreach, forcedBinary,
    note: breached ? `破停損第 ${sessionsSinceBreach} 日` : null,
  };
}

export function breachCheck(db, prices = new Map()) {
  const bad = findInvalidPrice(prices);
  if (bad) return { error: `invalid --price for ${bad.code}: "${bad.price}" is not a finite positive number` };
  return getAllPositions(db).map((p) => breachCheckOne(db, p, prices.get(p.code)));
}

// ---- #11 Action C review ------------------------------------------------------------------------

export function review(db, prices = new Map()) {
  const breachResults = breachCheck(db, prices);
  if (breachResults.error) return breachResults; // propagate NaN/invalid-price rejection (T1.3)
  const breaches = new Map(breachResults.map((b) => [b.code, b]));
  return getAllPositions(db).map((p) => {
    const price = prices.get(p.code);
    const invested = r1(p.shares * p.cost_avg);
    const live = price != null ? r1(p.shares * price) : null;
    const unrealized = live != null ? r1(live - invested) : null;
    const unrealizedPct = (unrealized != null && invested) ? r2(unrealized / invested * 100) : null;
    const b = breaches.get(p.code);
    const targetHit = (price != null && p.target_lo != null) ? price >= p.target_lo : null;
    return {
      code: p.code, name: p.name, shares: p.shares, costAvg: p.cost_avg,
      invested, live, unrealized, unrealizedPct,
      stop: p.stop, stopStatus: p.stop_status,
      stopHit: b.breached, targetHit, sessionsSinceBreach: b.sessionsSinceBreach,
      // Surface breachCheckOne's note (e.g. "active but no stop price recorded") — dropping it
      // made a genuine data gap indistinguishable from a safely-managed position (Tier-2 finding).
      note: b.note,
    };
  });
}

// ---- CLI ---------------------------------------------------------------------------------------

function parsePriceFlags(argv) {
  const prices = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--price' && argv[i + 1]) {
      const eq = argv[i + 1].indexOf('=');
      if (eq > 0) prices.set(argv[i + 1].slice(0, eq), Number(argv[i + 1].slice(eq + 1)));
      i++;
    }
  }
  return prices;
}

function flag(argv, n) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; }

function main() {
  const [verb, ...rest] = process.argv.slice(2);
  const db = openDb();
  try {
    let result;
    if (verb === 'theme-stop') {
      result = themeStop(db, flag(rest, '--theme'), parsePriceFlags(rest));
    } else if (verb === 'breach-check') {
      result = breachCheck(db, parsePriceFlags(rest));
    } else if (verb === 'review') {
      result = review(db, parsePriceFlags(rest));
    } else {
      console.error('Usage: positions.mjs theme-stop --theme "<name>" --price code=P [--price code=P ...]');
      console.error('       positions.mjs breach-check [--price code=P ...]');
      console.error('       positions.mjs review [--price code=P ...]');
      process.exit(1);
    }
    if (result && result.error) { console.error(`${verb}: ${result.error}`); process.exit(1); }
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    // Top-level safety net, matching rules.mjs: any thrown error becomes the house
    // {error}+exit-1 pattern, never a raw Node stack trace.
    console.error(`${verb}: ${e.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith('positions.mjs')) main();
