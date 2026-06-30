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

   **6a. Stop loss is calculated from the buy zone, not the spot price.**
   The stop loss must give adequate room *below the entry the user is told to wait
   for*. Formula: `stop_loss = buy_zone_bottom − max(2 × daily_range, buy_zone_bottom × 0.05)`.
   `daily_range` = Histock's latest `最高 − 最低` for that stock (fetched during
   Action A, not just Action C). This ensures the stop accommodates the stock's
   actual volatility instead of using a fixed -10% from an arbitrary reference price.

   **6b. Technical entry gate — must pass BEFORE recommending.**
   Every candidate stock must have its Histock technicals fetched and evaluated
   *before* it enters the recommendation list. A stock that fails any of these is
   excluded or flagged "等待進場條件成立":
   - RSI6 > 70 → overbought, do not recommend entry
   - KD K9 > 80 → overbought zone
   - Price far above 20MA (> 10%) → extended, wait for pullback
   - KD 死亡交叉 (K < D and declining) → bearish momentum, wait

   **6c. No-chase rule.**
   If a stock is already up > 3% intraday at the time of analysis, mark it "勿追高，
   等下一交易日" and do NOT include it in the buy zone — give the buy zone for a
   future pullback scenario only. Never set a buy zone that includes today's price
   when the stock is rallying.

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

---

## Action A — ETF common-holdings analysis & recommendation

Triggered by: "0050 跟 0052 共同持股", "推薦我買哪一檔", "哪一檔個股推薦購買". The user
names two (or more) ETFs and wants overlapping holdings plus a reasoned pick.

1. **Fetch full holdings for each ETF from the official 投信 site** (not Yahoo).
   See `references/data-sources.md` for the URL per ETF and the exact
   `agent-browser` extraction recipe (the tables are div-based — read `innerText`
   around a known holding, don't rely on `querySelectorAll('table')`).

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

5. **Fetch technicals for EVERY candidate + held stocks + watchlist — BEFORE
   recommending.** The fetch list includes: (a) new candidates from step 4,
   (b) currently held stocks from step 3.5b, (c) watchlist stocks from step 3.5c.

   For each stock, fetch Histock data (recipe in `references/data-sources.md`) to
   get: MA5/10/20, K9, D9, RSI6, RSI12, MACD, the day's OHLC (for daily_range
   = 最高 − 最低), **the day's volume and 5-day average volume (for Rule 6j)**. Also
   fetch the Yahoo live quote, **the next earnings/法說 date (Rule 6h), and the
   ex-dividend 除權息 date (Rule 6i)** — recipes for all of these in
   `references/data-sources.md`. This step is mandatory — a stock cannot enter the
   recommendation list without passing the technical entry gate (Rule 6b) AND the
   event gate (Rules 6h, 6i):
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
   it at the top of the output with full technical context.

   **For watchlist stocks**: compare current technicals against the prior analysis's
   trigger conditions. Report each as:
   - "✅ 進場條件已成立" — promote to recommendation candidates
   - "⏳ 條件未成立，持續觀察" — carry forward with updated values
   Present a separate **觀察名單追蹤** table showing prior condition → current
   status for each watchlist item.

   Present a technical screening table for all new candidates showing pass/fail so
   the user sees why certain stocks were excluded. Include columns for **量/5日均量
   (Rule 6j)**, **下次財報日 (Rule 6h)**, and **除權息日 (Rule 6i)** alongside the
   technical indicators, so event and volume exclusions are visible in the same table.

6. **Recommend stock(s) from the candidates that passed.** For each pick explain
   *why* (weight rank, structural theme, what it does, technical posture) and briefly
   *why not* the obvious alternatives. If the user asks for N picks but fewer than N
   pass the screen, say so — never pad the list with stocks that failed the gate.

