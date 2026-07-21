# Shopee Scraper — Category / Keyword Edition — Handover Document

| | |
|---|---|
| **Project** | Shopee Category / Keyword Scraper |
| **Type** | Windows desktop app (Python + Tkinter GUI, Playwright automation) |
| **Status** | ✅ Working |
| **Repository** | `nakornsstyk-alt/shopee-export` |
| **Folder** | `shopee-category-scraper/` |

---

## 1. Project Purpose

Given a Shopee **category URL**, a **search keyword**, a **Shopee search
URL**, or a **shop's own storefront URL**, this app scrapes up to 9 pages of
product listings (rank, name, link, star rating, price, quantity sold per
month) and exports them to CSV or a Google Sheet. It's used for
competitor/market research — e.g. "what are the top-selling skincare
products for keyword X, ranked by units sold" or "rank this one shop's own
products by sales" — across one or many inputs in a single run.

It replaces manually opening Shopee, searching, and copy-pasting product
names/prices/sold-counts into a spreadsheet by hand.

## 2. What It Does

- Accepts **one input or several, comma-separated**, in any mix of:
  - A category URL — `https://shopee.co.th/<name>-cat.<id1>.<id2>?sortBy=sales`
  - A Shopee search URL — `https://shopee.co.th/search?keyword=<kw>`
  - A shop's own storefront URL — `https://shopee.co.th/<shop-username>`
    (e.g. `https://shopee.co.th/s26_gold3`) — to rank just that one shop's
    own products by sales
  - A plain keyword — `นมผง`
- For **keyword inputs**, scrapes **both** `shopee.co.th/search` (normal
  search) **and** `shopee.co.th/mall/search` (Shopee Mall only) and merges
  them — the two surfaces return meaningfully different, each individually
  incomplete-looking, result sets for the same keyword.
- Recovers the **product name from the item's URL slug** (not by scraping
  visible card text), so it's structurally immune to in-card marketing
  badges ("ซื้อ 2 ชิ้น ลด ฿1", "ช้อปเพิ่มคุ้มกว่า", etc.) being mistaken for
  the product name. Falls back to filtered DOM-text scraping only if a link
  doesn't match the expected URL shape.
- Deduplicates products by their real **shop ID + item ID** (parsed from the
  URL), not by comparing raw link strings, since tracking query parameters
  differ between page loads and between the normal/Mall surfaces.
- **Rank is computed, not read from page order**: sorted by quantity sold
  (descending), with price (ascending) as the tiebreaker. This is necessary
  because merging two different search surfaces makes "page order" meaningless
  as a ranking.
- Every result row is tagged with the **keyword/category** that produced it,
  and rank restarts at 1 for each one — so multiple keywords land in one
  combined export without their rankings bleeding into each other.
- Exports to **CSV** or appends a new tab to a **Google Sheet**.
- Connects to the user's **already-logged-in real Chrome** via the Chrome
  DevTools Protocol (CDP) — no credential handling, no login automation, no
  bot-detection fights.

## 3. Requirements

- Windows, Python 3.12 (with "Add to PATH" checked at install)
- Google Chrome
- Python packages: `playwright`, `google-api-python-client`,
  `google-auth-httplib2`, `google-auth-oauthlib` (installed by `setup.bat`)
- A Google Cloud service account + `credentials.json`, only if using the
  "Push to Google Sheets" feature (CSV export needs nothing extra)

## 4. File Structure

```
shopee-category-scraper/
  app.py                  ← the entire application (single file)
  promo_phrases.txt        ← editable list of promo-badge phrases to filter out
  setup.bat               ← one-time installer (venv + pip + playwright install)
  launch.bat              ← runs the app (activates venv, python app.py)
  start_chrome_debug.bat  ← launches Chrome with the CDP debug port open
  README.md               ← user-facing quick-start guide
  HANDOVER.md             ← this file
  credentials.json        ← Google service account key (not committed; add manually)
  venv/                   ← created by setup.bat, not committed
```

