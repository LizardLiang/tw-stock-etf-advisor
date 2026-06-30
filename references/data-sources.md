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

```
agent-browser open "https://www.yuantaetfs.com/product/detail/0050/ratio"
agent-browser wait 4000
agent-browser find text "展開" click      # expand to full list
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
> 華邦電/旺矽/創意/京元/聯詠/旺宏/世界先進…), so the common-holdings intersection is
> meaningful. Do **NOT** confuse 00891 with **00911 兆豐洲際半導體**, which tracks the
> ICE Semiconductor Index and holds **US** stocks (Micron/AMD/Nvidia/Broadcom…) — a
> 國外成分股 ETF with ~zero overlap with Taiwan ETFs and not usable in this Taiwan-stock
> picking/tracking workflow.

### Other ETFs

Most Taiwan ETFs follow the same idea: find the issuer's official product page and
look for a "持股權重 / 基金資產 / 成分股" tab. To discover the URL, use the `WebSearch`
tool ("<ETF代號> <issuer> 持股 官網") rather than Google-via-browser — Google's search
page throws a CAPTCHA to headless browsers. Common issuers: 元大投信
(`yuantaetfs.com`), 富邦投信 (`fsit.com.tw` / `fubon.com`), 國泰投信, 群益投信.

### Computing common holdings

Parse each ETF's `(code, name, weight)` rows. Intersect by **code** (names can vary,
e.g. `國巨*` vs `國巨`). Present a side-by-side weight table sorted by weight, and note
which big holdings are unique to one ETF (explains the overlap's character — a pure
tech ETF won't share 0050's financials/traditionals).

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

## Institutional flows — 三大法人買賣超 (Rule 6k, optional / Tier 2)

Not yet a mandatory gate, but high-signal for Taiwan. 外資/投信/自營 net buy/sell:

- **Histock 法人頁**: `https://histock.tw/stock/<CODE>/三大法人` — recent days of
  外資/投信/自營 買賣超 (張). Read `innerText`.
- A stock you want to buy while **外資 connectively 賣超** is a red flag; **投信 連買**
  (fund window-dressing, esp. quarter-end) is a tailwind. Use as context, not a
  hard gate, until promoted to a numbered rule.