7. **Entry/exit plan (mandatory for every recommendation).** For each recommended
   stock:

   a. **Buy zone**: anchor to a real technical level — 20MA, recent consolidation
      floor, or key support visible in the price action. State which level and why.
      Never use "spot price minus X%". If the stock is already at/near support, the
      buy zone can include the current price; if it's extended above support, the buy
      zone sits lower and the user waits.

   b. **Stop loss**: `buy_zone_bottom − max(2 × daily_range, buy_zone_bottom × 0.05)`.
      Use the daily_range from Histock OHLC fetched in step 5. Always express as
      both a price and the % below buy zone bottom. If the resulting stop is tighter
      than 5% below buy zone bottom, widen it — tight stops on volatile stocks get
      triggered by normal noise (Rule 6a).

   c. **Staged take-profit** (Rule 6d):
      - TP1: +8% from buy zone midpoint → scale out ½, move stop to breakeven
      - TP2: +15% → scale out remainder or trail with 5MA
      Express both as prices.

   d. **Risk/reward summary**: show risk (entry → stop) vs reward (entry → TP1) in
      points and %. The R:R to TP1 should be at least 1:1.5; if it's worse, flag it.

   e. **Position sizing (Rule 6e-2, 6e-3).** For each stock, calculate:
      `shares = (account_equity × 0.01) / (entry − stop)`.
      If multiple picks share the same supply chain, apply the per-theme heat cap
      (2% combined, or 1% if TAIEX < 50-day MA). Show the user: per-position risk
      in dollars, total theme heat, and the combined exposure warning (Rule 6e-6).

   f. **Entry protocol (Rule 6e-5).** State: "先買 50% 部位（試單），確認站穩
      2 個交易日後再加碼剩餘 50%。試單觸停損則不加碼，全部出場。"

8. **Theme-level stop disclosure (Rule 6e-4).** If recommending 2+ stocks from the
   same theme, include a theme stop table:
   - 合計虧損 −10%: 減半（賣最弱一檔）
   - 合計虧損 −15%: 僅留最強一檔
   - 合計虧損 −20%: 全部出場，等待重新進場條件

9. **Offer to persist** the analysis via Eliot (stock note + `[[stock]]` log). Don't
   write without the user's go-ahead. The persisted note MUST include a
   `### 觀察名單` section listing each watchlist stock with its specific trigger
   condition — this is what step 3.5 reads in the next session. Format each entry
   as: `- <code> <name>：<trigger condition>` (e.g.
   `- 3037 欣興：等 KD 黃金交叉 + 站回 20MA(948)`).

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
5. **Mirror the trade to SQLite** so the chart shows the real fill (Rule 5):
   `add-marker.mjs <code> <date> <買=buy|賣=sell> <fill> "<備註>"`. On a buy, also assert the
   `stop`/`target` markers at the recorded levels. Then `fetch-history.mjs <code> --months 1`
   to top up price history. Best-effort; don't block on it.

---

## Action C — Check current holdings & suggest selling

Triggered by: "檢查我的持股", "我現在該賣什麼", "review my holdings", "should I sell
anything". This is the action that closes the loop: read what the user owns, get fresh
data, and produce a per-holding sell recommendation.

1. **Read the ledger.** Get the `## 持有中` positions from the holdings ledger (read
   is lightweight — `obsidian read path="Eliot/Notes/2026/stock-holdings.md"`, or ask
   Eliot). For each position you need: code, name, shares, cost average, recorded 停損
   and 停利 target.

2. **Fetch fresh data per holding:**
   - **Live quote** from Yahoo (price recipe in `references/data-sources.md`).
   - **Current ETF membership & weight**: re-fetch the relevant ETF holdings from the
     官網 and check whether the stock is still a constituent and at what weight.
   - **Technical indicators** from Histock (recipe in `references/data-sources.md`):
     MA5/10/20, K9, D9, RSI6, RSI12, MACD. These are daily-close values (T-1 during
     market hours).

3. **Evaluate technical signals per holding** (supplement the fundamental sell signals):
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

4. **Evaluate all four fundamental sell signals per holding:**
   | Signal | Condition | Suggestion |
   |---|---|---|
   | 停損觸價 | live ≤ recorded 停損 | **停損出場** — discipline, exit |
   | 停利觸價 | live ≥ 停利 target | **分批停利** — scale out, let rest run if trend intact |
   | 跌出 ETF 成分 | no longer in 0050/0052 holdings | **留意/考慮減碼** — weakened fundamentals signal |
   | 權重明顯下降 | ETF weight well below the level recorded at buy | **留意** — losing index conviction |
   | 報酬率檢視 | report unrealized P/L % from cost regardless | context for the above |

5. **Present a holdings review table**: code · name · cost · live price · 報酬率% ·
   技術面摘要 · 每個訊號狀態 · 建議 (續抱 / 分批停利 / 停損出場 / 留意減碼). Lead with
   anything actionable (停損/停利 hits) at the top. Include a per-holding technical
   summary row (MA position, KD state, RSI level) so the user sees the full picture.

6. **Offer to update the ledger via Eliot** if the user acts on a suggestion (record
   the sell, update 持有中). Don't write unprompted.

7. Close with the disclaimer line.

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
   - **Otherwise**: markers accrue automatically from Action A step 10 and Action B step 5. Add
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
