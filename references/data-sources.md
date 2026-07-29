# Data sources & agent-browser extraction recipes

All fetching uses the `agent-browser` skill/CLI. General pattern:

```
agent-browser open "<url>" && agent-browser wait 3500 && agent-browser eval --stdin <<'EVALEOF'
<javascript>
EVALEOF
```

- Use a **fixed `wait 3500`**, NOT `wait --load networkidle`. Yahoo and the 投信 sites
  keep firing ad/analytics requests, so `networkidle` frequently hangs to timeout.
- Use `eval --stdin` with a single-quoted heredoc so JS quoting survives the shell.
- `agent-browser close` when finished with a batch.
- For watching it live, add `--headed` to the first `open`.

### agent-browser operational gotchas (learned 2026-07-29, cost a whole analysis cycle)

1. **Cold start can exceed 3 minutes.** The first `open` of a session launches the browser and
   may take >180 s. **Set the tool timeout to ~420 s.** A timeout here looks exactly like a hang
   — on 2026-07-29 it was misread as "daemon broken on Windows", every ETF source was declared
   dead, and the analysis shipped with no membership table. The sources were fine.
2. **Never `pkill` a slow `open`.** Killing it destroys the session; the next `eval` then returns
   `len=0` against a blank page, which reads as "the site returned nothing" and compounds the
   misdiagnosis. Wait it out, or `agent-browser close` cleanly.
3. **Chain `open → wait → eval` in ONE shell invocation** when a session may not already be warm.
   Separate tool calls can each land on a fresh browser.
4. **Do NOT fall back to curl / `fetch()` / WebFetch for these sites.** Yuanta is a Nuxt SPA and
   Fubon is ASP.NET postback — both return a 200 shell with no holdings, which is easy to
   mistake for "the endpoint is down". Rule 1 says agent-browser; that is not a stylistic
   preference, it is the difference between real data and a false negative. (Plain-JSON official
   endpoints — the `scan.mjs` and `fetch-history.mjs` sources — are the documented exception.)

---

## 交叉驗證 (cross-source deviation, Rule 3a)

When the same figure at the same timestamp comes from two sources, resolve the
conflict against the declared **primary** below, then check the deviation against
the thresholds in Rule 3a.

| Figure type | Primary source | Notes |
|---|---|---|
| 已收盤 OHLC (settled) | TWSE (上市) / TPEx (上櫃) official data | the local DB's OHLC history should trace back to these |
| 即時報價 (live quote) | Yahoo 股市 | apply the 10% plausibility bound vs. last settled close (Rule 3a) — a live quote isn't "verified" against TWSE mid-session, just sanity-checked |
| ETF 成分/權重 | 投信官網 (fund company site) | Yahoo shows top-10-only and can lag weeks (Rule 2) — never treat Yahoo's weight as the verified figure when the 官網 disagrees |
| 財報/除權息/公告 (events) | MOPS (公開資訊觀測站) | Yahoo/Histock event dates are convenience fetches, not verification |

**Documented common causes of legitimate deviation** — when flagging, check against
this list and name the matching cause; an unexplained >5% deviation stays blocked:

- **T-1 vs live timing** — the DB's last close vs. a live intraday quote (this is the
  timing exemption in Rule 3a, not a conflict at all).
- **除權息還原 (adjusted) vs raw series** — one source back-adjusts historical closes
  for dividends, the other doesn't; state which series the analysis uses.
- **上市 vs 上櫃 mixup** — fetching the TWSE recipe for a TPEx-listed code (or vice
  versa) returns a different company's/market's data entirely.
- **TWSE 民國-date parsing (+1911)** — a date field misread as the Gregorian year
  instead of ROC year throws OHLC rows onto the wrong session.

**Worked example**: Yahoo shows a constituent's weight at 8.1%; the 元大官網 shows
9.3% for the same 交易日. Deviation is 1.2 percentage points on a >1% base → 標註
per Rule 3a: use the 元大官網 value (9.3%), note both figures and their respective
資料時間 (data-as-of dates) in the output.

---

## ETF full holdings — use the official 投信 site (NOT Yahoo)