## 5. Quick Start

1. `setup.bat` — one-time: creates a venv, installs dependencies and
   Playwright's browser (the browser install is currently unused by the CDP
   flow but harmless).
2. `start_chrome_debug.bat` — each session: opens Chrome with
   `--remote-debugging-port=9222 --user-data-dir=C:\chrome_debug`. **Log in
   to shopee.co.th** in that window (separate Chrome profile, doesn't touch
   your normal one).
3. `launch.bat` — opens the app GUI.
4. Paste input(s), pick page count (1–9), click **Start Scraping**.
5. **Export CSV** or **Push to Google Sheets**.

## 6. Output Format

| Column | Description |
|---|---|
| `Rank` | Computed rank within this row's group (qty sold desc, price asc tiebreak) — resets to 1 per group |
| `Keyword` | The category ID, keyword text, or shop username that produced this row |
| `Name` | Product title, recovered from the item URL's SEO slug (see §7.3) |
| `Link` | Full product URL |
| `Stars` | Star rating (e.g. `4.9`) |
| `Price (฿)` | Current price, digits only |
| `Qty Sold / Month` | Normalized sold count, e.g. `10,000+` |

---

## 7. How It Works (Technical)

### 7.1 Input parsing — `parse_input()` / `parse_multi_input()`

Input is split on commas first (`parse_multi_input`), then each segment is
classified (`parse_input`):

```python
CAT_ID_RE = re.compile(r"-cat\.([\d.]+)", re.IGNORECASE)
RESERVED_SHOP_PATHS = {"search", "mall", "cart", "notifications", ...}

# 1. Is it a URL? (has scheme + netloc)
#    a. Path contains "-cat.<id>"          → mode = "category"
#    b. Query has "?keyword=..."           → mode = "keyword"
#    c. A single path segment not already
#       claimed above, and not a reserved
#       Shopee site section               → mode = "shop"
#       (e.g. shopee.co.th/s26_gold3)
#    d. None of the above → ValueError
# 2. Not a URL at all → mode = "keyword", treat the whole string as the
#    keyword, and build https://shopee.co.th/search?keyword=<text>
```

`RESERVED_SHOP_PATHS` exists so a URL like `shopee.co.th/search` (no
`?keyword=`) or `shopee.co.th/cart` isn't misread as a shop named "search"
or "cart" — it guards shop detection to only fire on segments that aren't
already a known Shopee site section.

Each parsed segment carries: `mode` (`"category"`, `"keyword"`, or
`"shop"`), `base` (scheme+netloc+path), `query` (dict, always has `sortBy`
defaulted to `"sales"`), and `label` (category id, keyword, or shop
username — used for the Keyword column and to name the Sheets tab / CSV
file). Shop inputs are scraped once, like category inputs — no Mall-variant
merge, since a shop's storefront doesn't have a separate Mall/normal split
(that distinction only exists for the site-wide search results, §7.5).

`build_page_url(parsed, page_num)` clones `query`, sets `page=<page_num>`,
and URL-encodes it onto `base`.

### 7.2 Card discovery — by item link, not by container class

