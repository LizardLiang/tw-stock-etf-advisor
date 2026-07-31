# Charting & SQLite persistence — recipes for Action D and the A/B/C hooks

This file backs **Action D (畫 K 線圖)** and the structured-mirror writes in Actions A/B/C. It keeps
the per-command mechanics out of SKILL.md. Read it whenever you touch the DB or render a chart.

**Design in one line:** Obsidian (via Eliot) is the *narrative* source of truth — the full "why".
SQLite is the *structured mirror* — OHLC price history + decision markers — that the chart reads.
A marker's `reason` is a one-line echo of the Obsidian note, never a competing master record.

All scripts are **zero-dependency Node** (built-in `node:sqlite`, global `fetch`, `node:fs`). Always
invoke with the experimental flag so `node:sqlite` is enabled across Node 22.x:

```
node --experimental-sqlite <skill>/scripts/<name>.mjs …
```

---

## Table of contents
1. Database location & override
2. Schema
3. Fetching OHLC history (the 民國-date gotcha)
4. Recording markers (the buy/sell/hold "why")
5. Seeding from Obsidian
6. Rendering the chart
7. Tokyo Night palette + marker glyph/colour map
8. When to fetch / refresh (avoid hammering TWSE)
9. Screening & trade-plan math (`screen.mjs`)
10. Whole-market scan (`scan.mjs`)
11. Stateless rule math (`rules.mjs`)
12. Portfolio-state rule math (`positions.mjs`)

---

## 1. Database location & override

`scripts/db.mjs` resolves the DB path in this order (most specific wins):
1. env `TW_STOCK_DB`
2. `stock_db_path:` line in `Eliot/Profile.md` (override `ELIOT_PROFILE` to relocate Profile)
3. built-in default `C:\Users\lizard_liang\personal\stocks\stocks.db`

**To sync via OneDrive**, the user sets one override to a path under `…\OneDrive\…`, e.g. add to
`Eliot/Profile.md`:
```
stock_db_path: C:/Users/lizard_liang/OneDrive/tw-stock-advisor/stocks.db
```
Check / create:
```
node --experimental-sqlite scripts/db.mjs --show-path   # prints resolved path
node --experimental-sqlite scripts/db.mjs --init        # create file + schema
```

## 2. Schema (created idempotently on first `openDb()`)
- `stocks(code PK, name, market[twse|tpex])`
- `ohlc(code, date, open, high, low, close, volume, PK(code,date))` — date is ISO `YYYY-MM-DD`
- `indicators(code, date, ma5, ma10, ma20, k9, d9, rsi6, rsi12, macd, PK(code,date))` — optional
  cache; the chart computes MAs in JS from closes, so populating this is not required for charting
- `markers(id, code, date, action, price, reason, note_link, created_at)` — UNIQUE(code,date,action,
  price) so re-asserting a marker is idempotent
- `meta(key,value)`
- `market_snapshot(code, date, market, name, close, chg_pct, volume, value, PK(code,date))` —
  whole-market daily quotes (BOTH markets, ~1,900 rows/session), filled by `scan.mjs` so volume
  ratios and streaks compute locally. Distinct from `ohlc`: snapshot is wide (every stock) and
  shallow (close+volume+value only); `ohlc` is narrow (tracked stocks) and deep (full OHLC)
- `inst_flows(code, date, foreign_net, trust_net, dealer_net, PK(code,date))` — per-stock 三大法人
  daily nets in shares (positive = net buy), filled by `scan.mjs`
- `positions(code PK, name, shares, cost_avg, opened_at, stop, stop_status, target_lo, target_hi,
  theme, thesis_note, updated_at)` — structured mirror of the holdings ledger's "## 持有中" table
  (Rule 8), read/written by `positions.mjs` and backfilled by `seed-from-obsidian.mjs`.
  `stop_status` ∈ `active` | `reunderwritten` | `void` — distinguishes a MISSING stop (`active`,
  `stop=NULL`) from a CONSCIOUSLY DISCHARGED one (`reunderwritten`, Rule 6n) so breach-check never
  confuses the two
- `holidays(date PK, name, source)` — weekday non-trading days for `rules.mjs earnings` (Rule 6h);
  `source` ∈ `builtin` (best-effort table, seeded on every `openDb()`) | `twse` (from
  `--sync-holidays`, the only network call in the rule-math-mechanization delta)