Yahoo's holdings tab shows only the **top 10** and its `資料時間` can lag weeks. The
fund-company sites publish the **full** constituent list at ~T+1. Always prefer them
for holdings.

### 0050 元大台灣50 — 元大投信

URL: `https://www.yuantaetfs.com/product/detail/0050/ratio`

The page shows the top 5; click **展開** to load all ~50. The holdings table is
**div-based** — `document.querySelectorAll('table')` returns nothing. The reliable
extraction is to read `document.body.innerText` and slice the block that starts at a
known top holding (台積電). The rows render as tab-separated text:
`<code>\t<name>\t<shares>\t<weight>`.

> **展開 gotcha (2026-07-29): it must be clicked by snapshot ref.** `find text "展開" click`
> and an in-page `element.click()` both report success and **silently do nothing** — the list
> stays at 5 rows, which looks like "the site only publishes the top 5". Take a snapshot, grab
> the ref of the `generic "展開"` node, and click that:
> ```
> REF=$(agent-browser snapshot -i -c | grep '展開' | head -1 | sed -E 's/.*ref=(e[0-9]+).*/\1/')
> agent-browser click "@$REF"
> ```
> Verify the expansion actually happened before trusting the result — count the rows (0050
> should be ~50, 0051 ~100). Anchor on `基金權重-股票` rather than 台積電 so the same slice
> works for both funds.

```
agent-browser open "https://www.yuantaetfs.com/product/detail/0050/ratio"
agent-browser wait 4000
agent-browser click "@eNN"                # 展開 — by snapshot ref, see gotcha above
agent-browser wait 1500
agent-browser eval --stdin <<'EVALEOF'
(() => {
  const t = document.body.innerText;
  const i = t.indexOf('台積電');
  return t.slice(i - 30, i + 3000);   // contains code\tname\tshares\tweight rows
})()
EVALEOF
```

Also capture the `交易日期: YYYY/MM/DD` shown above the table — that is the data-as-of
date to cite.

### 0051 元大中型100 — 元大投信

Same system and recipe as 0050 — mid-caps ranked 51–150, the pool's mid-cap tier.

URL: `https://www.yuantaetfs.com/product/detail/0051/ratio`

**Anchor gotcha: 0051 does NOT hold 台積電** — every other recipe here anchors its
`innerText` slice on 台積電, but that returns `-1` on this page. Anchor on the
holdings-table header (`持股明細` / `股票名稱`) instead and take a wide window,
since the top holding rotates:

```
agent-browser open "https://www.yuantaetfs.com/product/detail/0051/ratio"
agent-browser wait 4000
agent-browser click "@eNN"                # 展開 — by snapshot ref (same gotcha as 0050)
agent-browser wait 1500
agent-browser eval --stdin <<'EVALEOF'
(() => {
  const t = document.body.innerText;
  const i = t.indexOf('持股明細');
  return t.slice(Math.max(0, i), i + 6000);   // code\tname\tshares\tweight rows
})()
EVALEOF
```

Capture the `交易日期` line as the data-as-of date, same as 0050.

### 0052 富邦科技 — 富邦投信 ETF 投資網

URL: `https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=0052`

This page exposes the full holdings directly in `innerText` as a clean tab-separated
table: `<code>\t<name>\t<shares>\t<value>\t<weight%>`. Slice around 台積電:

```
agent-browser open "https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=0052"
agent-browser wait 4000
agent-browser eval --stdin <<'EVALEOF'
(() => {
  const t = document.body.innerText;
  const i = t.indexOf('台積電');
  return t.slice(Math.max(0, i - 200), i + 3000);
})()
EVALEOF
```

### 00892 富邦台灣半導體 — 富邦投信 ETF 投資網

Same system as 0052 — just change `stkId`. Full holdings in `innerText` as a clean
tab-separated table `<code>\t<name>\t<shares>\t<value>\t<weight%>`. Note the table
leads with a small 期貨 (futures) block before the 股票 block; slice around 台積電 to
land in the stock rows.

```
agent-browser open "https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=00892"
agent-browser wait 4000
agent-browser eval --stdin <<'EVALEOF'
(() => {
  const t = document.body.innerText;
  const i = t.indexOf('台積電');
  return t.slice(Math.max(0, i - 200), i + 3000);
})()
EVALEOF
```

