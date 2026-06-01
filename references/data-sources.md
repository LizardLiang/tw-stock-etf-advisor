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