## 3. Fetching OHLC history

```
node --experimental-sqlite scripts/fetch-history.mjs <code> --months 4            # TWSE (上市)
node --experimental-sqlite scripts/fetch-history.mjs <code> --months 3 --market tpex   # 上櫃
node --experimental-sqlite scripts/fetch-history.mjs <code> --months 6 --force    # ignore cache
node --experimental-sqlite scripts/fetch-history.mjs NVDA --months 6              # 美股 (Yahoo v8, auto-routed)
node --experimental-sqlite scripts/fetch-history.mjs SPY --months 24              # seeds the NYSE calendar (6h)
node --experimental-sqlite scripts/fetch-history.mjs AAPL --source stooq          # explicit US fallback
```
- Source: TWSE `rwd/zh/afterTrading/STOCK_DAY?response=json&date=YYYYMMDD&stockNo=CODE` (one call
  per month). OTC → TPEx `www/zh-tw/afterTrading/tradingStock?code=CODE&date=YYYY/MM/01&id=&response=json`.
- **民國 gotcha**: TWSE dates are ROC years (`115/06/02`). Gregorian = ROC + 1911 → `2026-06-02`.
  `fetch-history.mjs` handles this; if you ever parse TWSE JSON by hand, remember `+1911`.
- **TPEx mixes both calendars**: the `date=` *query parameter* is **Gregorian** (`2026/07/01`),
  while the row dates *inside* the response are still ROC (`115/07/01`). Passing a ROC year in
  the query silently yields an empty month.
- **TPEx volume is 張 (lots), TWSE is 股 (shares)** — `parseTpexMonth` multiplies by 1000 so
  `ohlc.volume` means the same thing in both markets. Rule 6j's 量比 and Rule 6q's liquidity
  floor both read that column; skipping the conversion is a silent 1000× error, not a crash.
- Numbers carry thousands commas and may be `--` on no-trade days; those rows are skipped.
- **Endpoint rot is the recurring failure mode — it degrades silently, twice now.** 2026-07-28:
  TWSE's legacy `exchangeReport/STOCK_DAY` served a cached month, dropping that day's bar with no
  error. 2026-07-29: TPEx retired `web/stock/aftertrading/daily_trading_info/st43_result.php` and
  served an HTML 404 there — `res.json()` threw, the per-month `catch` printed `(skipped)`, and
  **every 上櫃 stock came back with 0 rows and got stuck at Rule 6q grade C for weeks**. Both
  fetchers now assert a JSON content-type via `readJson()` and fail by name; `parseTpexMonth`
  throws on a missing `tables[]` rather than returning an empty array. If you add a third source,
  keep that contract. Symptom to watch for: `upserted 0 rows` with no visible error.
- **美股 (v1.20.0)**: an alphabetic ticker auto-routes to the Yahoo v8 chart API — one ranged
  call, no per-month loop, no browser. The parser keeps the same fail-loud contract
  (`chart.error`/schema drift/non-JSON all throw by name), converts dates in the exchange's own
  timezone (never UTC slicing), and uses the split-adjusted raw `quote` arrays — refetch the full
  range after a split. `--source stooq` is the explicit, never-automatic fallback (header-asserted
  CSV; Stooq may serve a JS challenge to plain fetch — the named error is correct behavior). A
  successful US fetch re-derives the US-scoped trading calendar (`holidays_us`), which is how
  Rule 6h's NYSE counter stays honest — SPY's span is the authoritative calendar.
- **Caching**: months already in `ohlc` are skipped (the newest month is always re-fetched to top up
  the latest sessions). The script throttles 1.2 s between month-calls and sends a `User-Agent` —
  TWSE rate-limits aggressive callers.
- If Node `fetch` is ever blocked (corp proxy / TWSE block), fall back to `agent-browser` opening the
  same JSON URL and pasting the JSON, then upsert manually — but try the script first.

## 4. Recording markers & forward signals

```
node --experimental-sqlite scripts/add-marker.mjs <code> <date> <action> [price] [reason] [note_link] \
     [--status S] [--condition "..."] [--outcome "..."]
# action ∈ buy | sell | hold | watch | signal | stop | target
# status ∈ pending | met | open | closed | stopped | invalidated   (drives the chart colour)
```
- `buy`/`sell` sit at the fill price (badge pins); `stop`/`target`/`signal` render as dashed
  horizontal lines; `hold`/`watch` sit just below/above the candle on their date.