This is the **preferred** source for 00892 (official, full list). 富邦半導體 is a
~30-stock concentrated ETF — 台積電 ~23%, 聯發科 ~10%, plus 瑞昱/鴻勁/日月光/信驊/
聯詠/旺矽/穎崴/力旺 etc., almost all of which are 0050/0052 共同成分.

### 00733 富邦臺灣中小 — 富邦投信 ETF 投資網

Same system as 0052/00892 — just change `stkId`. Small/mid-cap momentum ETF, the
pool's small-cap tier. **Anchor gotcha: 00733 does NOT hold 台積電** — slicing
around 台積電 fails here. Anchor on the stock-table header (`股票名稱` or the
持股/成分 heading) and take a wide window; the top holding rotates frequently
(momentum-rebalanced):

```
agent-browser open "https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=00733"
agent-browser wait 4000
agent-browser eval --stdin <<'EVALEOF'
(() => {
  const t = document.body.innerText;
  const i = t.indexOf('股票名稱');
  return t.slice(Math.max(0, i), i + 6000);   // code\tname\tshares\tvalue\tweight%
})()
EVALEOF
```

Same 期貨-block caveat as 00892 — a small futures block may precede the stock rows.

### 00891 中信關鍵半導體 — use MoneyDJ (official site is bot-blocked)

The official 中國信託投信 page (`ctbcinvestments.com/Etf/88182265`) returns a
**"Web Page Blocked / Attack ID"** firewall page to headless browsers — do NOT use it.
玩股網/口袋證券/FindBillion are SPAs (holdings lazy-loaded, not in initial `innerText`)
or have bot-protection. The reliable headless source is **MoneyDJ**, which is
server-rendered:

URL: `https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00891.tw`

```
agent-browser open "https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00891.tw"
agent-browser wait 4500
agent-browser eval --stdin <<'EVALEOF'
(() => {
  const t = document.body.innerText;
  const i = t.indexOf('台積電');
  return t.slice(Math.max(0, i - 180), i + 600);   // 個股名稱(code.TW)\t投資比例%\t持有股數
})()
EVALEOF
```

Output is a clean table `個股名稱(code.TW)\t投資比例(%)\t持有股數`, preceded by two date
lines — `持股分佈(依產業) 資料日期` and the holdings `持股明細 資料日期：YYYY/MM/DD`
(cite the latter). **Caveat (Rule 2):** MoneyDJ lists only the **top 10** holdings
(the block ends at `相關基金`). 00891 is a concentrated 30-stock ESG-screened semi ETF
where 台積電 ~36% and the top 10 ≈ 78%+, so the top 10 captures the dominant overlap
with 0050/0052 — but smaller shared names below #10 will be missed. If a fuller list is
needed, a human can open the 官網 in a real (non-headless) browser.

### 00904 新光臺灣半導體30 — use MoneyDJ (official site is lazy-loaded)

The official 新光投信 page (`tsit.com.tw/ETF/Home/ETFSeriesDetail/00904`) loads the
holdings behind a JS tab not present in initial `innerText`. Use **MoneyDJ**, same
recipe as 00891 with `etfid=00904.tw`:

```
agent-browser open "https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00904.tw"
agent-browser wait 4500
agent-browser eval --stdin <<'EVALEOF'
(() => {
  const t = document.body.innerText;
  const i = t.indexOf('台積電');
  return t.slice(Math.max(0, i - 180), i + 600);
})()
EVALEOF
```

Same **top-10-only caveat** as 00891. 00904 is even more 台積電-heavy (~41%), so top 10
≈ 90%+ of weight — fine for the overlap analysis, with the coverage caveat surfaced.

