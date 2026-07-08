---
name: tw-stock-etf-advisor
description: >-
  Taiwan ETF and stock research, buy/sell decisions, and personal holdings
  tracking. Use this whenever the user asks about Taiwan ETFs (especially 0050
  元大台灣50 and 0052 富邦科技), wants to find common/overlapping holdings between
  ETFs, asks "which stock should I buy" with reasoning, wants an entry price and
  sell strategy (buy zone / 停利 / 停損), wants to record a trade they made, or
  asks to review their current holdings and get selling suggestions. Trigger even
  when the user only says things like "幫我看 0050 跟 0052 共同持股", "推薦我買哪一檔",
  "我買了 <股票> <股數> @<價>", "檢查我的持股", or "我現在該賣什麼" — they need this
  skill's exact data-sourcing and tracking workflow, not ad-hoc browsing. Always
  fetch live data with agent-browser; never guess or derive prices. ALSO use this
  skill whenever the user wants to SEE or VISUALIZE a Taiwan stock — "畫 K 線",
  "畫個 K 線圖", "把買賣點/進出場標在圖上", "show me the chart for 2330", "candlestick
  chart", "K-line", "視覺化我的持股", "畫出奇鋐的走勢" — it generates a standalone
  Tokyo-Night candlestick chart (Action D) that marks WHY each buy/sell/hold happened.
---

# Taiwan Stock & ETF Advisor

This skill reproduces a research-to-tracking workflow for Taiwan equities. It has
**four** actions. Figure out which one the user wants from their phrasing, then follow
that section. The non-negotiable rules below apply to all of them.

- **Action A** — ETF common-holdings analysis & stock recommendation
- **Action B** — record a trade to the holdings ledger
- **Action C** — review current holdings & suggest selling
- **Action D** — draw a K-line (candlestick) chart marking buy/sell/hold reasons

## Core rules (why they matter)

1. **Fetch real data — never guess, never derive prices.** Stock prices and ETF
   weights change every day. A price computed from "holding value ÷ shares" is a
   stale close, not a quote. Always pull the live number with `agent-browser`. We
   learned this the hard way: a derived price was off by 6% the same morning.

2. **For ETF holdings, prefer the fund company's official site over Yahoo.** Yahoo
   only shows the top 10 holdings and its "資料時間" can lag by weeks (we saw 4/1
   data on 6/1). The 投信 (fund company) sites publish the full constituent list at
   T+1. Use Yahoo only for live *quotes*, not for *holdings*. Exact URLs and
   extraction recipes are in `references/data-sources.md`.

3. **Always state the data-as-of date and surface staleness.** Each figure carries
   its own timestamp (holdings vs. weights vs. price). If something looks old, say so
   rather than presenting it as current.