- **`signal` is the forward-looking flag** — a condition to *check in the future*, drawn as a dashed
  threshold line at its trigger level with a ⚑ flag. Use it for watchlist entry triggers. Give it the
  trigger **level** as `price`, the `--condition` text (e.g. `"站回 20MA(4,329) 連 2 日 + KD 金叉"`),
  and `--status pending`. When it fires, re-assert with `--status met` (idempotent upsert).
- **The three post-mortem fields** make a chart a review reference:
  - `reason`  — the thesis (why we acted / are watching)
  - `condition` — what must happen for a signal/stop/target to fire
  - `outcome` — what actually happened (realized P&L, "停損出場") — fill this in when a position closes
- `status` colours the marker/line and the review-panel pill: `pending`=amber, `met`=green,
  `open`=blue, `closed`=grey, `stopped`/`invalidated`=red.
- `reason`/`condition`/`outcome` should be *short* echoes of the Obsidian note; pass its slug as
  `note_link` (e.g. `"[[0050-vs-0052-analysis-20260629]]"`) for the full story.
- Every marker also becomes a row in the chart's **決策與訊號紀錄** review panel (date · action ·
  status · level · 距現價 · condition/reason · outcome · source) — the post-mortem reference.

## 5. Seeding from Obsidian (one-time / re-runnable)

```
node --experimental-sqlite scripts/seed-from-obsidian.mjs
node --experimental-sqlite scripts/seed-from-obsidian.mjs --vault "<path>" --ledger "<path>" --note "<path>" --us-ledger "<path>"
```
Parses the holdings ledger `## 交易明細` table → buy/sell markers (+ stop/target from the 停損 /
停利目標 columns on buy rows; 備註 → reason) and the newest analysis note's `### 觀察名單` lines
(`- <code> <name>：<trigger>`) → watch markers dated at the note's `created:` date. Idempotent.
**市場維度 (v1.20.0)**: the US ledger (`us-stock-holdings.md`, default beside the TW one) seeds
in its own pass; positions reconciliation is **market-scoped** — seeding the TW ledger can never
delete a US position and vice versa. A missing US ledger is normal (skipped), not a failure.

## 6. Rendering the chart

```
node --experimental-sqlite scripts/render-chart.mjs <code> --days 60 [-o out.html]
```
- Reads `ohlc` + `markers`, injects a JSON payload into `assets/chart-template.html` (replacing the
  exact `const DATA = __CHART_DATA__;` statement — note the bare token also appears in the template's
  comment, so match the full statement), writes a self-contained HTML file.
- Default output: `C:\Users\lizard_liang\personal\stocks\charts\<code>-<YYYYMMDD>.html`. Charts are
  regenerable artifacts — the DB is the thing worth syncing, not the HTML.
- Open it in the browser to show the user (`start <path>` on Windows, or `agent-browser open file:///<path>`
  + screenshot if you want to verify headless).
- The chart renders candles (**market-aware**: TW 紅漲綠跌; US tickers 綠漲紅跌 with a
  Yahoo-Finance footer and M/K 股 volume units — the template reads `DATA.market`), MA5/10/20,
  volume, dashed 停損/停利 lines (semantic red/green, never flipped), and pin markers whose hover
  tooltip shows the recorded reason + note link. MAs are computed in JS from closes — no need to
  populate `indicators` first. US tickers are accepted anywhere a code is (`render-chart.mjs NVDA`).

## 7. Tokyo Night palette + marker map (enkia/tokyo-night-vscode-theme)

| token | hex | use |
|---|---|---|
| bg | `#1a1b26` | page background |
| panel | `#16161e` | chart panel |
| fg | `#a9b1d6` | text |
| muted | `#51597d` | axes / comments |
| red | `#f7768e` | **candle up (紅漲)**, stop line |
| green | `#9ece6a` | **candle down (綠跌)**, target line |
| blue | `#7aa2f7` | buy ▲ / status open |
| purple | `#bb9af7` | sell ▼, MA20 |
| orange | `#e0af68` | hold ◆, MA5, **signal ⚑ (status pending)** |
| cyan | `#7dcfff` | watch ○, MA10 |
| green | `#9ece6a` | target line, **status met** |
| grey | `#787c99` | status closed |