> **Note on these three semiconductor ETFs (00891/00892/00904):** all hold Taiwan
> stocks and overlap heavily with 0050/0052 (台積電/聯發科/日月光/聯電/瑞昱/南亞科/
> 華邦電/旺矽/創意/京元/聯詠/旺宏/世界先進…), so their overlap signal is
> meaningful. Do **NOT** confuse 00891 with **00911 兆豐洲際半導體**, which tracks the
> ICE Semiconductor Index and holds **US** stocks (Micron/AMD/Nvidia/Broadcom…) — a
> 國外成分股 ETF with ~zero overlap with Taiwan ETFs and not usable in this Taiwan-stock
> picking/tracking workflow. Because 00891/00904 are top-10-only sources, they are
> **confirmation-only** in the membership-score table (SKILL.md Action A step 2):
> presence adds a 半導體ETF確認 ✓, but they never count toward a stock's tier —
> absence from a truncated list proves nothing.

### Sources that look right but carry no holdings — don't burn a cycle on them

- **TWSE ETFortune** (`https://www.twse.com.tw/zh/ETFortune/etfInfo/<CODE>`) — loads fine and is
  the natural-looking official page, but it is **基金概況 only**: 發行公司/經理人/標的指數/費率,
  **no constituent list** (verified 2026-07-29: 1,469 chars of innerText, no 台積電 anchor).
  Useful for confirming an ETF's index and issuer, useless for step 2.
- **TWSE ETF PCF** (`rwd/zh/ETF/etfPCF?stkNo=…`) — 404.
- **Fubon `RWD/ETFBasicInfo.aspx` / `Trade/PCF.aspx`** — returns a site-maintenance notice.
  The working Fubon path is `Fund/Assets.aspx?stkId=<id>` (above).

Constituent lists come from the **issuer's own holdings page**, full stop.

### Other ETFs

Most Taiwan ETFs follow the same idea: find the issuer's official product page and
look for a "持股權重 / 基金資產 / 成分股" tab. To discover the URL, use the `WebSearch`
tool ("<ETF代號> <issuer> 持股 官網") rather than Google-via-browser — Google's search
page throws a CAPTCHA to headless browsers. Common issuers: 元大投信
(`yuantaetfs.com`), 富邦投信 (`fsit.com.tw` / `fubon.com`), 國泰投信, 群益投信.

### Computing the membership-score table (soft tiers)

Parse each ETF's `(code, name, weight)` rows. Match by **code**, never by name
(names can vary, e.g. `國巨*` vs `國巨`). Do **NOT** intersect — an intersection
only shrinks as ETFs are added, and with top-10-only sources it caps the pool at
~10 mega-caps. Instead (must mirror SKILL.md Action A step 2):

- Pool = **union** of all fetched ETFs' constituents, keyed by code.
- Tier = count of memberships in the **full-list ETFs only**
  (0050/0052/00892/0051/00733): **核心** (3+) > **確認** (2) > **單一** (1,
  flagged「單一指數，指數信念較低」).
- **00891/00904 (top-10-only) never count toward the tier** — show them as a
  bonus「半導體ETF確認 ✓」column. Presence is signal; absence from a truncated
  list is not.
- Present the table sorted by tier then combined weight, and note which big
  holdings sit in only one ETF (explains the pool's character — a pure tech ETF
  won't share 0050's financials/traditionals; 0051/00733 mid-caps are absent
  from 0050).

---

## 市場掃描 — whole-market discovery endpoints (Action A step 2b, `scan.mjs`)

The non-ETF pool source. All six endpoints are **plain JSON over HTTPS — no
agent-browser** — and all are official TWSE/TPEx, so they satisfy Rule 1/3a as
primaries directly. `scripts/scan.mjs` fetches, parses, caches, and ranks; **never
hand-fetch these or hand-parse the field indices** (the layouts below are documented
for maintaining the script, not for ad-hoc use — same discipline as screen.mjs).

| Data | Endpoint | Notes |
|---|---|---|
| 上市 all-stock daily OHLCV | `twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=ALLBUT0999&response=json` | multi-table response; use the table whose fields include 證券代號+收盤價. 漲跌 sign is a separate HTML field (`<p …>+</p>`, red=up) |
| 上櫃 all-stock daily OHLCV | `tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=ROC/MM/DD&se=EW` | 漲跌 is a signed string; may be 除息 text (unparseable → chg null) |
| 上市 per-stock 三大法人 | `twse.com.tw/rwd/zh/fund/T86?date=YYYYMMDD&selectType=ALLBUT0999&response=json` | 外資 = col4(外陸資)+col7(外資自營); 投信 = col10; 自營合計 = col11 |
| 上櫃 per-stock 三大法人 | `tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d=ROC/MM/DD` | 24 cols in 買進/賣出/買賣超 triples: 外資合計 = col10; 投信 = col13; 自營合計 = col22 |
| 上市 monthly 營收 | `openapi.twse.com.tw/v1/opendata/t187ap05_L` | YoY/MoM % precomputed; 資料年月 is ROC (`11506` → 2026-06) |
| 上櫃 monthly 營收 | `tpex.org.tw/openapi/v1/mopsfin_t187ap05_O` | same shape as the 上市 feed |