3a. **Cross-source deviation — compare before trusting either number.** When the
    same figure at the same timestamp is available from two sources, compare them.
    **Prices/weights**: >1% deviation → 標註 (show both values, use the primary's);
    >5% deviation → 封鎖 (the figure enters NO gate/stop/sizing computation until
    the primary is re-fetched and confirms which value is real). **0–100 indicators**
    (K/D/RSI): use absolute deviation (±3), not percentage — the existing histock
    spot-check convention (Action A step 5 cites it as "per 3a").
    **Timing exemption**: a live quote vs. the local DB's T-1 close is NOT a
    conflict — different timestamps, not a disagreement. Apply a plausibility bound
    instead: |live − last settled close| > 10% (Taiwan's 漲跌停 limit) is presumed a
    fetch/parse error (wrong ticker, stale page) → re-fetch before analyzing, never
    treat it as a real move.
    **"Verified"** means re-fetched from the declared primary with value + timestamp
    cited — never assert verification without a fetch.
    Primary hierarchy, causes table, and a worked example are in
    `references/data-sources.md` §交叉驗證. (Distinct from Rule 6q: 3a governs
    conflicting data; 6q governs missing data.)

4. **This is not professional investment advice.** End every recommendation with a
   short risk/disclaimer line. Taiwan AI-theme stocks are volatile with deep
   pullbacks — remind the user to verify the latest price/financials and honor stops.

5. **Persist to Obsidian by delegating to Eliot — and mirror the structured bits to
   SQLite.** This skill does the analysis and data fetching; the *narrative* vault writes
   (analysis note, `[[stock]]` project log, holdings ledger) go through the **Eliot** skill
   so they follow the user's templates and approval flow (`references/obsidian-tracking.md`).
   **Obsidian stays the source of truth for the "why".** Separately, the *structured* data —
   daily OHLC price history and decision **markers** (buy/sell/hold/watch/stop/target with a
   one-line reason) — is mirrored into a local **SQLite** DB so it can be charted and queried
   (Action D). The marker's reason is a short echo of the note, never a competing master copy;
   the two must not diverge in intent. SQLite mechanics are in `references/charting.md`. The DB
   path resolves env `TW_STOCK_DB` → `Eliot/Profile.md` `stock_db_path:` →
   default `C:\Users\lizard_liang\personal\stocks\stocks.db` (point the override at OneDrive to sync).

6. **Risk management — learned from 2026-06 post-mortem.** The following rules exist
   because a prior analysis cycle produced structurally flawed recommendations that
   would have lost money even with perfect execution. They are non-negotiable.
   **Audit trigger:** if the user asks some form of 「所以每次結論都是不要進場嗎？」/
   "is the conclusion always don't-enter?", treat it as a **mandatory audit signal**:
   re-check every candidate that failed R:R for stop-regime mismatch (6a-1) and
   TP1-based R:R (7d) *before* defending the conclusion. Also check whether the
   "wait" verdicts trace to an undeclared ATR-hot regime (6m — say so explicitly
   instead of serial R:R fails) or to a watchlist trigger that fired outside its
   validity band (6l — that is a trigger-authoring defect, own it as such).

   **6a. Stop loss is calculated from the buy zone, not the spot price — and its
   width formula depends on the entry style (see 6a-1).**
   The stop loss must give adequate room *below the entry the user is told to wait
   for*. Formula: `stop_loss = buy_zone_bottom − max(2 × ATR14, buy_zone_bottom × 0.05)`.
   `ATR14` = the 14-day Average True Range, computed from the OHLC in the local DB
   (`TR = max(high−low, |high−prevClose|, |low−prevClose|)`, averaged over the last
   14 sessions). This accommodates the stock's *typical* volatility instead of a fixed
   −10%. **This 2×ATR14 formula applies to Style-1 pullback entries ONLY.** Style-2
   breakout entries use the structural stop in 6a-1 — applying 2×ATR width to a
   breakout inflates 1R and falsely fails R:R (the 2026-07-03 bug).
   **Why ATR14, not a single day's range (fixed 2026-07 — the paralysis bug):** the old
   rule used `daily_range = 最高 − 最低` of the *latest* session. After a crash or on a
   whipsaw day that single range spikes (we saw ±7.7% on 3037 on 7/1), so `2 × range`
   produced a stop ~20%+ below entry and every candidate's R:R "failed" → the gate never
   said yes for two weeks. ATR14 smooths the outlier day and yields usable stops. If the
   DB has < 14 sessions, fall back to the single-day range but **flag it as provisional**
   and do NOT reject a candidate on R:R computed from a lone spike day — recompute once
   ATR14 is available.

   **6a-1. Stop-width regime — match the stop to the entry style (fixed 2026-07-03).**

   | Entry style | Stop reference | Formula |
   |---|---|---|
   | Style-1 pullback | buy zone bottom (support level) | `bottom − max(2×ATR14, bottom×5%)` |
   | Style-2 breakout | **breakout pivot** (base TOP / reclaimed prior high) | just under the pivot, honoring the 5% floor below entry — **NOT 2×ATR, NOT the base low** |
   | Style-3 reversal (added 2026-07-08) | **reversal-day low** | just under the reversal-day low, honoring the 5% floor below entry — `screen.mjs --style 3 --revlow L` (hard-errors without it) |

   Why: a Style-2 entry is only valid while the breakout holds; if price falls back
   below the pivot the thesis is dead — waiting out a 2×ATR-wide stop down to the
   base low just donates the difference. On 2026-07-03, 2383's 2×ATR stop (−11%,
   1R 685) made a real 2.8 R:R read as 1.3 → false "等回測". The structural stop
   5,650 (−5.4%, 1R 320) was correct. **The over-wide stop is the paralysis
   mechanism itself.** Enforced mechanically by `scripts/screen.mjs`: the `--style`
   flag selects the formula, and a Style-2 run without `--pivot` hard-errors
   instead of silently falling back to 2×ATR.

   **6b. Technical entry gate — must pass BEFORE recommending.**
   Every candidate stock must have its Histock technicals fetched and evaluated
   *before* it enters the recommendation list. There are **three valid entry styles**;
   a candidate qualifies if it passes *any*. Do not force every stock through the
   pullback gate — that biases the whole system toward permanent "wait" in trending /
   post-crash-recovery tapes (the paralysis bug, 2026-07).

   **Style 1 — Pullback entry (buy weakness into support).** Use when the stock is
   near a moving average / consolidation floor. Fails (→ exclude or flag
   "等待進場條件成立") if any of:
   - RSI6 > 70 → overbought, wait for a pullback
   - KD K9 > 80 → overbought zone
   - Price far above 20MA (> 10%) → extended, wait for pullback
   - KD 死亡交叉 (K < D and declining) → bearish momentum, wait

   **Style 2 — Breakout entry (buy strength out of a base).** This is the
   O'Neil/Minervini path the correlation rules cite (6e) but the old gate never
   implemented. A stock qualifies as a breakout buy — *even if it is somewhat extended
   or RSI is elevated* — when ALL of:
   - It is breaking **out of a recognizable base/consolidation** (a multi-session
     sideways range, a flag, or a reclaim of a prior pivot high), not spiking in open air.
   - **Volume confirms** (Rule 6j): breakout-day 量 > 5-day average (ideally > 1.5×).
   - KD is a golden cross (K > D and rising); MACD rising / turning positive.
   - RSI6 ≤ 80 (a breakout can run hot to ~70–80; only reject > 80 climax readings).
   - The stop just under the **breakout pivot** (per 6a-1 — not 20MA, not the base
     low) yields R:R to the **reward target** (TP2/measured-move, per step 7d — never
     TP1) ≥ 1:1.5. If even the pivot-stop reward-target R:R fails, it is extended —
     pass and wait for the next base.
   For a Style-2 buy the buy zone is the **breakout level up to +2~3% above it**
   (buying the breakout), not a lower pullback zone — say which base is breaking and
   where its floor (the stop reference) sits.

   **Style 3 — Reversal-day entry inside a base (added 2026-07-08, user-approved).**
   The gap between Style-1 and Style-2: a volume-confirmed reversal day *inside* an
   established base, before the base top breaks. Without this style, the only legal
   entries are the support edge and the breakout — a stock reversing mid-base fires
   its watchlist trigger but is unbuyable (the 2379 2026-07-08 contradiction: trigger
   met at 817, Style-1 R:R fails, Style-2 pivot not yet broken). Qualifies when ALL of:
   - A **recognizable multi-week base** after a climax/correction (not a live
     downtrend — lower lows still forming disqualify).
   - **Reversal day 1 or 2 only**: KD golden cross + the close reclaims the last 3+
     sessions' closes. Day 3+ is late — wait for the Style-2 breakout instead.
   - **Volume ≥ 1× the 5-day average** (Rule 6j; ≥ 1.5× strengthens it).
   - RSI6 ≤ 80.
   - Stop just under the **reversal-day low** (per 6a-1, `screen.mjs --style 3
     --revlow`), and R:R to the reward target ≥ 1:1.5.
   Execution constraints (stricter than Style-1/2 because the base top has NOT yet
   confirmed): **pilot 50% only, never full size**; add the rest only after the base
   top breaks out (Style-2 rules take over from there); **close back below the
   reversal-day low = out, no averaging, no second guess**. The entry window is the
   reversal-day close +1% — beyond that the edge is gone (see 6l), wait for the
   breakout.

   **6c. No-chase rule — applies to spikes, NOT to base breakouts or base reversals.**
   If a stock is up > 3% on the session as an **isolated spike in open air** (no base
   breakout, or it is the 2nd+ consecutive extended up-day far above 20MA), mark it
   "勿追高，等下一交易日" and give the buy zone for a future pullback only. **But** a
   > 3% move that IS a volume-confirmed Style-2 breakout from a base is the *entry
   signal itself*, not a chase — do not exclude it under 6c; buy the breakout per 6b
   Style 2. Likewise a > 3% move that qualifies as a **Style-3 reversal day inside a
   base** (volume-confirmed, day 1–2, reclaiming recent closes) is an entry signal,
   not a chase — 6c does not block it. Distinguish the three explicitly in the writeup
   (spike vs base-breakout vs base-reversal) so the reason is auditable. Never set a
   pullback buy zone that includes today's price when a stock is merely spiking
   without a base.

   **6d. Staged take-profit, not a single far target.**
   Replace the old "+15~20% single target" with staged exits:
   - **+8% from buy zone midpoint**: scale out ½ position, move stop to breakeven
   - **+15%**: scale out remaining ½ or trail with 5MA
   This improves win rate dramatically — the first target is reachable within normal
   trends, and the stop-to-breakeven move eliminates downside on the remainder.

   **6e. Correlation-aware position sizing (replaces forced diversification).**
   Same-theme concentration is acceptable — forced cross-sector diversification at
   small portfolio scale dilutes returns without proportionally reducing risk
   (O'Neil, Minervini, Acadian study). The real fix is sizing and exits.

   **6e-1. Treat same supply chain as ONE correlated exposure.**
   All positions within the same supply chain (e.g. AI server: material → thermal →
   ODM) depend on the same end demand. A demand shock hits all simultaneously.
   Size as one combined position, not N independent bets.

   **6e-2. Per-position risk cap: 1% of account equity.**
   `shares = (account_equity × 0.01) / (entry_price − stop_price)`.
   This replaces "buy N shares" — position size is derived from the stop distance.

   **6e-3. Per-theme heat cap: 2% of account (all correlated positions combined).**
   For 3 same-chain positions: each risks ~0.67% max, not 1% each.
   For 2 same-chain positions: each risks ~1% max.
   Always state the per-theme heat in the recommendation so the user sees the
   combined risk.

   **6e-4. Theme-level stop loss (fires before individual stops).**
   When total unrealized loss across all same-theme positions reaches:
   - **−10% of invested capital**: halve all positions (sell weakest leg first)
   - **−15%**: exit 2 of 3, keep only the strongest
   - **−20%**: exit ALL positions, 100% cash, do not re-enter the same theme until
     the sector ETF reclaims its 50-day MA AND at least 2 weeks have passed
   This overrides individual stock stops — if the theme is broken, every leg is
   suspect even if one stock hasn't hit its own stop yet.

   **6e-5. Entry protocol: pilot → add, never full size at once.**
   First entry: 50% of intended position. Add the remaining 50% only after price
   confirms (holds above entry for 2+ sessions, or breaks out of consolidation).
   If the pilot hits stop, do NOT add — exit and reassess.

   **6e-6. Disclose correlation in every multi-stock recommendation.**
   When recommending 2+ stocks from the same theme, always include:
   - A one-line warning: "這 N 檔同屬 [theme]，相關性高，合計部位視為一個曝險單位"
   - The per-theme heat calculation
   - The theme-level stop thresholds

   **6f. Market condition gate (Minervini/Weinstein).**
   The market environment is a prerequisite for any concentrated theme position.
   Check the TAIEX (加權指數) condition before recommending entries:
   - **TAIEX above 50-day AND 200-day MA**: full exposure allowed
   - **TAIEX below 50-day MA**: reduce theme heat cap to 50% of normal (1% instead
     of 2%), and flag "大盤轉弱，減碼操作"
   - **TAIEX below 200-day MA**: do NOT recommend new entries, suggest cash. Flag
     "大盤空頭，不建議進場"
   Fetch the TAIEX quote from Yahoo (`^TWII`) during Action A and compare against
   the index's MA levels. This prevents entering theme positions during broad
   market corrections where even good stocks get dragged down.

   **6g. Buy zone anchored to technical levels, not arbitrary percentages.**
   The buy zone should reference actual support levels: 20MA, recent consolidation
   floor, or a Fibonacci retracement — not "current price minus 3%". State which
   technical level anchors the buy zone so the user understands *why* that zone and
   can judge if the level breaks.

   **6h. Earnings blackout — event risk overrides technicals.**
   The entire rule set above is price/technical-based and is *blind to scheduled
   events*. The real account-killer is a gap, and gaps come from events — an ATR stop
   at 2,550 is worthless if an earnings miss gaps the open to 2,400, because stops do
   not fill in gaps. Therefore, before any entry, check the stock's next earnings
   (財報/法說) date:
   - **Distance to earnings ≤ 5 trading days → do NOT initiate.** Flag the candidate
     "財報前，等財報後再議" and exclude it from the buy zone.
   - **For held positions approaching earnings**: surface "X 個交易日後財報" and
     prompt the user to consider trimming to reduce gap exposure, or to accept the
     binary risk consciously.
   - Rationale: a stop cannot protect against an overnight/earnings gap. Skipping the
     pre-earnings window costs an occasional missed move; ignoring it risks an
     un-stoppable loss. Fetch the next earnings date during Action A step 5 (recipe in
     `references/data-sources.md`).

   **6i. Ex-dividend awareness — do not mistake the 除息 gap for a breakdown.**
   Taiwan's ex-dividend season is heavy (roughly June–August). On the ex-dividend
   (除權息) day a stock's price drops *mechanically* by the dividend amount. This:
   1. **Can falsely trip a stop** (the stock didn't "fall" — it shed the dividend).
   2. **Distorts every technical** — MAs, the price gap, KD/RSI all get knocked.
   Rules:
   - Fetch each tracked/held/candidate stock's ex-dividend (除權息交易日) date during
     Action A step 5.
   - **A price drop on or right after the ex-div day is NOT a sell signal** — restore
     the dividend before judging whether support broke. Never recommend 停損出場 on a
     move that is wholly explained by 除息.
   - For a held position approaching its ex-div date, note it so the user isn't
     alarmed by the mechanical drop, and remember the recorded 停損 may need adjusting
     down by the dividend amount.

   **6j. Volume confirmation — a reclaim/breakout without volume is suspect.**
   The technical gate (6b) uses price/MA/KD/RSI but ignores volume; we already fetch
   成交量 from Histock every session, so this is the cheapest high-value add. Per
   O'Neil/Minervini, a reclaim of a key MA or a breakout on *below-average volume* is
   a likely fake.
   - When a "站回 20MA" / "突破" / "進場條件成立" signal fires, require **當日量 >
     5 日均量** to treat it as confirmed.
   - If volume is below the 5-day average, downgrade the status to "量縮，待確認" and
     do NOT promote the stock to the recommendation list on that basis alone.
   - Report the volume-vs-average comparison alongside the technical screen so the
     user sees whether conviction backed the move.

   **6l. Trigger validity band — a late-firing trigger is a rewrite, not a buy
   (added 2026-07-08).** Every watchlist trigger condition MUST state a validity
   band: the anchor level up to **+2%** (Style-2 breakout triggers: the pivot up to
   +2~3%, per 6b; Style-3: reversal-day close +1%). If the condition first fires
   with price already beyond the band, it is a **late fire**: do NOT chase, do NOT
   report it as "進場條件已成立" — report "遲到觸發（超出有效帶 X%）" and rewrite
   the trigger the same session (new anchor, or switch the path to
   breakout/reversal). Why: on 2026-07-08, "站穩 776 上" fired at 817 (+5.3% above
   its anchor) — met-but-unbuyable is a contradiction the trigger's author created,
   and resolving it ad hoc looks like paralysis. The 觀察名單 entry format (step 9)
   carries the band explicitly.

   **6m. ATR-hot regime — declare the closed pullback path instead of serially
   failing R:R (added 2026-07-08).** When `atrPct > 6%` (screen.mjs sets `atrHot:
   true`), the Style-1 2×ATR stop makes essentially the entire pullback zone fail
   R:R *by construction* — only the extreme zone bottom can pass. That is math, not
   judgment; hiding it inside per-candidate R:R failures reads as "the system always
   says wait". Instead, state the regime up front in the analysis: "ATR 未收斂
   (X%)：回檔路徑關閉，僅突破 (Style-2) / 反轉日 (Style-3) 路徑有效；回檔僅買區
   最下緣一點勉強可用". Re-open the pullback path when atrPct ≤ 6%. Do not present
   Style-1 zones for an ATR-hot stock except that single bottom point, and label it
   "只在買區下緣進".

   **6n. Stop-execution accountability — an unexecuted stop is theater (added
   2026-07-08).** In June 2026 a stop-breach exit was re-recommended for ~13
   consecutive sessions while the position bled to −20%; the system repeated itself
   daily with no escalation path. Rule: when a stop-breach exit recommendation goes
   **unexecuted for 2+ sessions**, the analysis must force a binary decision and
   accept no third option:
   - **Execute** — record the exit via Action B, or
   - **Re-underwrite** — the user consciously keeps the position: record in the
     ledger "決定續抱 + 理由 + 新停損/退場計畫" (via Eliot), set the old stop marker
     `--status invalidated` with the re-underwrite as `--outcome`, and assert the new
     stop marker. The position is then judged against the NEW plan, not nagged about
     the old one.
   Until one of the two happens, every analysis leads with the 持股警報 pinned at
   top, counting the sessions since breach ("破停損第 N 日"). A stop that neither
   fires nor is consciously re-underwritten protects nothing.

   **6o. Every position must carry a thesis (added 2026-07-08).** A prospective
   thesis note is created at Action B buy time and re-scored with a numeric health
   score at every Action C review — the reactive post-mortem habit becomes a
   prospective discipline. Falsifiable core assumptions get a 🟢/🟡/🔴/⚫ status each
   review; red lines (the ATR stop breach is always one) pre-commit the action that
   Rule 6n enforces, so an exit-or-re-underwrite decision is a lookup, not a fresh
   argument. Full template, health-score formula, action mapping, and drift
   classification are in `references/thesis-tracking.md` — read it before Action B's
   thesis step and Action C's re-score step.

   **6p. 鏡子測試 — 說不完整就不進場 (added 2026-07-08).** Rules 6b–6o are all veto
   gates — they can only say no. This is the affirmative half: before any stock is
   presented as a buy (not a watchlist item), complete a 5-sentence mirror test.
   A completed test is documented conviction; an incomplete one demotes the pick to
   觀察名單, never a buy.

   1. 進場型態與觸發:「這是 Style-<1|2|3> <型態>，觸發條件是 <trigger/base>，量能
      <X>× 5日均量」
   2. 買區與停損:「買區 <lo–hi>（錨定 <technical level>），停損 <price>（<style 依
      6a-1>，−<X>%）」
   3. 失效條件:「如果 <condition，e.g. 收回跌破 pivot / 反轉日低點>，論點死亡，無條件
      出場」
   4. 部位與熱度:「<shares> 股（1% 風險），同主題合計熱度 <X>%（上限 2%）」
   5. 最壞情況:「停損打到虧 <NTD>（<X>% of equity），我接受」

   Rules:
   - Sentences 2/4/5 quote `screen.mjs` trade-plan JSON values verbatim — no
     hand-math, same discipline as step 7.
   - **Positive-gate-only clause**: this test runs AFTER 6b/6h/6i/6j and the R:R
     check have passed; it may NOT re-veto a condition those gates already
     cleared. It fails a candidate only when a sentence's element is missing or
     unstatable — e.g. a Style-2 candidate with no recognizable base has sentence
     1 unstatable → 觀察名單, even though RSI/KD/volume all passed. The missing
     base fails it, not a re-judgment of the technicals that already cleared.
   - Failure output: "鏡子測試未過：缺 <element> → 轉觀察名單" plus a concrete
     trigger condition with its validity band (6l).
   - Equity absent: state sentences 4–5 in 1R-per-share + percentage terms,
     flagged "提供 account_equity 後換算股數" — the test still passes. An
     unprovided equity is a user-input gap, not a market fact that can fail it.
   - ATR provisional (thin DB, 6a fallback): sentence 2 carries the provisional
     flag — the test still passes.

   Why: the veto gates (6b–6o) prevent bad entries; the mirror test proves a
   good one — it is the counterweight that turns "nothing vetoed it" into
   "here is the complete case".

   **6q. 資料充足度分級 (A/B/C) — 沒有資料就沒有訊號 (added 2026-07-08).** Before
   analyzing any candidate, rate its data availability from five named checks. This
   generalizes 6a's provisional-ATR fallback (a B-level precedent) into a
   system-wide honesty rule: thin Taiwan small caps and sparse ETF constituents
   should get an honest "no signal" instead of a forced recommendation or a fake
   gate failure.

   1. **本地 OHLC 歷史深度** — ≥60 sessions = 全指標可信；14–59 = 部分（ATR 可用但
      趨勢指標弱）；<14 = 不足。
   2. **即時報價可得**。
   3. **技術指標可算**（`screen.mjs` 能跑，不 hard-error）。
   4. **事件日可查**（財報日 6h、除權息日 6i）。
   5. **流動性**（成交量夠大，停損才有意義 — 5日均量過低者標 C）。

   **Rating**:
   - **A** = 全過 → 正常分析。
   - **B** = 非關鍵缺口 → 照常分析但逐項點名缺口、偏保守（6a 的 provisional-ATR 即
     B 級先例）。
   - **C** = 關鍵缺口 → 「資料不足，不給訊號」。

   **先補再降級**: thin local history → 先跑 `fetch-history.mjs <code> --months N`
   （上櫃加 `--market tpex`）再評級；**C 只在缺口撐過補抓之後才成立**（新上市、極端
   冷門、來源不可達）。絕不用未補抓的資料直接判 C。

   **C 級輸出規格**: 排除在推薦之外，歸類到獨立的「資料不足」類別 — **不與技術面
   gate failure 混列**（這個區分讓 audit trail 誠實：gate 沒有說話，是因為它無法
   判斷，而不是判斷後說不）；必須附具體升級路徑（「另補 N 個交易日後重評」/「補
   財報日後重評」）。**非懲罰性**：C 判定是完整答案；絕不為了湊滿 N 檔而灌水
   （呼應 Action A step 6 的 no-padding 規則）。

   **Worked examples**:
   - 新上市股，補抓歷史後僅剩 8 個交易日 → **C**，「資料不足，另補 6+ 個交易日後
     重評」，不進推薦清單也不算技術面未過關。
   - 對照：3037 有 4 個月本地歷史，但查不到法說日 → **B**（歷史深度過關，僅事件
     日缺口，屬非關鍵）；分析照常進行，點名 6h 缺口 + 「財報日未確認，事件風險未
     濾」但書。

   Why: forcing a signal out of missing data is how thin small caps turn into
   unbounded risk — an unverifiable earnings date defeats 6h, an uncomputable ATR
   defeats 6a, and thin volume defeats the stop itself.

---

## Action A — ETF common-holdings analysis & recommendation

Triggered by: "0050 跟 0052 共同持股", "推薦我買哪一檔", "哪一檔個股推薦購買". The user
names two (or more) ETFs and wants overlapping holdings plus a reasoned pick.

1. **Fetch full holdings for each ETF from the official 投信 site** (not Yahoo).
   See `references/data-sources.md` for the URL per ETF and the exact
   `agent-browser` extraction recipe (the tables are div-based — read `innerText`
   around a known holding, don't rely on `querySelectorAll('table')`). 權重與官網差
   >1% 依 3a 標註 (if Yahoo's weight for the same holding is ever consulted and
   disagrees with the 官網 by more than 1%, flag per Rule 3a and use the 官網 value).

2. **Compute the intersection** by stock code. Build a table of common holdings with
   each ETF's weight side by side, sorted by weight. Note which large holdings are
   *not* shared (e.g. 0050's financials/traditionals that a pure-tech ETF lacks) — it
   explains the overlap's character.

3. **Market condition gate (Rule 6f).** Before shortlisting, fetch the TAIEX
   (加權指數 `^TWII`) quote and its 50-day/200-day MA from Histock or Yahoo. If
   TAIEX is below its 200-day MA, stop here — recommend cash, do not proceed to
   stock selection. If below 50-day MA, flag reduced exposure and halve the theme
   heat cap for all subsequent sizing calculations.

3.5. **Load prior context — watchlist & holdings.**
   This step bridges consecutive analysis sessions so tracking is continuous.

   a. **Read the most recent analysis note.** Search Obsidian for the latest stock
      analysis note: `obsidian search query="tags: stock, analysis" path="Eliot/Notes"
      format=json limit=1`. Read that note and extract:
      - **觀察名單 (watchlist)**: stock codes + their trigger conditions (e.g. "欣興：
        等 KD 黃金交叉 + 站回 20MA")
      - **Previous recommendation**: what was recommended last time and at what levels
      If no prior note exists, skip — this is the first analysis.

   b. **Read the holdings ledger.** `obsidian read
      path="Eliot/Notes/2026/stock-holdings.md"` to get `## 持有中` positions. For
      each held stock, note code/name/cost/stop/TP. These holdings will be checked
      against live data in step 5 alongside the candidates — if any holding has
      breached its stop, surface it as a **持股警報** at the top of the output (before
      the ETF analysis), since stop-loss discipline is more urgent than new picks.

   c. **Evaluate watchlist trigger conditions.** For each watchlist item, its trigger
      condition will be checked during step 5's technical fetch. If a previously
      flagged stock now meets its entry condition (e.g. KD golden cross has formed,
      price has pulled back to 20MA), **promote it to the candidate list** in step 4
      with a note: "前次觀察名單標的，進場條件已成立". If the condition is still not met,
      carry it forward to this session's watchlist with updated technicals.

   d. **Present continuity summary** (brief, before the main analysis):
      - "前次分析 (YYYY-MM-DD): 推薦 X，觀察 Y/Z"
      - "持有中: A (@cost), B (@cost)"
      - "觀察名單進場條件檢查: 見 step 5"

4. **Shortlist candidates (pre-technical screen).** Identify 4–6 candidate stocks
   from the intersection based on weight, theme, and structural story. Same-theme
   concentration is allowed (Rule 6e) — do NOT force cross-sector picks. But flag
   which candidates share the same supply chain so correlation-adjusted sizing
   applies later. **Additionally, include any watchlist stocks from step 3.5 whose
   trigger conditions will be evaluated in step 5** — they get priority since the
   user is already tracking them.

5. **Screen EVERY candidate + held stocks + watchlist — BEFORE recommending.** The
   list includes: (a) new candidates from step 4, (b) currently held stocks from
   step 3.5b, (c) watchlist stocks from step 3.5c.

   **The numbers come from the script, not from hand-math or Histock scraping.**
   First top up history (`fetch-history.mjs <code> --months 1` per stock), then run
   `node --experimental-sqlite scripts/screen.mjs <code1> <code2> …` (all codes in
   one call; CLI + JSON glossary in `references/charting.md` §9). **This top-up-then-
   screen order is also when the Rule 6q 資料充足度分級 (A/B/C) is computed** — rate
   each stock from the five named checks only AFTER this fetch, never before
   (fetch-before-downgrade). It computes, per
   stock, from the local OHLC DB: OHLC/chg%, MA5/10/20, 20MA deviation,
   aboveMA20Streak, **ATR14 (Rule 6a)**, 量/5日均量 ratio (**Rule 6j**), K9/D9,
   RSI6/12, MACD (DIF/signal/OSC), the derived signal booleans (KD 金叉/死叉, MACD
   rising, 過熱, 勿追高…), and the **Rule 6b gate verdicts** (`gate.style1.pass` +
   `failures[]`, `gate.style2Partial`). KD/RSI match Histock exactly; only fetch
   Histock as a **spot-check** when the script sets `gate.histockSpotCheck: true`
   (a reading within ±3 of a threshold, per 3a) or the DB has too little history.

   Still fetched from the web (not computable from the DB): the Yahoo live quote
   (the DB close is the last settled session — T-1 during market hours), **the next
   earnings/法說 date (Rule 6h), and the ex-dividend 除權息 date (Rule 6i)** —
   recipes in `references/data-sources.md`. This step is mandatory — a stock cannot
   enter the recommendation list without passing the technical entry gate (Rule 6b)
   AND the event gate (Rules 6h, 6i):
   - RSI6 > 70 → **exclude** (overbought)
   - KD K9 > 80 → **exclude** (overbought zone)
   - Price > 20MA by more than 10% → **flag** "已過熱，等拉回再議"
   - KD 死亡交叉 (K < D, both declining) → **flag** "動能偏弱，等 KD 黃金交叉"
   - Intraday gain > 3% → **flag** "勿追高，等下一交易日" (Rule 6c)
   - Next earnings ≤ 5 trading days away → **exclude** "財報前，等財報後再議" (Rule 6h)
   - On/just after ex-dividend date → **do not treat the 除息 drop as a breakdown**;
     restore the dividend before judging support, and adjust 停損 down by the
     dividend amount (Rule 6i)
   - A "站回 / 突破 / 進場條件成立" signal with 當日量 ≤ 5 日均量 → **downgrade** to
     "量縮，待確認"; do not promote on that basis alone (Rule 6j)

   **For held stocks**: compare live price against recorded 停損 and 停利. If any
   holding has breached its stop (live ≤ 停損), flag it as **持股警報** and present
   it at the top of the output with full technical context, counting the sessions
   since breach ("破停損第 N 日"). At N ≥ 2 apply Rule 6n: force the binary —
   execute the exit (Action B) or re-underwrite in the ledger; do not just repeat
   the recommendation a 3rd time.

   **For watchlist stocks**: compare current technicals against the prior analysis's
   trigger conditions **and each condition's validity band (Rule 6l)**. Report each as:
   - "✅ 進場條件已成立" — fired inside its band → promote to recommendation candidates
   - "⚠️ 遲到觸發" — condition met but price beyond the band → do NOT promote as a
     buy at market; rewrite the trigger this session (6l), or qualify it under
     Style-2/Style-3 on its own merits
   - "⏳ 條件未成立，持續觀察" — carry forward with updated values
   Present a separate **觀察名單追蹤** table showing prior condition → current
   status for each watchlist item.

   Present a technical screening table for all new candidates showing pass/fail so
   the user sees why certain stocks were excluded. Include columns for **量/5日均量
   (Rule 6j)**, **下次財報日 (Rule 6h)**, **除權息日 (Rule 6i)**, and **資料級
   (Rule 6q, A/B/C)** alongside the technical indicators, so event, volume, and
   data-richness exclusions are visible in the same table. **List C-rated
   candidates separately in their own 「資料不足」bucket** with the upgrade path
   stated — do not fold them into the pass/fail gate rows; the distinction keeps
   the audit trail honest (the gate said nothing because it could not, per 6q).

6. **Recommend stock(s) from the candidates that passed.** For each pick explain
   *why* (weight rank, structural theme, what it does, technical posture) and briefly
   *why not* the obvious alternatives. If the user asks for N picks but fewer than N
   pass the screen, say so — never pad the list with stocks that failed the gate.
   State "資料不足 X 檔" alongside "未過關 Y 檔" so the user sees why the list is
   short — C-rated candidates (Rule 6q) never count toward N picks, same
   non-padding discipline.

7. **Entry/exit plan (mandatory for every recommendation).** Pick the stop regime
   per 6a-1 *before* computing R:R — style determines stop width, stop width
   determines 1R, 1R determines the verdict. **All numbers in this step come from
   the script**: `node --experimental-sqlite scripts/screen.mjs <code> --style 1|2|3
   --zone LO-HI [--pivot P] [--revlow L] [--target T] [--equity E]` returns stop,
   TP1/TP2, 1R, R:R verdict, and share sizing in one JSON. The model supplies the
   judgment inputs (style, buy zone, breakout pivot / reversal-day low,
   measured-move target) and MUST NOT hand-compute stop/TP/R:R/shares — hand-math
   caused both paralysis bugs. The script hard-errors on Style-2 without `--pivot`
   and Style-3 without `--revlow` (no silent 2×ATR fallback). If the stock is
   ATR-hot (`atrHot: true`), lead with the Rule 6m regime statement.
   For each recommended stock:

   a. **Buy zone**: anchor to a real technical level. For a **Style-1 pullback** buy
      (6b) that's the 20MA / consolidation floor / key support. For a **Style-2
      breakout** buy that's the **breakout pivot up to +2~3% above it** (you buy the
      breakout, not a lower pullback). For a **Style-3 reversal** buy it's the
      reversal-day close up to +1% above it. State which style and which level, and
      why. Never use "spot price minus X%". A Style-2/Style-3 buy zone legitimately
      includes today's price when a volume-confirmed base breakout / base reversal is
      in progress (6c does not block either).

   b. **Stop loss** — per the 6a-1 regime table. For a **Style-1 pullback**:
      `buy_zone_bottom − max(2 × ATR14, buy_zone_bottom × 0.05)`, with **ATR14**
      computed from the local OHLC DB (Rule 6a), not a single session's range.
      For a **Style-2 breakout**: the structural stop **just under the breakout
      pivot (base top / reclaimed high)**, honoring the 5% floor below entry —
      do NOT use the base low and do NOT use 2×ATR14; both belong to Style-1
      (mis-applying them was the 2026-07-03 bug). Always express as both a price
      and the % below buy zone bottom. If tighter than 5%, widen to the 5% floor.

   c. **Staged take-profit** (Rule 6d):
      - TP1: +8% from buy zone midpoint → scale out ½, move stop to breakeven
      - TP2: +15% → scale out remainder or trail with 5MA
      Express both as prices.

   d. **Risk/reward summary — measure reward against TP2/trend, NOT TP1.** TP1 (+8%)
      is a *partial de-risk scale-out*, not the reward leg — with a 2×ATR14 stop it is
      typically only ~0.5R, so a "R:R to TP1 ≥ 1.5" test is mathematically unsatisfiable
      for volatile semis and was a paralysis bug (2026-07). Instead: express risk in
      **R** (`1R = entry − stop`), and judge viability by the R:R to the **reward
      target** = TP2 (+15%) or a measured-move / prior-swing-high target, whichever the
      structure supports. Require **R:R to the reward target ≥ 1:1.5**; TP1 is reported
      separately as the point where you take half off and move to breakeven (de-risk),
      not as the reward. If even the reward-target R:R < 1.5, *then* flag/pass.
      **Before flagging/passing on R:R < 1.5, audit the stop width against 6a-1**:
      if a Style-2 candidate was computed with a 2×ATR stop (or a stop anchored to
      the base low), recompute with the structural pivot stop first. A failed R:R
      with a mismatched stop regime is not a signal — it is the bug.

   e. **Position sizing (Rule 6e-2, 6e-3).** For each stock, calculate:
      `shares = (account_equity × 0.01) / (entry − stop)`.
      If multiple picks share the same supply chain, apply the per-theme heat cap
      (2% combined, or 1% if TAIEX < 50-day MA). Show the user: per-position risk
      in dollars, total theme heat, and the combined exposure warning (Rule 6e-6).

   f. **Entry protocol (Rule 6e-5).** State: "先買 50% 部位（試單），確認站穩
      2 個交易日後再加碼剩餘 50%。試單觸停損則不加碼，全部出場。"

   g. **Mirror test (Rule 6p).** For every recommended stock, complete all 5
      sentences and list them; missing any sentence demotes that stock to
      觀察名單 with its trigger condition and validity band (6l) instead of a
      buy. Sentences 1–3 draw on this step's 7a–b judgment (style, buy zone,
      invalidation); sentences 4–5 draw on the 7e sizing output (shares, theme
      heat, worst-case loss).

8. **Theme-level stop disclosure (Rule 6e-4).** If recommending 2+ stocks from the
   same theme, include a theme stop table:
   - 合計虧損 −10%: 減半（賣最弱一檔）
   - 合計虧損 −15%: 僅留最強一檔
   - 合計虧損 −20%: 全部出場，等待重新進場條件

9. **Offer to persist** the analysis via Eliot (stock note + `[[stock]]` log). Don't
   write without the user's go-ahead. The persisted note's 結論／推薦 section MUST
   carry each recommended pick's completed 5-sentence mirror test (Rule 6p)
   verbatim — this is what Action B's thesis draft (Rule 6o /
   `references/thesis-tracking.md`) seeds 進場論點 from. The note MUST also include a
   `### 觀察名單` section listing each watchlist stock with its specific trigger
   condition — this is what step 3.5 reads in the next session. Format each entry
   as: `- <code> <name>：<trigger condition>（有效帶 <lo>-<hi>）` — the validity band
   is mandatory per Rule 6l (anchor +2%; breakout pivot +2~3%; reversal close +1%).
   E.g. `- 3037 欣興：等 KD 黃金交叉 + 站回 20MA(948)（有效帶 948-967）`. A condition
   that fires with price beyond its band is a late fire → rewrite, not a buy.

10. **Mirror to SQLite (structured layer, after the Eliot write).** Once the user approves
    the persist, also record the structured side so charts stay current (Rule 5; mechanics in
    `references/charting.md`). For each recommended pick and each watchlist entry, add a marker:
    - each watchlist entry → a forward **signal** so its trigger shows on the chart as a flagged
      threshold line: `add-marker.mjs <code> <date> signal <trigger-level> "進場觀察：<name>" "[[<note-slug>]]" --status pending --condition "<the exact trigger, e.g. 站回 20MA(4329) 連 2 日 + KD 金叉>"`.
      When a trigger fires, re-assert with `--status met`. A recommended position adds `buy`
      (`--status open`) plus `stop`/`target` markers at the planned levels with their `--condition`.
    - top up price history for every stock you charted/analyzed:
      `fetch-history.mjs <code> --months 1` (cheap — only the current month re-fetches).
    This is best-effort and silent; never block the analysis on it. If Node/DB is unavailable,
    skip and mention it.

---

## Action B — Record a trade to the holdings ledger

Triggered by: "我買了 <股號/股名> <股數> @<價>", "賣出 <股號> 一半 @<價>". The user is
reporting an actual transaction.

1. Parse: date (default today), action (買/賣), code, name, shares, fill price.
2. Pull 停損/停利 from the most recent analysis note for that stock if available;
   otherwise leave blank or ask. The 停損 in the analysis should already be
   calculated per Rule 6a (from buy zone, ATR-based). Carry it over as-is.
3. **Validate the entry** (for buys only):
   a. If the fill price sits outside the analysis's suggested buy zone, mention it
      with the deviation ("進場價高於建議買區上緣 X 元").
   b. If the stock was flagged "勿追高" in the most recent analysis and the fill
      date matches the flag date, warn: "此標的當日分析標註勿追高。"
   c. If the stock was NOT in the recommendation list at all (user self-selected),
      note: "此標的未在近期分析推薦清單中，建議先執行完整分析再進場。"
   These are informational warnings, not blocks — the user has already traded. But
   surfacing them builds awareness for next time.
4. **Delegate the write to Eliot**: append one transaction row and update the
   `## 持有中` position summary (cost average, total cost). Log a one-liner to
   `[[stock]]`. The exact ledger format is in `references/obsidian-tracking.md`.
5. **Draft/update the thesis (Rule 6o)** and persist it via Eliot alongside the
   ledger write — template and rules in `references/thesis-tracking.md`.
   - **New position (no open thesis for this code)**: draft a new thesis note,
     seeded from the latest analysis note when one covers this stock. If the stock
     is **not** in any recent recommendation list (self-selected), draft the thesis
     from the user's own stated reasoning instead and flag "自選標的，無事前分析" —
     the full template (assumptions, red lines, stop/invalidation) is still required.
   - **Add to an existing position**: update the SAME thesis file with the add (new
     進場紀錄 row) — do not create a second thesis file for the same open position.
   - **Sell that brings shares to zero**: close the thesis — append the outcome
     section (exit price, R-multiple, which assumptions proved right/wrong) per
     `references/thesis-tracking.md` §5. A later re-entry gets a NEW thesis file.
6. **Mirror the trade to SQLite** so the chart shows the real fill (Rule 5):
   `add-marker.mjs <code> <date> <買=buy|賣=sell> <fill> "<備註>"`. On a buy, also assert the
   `stop`/`target` markers at the recorded levels. Then `fetch-history.mjs <code> --months 1`
   to top up price history. Best-effort; don't block on it.

---

## Action C — Check current holdings & suggest selling

Triggered by: "檢查我的持股", "我現在該賣什麼", "review my holdings", "should I sell
anything", or a direct move question about a held stock ("XX 為什麼跌/漲"). This is the
action that closes the loop: read what the user owns, get fresh data, and produce a
per-holding sell recommendation.

1. **Read the ledger.** Get the `## 持有中` positions from the holdings ledger (read
   is lightweight — `obsidian read path="Eliot/Notes/2026/stock-holdings.md"`, or ask
   Eliot). For each position you need: code, name, shares, cost average, recorded 停損
   and 停利 target.

2. **Fetch fresh data per holding:**
   - **Live quote** from Yahoo (price recipe in `references/data-sources.md`).
     **Plausibility bound (Rule 3a) before it feeds the stop/TP comparison in
     step 5**: if the live quote deviates > 10% from the last settled DB close,
     treat it as a suspect fetch (wrong ticker/stale page/parse error) and
     re-fetch rather than compare against 停損/停利 — a parse error must not fake
     a stop breach.
   - **Current ETF membership & weight**: re-fetch the relevant ETF holdings from the
     官網 and check whether the stock is still a constituent and at what weight.
   - **Technical indicators** from Histock (recipe in `references/data-sources.md`):
     MA5/10/20, K9, D9, RSI6, RSI12, MACD. These are daily-close values (T-1 during
     market hours).
   - **Data-richness rating (Rule 6q)**: rate the holding for context only — a C
     rating flags its indicators as unreliable but never skips the 停損/停利-vs-live-
     quote comparison in step 5; a held position is never skipped for data thinness.

3. **異動歸因 (move attribution) — trigger-gated, not run per-holding by default.**
   This answers the review's real question: did the move break the setup, or is it
   noise? Only run it when triggered; an untriggered holding's review-table row alone
   is sufficient — do not spend a news search on every holding.

   **Trigger gate** (any one fires it):
   - **|當日漲跌| ≥ 3%**
   - **Live price within 1% of, or through, the recorded 停損**
   - **User asked directly** ("XX 為什麼跌/漲")

   **Ordered checks — short-circuit on the first hit:**
   1. **機械性 (除權息, Rule 6i).** If the move is wholly explained by 除息, stop
      here — do NOT issue a 情緒・雜訊 verdict (a mechanical gap is not sentiment).
      State "除息機械性缺口，非賣壓" and skip the remaining checks; no news search runs.
   2. **大盤 (TAIEX 同日漲跌%).** If the whole market moved, produce ONE market-level
      attribution and continue per-stock only for holdings whose move materially
      exceeds the index (rough guide: beyond TAIEX% + 2pp). On a broad-market day this
      keeps the output to one market read plus outliers, not N repeated stories.
   3. **同主題 (same supply-chain peers, per 6e-1).** If peers moved together, it's
      theme-wide, not stock-specific — say so, and narrow to what's different about
      this name if anything is.
   4. **個股新聞 (company news / 重大訊息).** Check for a company-specific cause —
      recipes in `references/data-sources.md` §個股新聞查證. Best-effort: a failed
      fetch yields 原因不明, never an invented cause.

   **Mandatory verdict — exactly one** (for any holding that reaches check 2 or
   beyond; the mechanical short-circuit in check 1 replaces it with the statement
   above, not one of these four):
   - **價值事件** — a citable dated source (headline/announcement + date) explains the
     move. No source → cannot claim this verdict; fall back to 原因不明 or 情緒・雜訊.
   - **情緒・雜訊** — price moved on sentiment/flow, not a fact change.
   - **原因不明** — nothing material found. This is a **valid, non-penalized** output,
     not a failure — flag it: "最危險的結論 — 可能有未公開資訊在跑，收緊注意力，停損
     紀律不變".
   - **混合** — part fact, part noise; the value component still needs its own
     citable source.

   **Output per triggered holding**: 2–4 timeline bullets (🔴 主因 / 🟡 次因 / ⚪ 背景)
   + the verdict + the implication line:
   - 價值事件 (or the value half of 混合) → "檢查 thesis 假設（事實變化）— 見 Rule 6o 複審"
   - 情緒・雜訊 → "技術面規則照舊（drift: 僅價格變化）"
   - 原因不明 → the danger flag above

   **Precedence: no verdict suspends a stop.** A stop breach still routes through the
   持股警報/Rule 6n path regardless of verdict — the verdict may inform the
   re-underwrite reasoning in step 6, never defer the binary.

   **Worked example**: a holding is −4.2% on a session where TAIEX is −0.5% (not a
   market-wide day), no 除息 pending, theme peers flat, and one dated 重大訊息 (a
   customer order cut, announced same morning) is found → verdict **價值事件** with
   the citation → implication "檢查 thesis 假設（事實變化）— 見 Rule 6o 複審".

4. **Evaluate technical signals per holding** (supplement the fundamental sell signals):
   | Signal | Condition | Interpretation |
   |---|---|---|
   | 均線空頭排列 | price < MA5 < MA10 | short-term downtrend, caution |
   | 均線多頭排列 | price > MA5 > MA10 > MA20 | uptrend intact, support valid |
   | KD 死亡交叉 | K < D and both declining | bearish momentum |
   | KD 黃金交叉 | K > D and both rising | bullish momentum |
   | KD 超買 | K9 > 80 | overbought — consider scaling out |
   | KD 超賣 | K9 < 20 | oversold — possible bounce, but respect stops |
   | RSI 偏弱 | RSI6 < 40 | selling pressure dominant |
   | RSI 偏強 | RSI6 > 70 | buying pressure dominant |
   | MACD 正轉負 | MACD crossing below 0 | medium-term trend weakening |

   Technical signals alone are not sell triggers — they add context to the fundamental
   sell signals below. E.g. "停損 approaching + KD death cross + RSI weak" strengthens
   the case for exit, while "near 停損 but KD golden cross" suggests watching one more
   session.

5. **Evaluate all four fundamental sell signals per holding:**
   | Signal | Condition | Suggestion |
   |---|---|---|
   | 停損觸價 | live ≤ recorded 停損 | **停損出場** — discipline, exit |
   | 停利觸價 | live ≥ 停利 target | **分批停利** — scale out, let rest run if trend intact |
   | 跌出 ETF 成分 | no longer in 0050/0052 holdings | **留意/考慮減碼** — weakened fundamentals signal |
   | 權重明顯下降 | ETF weight well below the level recorded at buy | **留意** — losing index conviction |
   | 報酬率檢視 | report unrealized P/L % from cost regardless | context for the above |

6. **Thesis health re-score (Rule 6o).** For each holding, read its thesis note
   (`Eliot/Notes/<YYYY>/thesis/<code>-*.md`) and run the health re-score + drift
   check per `references/thesis-tracking.md` §2–4: mark every core assumption
   🟢/🟡/🔴/⚫, check every red line, compute
   `health = 10 − 3×⚫ − 2×🔴 − 1×🟡 − 5×(red lines triggered)` **showing the count
   breakdown**, classify each change as 事實/價格/措辭 drift with cited evidence, and
   map the score to an action (§3: ≥9 hold/add · 7–8 hold · 4–6 reduce · ≤3 or any
   red line → Rule 6n binary). A triggered red line forces the 6n binary regardless
   of score — it does not get softened by an otherwise-healthy score. Append the
   re-score to the thesis's 複審紀錄 log. **Holding with no thesis file**: flag
   "無 thesis 紀錄", offer to draft one retroactively (seeded from the ledger/analysis
   context), and continue this review using the ledger's recorded 停損/停利 — do not
   block the review on the missing thesis.

7. **Present a holdings review table**: code · name · cost · live price · 報酬率% ·
   技術面摘要 · 每個訊號狀態 · **異動歸因** (verdict icon/short verdict for triggered
   holdings, "—" for untriggered) · **論點健康度** (score + mapped action, or "無 thesis
   紀錄") · 建議 (續抱 / 分批停利 / 停損出場 / 留意減碼). Lead with anything actionable
   (停損/停利 hits, or a triggered thesis red line) at the top. Include a per-holding
   technical summary row (MA position, KD state, RSI level) so the user sees the
   full picture.

8. **Offer to update the ledger via Eliot** if the user acts on a suggestion (record
   the sell, update 持有中). Don't write unprompted.

9. Close with the disclaimer line.

---

## Action D — Draw a K-line chart marking buy/sell/hold reasons

Triggered by: "畫 K 線", "畫個 K 線圖", "把買賣點/進出場標在圖上", "show me the chart for
2330", "candlestick", "K-line", "視覺化我的持股", "畫出奇鋐走勢". The user wants to *see* a
stock's price action with the decisions (and their reasons) marked on it.

This action is **code-driven, not browser-driven**: it renders a self-contained Tokyo-Night
candlestick HTML file from a local SQLite DB (OHLC history + decision markers). All scripts are
zero-dependency Node — run each with `node --experimental-sqlite <skill>/scripts/<name>.mjs …`.
Read `references/charting.md` once at the start of this action — it has the DB schema, the
TWSE 民國-date gotcha, and the exact CLI for every step.

1. **Resolve the target stock(s).** A code/name from the prompt, or "my holdings" → read the
   `## 持有中` ledger (Action C step 1) and chart each. Default lookback 60 trading days (`--days`).

2. **Ensure the DB exists and history is fresh.**
   - `scripts/db.mjs --init` is implicit (every script auto-creates the schema).
   - `scripts/fetch-history.mjs <code> --months 4` (TWSE 上市; add `--market tpex` for 上櫃).
     Only missing months are fetched, and the current month always tops up — cheap to re-run.

3. **Make sure the buy/sell/hold "why" markers exist.** The chart is only as good as its markers.
   - **First time / sparse DB**: run `scripts/seed-from-obsidian.mjs` once to import the holdings
     ledger (買/賣 + 停損/停利) and the latest analysis note's `### 觀察名單` into markers.
   - **Otherwise**: markers accrue automatically from Action A step 10 and Action B step 6. Add
     ad-hoc ones with `scripts/add-marker.mjs <code> <date> <action> [price] [reason] [note_link]`
     (action ∈ buy|sell|hold|watch|stop|target). Keep the reason short — it is the chart tooltip;
     the full rationale lives in the Obsidian note (pass its `[[slug]]` as note_link).

4. **Render and open.** `scripts/render-chart.mjs <code> --days 60` writes
   `…\personal\stocks\charts\<code>-<YYYYMMDD>.html`. Open it for the user (`start <path>`), or
   `agent-browser open file:///<path>` + `screenshot` if you want to verify it headless. **If the
   user reports the file looks blank**, open it **headed** (`agent-browser open --headed file:///<path>`)
   so it renders in a visible window. The chart shows 紅漲綠跌 candles, MA5/10/20, volume, dashed
   停損/停利 lines, ⚑ **signal** threshold lines (amber=待觸發, green=已成立) for forward triggers,
   and pin markers (▲買 ▼賣 ◆續抱) whose hover tooltip shows reason + status + outcome + note link.
   Below the chart is the **決策與訊號紀錄** review panel — every decision/signal with its level,
   distance-to-current-price, condition, and outcome — so the chart doubles as a post-mortem reference.

5. **Summarize what the chart shows** in chat (don't just hand over a file): the trend, where the
   marked decisions sit relative to the moving averages, **which forward signals are closest to
   firing** (smallest 距現價 in the review panel), and whether any 停損/停利 line is close to the
   latest close. Charts are per-stock; for "my holdings" render one per held position. Close with
   the disclaimer line (Rule 4).

---

## Mechanics & gotchas

- `agent-browser`: `open` → `wait 3500` (a fixed wait — Yahoo's `--load networkidle`
  often hangs on ad/JS activity) → extract via `eval --stdin` heredoc → `close` when
  done. Full recipes and the exact selectors/text-anchors are in
  `references/data-sources.md`.
- Read that reference file at the start of Actions A and C — it has the per-site
  extraction code that is easy to get wrong (div-based tables, stale-data traps).
- Read `references/obsidian-tracking.md` before any persist step so the note and
  ledger formats match the user's existing vault conventions.
- Read `references/charting.md` before Action D (or the SQLite mirror steps in A/B) — it
  has the DB path resolution, the TWSE 民國-date (+1911) gotcha, the marker glyph/colour map,
  and every script's exact CLI. The charting scripts are zero-dependency Node (built-in
  `node:sqlite` + global `fetch`); always invoke with `node --experimental-sqlite`.
- `scripts/screen.mjs` is the **rule-math engine** (Action A steps 5 & 7): screening mode
  computes indicators + Rule 6b gate verdicts from the local DB; trade-plan mode
  (`--style/--zone/--pivot/--target/--equity`) computes the 6a-1 stop, TP1/TP2, R:R
  verdict, and 6e-2 sizing. The model never hand-computes these numbers. CLI + JSON
  glossary in `references/charting.md` §9.