**Status → colour** (overrides the action colour on the marker, line, and review-panel pill):
`pending`=amber · `met`=green · `open`=blue · `closed`=grey · `stopped`/`invalidated`=red. A `signal`
flag turns from amber to green when you re-assert it with `--status met`.

**Taiwan convention 紅漲綠跌** is deliberately inverted vs Western charts (where green=up). The
candle-colour constants live in `:root` of the template (`--up`/`--down`) — flip them there if a user
ever wants the Western scheme. Markers use their own colours/glyphs so they never read as candle colour.

## 8. When to fetch / refresh

- Before rendering, ensure history covers the requested `--days`. If `render-chart.mjs` reports
  "No OHLC", run `fetch-history.mjs` first.
- During a normal analysis session you already pull the latest day from Histock/Yahoo — also call
  `fetch-history.mjs <code> --months 1` (cheap; only the current month re-fetches) to keep the DB's
  newest sessions current, then re-render.
- Don't loop fetches across many stocks without the built-in throttle; TWSE will start returning
  errors. The script already sleeps between month-calls.

## 9. Screening & trade-plan math (`screen.mjs`)

The rule-math engine. All deterministic arithmetic (indicators, gate thresholds, stops, R:R,
sizing) lives here — the model supplies judgment inputs and reads back JSON. Hand-computing
these numbers caused both 2026-07 paralysis bugs; don't.

### Mode 1 — screening (indicators + Rule 6b gate)

```
node --experimental-sqlite scripts/screen.mjs <code> [<code>...] [--date YYYY-MM-DD]
```
One JSON line per code, computed from the local `ohlc` table (top up with
`fetch-history.mjs <code> --months 1` first). US tickers work identically
(`screen.mjs NVDA`) — every output object carries `market: 'tw'|'us'` (derived from the
code shape; the 6q liquidity floor and 6l-1 tick switch on it automatically). Fields:

- price/volume: `date open high low close chgPct volume vol5avg volRatio`
  (`vol5avg` = mean of the **prior** 5 sessions; `volRatio > 1` = Rule 6j confirmed, `≥ 1.5` strong)