Shared gotchas (all also handled by the script):
- **民國 dates everywhere** — Gregorian = ROC + 1911, same trap as `fetch-history.mjs`.
- **Common-stock filter**: keep only 4-digit codes not starting with `0`
  (`/^[1-9]\d{3}$/`) — drops ETF/ETN (00xx), warrants/bonds (5–6 chars), TDR (91xxxx).
- **Non-trading / unpublished days** return `stat != "OK"` or an empty table — the
  script skips them silently (today's data publishes after the close, ~14:00+).
- **Rate limits**: the rwd endpoints are the same infrastructure that throttles
  `fetch-history.mjs`; the script sleeps 1.2 s between calls and caches by date, so
  a daily run costs ~6 HTTP calls. Don't defeat the cache with `--backfill` sweeps.

The three signals and their default thresholds (`--chg 3 --vol-ratio 1.5
--trust-days 3 --rev-yoy 30 --min-value 100000000`), the 掃描 tier semantics, and
the mandatory 「非ETF成分，無指數把關」 flag are specified in SKILL.md Action A
step 2b; the CLI + output glossary is in `references/charting.md` §10.

---

## Live quotes — Yahoo 股市

URL pattern: `https://tw.stock.yahoo.com/quote/<CODE>.TW` (e.g. `2383.TW`).

The quote page's `innerText` starts with site nav then the stock block. The price and
change appear right after the stock name + code + sector. Grab the head of the text:

```
agent-browser open "https://tw.stock.yahoo.com/quote/2383.TW"
agent-browser wait 3500
agent-browser eval --stdin <<'EVALEOF'
(() => document.body.innerText.slice(0, 220).replace(/\n+/g, ' '))()
EVALEOF
```

Output looks like: `... 台光電 2383 電子零組件 比較 加入自選股 5,100 20.00 (0.39%) 開盤 |
2026/06/01 10:24 更新 642 成交量 ...` → price = 5,100, change = +20 (+0.39%), with the
update timestamp. To batch several tickers, loop `open → wait → eval → ` per code in
one shell invocation, then `close` at the end.

**Never** substitute a price derived from ETF holding value ÷ shares for a live quote.
That number is the last fund-valuation close and drifts intraday (we saw a 6% gap the
same morning). Deriving is only acceptable as an explicitly-labeled rough fallback if
the quote fetch fails.

---

## Technical indicators — Histock

URL pattern: `https://histock.tw/stock/<CODE>` (e.g. `https://histock.tw/stock/3017`).

Histock renders the chart as canvas, but the **indicator values appear as text** in
`innerText` after the chart data block. Look for the `KD` anchor and slice from there:

```
agent-browser open "https://histock.tw/stock/3017"
agent-browser wait 4000
agent-browser eval --stdin <<'EVALEOF'
(() => {
  const t = document.body.innerText;
  const kd = t.indexOf('KD');
  if (kd === -1) return 'KD not found';
  return t.slice(kd, kd + 400);
})()
EVALEOF
```

Output contains a block like:
```
日期  06/04
開盤  2805
最高  2820
最低  2675
收盤  2710
量    4,446
5MA   2,743.0
10MA  2,684.0
20MA  2,579.5
K9    61.85
D9    65.26
RSI6  53.16
RSI12 54.93
MACD  62.77
```

These are **daily-close values** — during market hours they reflect the prior trading
day (T-1), not intraday. Combine with Yahoo's live quote for the current session.

**Why Histock over Yahoo for technicals:** Yahoo renders KD/RSI/MACD only as
canvas/SVG chart visuals with no extractable text in the DOM. Histock exposes the
actual numeric values in `innerText`, making them reliable for automated extraction.
Goodinfo returns 404 for assessment pages from headless browsers.

The Histock block already gives the day's **量 (volume)**. For **Rule 6j volume
confirmation** you also need the 5-day average volume — compute it from the recent
daily volumes. Histock's individual-stock page also has a "技術分析/成交量" area, but
the simplest reliable path is to read the last 5 sessions' 量 off the data table and
average them, then compare the latest 量 against that average.

---

## Event data — earnings date, ex-dividend date (Rules 6h, 6i)

The technical rules are blind to scheduled events; these two fetches close that gap.
Both are public on Taiwan sources.

### Next earnings / 法說會 date (Rule 6h)

The official source is TWSE's 公開資訊觀測站 (MOPS) earnings-calendar
(`mops.twse.com.tw`), but it is form-driven and awkward to scrape. The pragmatic path:

- **Yahoo 個股「基本」頁** often lists 財報/法說 events:
  `https://tw.stock.yahoo.com/quote/<CODE>.TW/profile` — read `innerText` and search
  for 「財報」「法說」「電話會議」 with a date.
- **Fallback — WebSearch** (not browser, to avoid Google CAPTCHA): query
  "<code> <name> 法說會 OR 財報 公布日期 2026Q<n>" and read the date from the result.
- Taiwan companies report quarterly; Q1 ≈ mid-May, Q2 ≈ mid-Aug, Q3 ≈ mid-Nov,
  Q4/annual ≈ end-Mar. Monthly 營收 is published by the 10th of each month — a
  營收 release is a smaller event but can still move the stock.

Convert the found date to "X trading days away" and apply the ≤ 5-day blackout.

### Ex-dividend / 除權息 date (Rule 6i)

- **Histock 除權息頁**: `https://histock.tw/stock/<CODE>/除權除息` (or the 股利政策
  tab on the main `histock.tw/stock/<CODE>` page) lists 除權息交易日 and the
  現金股利/股票股利 amounts. Read `innerText` and search for 「除息交易日」「除權交易日」
  「現金股利」.
- **Fallback — WebSearch**: "<code> <name> 除權息 交易日 2026".
- Taiwan ex-dividend season clusters in **June–August**. When the ex-div date is
  near or just passed, a price drop ≈ the dividend amount is mechanical, NOT a
  breakdown — restore the dividend before judging support, and lower the recorded
  停損 by the dividend amount.

---

## 個股新聞查證 (Action C move attribution)

For the company-news check in Action C's 異動歸因 (move attribution) step:

- **Yahoo TW 個股新聞頁**: `https://tw.stock.yahoo.com/quote/<CODE>.TW/news` — read
  `innerText` for recent headlines with dates; scan for anything that could move the
  stock (訂單/財測/客戶/法說/併購 etc.).
- **MOPS 重大訊息** (`https://mops.twse.com.tw`) is the **authoritative** source for
  official company announcements (重大訊息公告) — prefer it over a headline when both
  exist, since it carries the filing date directly.
- **Fallback — WebSearch** is acceptable here (unlike ETF-holdings discovery):
  attribution is best-effort, not a data-integrity requirement. Query
  "<code> <name> 股價 下跌/上漲 原因 <date>".
- **A failed fetch yields 原因不明, never an invented cause** — do not guess a
  plausible-sounding story to fill the gap; an unsourced cause cannot support a
  價值事件 verdict (see SKILL.md Rule 6i and the Action C move-attribution step).

---

## Institutional flows — 三大法人買賣超 (Rule 6k, optional / Tier 2)

Not yet a mandatory gate, but high-signal for Taiwan. 外資/投信/自營 net buy/sell:

- **Histock 法人頁**: `https://histock.tw/stock/<CODE>/三大法人` — recent days of
  外資/投信/自營 買賣超 (張). Read `innerText`.
- A stock you want to buy while **外資 connectively 賣超** is a red flag; **投信 連買**
  (fund window-dressing, esp. quarter-end) is a tailwind. Use as context, not a
  hard gate, until promoted to a numbered rule.
