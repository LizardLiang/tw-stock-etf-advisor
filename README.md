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

Three actions, picked from how you ask:

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
- Returns a per-holding table: 續抱 / 分批停利 / 停損出場 / 留意減碼.

## How it works

- **Live data via [`agent-browser`](https://github.com/...):** ETF holdings from the
  issuer's 官網, live quotes from Yahoo 股市. The skill bundles the exact extraction
  recipes (these sites use div-based tables and stale-data traps that are easy to get
  wrong) in [`references/data-sources.md`](references/data-sources.md).
- **Tracking via [Eliot](https://github.com/LizardLiang/eliot):** analysis notes, the
  `[[stock]]` project log, and the holdings ledger are written through the Eliot
  Obsidian skill so they follow your vault templates and approval flow. Formats are in
  [`references/obsidian-tracking.md`](references/obsidian-tracking.md).

## Disclaimer

This skill produces analysis, **not professional investment advice**. Prices and ETF
weights change continuously; Taiwan AI-theme stocks are volatile with deep pullbacks.
Always verify the latest price and financials yourself and honor your stops.

## License

MIT
