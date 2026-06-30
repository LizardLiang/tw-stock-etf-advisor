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

## 3. Fetching OHLC history

```
node --experimental-sqlite scripts/fetch-history.mjs <code> --months 4            # TWSE (上市)
node --experimental-sqlite scripts/fetch-history.mjs <code> --months 3 --market tpex   # 上櫃
node --experimental-sqlite scripts/fetch-history.mjs <code> --months 6 --force    # ignore cache
```
- Source: TWSE `STOCK_DAY?response=json&date=YYYYMMDD&stockNo=CODE` (one call per month). OTC →
  TPEx `st43_result.php`.
- **民國 gotcha**: TWSE dates are ROC years (`115/06/02`). Gregorian = ROC + 1911 → `2026-06-02`.
  `fetch-history.mjs` handles this; if you ever parse TWSE JSON by hand, remember `+1911`.
- Numbers carry thousands commas and may be `--` on no-trade days; those rows are skipped.
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
node --experimental-sqlite scripts/seed-from-obsidian.mjs --vault "<path>" --ledger "<path>" --note "<path>"
```
Parses the holdings ledger `## 交易明細` table → buy/sell markers (+ stop/target from the 停損 /
停利目標 columns on buy rows; 備註 → reason) and the newest analysis note's `### 觀察名單` lines
(`- <code> <name>：<trigger>`) → watch markers dated at the note's `created:` date. Idempotent.

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
- The chart renders candles (紅漲綠跌), MA5/10/20, volume, dashed 停損/停利 lines, and pin markers
  whose hover tooltip shows the recorded reason + note link. MAs are computed in JS from closes — no
  need to populate `indicators` first.

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
