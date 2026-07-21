# Shopee Scraper — Category / Keyword Edition (Windows)

Paste a Shopee **category URL**, a Shopee **search URL**, a **shop's own
storefront URL** (e.g. `shopee.co.th/s26_gold3`), a plain **keyword**, or
**multiple of these separated by commas**, and the app scrapes **9 pages**
per input, respecting whatever sort order is in the URL (defaults to
`sortBy=sales` / สินค้าขายดี if missing).

All inputs' results land in one combined table/export — each row tagged with
the **Keyword** column that produced it, and rank restarting at 1 for every
keyword (so "rank 3" always means 3rd place for that keyword's own search,
not 3rd overall).

For keyword inputs, both `shopee.co.th/search` (normal search) and
`shopee.co.th/mall/search` (Shopee Mall only) are scraped and merged — the
two return noticeably different, each individually incomplete-looking,
result sets for the same keyword. Duplicates (the same product appearing in
both) are removed by matching each product's real shop/item ID, not its raw
link, since tracking parameters differ between the two surfaces. Rank is
then computed from the merged set as **quantity sold (highest first), with
price (lowest first) as the tiebreaker** — not page order, since page order
from two different sources merged together isn't a meaningful ranking.

**Collects:** Rank · Keyword · Product Name · Link · Stars · Price (฿) · Qty Sold / Month

---

## Quick Start

### 1. First-time setup
```
Double-click: setup.bat
```
Installs Python packages and Playwright browser.

### 2. Each session — start Chrome in debug mode
```
Double-click: start_chrome_debug.bat
```
A Chrome window opens. **Log in to shopee.co.th** in that window.

### 3. Run the scraper
```
Double-click: launch.bat
```

### 4. Use the app
1. Paste any of the following:

   - A category URL — `https://shopee.co.th/เครื่องสำอางสำหรับผิวหน้า-cat.11044959.11045208?page=0&sortBy=sales`
   - A search URL — `https://shopee.co.th/search?keyword=นมผง`
   - A shop's own storefront URL — `https://shopee.co.th/s26_gold3` — to
     rank just that one shop's own products by sales. Only the shop's actual
     product grid (sold **per month**, "ขายได้ X ชิ้น/เดือน") is kept; the
     recommendation/highlight carousels above it (lifetime "ขายแล้ว X ชิ้น")
     are dropped
   - A plain keyword — `นมผง`
   - **Multiple inputs, comma-separated** — `นมผง, ยาสีฟัน, https://shopee.co.th/s26_gold3`
     (each runs as its own scrape, one after another, over the same Chrome
     connection; you can freely mix category/search/shop URLs and keywords
     in the same list)

2. Pick number of pages (1–9, default 9) — applies to each input
3. Click **▶ Start Scraping**
4. Double-click any row to open the product link
5. Export via **💾 Export CSV** or **📊 Push to Google Sheets** — everything
   goes into one file/tab, with a **Keyword** column identifying which input
   each row came from

---

## How URLs are walked

The input is split on commas first (a single input with no comma is just
one segment), then each segment is turned into a URL template:

- A plain keyword is turned into a `shopee.co.th/search?keyword=...` URL
- `page=` is replaced with `0, 1, 2, …` up to the page count you chose
- `sortBy=` is preserved (or set to `sales` if missing)
- Any other query parameters (filters, etc.) are kept as-is
- Each segment's category ID (`cat.XXXX.YYYY`), keyword text, or shop
  username is written to every row it produces as the **Keyword** column
- For a keyword segment, both the normal-search and Mall-search URLs are
  built and scraped, then merged and deduped by item ID before ranking (see
  above) — results from different *segments*, however, are never deduped
  against each other, since the same product legitimately ranking under two
  different keywords/shops is two different facts worth keeping
- A shop URL is recognized as anything not matching category/search that
  reduces to a single path segment (e.g. `/s26_gold3`) not already used for
  a Shopee site section (`/search`, `/cart`, etc.) — it's scraped once, no
  Mall-variant merge, since a shop is just itself
- The first segment's label (plus a count of how many more) is used to name
  the Sheet tab / CSV file

---

## Google Sheets Setup

1. Create a service account at [Google Cloud Console](https://console.cloud.google.com)
2. Enable **Google Sheets API**
3. Download the JSON key → save as `credentials.json` in the app folder
4. Share your Sheet with the service account email (Editor access)
5. Paste your Sheet ID in the app

---

## File Structure

```
shopee-category-scraper/
  app.py                  ← main app
  promo_phrases.txt        ← editable list of promo-badge phrases to ignore
  setup.bat               ← one-time installer
  launch.bat              ← run the app
  start_chrome_debug.bat  ← start Chrome with CDP
  HANDOVER.md              ← technical deep-dive / how to recreate this app
  credentials.json        ← your Google service account key (add manually)
  venv/                   ← auto-created by setup.bat
```

---

## How It Works

- Connects to **your real Chrome** via CDP (port 9222) — Chrome handles all
  Shopee authentication tokens automatically
- Iterates `page=0..8` (9 pages) on the category/search URL you paste (or the
  search URL built from your keyword); for keywords, this runs once against
  normal search and once against Mall search
- Scrolls each page to trigger lazy loading — keeps scrolling until product
  links stop increasing (not a fixed scroll count), so it gets past the
  banners/carousels a shop's own page renders above its product grid
- Detects products by their **item links** (every product links to
  `.../-i.<ids>` or `/product/<ids>`), not by container class names — so it
  works across category, search, and shop pages even though those use
  different card markup
- Reads rendered HTML via `page.evaluate()` JS — no API calls, no bot
  detection issues
- Extracts stars, price, and sold count using partial class matching
  (`[class*="..."]`) since Shopee uses generated class names
- **Product name is recovered from the item's own URL first**: Shopee
  builds links as `.../<slugified-title>-i.<shopid>.<itemid>`, generating
  that slug straight from the real title, so it can never contain a
  promo badge. Special characters (`%`, `/`, `&`, ...) get stripped by
  Shopee's own slugifier, so the recovered name may be missing some
  punctuation the on-page title has, but the words are always correct.
- If a link doesn't match that URL shape (rare — e.g. some ad-redirect
  links), the app falls back to scraping the name out of the card's DOM
  text, filtering out known marketing badges (e.g. "ซื้อ 2 ชิ้น ลด ฿1",
  "ช้อปเพิ่มคุ้มกว่า", "ส่งฟรี"): numeric "buy N get discount" badges are
  caught automatically by pattern regardless of wording, and everything
  else is matched against `promo_phrases.txt` — the longest surviving
  candidate wins

### If a promo badge still shows up as the item name

This should be rare now that the URL slug is the primary source, but if
it happens (i.e. the link didn't match the expected item-URL shape, so
the DOM fallback was used): open `promo_phrases.txt`, add the exact badge
text on its own line, save, and re-scrape — no code changes needed. See
the comments at the top of that file for the format.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "URL is not a category page... / not a search page... / recognizable shop URL" | Paste a category URL (`-cat.<numbers>`), a search URL (`?keyword=...`), a shop URL (`shopee.co.th/<username>`), or a plain keyword |
| "Cannot connect to Chrome" | Run `start_chrome_debug.bat` first |
| 0 products found | Make sure you're logged in to Shopee in the debug Chrome window |
| credentials.json error | Re-download JSON key from Google Cloud Console |
| Chrome not found | Edit `start_chrome_debug.bat` with your actual Chrome path |