- MAs: `ma5 ma10 ma20 devFrom20Pct maAligned(bull|bear|mixed) aboveMA20Streak`
  (streak = consecutive closes above that day's MA20 — feeds "站回20MA連N日")
- `atr14 atrPct atrProvisional` — Rule 6a simple mean of the last 14 TRs; `atrProvisional: true`
  when < 15 sessions (do NOT reject on R:R computed from it)
- indicators: `k9 d9` (KD 9,3,3 — matches Histock exactly), `rsi6 rsi12` (Wilder — matches
  exactly), `dif macdSignal osc` (MACD 12,26,9). **Histock's displayed「MACD」number is the
  signal line (`macdSignal`)**, not DIF. MACD converges to ~±10% with a 3-month warmup; fetch
  6 months of history if tighter agreement matters.
- `signals`: booleans — `kdGolden kdDeath macdRising rsi6Gt70 rsi6Gt80 k9Gt80 extendedGt10
  dayGainGt3 volConfirmed volStrong`
- `gate.style1`: `{ pass, failures[] }` — the four Rule 6b Style-1 checks
- `gate.style2Partial`: the four mechanical Style-2 checks (`volConfirmed kdGolden macdRising
  rsi6LE80`); base-structure recognition and R:R stay with the model (pivot is a judgment input)
- `continuation` — the **Rule 6b Style-3c 延遲確認 gate** (added 2026-07-22): did yesterday's
  day-1/2 reversal candidate get confirmed TODAY? Fields: `upRun reversalDate reversalClose
  reversalDayOfMove declineDays declineStart checks{windowOk kdGoldenYesterday
  closeAboveReversal reclaimedNow volConfirmed kdGoldenToday rsi6LE80} qualified failures[]`.
  Always confirms **yesterday only** (+1 session, D3); `null` when < 4 sessions of history.
  Read `qualified`/`failures[]` — never re-derive the checks by eye.
- `gate.histockSpotCheck`: `true` when a reading sits within ±3 of a gate threshold (RSI6 near
  70/80, K9 near 80, dev near 10%) → only then fetch Histock to cross-check. Otherwise skip the
  browser entirely; the script is the indicator source.

Computed rows are cached into the `indicators` table (idempotent upsert).

### Mode 2 — trade plan (Rule 6a-1 stop enforced by code)

```
node --experimental-sqlite scripts/screen.mjs <code> --style 1|2|3 --zone LO-HI \
     [--pivot P] [--revlow L] [--confirm] [--vol-trial] [--target T] [--equity E] [--date YYYY-MM-DD]
```
- `--style 1` (pullback): `stop = zone_bottom − max(2×ATR14, bottom×5%)`. When the stock is
  ATR-hot (screening `atrPct > 6` → `atrHot: true`), the notes flag Rule 6m: the pullback
  path is regime-closed except the zone bottom — prefer Style-2/3.
- `--style 2` (breakout): **requires `--pivot`** (base top / reclaimed high);
  `stop = min(pivot×0.99, bottom×0.95)`. Omitting `--pivot` is a **hard error** — the script
  refuses to fall back to 2×ATR (that silent regime swap was the 2026-07-03 bug).
- `--style 3` (reversal-day inside a base, Rule 6b Style-3, added 2026-07-08): **requires
  `--revlow`** (the reversal day's low); `stop = min(revlow×0.99, bottom×0.95)`. Same
  hard-error policy. Pilot 50% only; close < revlow = out. **Also hard-errors when
  量 ≤ 5日均量 (Rule 6j, script-enforced since 2026-07-28)** — the error names the ratio and
  points at `--vol-trial`.
- `--style 3` auto-detects the **Rule 6b-R1 reclaim 試行** (added 2026-07-31, no flag): a
  reversal day with a decline segment whose reclaim failed (and volume confirmed) tags
  `reclaimTrial: true`, `variant: '3-reclaimTrial'`, `pilotPct: 25` — **report-only paper
  track, never a buy** (pre-registered evidence: both frozen OOS samples show the blocked
  group with higher avgR and lower stop rate; `experiments/reclaim-preregistration.md`).
  A vol+reclaim dual failure is flagged in notes and belongs to neither trial.
- `--style 3 --vol-trial` (Rule 6j-A2 試行, added 2026-07-28): plans a volume-failed Style-3 as a
  **report-only paper track** — `volTrial: true`, `variant: '3-volTrial'`, `pilotPct: 25`.
  Rationale: 6j's 1.0× threshold showed no discriminative power across 3 pre-registered samples
  (2:1 against, 6,800+ signals). **Never a buy recommendation while the trial runs**; the notes
  carry the disclaimer. Ignored with a note (not fatal) when volume already confirms. Scoped to
  plain Style-3 — it does NOT unlock an unqualified 3c and does not touch Style-1/2.
- `--style 3 --confirm` (3c 延遲確認, Rule 6b Style-3c, added 2026-07-22): no `--revlow`
  (ignored with a note if passed) — the **confirmation-day low is read from the DB**;
  `stop = min(confirmLow×0.99, bottom×0.95)`. **Hard-errors unless the screening
  `continuation.qualified` is true** — the script, not the model, decides 3c
  qualification (the error names the failed checks). Pilot 50% only; close below the
  confirmation-day low = out. **試行觀察期**: until the user promotes 3c, a qualified day
  is report-only (紙上追蹤) — see SKILL.md 6b Style-3c trial clause.
- `--target`: measured-move / prior-high structural target. **The reward leg is
  `max(--target, TP2)` (Rule 7d, mechanized 2026-07-31)** — a structural target below TP2 is
  demoted to TP0/近程壓力 (read `structuralTarget` vs `rewardTarget`); rr judged against a
  nearest-structure target was mathematically unpassable with 5%-floor stops (the audit's
  「授權集合為空」 driver) and was never what the backtests validated. Omitting `--target`
  still defaults to TP2.
- **Rule 6i dividend restoration (2026-07-31)**: `screenCode` runs all close-vs-close
  comparisons (up/down runs, decline segments, reclaim anchors, `chgPct` — now the exchange's
  vs-參考價 convention) on a dividend-restored series from the `dividends` table. Price
  LEVELS (stops, zones, ATR, MA, KD/RSI — Histock parity) stay raw. New fields:
  `reversal.declineStart` is **today's-basis** (dividends shed), `declineStartRaw` the
  historical close, `divAdjusted`, `divEvents`, `nextDiv`. Sync data with
  `node --experimental-sqlite scripts/fetch-dividends.mjs --months 4` (TWSE TWT49U full
  history, market-wide; TPEx is a forward 預告 window only — rows accumulate on daily runs,
  and an absent row is NOT proof of no dividend).
- `--equity`: account equity → `sizing.shares = floor(equity×1% / 1R)` (Rule 6e-2; apply the
  2% per-theme heat cap manually across correlated picks, Rule 6e-3). Also returns
  `sizing.pilotShares = floor(shares × pilotPct/100)` — the Rule 6e-5 first entry (50%, or 25%
  on the 6j-A2 trial path). **Never hand-halve a position — read `pilotShares`.**
  **Separate books (市場維度)**: pass the equity of the stock's OWN market — TWD for numeric
  codes, USD for US tickers; `sizing.equityCurrency` stamps which book was used, never FX.

- `entryAuthorised` — **the Rule 6l-1 authorised entry set** (added v1.15.0): the 6l band
  INTERSECT the prices where R:R >= 1.5, aligned to the exchange tick. Fields:
  `band{lo,hi,anchor,anchorSource} maxEntryForRR tick lo hi singlePoint empty binding notes[]`.
  **Quote `lo`/`hi` as the buy zone — never the band alone.** The band is a fixed percentage
  while the R:R cost of that percentage scales with stop width, so the two cross at a price
  nobody can eyeball: on 3504 (2026-07-29) the band was 68.6-69.29, R:R held only to 68.68,
  and after tick alignment the authorised set was the single price **68.6**. `empty: true`
  means no legal price exists (6668 same session: ceiling 36.18 below band floor 37.15) —
  that is a complete answer, not a failure to compute. Two details the script owns: the
  ceiling is FLOORED to the tick (rounding up yields a price failing its own test —
  68.6666 -> 68.67 -> R:R 1.4993), and it uses the REPORTED (rounded) stop so a reader can
  reproduce it from the same object. `tickSize(price, market)` is exported for reuse —
  the TWSE/TPEx ladder for tw, a flat $0.01 for us (v1.20.0).

Output JSON: `style variant volTrial pilotPct volRatio zone pivot revlow confirmLow reversalDate
atr14 atrHot stop stopPctBelowBottom tp1 tp2
rewardTarget oneR rr rrPass notes[] sizing? gate` — `variant` is `'3c'` for a
`--confirm` plan, `'3-volTrial'` for a 6j-A2 trial plan (else null); `rr` is measured mid→target per Rule 7d
(never TP1); `notes[]` explains which stop branch fired (audit trail). R:R at the zone
**bottom** is more favourable than at mid — a `rrPass: false` at mid with a pass at bottom =
"只在買區下緣進" (e.g. 3711 2026-07-03: mid 1.33 fail, bottom 1.49 pass → deep-pullback-only
entry).

Exit codes: missing OHLC / bad inputs / Style-2 without pivot / Style-3 without revlow /
Style-3 `--confirm` when `continuation.qualified` is false → exit 1 with a message.

## 10. Whole-market scan (`scan.mjs`)

The 市場掃描 discovery engine (SKILL.md Action A step 2b) — sweeps every 上市/上櫃 common
stock so the candidate pool isn't capped at ETF constituents. Endpoints and field layouts
are in `references/data-sources.md` §市場掃描; never hand-fetch them.

```
node --experimental-sqlite scripts/scan.mjs                    # sync caches + scan
node --experimental-sqlite scripts/scan.mjs --no-sync          # scan cached data only
node --experimental-sqlite scripts/scan.mjs --sync-only        # refresh caches, no output
node --experimental-sqlite scripts/scan.mjs --top 20 --min-value 50000000 --rev-yoy 50
```

Flags (defaults): `--top 15` rows per list · `--min-value 100000000` NT$ traded/day
liquidity floor · `--chg 3` momentum min %gain · `--vol-ratio 1.5` momentum min volume vs
own 5-session avg · `--trust-days 3` min consecutive 投信 net-buy sessions ·
`--rev-yoy 30` min revenue YoY % · `--backfill 10` calendar days of history to ensure.

Sync fills `market_snapshot` + `inst_flows` for dates not yet cached (first run ≈ 2 min
for ~6 sessions of backfill; daily re-runs ≈ 6 HTTP calls / ~12 s). Monthly revenue is
fetched fresh each run (YoY precomputed by TWSE/TPEx, nothing to cache).

Output JSON:
- `asOf` — `{snapshot, inst, revenueMonth}` data-as-of dates (cite them, Rule 3)
- `universe` — `{total, afterLiquidityFloor, snapshotDepth}`; `snapshotDepth` < 6 means
  volume ratios / streaks run on thin history (entries carry a `provisional` note)
- `multiSignal` — codes hitting ≥2 lists, **read first**
- `momentum[]` — `{code,name,market,close,chgPct,value,volRatio,provisional?}` sorted by
  volRatio; `volRatio: null` + provisional until 3 prior snapshot days exist
- `trustBuy[]` — `{…, streak, streakNet, todayNet, provisional?}` sorted by streak;
  streak is capped by cached inst days (≤10), flagged when it hits the cap
- `revenue[]` — `{…, revYoY, revMoM, revMonth}` sorted by YoY
- `momentumTotal / trustBuyTotal / revenueTotal` — full counts before the `--top` cap

Scan hits are *discovery*, not candidates: they still go through `fetch-history.mjs`
(most scan names aren't in `ohlc` yet — `--market tpex` for 上櫃!), the `screen.mjs`
gates, and the Rule 6q rating before any recommendation. Non-ETF names carry tier 掃描
and the 「非ETF成分，無指數把關」 flag per step 2b.

## 11. Stateless rule math (`rules.mjs`)

The rule-math-mechanization delta's stateless engine (SKILL.md Rule 8): five inputs-in/
verdict-out subcommands, no portfolio state. `earnings` is the only verb that opens the DB
(for the `holidays` table); `band`/`heat`/`thesis`/`deviate` are pure functions.

```
node --experimental-sqlite scripts/rules.mjs earnings --event YYYY-MM-DD [--from YYYY-MM-DD] [--market tw|us] [--sync-holidays]
node --experimental-sqlite scripts/rules.mjs band --style 1|2|3 --anchor A [--price P] [--breakout-pct N]
node --experimental-sqlite scripts/rules.mjs heat --json legs.json --equity E [--cap 2]
node --experimental-sqlite scripts/rules.mjs thesis --json thesis.json
node --experimental-sqlite scripts/rules.mjs deviate --a V1 --b V2 --kind price|weight|indicator|quote-vs-close [--market tw|us]
```

- **`earnings`** (Rule 6h) — `--event`/`--from` are ISO dates (`--from` defaults to today).
  `tradingDaysAway` = trading sessions strictly after `from`, up to and including `event`
  (2026-07-20→2026-07-28 = 6). `blackout` at `tradingDaysAway <= 5`. `holidaysCrossed[]` lists
  the weekday holidays skipped.
  **`coverageVerified`** (added 2026-07-20) — `true` only when `[from, event]` lies wholly
  inside **verified** coverage: the ohlc-derived trading-day span ∪ years actually synced
  from TWSE with a non-empty parse. The static built-in holiday table **never** makes a
  range verified — it is an accuracy aid only, having twice missed real closures
  (2026-04-06/07-10; then the 2026-02-27/10-09 make-up Fridays), and typhoon closures are
  unknowable in advance. When `false`, `warning` carries the verified intervals and the
  remedy; refresh with `--sync-holidays` (the only network call in this feature).
  **Consuming the flag is mandatory, not optional** — SKILL.md Rule 6h: `coverageVerified:
  false` together with `tradingDaysAway <= 7` must be treated as a blackout unless a sync
  verifies the range. A warning nobody is instructed to act on is decoration, which is the
  exact defect class this feature exists to remove.
  **`--market us` (v1.20.0)**: counts against the NYSE calendar (`holidays_us` + the
  US-scoped ohlc span). The two calendars never mix — 春節 is a normal NYSE week. There is
  no US sync source: `--sync-holidays --market us` hard-errors, and the remedy is
  `fetch-history.mjs SPY --months 24` (SPY-derived span = the verified US calendar).
- **`band`** (Rule 6l) — `--anchor` is the trigger level; band width by style: Style-1 generic
  +2%, Style-2 breakout pivot `--breakout-pct` (default 3, i.e. +2~3%), Style-3 reversal close
  +1%. With `--price`: `fired` (price ≥ anchor), `lateFire` (price > `bandHi`), `excessPct`
  (how far beyond `bandHi`, not the raw anchor — that's what "超出有效帶 X%" means).
- **`heat`** (Rule 6e-3) — `legs.json`: `[{code, entry, stop, shares?}]`; a leg without `shares`
  defaults to the Rule 6e-2 1%-equity sizing. Returns per-leg `oneR`/`riskAmt`/`riskPct` and
  `themeHeatPct`/`overCap`/`scaleFactor`; when `overCap`, read `legs[].sharesAtCap`, not `shares`.
- **`thesis`** (Rule 6o) — `thesis.json`: `{assumptions:[{name,status}], redLines:[{name,triggered}]}`,
  `status` ∈ `green`|`yellow`|`red`|`black`. `health = 10 − 3×black − 2×red − 1×yellow −
  5×redLinesTriggered`; `breakdown` is the printable string (thesis-tracking.md §2 format,
  only nonzero terms shown). Any `redLines[].triggered` forces `forcedBinary: true` regardless
  of score — never softened by a healthy `health`.
- **`deviate`** (Rule 3a) — `--kind price|weight`: `deltaPct` (relative to `--b`) `>=5%` →
  `封鎖`, `>=1%` → `標註` (compared on the 1-decimal display value, so a reading that rounds
  to exactly "1.0%" still flags). `--kind indicator`: absolute `deltaAbs > 3` → `標註` (0–100
  scale). `--kind quote-vs-close`: `deltaPct > 10%` → `refetch` (the timing exemption — never
  `封鎖`, a live-vs-T-1-close gap beyond 漲跌停 is a suspect fetch, not a conflict). With
  `--market us` the bound is **20%** (no 漲跌停; real 10–18% earnings gaps exist — v1.20.0).

Exit codes: bad/missing flags, unparseable `--json`, or `--event` before `--from` → exit 1
with a message.

## 12. Portfolio-state rule math (`positions.mjs`)

Needs the `positions` table (backfilled by `seed-from-obsidian.mjs`, kept current by Action B's
ledger writes). R4 runs through every verb: `stop_status` distinguishes a MISSING stop
(`active`, `stop=NULL`) from a CONSCIOUSLY RE-UNDERWRITTEN one (`reunderwritten`, Rule 6n) — a
re-underwritten (or `void`) position never reports a breach, only P&L.

```
node --experimental-sqlite scripts/positions.mjs theme-stop --theme "AI鏈" --price 3017=2135 [--price code=P ...]
node --experimental-sqlite scripts/positions.mjs breach-check [--price code=P ...] [--market tw|us]
node --experimental-sqlite scripts/positions.mjs review [--price code=P ...] [--market tw|us]
```

**市場維度 (v1.20.0)**: every `review` row carries `market` (derived from code shape);
`--market tw|us` scopes `review`/`breach-check` to one book — Action C invokes once per book
so each report stays in one currency. `theme-stop` **hard-errors on a theme that spans both
markets** (TWD+USD must never be summed; split the theme per market).

- **`theme-stop`** (Rule 6e-4) — all legs of `--theme` need a `--price`; the command errors
  (naming the missing codes) rather than silently partial-computing the combined %. `tier` ∈
  `null`|`-10`|`-15`|`-20` on combined `unrealizedPct`; `action` names the exact 6e-4 response;
  `weakestLeg` is a lookup (worst unrealized %), not something the model re-derives.
- **`breach-check`** (Rule 6n) — one row per position in `positions`. `firstBreachDate` is the
  earliest `ohlc` close (from `opened_at` onward) at or below `stop`; an optional
  `--price code=P` appends today's live price to the series when `ohlc` hasn't caught up yet.
  `sessionsSinceBreach` counts rows from `firstBreachDate` onward; `forcedBinary: true` at
  `sessionsSinceBreach >= 2` (the execute-or-re-underwrite decision itself stays judgment — this
  only flags that the decision is due). Non-`active` `stop_status` always yields
  `breached: false` with a `note` explaining why (never re-flagged as an unexecuted stop).
- **`review`** (Action C step 5) — folds in `breach-check`. Per holding: `invested` (cost ×
  shares), `live`/`unrealized`/`unrealizedPct` (needs `--price`), `stopHit` (from
  `breach-check`), `targetHit` (`price >= target_lo`), `sessionsSinceBreach`. This is what
  Action C step 5/7 reads instead of hand-computing cost × shares.

Exit codes: unknown `--theme`, missing `--price` for a theme leg, or an unrecognized verb →
exit 1 with a message.
