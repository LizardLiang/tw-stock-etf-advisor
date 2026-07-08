# Obsidian tracking — formats & Eliot delegation

Persistence (analysis notes, the holdings ledger, the project log) is the **Eliot**
skill's job. This skill produces the content; Eliot performs the vault writes so they
follow the user's templates, approval flow, and `vault_layout`. To persist, invoke the
Eliot skill (or run the equivalent `obsidian` CLI commands) with the structures below.

Reads are lightweight and safe to do directly: `obsidian read path="<file>"`.

Default vault paths (confirm against `Eliot/Profile.md > ## Vault Layout`):
- Notes: `Eliot/Notes/<YYYY>/`
- Project: `Eliot/Projects/stock.md`
- Holdings ledger: `Eliot/Notes/<YYYY>/stock-holdings.md`

---

## 1. Stock analysis note (`stock_note_template`)

The user's Profile.md pins a template for all stock notes. Structure:

```markdown
---
type: permanent
id: <YYYYMMDDHHmm>            # 12-digit timestamp
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [stock, analysis]       # add etf when ETF-related
tickers: [<...>]
says: <one-line summary, ~120 chars>
up: ["[[stock]]"]
---
# <title>

## 標的 Tickers
## 資料時間 Data As-Of      # cite each source's date: holdings vs price
## 重點摘要 Summary
## 分析 Analysis
## 結論／推薦 Recommendation  # per-pick: 現價 / 買區 / 停利 / 停損 / 理由
## 風險 Risks / Disclaimer
## Related Project
[[stock]]
```

After creating/updating a note, append a one-line entry to the project log:

```
obsidian append path="Eliot/Projects/stock.md" content="\n- <YYYY-MM-DD>: [[<note-slug>]] — <what changed>"
```

---

## 2. Holdings ledger (`stock-holdings.md`)

Two tables. A transaction is appended; the position summary is recomputed.

```markdown
---
type: permanent
id: <YYYYMMDDHHmm>
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [stock, holdings, ledger]
says: 個人持股交易紀錄（買賣 ledger）與持有中部位摘要。
up: ["[[stock]]"]
---
# 股票交易紀錄 Holdings Ledger

## 交易明細 Transactions
| 日期 | 動作 | 股號 | 股名 | 股數 | 成交價 | 金額 | 停損 | 停利目標 | 備註 |
|------|------|------|------|------|--------|------|------|----------|------|
| 2026-06-01 | 買 | 3017 | 奇鋐 | 1 | 2,820 | 2,820 | 2,550 | 3,255~3,400 | AI 散熱 |

## 持有中 Current Positions
| 股號 | 股名 | 股數 | 成本均價 | 投入金額 | 停損 | 停利目標 |
|------|------|------|----------|----------|------|----------|
| 3017 | 奇鋐 | 1 | 2,820 | 2,820 | 2,550 | 3,255~3,400 |

## Related Project
[[stock]]
```

### Recording a buy
- Append a transaction row (action `買`).
- Update `## 持有中`: if the code already exists, recompute shares and cost average
  `((old_shares*old_avg) + (new_shares*fill)) / total_shares`; else add a row.

### Recording a sell
- Append a transaction row (action `賣`).
- Update `## 持有中`: reduce shares; if it reaches 0, remove the row. Cost average of
  the remaining shares is unchanged. Optionally note realized P/L in 備註.

### Reading for the sell-review action
Read `## 持有中` to get each position's code, name, shares, cost average, 停損, and
停利目標 — those are the thresholds the sell-signal evaluation compares the live quote
and current ETF weight against (see SKILL.md Action C).

---

## 3. Thesis notes (Rule 6o)

Per-position thesis notes live at `Eliot/Notes/<YYYY>/thesis/<code>-<entrydate>.md` —
a sibling of the analysis notes and ledger above, same vault, same Eliot delegation.
Template, health-score formula, drift protocol, and lifecycle rules are owned by
`references/thesis-tracking.md`, not repeated here. Writes go through Eliot like
every other vault write in this skill; confirm the path against
`Eliot/Profile.md > ## Vault Layout` the same way as the default paths listed above.
