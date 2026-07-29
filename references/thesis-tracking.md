# Thesis tracking — per-position thesis notes, health score, drift

A thesis note is the prospective counterpart to the post-mortem habit: written at
buy time, re-scored at every holdings review, so Rule 6n's execute-or-re-underwrite
binary has a pre-committed contract to enforce instead of a fresh argument each
session. Storage follows `references/obsidian-tracking.md` conventions; writes go
through Eliot like every other vault write.

Path: `Eliot/Notes/<YYYY>/thesis/<code>-<entrydate>.md` (entry date in the filename —
a later re-entry after a full exit gets a NEW file, never overwrites the closed one).

---

## 1. Thesis note template (`thesis_note_template`)

Keep the whole note to ~40 lines or it becomes friction and gets skipped.

```markdown
---
type: permanent
id: <YYYYMMDDHHmm>
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [stock, thesis]
tickers: [<code>]
says: <one-line: why this position, what would break it>
up: ["[[stock]]"]
---
# <code> <name> 進場論點

## 進場論點
<entry rationale, ≤5 sentences — the story, the timeframe, why now. When the
source analysis note completed Rule 6p's mirror test for this pick, seed this
section verbatim from those 5 sentences instead of re-deriving them.>

## 核心假設
| # | 假設 | 驗證方式 | 狀態 |
|---|------|----------|------|
| 1 | <falsifiable claim> | <how/when to check it> | 🟢 |

(3–7 rows. Each assumption must be falsifiable — "AI 需求持續" is not; "Q3 法說
guidance 維持 20%+ 成長" is.)

## 紅線
| # | 紅線條件 | 觸發動作 |
|---|----------|----------|
| 1 | 跌破停損 <price>（ATR14/結構停損） | Rule 6n：執行出場或正式重新論證 |

(Row 1 — the ATR/structural stop breach — is MANDATORY in every thesis. Add more
red lines for thesis-specific breaks, e.g. "客戶集中度失衡" or a named competitor event.)

## 停損與失效條件
- 進場風格：Style-<1|2|3>（依 6a-1）
- 停損價：<price>（<%> below entry）
- 失效條件：<what would make the thesis wrong even if price hasn't hit the stop yet>

## 進場紀錄
| 日期 | 動作 | 股數 | 價格 | 備註 |
|------|------|------|------|------|
| <date> | 買 | <shares> | <price> | 首次建倉 |

## 複審紀錄
(appended each Action C re-score — date, health score, count breakdown, drift verdict;
see §2–3 below. On full exit, append the outcome section per §4.)
```

---

## 2. Health score protocol

At every Action C re-score, mark each 核心假設 row's 狀態:

- 🟢 holds — evidence still supports it
- 🟡 weakening — early contrary signal, not yet disproven
- 🔴 impaired — meaningfully undermined by new evidence
- ⚫ broken — falsified

Then check every 紅線 row: triggered or not.

```
health = 10 − 3×⚫ − 2×🔴 − 1×🟡 − 5×(triggered red lines)
```

Always show the count breakdown in the output — e.g. "10 − 3×1(⚫) − 1×1(🟡) = 6" —
never a silent total. This is what keeps the arithmetic auditable across sessions.

**Computed mechanically by `rules.mjs thesis --json thesis.json`** (SKILL.md Rule 8) —
`{assumptions:[{name,status}], redLines:[{name,triggered}]}` in, `{counts, health,
breakdown, action, forcedBinary}` out. The model supplies each assumption's
🟢/🟡/🔴/⚫ status and each red line's triggered/not (judgment inputs); the formula,
breakdown string, and action mapping are the script's job — never hand-compute them.
Quote `breakdown` verbatim into 複審紀錄.

**Worked example.** Position with 5 assumptions (1 ⚫, 1 🟡, 3 🟢) and no red line
triggered:

```
health = 10 − 3×1(⚫) − 2×0(🔴) − 1×1(🟡) − 5×0(red lines)
       = 10 − 3 − 0 − 1 − 0
       = 6  →  reduce (per §3 mapping)
```

Same position after the recorded stop is breached (a red line firing):

```
health formula still evaluates to 6, but a triggered red line forces the
Rule 6n binary regardless of score — execute the exit or formally re-underwrite.
The score does not soften a live stop breach.
```

---

## 3. Action mapping

| Health score | Action |
|---|---|
| ≥ 9 | hold / add-eligible |
| 7–8 | hold |
| 4–6 | reduce |
| ≤ 3, **or any triggered red line regardless of score** | exit or formal re-underwrite (Rule 6n binary) |

**Precedence: hard stops always win.** Rules 6a (ATR stop), 6e-4 (theme-level stop),
and 6n (stop-execution accountability) override a benign health score. A 8/10 thesis
does not excuse an unexecuted stop breach — see the Requirement scenario "score
contradicts stop discipline": stop-breach handling governs, the score does not soften it.

---

## 4. Drift protocol

Each re-score compares the current read against the thesis's last snapshot — the
prior 複審紀錄 entry (or, for the first review, the original 核心假設 狀態 column).
Classify every change:

- **事實變化 (fact change)** — new information contradicts or confirms an assumption.
  Requires a cited source (財報、法說, a specific news item, a technical break).
- **價格變化 (price change)** — price moved but the underlying facts didn't. Never
  downgrade an assumption on price movement alone.
- **措辭變化 (wording change)** — the note's phrasing was tightened/reworded with no
  new information. Classify as **Unchanged** — wording drift is not thesis drift.

**Every non-"Unchanged" verdict must cite the specific new evidence** (a figure, a
date, a quote) — "sentiment feels weaker" is not a verdict, it's a shrug.

**除息 is mechanical, never a fact/red-line event (Rule 6i).** If a price drop is
wholly explained by 除權息, classify it as mechanical price change — restore the
dividend before judging any assumption, and never let it trigger the stop red line
on its own.

**Move-attribution verdicts map directly to drift class**: an Action C 異動歸因
價值事件 verdict classifies as 事實變化; a 情緒・雜訊 or mechanical verdict classifies
as 價格變化 — reuse the verdict instead of re-deriving the drift class from scratch.

Append the re-score to 複審紀錄 as a dated log line: date, health score + breakdown,
per-assumption drift verdict (fact/price/wording), and the mapped action.

---

## 5. Lifecycle

- **Add to position** — update the SAME thesis file (new 進場紀錄 row, cost-average
  note); do not create a second thesis for the same open position.
- **Full exit** — close the thesis: append an outcome section with exit price,
  realized R-multiple, and which core assumptions proved right/wrong. This is what
  turns the thesis into a post-mortem record.
  ```markdown
  ## 結果 Outcome
  - 出場價／R倍數: <price> / <+N.NR or -N.NR>
  - 假設覆盤: <# proved right, # proved wrong, one line each>
  - 狀態: 已結案
  ```
- **Re-entry after a full exit** — start a NEW thesis file (new entry date in the
  filename). Never reopen a closed one; the old file's outcome section is the
  record of what actually happened last time.

---

## 6. Missing-thesis handling

A holding without a thesis (predates this tracking) does not block Action C's
review — flag "無 thesis 紀錄", offer to draft one retroactively (seeded from
whatever analysis note or ledger context exists), and continue the review using
the ledger's recorded 停損/停利 in the meantime.
