# Taiwan Stock & ETF Advisor

A Claude [skill](https://code.claude.com/docs/en/skills) / [plugin](https://code.claude.com/docs/en/plugins)
for **Taiwan ETF / stock research, buy-sell decisions, and personal holdings tracking** —
with a hard rule it never breaks: **always fetch live data, never guess or derive a price.**

It reproduces an end-to-end workflow: find the common holdings between two ETFs
(e.g. `0050` 元大台灣50 and `0052` 富邦科技), recommend what to buy and why, attach an
entry/exit plan from a live quote, record the trades you actually make, and later review
your holdings to tell you what to consider selling.

## Install

With the [`skills`](https://github.com/vercel-labs/skills) CLI (works with Claude Code,
Cursor, and other agents):

```bash
npx skills add LizardLiang/tw-stock-etf-advisor
```

Or as a Claude Code plugin marketplace:

```text
/plugin marketplace add LizardLiang/tw-stock-etf-advisor
/plugin install tw-stock-etf-advisor@lizard-skills
```

Once installed, just ask in plain language — the skill triggers automatically.

## What it does

Four actions, picked from how you ask:

### A. ETF common-holdings analysis & recommendation
> "幫我看 0050 跟 0052 的共同持股，推薦我買哪一檔，為什麼"

- Pulls the **full** constituent list from each fund company's official site (元大投信,
  富邦投信) — not Yahoo, which only shows the top 10 and can lag by weeks.
- Computes the intersection and shows a side-by-side weight table.
- Recommends stock(s) with reasoning, spread across the supply chain when you ask for
  several, plus an entry price / 停利 / 停損 plan from a **live** quote.

### B. Record a trade
> "我買了 奇鋐 1 股 @2820"

- Appends the transaction to your holdings ledger and updates the position summary
  (cost average), via the Eliot Obsidian assistant.

### C. Check holdings & suggest selling
> "檢查我的持股，我現在該賣什麼"

- Reads your current positions, fetches fresh prices and current ETF weights, then
  evaluates four sell signals per holding: **停損觸價 · 停利觸價 · 跌出 ETF 成分 ·
  權重明顯下降**, with an unrealized-return check for context.
- Re-scores each position's **thesis health** (assumptions 🟢/🟡/🔴/⚫, red lines,
  a numeric score mapped to 續抱/減碼/出場) and runs **move attribution** on any
  holding that swung ≥3% or is near its stop — verdict: 價值事件 / 情緒雜訊 /
  原因不明 / 混合, with 原因不明 flagged as the dangerous one.
- Returns a per-holding table: 續抱 / 分批停利 / 停損出場 / 留意減碼.

### D. Draw a K-line chart marking why each decision happened
> "畫出奇鋐的 K 線，把買賣點標在圖上"

- Renders a standalone **Tokyo-Night candlestick chart** (no dependencies, one HTML
  file) from a local SQLite DB: MA5/10/20, volume, dashed 停損/停利 lines, forward ⚑
  signal lines for watchlist triggers, and pin markers (▲買 ▼賣 ◆續抱) whose tooltips
  carry the reason.
- Below the chart, a **決策與訊號紀錄** review panel logs every decision and signal
  with its condition and outcome — the chart doubles as a post-mortem record.

## Trade discipline built in

Recommendations pass through a non-negotiable rule layer (learned from real
post-mortems, see `SKILL.md` rules 3a and 6a–6q):

- **ATR-based stops matched to the entry style** (pullback / breakout / reversal-day),
  staged take-profit, 1% per-position risk and 2% per-theme heat sizing, a TAIEX
  market-condition gate, and earnings/ex-dividend event gates.
- **Thesis tracking** — every position gets a thesis note at buy time (falsifiable
  assumptions, red lines, stop + invalidation), re-scored each review with drift
  checks that separate fact change from price change from rewording.
- **Mirror test** — a buy is only presented when its full 5-sentence case (setup,
  stop, invalidation, size, worst-case loss) can be stated; incomplete → watchlist.
- **A/B/C data-richness rating** — thin data yields an honest 「資料不足，不給訊號」
  instead of a forced call.
- **Cross-source validation** — figures are checked across sources (>1% flag, >5%
  block) against declared primaries (TWSE, 投信官網, MOPS).
- All stop/target/R:R/sizing math comes from a deterministic script
  (`scripts/screen.mjs`), never model arithmetic.

## How it works

- **Live data via [`agent-browser`](https://github.com/vercel-labs/agent-browser):**
  ETF holdings from the issuer's 官網, live quotes from Yahoo 股市. The skill bundles
  the exact extraction recipes (these sites use div-based tables and stale-data traps
  that are easy to get wrong) plus the cross-source validation protocol in
  [`references/data-sources.md`](references/data-sources.md).
- **Tracking via [Eliot](https://github.com/LizardLiang/eliot):** analysis notes, the
  `[[stock]]` project log, the holdings ledger, and per-position thesis notes are
  written through the Eliot Obsidian skill so they follow your vault templates and
  approval flow. Formats are in
  [`references/obsidian-tracking.md`](references/obsidian-tracking.md) and
  [`references/thesis-tracking.md`](references/thesis-tracking.md).
- **Structured layer in SQLite:** daily OHLC history (fetched from TWSE/TPEx) and
  decision markers live in a local zero-dependency `node:sqlite` DB, powering the
  charts and the deterministic rule-math engine
  ([`references/charting.md`](references/charting.md)).

## Disclaimer

This skill produces analysis, **not professional investment advice**. Prices and ETF
weights change continuously; Taiwan AI-theme stocks are volatile with deep pullbacks.
Always verify the latest price and financials yourself and honor your stops.

## License

MIT