Shopee's product-card container class names differ between page types
(category vs. search vs. a shop's own microsite) and drift over time. An
earlier version tried a list of known container selectors
(`li[data-sqe='item']`, `.shopee-search-item-result__item`, ...) and broke
on shop pages, which use none of them. So detection/extraction is now
anchored on the **one invariant**: every product card, on every page type,
contains a link to the product. Product URLs come in two shapes:

- SEO slug (search/category): `.../<slug>-i.<shopid>.<itemid>`
- canonical (sometimes in shop microsites): `/product/<shopid>/<itemid>`

`__itemId(href)` (JS) and `ITEM_ID_RE` (Python) both match either shape and
return `"<shopid>.<itemid>"`. Card discovery counts distinct such ids.

For each page: `page.goto(url, wait_until="domcontentloaded")` (not
`networkidle` — Shopee's SPA keeps connections open and would time out),
sleep ~2.5s for React to hydrate, then `_scroll_to_load_cards()`:

```python
# Scroll (window.scrollBy 2000px) in a loop, up to 40 times.
# After each scroll, recount distinct item-links and read scrollHeight.
# Stop after 3 consecutive rounds where BOTH stop changing (fully loaded /
# reached the bottom). Return the final item count.
```

This handles a shop page's banner carousel / shop-info card / tab bar above
the grid (it keeps scrolling until items actually appear, rather than a
fixed count that could stop short), and also fully lazy-loads long grids.
Category/search pages have items near the top, so it settles quickly there.

If the count is 0, a diagnostic logs the total `<a>` count and page height —
so "products exist but no item-links matched" (a structural/URL-format
problem) is distinguishable from "page genuinely empty" (login/render
problem) from the log alone.

The extraction JS then, in one `page.evaluate()`: collects one representative
anchor per distinct item id, and for each derives the **card container** as
the largest ancestor of that anchor still containing no *other* item id
(i.e. the biggest single-item subtree — a class-name-independent card
boundary). It extracts, scoped to that container: link, name, stars, price,
original price, discount %, qty sold, mall flag, shipping tag, location,
sponsored flag. (Only name/link/stars/price/qty_sold currently reach the CSV
output; the rest are extracted but unused today — easy to wire up later.)

### 7.3 Product name extraction — the important part

**Primary method — from the URL, not the DOM:**

Shopee builds item URLs as:

```
https://shopee.co.th/<slugified-title>-i.<shopid>.<itemid>
```

The slug is generated by Shopee directly from the real product title, so it
can **never** contain a promo badge (badges only ever exist as separate DOM
elements). Recovering it:

```python
ITEM_SLUG_RE = re.compile(r"^(.*)-i\.\d+\.\d+$")

def name_from_link(link: str) -> str:
    path = urllib.parse.urlparse(link).path.lstrip("/")
    decoded = urllib.parse.unquote(path, encoding="utf-8", errors="ignore")
    m = ITEM_SLUG_RE.match(decoded)
    if not m:
        return ""                      # caller falls back to DOM scraping
    name = m.group(1).replace("-", " ")
    return re.sub(r"\s+", " ", name).strip()
```

Caveat: special characters (`%`, `/`, `&`, ...) are stripped by Shopee's own
slugifier, so e.g. "100%" in a title comes back as "100" — the words are
always correct, punctuation may not be 100% faithful.

**Fallback method — DOM scraping with promo filtering** (only used when a
link doesn't match the item-URL shape, e.g. ad-redirect links):

1. Collect text from every element matching any of:
   `[data-sqe="name"]`, `[class*="item-name"]`, `[class*="itemName"]`,
   `[class*="ellipsis"]`, `[class*="name"]` — pooled together across *all*
   of these selectors (not stopping at the first selector that matches
   anything — an earlier bug did this and let an unfiltered badge win just
   because it was the only candidate under the first-tried selector).
2. Filter out anything matching a **generic regex** for numeric promo
   patterns (works regardless of exact wording):
   ```js
   /(ซื้อ\s*\d+\s*ชิ้น|ลด\s*฿?\s*\d|ช้อป[^\n]{0,15}คุ้ม|ยิ่งซื้อยิ่ง(คุ้ม|ได้)|flash\s*sale|voucher)/i
   ```
3. Also filter against a **plain-text phrase list loaded from
   `promo_phrases.txt`** (one phrase per line, `#` for comments, simple
   case-insensitive substring match) — this is deliberately *not* hardcoded
   in the Python/JS so new badge wording Shopee introduces can be added by
   editing a text file, no code change needed.
4. Of everything that survives filtering, keep the **longest** string (real
   titles are long descriptive sentences; promo badges are short taglines).

### 7.4 Canonical item identity & deduplication

Two URLs for the same product can differ in tracking query params
(`extraParams`, `sp_atk`, ...), in which surface they came from (normal
search vs. Mall search), or in which of the two URL shapes they use (SEO
slug vs. `/product/<shopid>/<itemid>`). Comparing raw link strings
under-deduplicates, so identity is the `shopid.itemid` pair parsed from
either URL shape:

```python
ITEM_ID_RE = re.compile(r"-i\.(\d+)\.(\d+)|/product/(\d+)/(\d+)")

def item_key(link: str) -> str:
    m = ITEM_ID_RE.search(urllib.parse.urlparse(link).path)
    if not m:
        return link                                        # fall back to raw link
    return f"{m.group(1)}.{m.group(2)}" if m.group(1) else f"{m.group(3)}.{m.group(4)}"
```

Within a single page-walk, an additional cheap raw-link dedup avoids
re-adding the same literal card twice across pages during pagination. The
canonical `item_key`-based dedup runs once more afterwards, across the
*combined* normal+Mall result set for keyword inputs.

### 7.5 Keyword dual-source fetch (normal + Mall)

For every `mode == "keyword"` input, two full page-walks are run over the
**same already-open Playwright page/Chrome connection**:

```python
normal_input = {"mode": "keyword", "base": f"{SHOPEE_BASE}/search",      "query": parsed["query"], "label": label}
mall_input   = {"mode": "keyword", "base": f"{SHOPEE_BASE}/mall/search", "query": parsed["query"], "label": label}
raw_results = scrape(normal_input) + scrape(mall_input)
```

Category inputs are scraped once (no Mall/normal distinction applies).

### 7.6 Ranking

After the (possibly dual-source) raw results for one input are collected:

```python
deduped = dedupe_by_item_key(raw_results)
deduped.sort(key=lambda r: (-qty_sold_value(r["qtySold"]), price_value(r["price"])))
# then enumerate 1..N as "rank"
```

- `qty_sold_value()` parses Thai shorthand (`พัน`=1e3, `หมื่น`=1e4, `แสน`=1e5,
  `ล้าน`=1e6, `K`/`k`=1e3, `M`/`m`=1e6) or a plain number into a float for
  sorting, preserving whether a trailing `+` was present.
- `price_value()` strips commas and parses to float; unparseable/empty
  prices sort **last** (`float("inf")`), so missing price data never wins a
  tiebreak by accident.
- Display formatting (`normalize_qty()`) turns the numeric value back into a
  comma-grouped string with the `+` suffix reattached if present, e.g.
  `"10k+"` → `"10,000+"`.

### 7.7 Chrome connection

```python
browser = playwright.chromium.connect_over_cdp("http://localhost:9222")
context = browser.contexts[0] if browser.contexts else browser.new_context()
page = context.new_page()
```

This attaches to the user's **already-running, already-logged-in** Chrome
(started via `start_chrome_debug.bat` with `--remote-debugging-port=9222`),
so Shopee's session cookies/tokens are handled automatically — no login
automation, no bot-detection arms race, since it's real user browsing.

### 7.8 Export

- **CSV**: `csv.DictWriter` with fields
  `rank, keyword, name, link, stars, price, qty_sold`, UTF-8 with BOM
  (`utf-8-sig`) so Thai text displays correctly when opened directly in
  Excel.
- **Google Sheets**: creates a new tab named `<slugified-label>_<MMDD_HHMM>`
  in a fixed spreadsheet ID (or whatever the user pastes in), writes the
  header row + all data rows via `spreadsheets().values().update()`.
  Requires a service-account `credentials.json` shared with Editor access on
  the target sheet.

### 7.9 GUI

Plain Tkinter (`tkinter` + `ttk`), single window, no external UI framework:
- Left panel: input field, page-count spinner, Start button, Sheets/CSV
  export buttons + credentials picker, Chrome-launch helper + live CDP
  status dot (polls `http://localhost:9222/json/version` every 3s).
- Right panel: progress bar, results table (`ttk.Treeview`), log box.
- Scraping runs in a background `threading.Thread` so the GUI doesn't freeze;
  progress updates come back via `self.after(0, ...)` callbacks (Tkinter is
  not thread-safe, so all widget updates are marshaled onto the main thread
  this way).
- Double-clicking a result row opens its link in the default browser — uses
  the row's **position in the tree**, not the displayed rank number, since
  rank restarts per keyword and is not a unique index into the results list.

---

## 8. Key Code Locations (in `app.py`)

| What | Function |
|---|---|
| Split comma-separated input | `parse_multi_input()` |
| Classify one input (category/search/keyword) | `parse_input()` |
| Build a page's URL | `build_page_url()` |
| Recover name from URL slug | `name_from_link()` |
| Canonical item identity | `item_key()` |
| Promo-badge phrase list (editable) | `load_promo_phrases()` (reads `promo_phrases.txt`) |
| Sold-count parsing (Thai shorthand) | `parse_qty_sold()`, `qty_sold_value()`, `normalize_qty()` |
| Price parsing for ranking | `price_value()` |
| One page-walk over one input | `_scrape_one_input()` |
| Count distinct item-links in DOM | `_count_items()` |
| Scroll until product cards appear | `_scroll_to_load_cards()` |
| Dedup a result set | `_dedupe_by_item()` |
| Dedup + rank a result set | `_rank_group()` |
| Top-level orchestration (multi-input, dual-source) | `scrape_shopee_multi()` |
| Google Sheets export | `push_to_sheets()` |
| CSV export | `export_csv()` |
| GUI | `ShopeeCategoryScraperApp` (Tkinter class) |

## 9. Known Limitations

- **Windows + Chrome only.** Relies on `chrome.exe` paths and a CDP
  connection; no headless/server mode.
- **Manual login.** The app never logs in — you must log in to
  shopee.co.th yourself in the CDP-launched Chrome window each session (the
  separate `--user-data-dir` profile does persist the session between runs,
  though, so this is usually only needed once).
- **Selector drift risk.** Card *detection* no longer depends on container
  class names (it uses item-links, §7.2), so that part is resilient. But the
  in-card *field* extraction (price, stars, sold, etc.) still uses partial
  class matching (`[class*="price"]`, ...) and text regexes that could need
  updating if Shopee changes them — a scrape that finds the right item count
  but returns blank prices/sold would point here.
- **`promo_phrases.txt` is reactive, not exhaustive.** New marketing badge
  wording will need to be added as it's spotted; the generic numeric regex
  (§7.3 step 2) covers "buy N get discount" style badges automatically
  regardless of wording, but purely lexical badges (no digits) need an
  explicit phrase entry.
- **Rank ties.** If two products have identical sold-count *and* identical
  price, their relative order is whatever Python's stable sort happened to
  produce (effectively scrape order) — not a meaningful distinction in
  practice.
- **Shop pages** render a banner carousel, shop-info card, and tab bar above
  the product grid, and use different card markup than search/category —
  both handled by the item-link-based detection + scroll-until-loaded
  approach (§7.2). If a shop scrape still returns 0, the 0-items diagnostic
  (total link count + page height, logged automatically) tells you whether
  it's a structural/URL-format issue (many links, none matched) or a
  render/login issue (few links) — see Troubleshooting.
- Extracted-but-unused fields exist in the scraper (original price, discount
  %, mall flag, shipping tag, location, sponsored flag) — captured in the
  JS `results.push({...})` object but not currently carried through to the
  CSV/Sheets output. Easy to add if needed (see `_rank_group()`).

## 10. Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| "Cannot connect to Chrome" | CDP Chrome not running | Run `start_chrome_debug.bat` first |
| 0 products found, diagnostic shows **few** links on the page | Not logged in, or the page didn't render | Log in to Shopee in the debug Chrome window; try scrolling the page manually once, then re-scrape |
| 0 products found, diagnostic shows **many** links on the page | Products render but their links don't match either item-URL shape (`-i.<ids>` / `/product/<ids>`) — Shopee introduced a new URL format | Inspect a product link on that live page (DevTools); extend `ITEM_ID_RE` (Python) and `_ITEM_RE_JS` (JS) to match the new shape |
| "URL is not a category page... / not a search page... / recognizable shop URL" | Pasted a non-matching URL | Use a `-cat.<id>` URL, a `?keyword=...` URL, a shop URL, or a plain keyword |
| A promo badge shows up as the product name | Rare — only when the link didn't match the item-URL shape so the DOM name fallback (§7.3) was used, and the badge wasn't in `promo_phrases.txt` | Add the exact badge text as a new line in `promo_phrases.txt`, re-scrape |
| Right item count found but prices/sold are blank | Shopee changed the in-card field markup (§7.2 caveat) | Re-inspect a live card in DevTools; update the field selectors/regexes in the extraction JS |
| CSV opens with garbled Thai text in Excel | Excel misdetecting encoding | Shouldn't happen — export already uses `utf-8-sig` (BOM); if it does, re-open via Excel's "From Text/CSV" import with UTF-8 explicitly selected |
| Google Sheets push fails | Missing/expired `credentials.json`, or the sheet isn't shared with the service account | Re-download the JSON key; share the target sheet with the service account's email as Editor |

## 11. Recreating From Scratch

If this file is ever lost, the app can be rebuilt from the descriptions in
§7 above; the essential pieces, in order of what to build first:

1. **Tkinter shell** — a window with an input `Entry`, a `Spinbox` for page
   count, a "Start" `Button`, a `ttk.Treeview` results table, and a
   `scrolledtext.ScrolledText` log box. Run scraping in a background
   `threading.Thread`, marshal all UI updates back through `self.after(0, ...)`.
2. **Input parser** (§7.1) — regex-classify category vs. search vs. plain
   keyword, split multi-input on commas.
3. **Playwright CDP connection** (§7.7) — `connect_over_cdp("http://localhost:9222")`,
   reuse the first existing browser context so the user's login carries over.
4. **Page walk + card scraping** (§7.2) — detect products by their item
   links (`-i.<ids>` or `/product/<ids>`), not container class names; scroll
   until the item count stops growing; then run a single `page.evaluate()`
   per page that finds each item's card container (largest single-item
   ancestor of its link) and extracts all fields at once (cheaper than many
   round-trips).
5. **Name resolution** (§7.3) — URL-slug method first, DOM-scrape-with-
   promo-filter as fallback. This is the single most fragile/important part
   — get the item-URL regex right first, since it removes most of the need
   for the fallback to be perfect.
6. **Dual-source merge + item-key dedup** (§7.4–7.5) — only needed for
   keyword mode; scrape `/search` and `/mall/search` with identical query
   params, concatenate, dedupe by `shopid.itemid`.
7. **Ranking** (§7.6) — sort by parsed quantity-sold descending, price
   ascending as tiebreaker; this replaces relying on page order once results
   come from more than one source.
8. **Export** (§7.8) — `csv.DictWriter` for CSV; Google Sheets API
   `spreadsheets().values().update()` for the Sheets push, gated behind a
   service-account JSON key.

---

## 12. Context & Notes

- Google Sheet ID and the promo phrase list are the two things most likely
  to need per-user customization — both are exposed as plain, editable
  values (a GUI field and a text file, respectively), not buried in code.
- This scraper is unrelated to the `shopee-exporter-v4/` Chrome extension in
  the same repo, which automates **order** exports from Shopee Seller
  Center — different tool, different purpose, no shared code.

**Branch:** `claude/keyword-exporter-promotion-names-urugv2`
**Repository:** `nakornsstyk-alt/shopee-export`

*End of Handover Document*
