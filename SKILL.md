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
  fetch live data with agent-browser; never guess or derive prices.
---

# Taiwan Stock & ETF Advisor

This skill reproduces a research-to-tracking workflow for Taiwan equities. It has
three actions. Figure out which one the user wants from their phrasing, then follow
that section. The non-negotiable rules below apply to all three.

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

5. **Persist to Obsidian by delegating to Eliot.** This skill does the analysis and
   data fetching; the vault writes (analysis note, `[[stock]]` project log, holdings
   ledger) go through the **Eliot** skill so they follow the user's templates and
   approval flow. See `references/obsidian-tracking.md`.

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

3. **Recommend stock(s) with reasoning.** If the user asks for one, give one; if they
   ask for "at least N", give N and spread them across different links of the supply
   chain (e.g. material / thermal / system) so the picks aren't redundant. For each
   pick explain *why* (weight rank in both ETFs, structural theme, what it does) and
   briefly *why not* the obvious alternatives (e.g. don't single-bet 台積電 when the
   ETF already over-weights it).

4. **If the user wants an entry/exit plan**, fetch the live quote (Action C's price
   recipe) and give: reference price, buy zone, 停利 target (%), 停損 (%). Anchor
   percentages to the live price; flag any stock that already ran up hard today as
   "勿追高".

5. **Offer to persist** the analysis via Eliot (stock note + `[[stock]]` log). Don't
   write without the user's go-ahead.

---

## Action B — Record a trade to the holdings ledger

Triggered by: "我買了 <股號/股名> <股數> @<價>", "賣出 <股號> 一半 @<價>". The user is
reporting an actual transaction.

1. Parse: date (default today), action (買/賣), code, name, shares, fill price.
2. Pull 停損/停利 from the most recent analysis note for that stock if available;
   otherwise leave blank or ask.
3. **Delegate the write to Eliot**: append one transaction row and update the
   `## 持有中` position summary (cost average, total cost). Log a one-liner to
   `[[stock]]`. The exact ledger format is in `references/obsidian-tracking.md`.
4. If the fill price sits outside the analysis's suggested buy zone, mention it once
   (a neutral note, not a scold).

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

## Mechanics & gotchas

- `agent-browser`: `open` → `wait 3500` (a fixed wait — Yahoo's `--load networkidle`
  often hangs on ad/JS activity) → extract via `eval --stdin` heredoc → `close` when
  done. Full recipes and the exact selectors/text-anchors are in
  `references/data-sources.md`.
- Read that reference file at the start of Actions A and C — it has the per-site
  extraction code that is easy to get wrong (div-based tables, stale-data traps).
- Read `references/obsidian-tracking.md` before any persist step so the note and
  ledger formats match the user's existing vault conventions.
