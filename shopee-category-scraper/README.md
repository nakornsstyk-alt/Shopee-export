# Shopee Scraper — Category / Keyword Edition (Windows)

Paste a Shopee **category URL**, a Shopee **search URL**, or just a plain
**keyword**, and the app scrapes **9 pages** of products, respecting whatever
sort order is in the URL (defaults to `sortBy=sales` / สินค้าขายดี if missing).

**Collects:** Rank · Product Name · Link · Stars · Price (฿) · Qty Sold / Month

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
   - A plain keyword — `นมผง`

2. Pick number of pages (1–9, default 9)
3. Click **▶ Start Scraping**
4. Double-click any row to open the product link
5. Export via **💾 Export CSV** or **📊 Push to Google Sheets**

---

## How URLs are walked

The input is turned into a URL template:

- A plain keyword is turned into a `shopee.co.th/search?keyword=...` URL
- `page=` is replaced with `0, 1, 2, …` up to the page count you chose
- `sortBy=` is preserved (or set to `sales` if missing)
- Any other query parameters (filters, etc.) are kept as-is
- The category ID (`cat.XXXX.YYYY`) or the keyword text is used to name the Sheet tab / CSV file

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
  credentials.json        ← your Google service account key (add manually)
  venv/                   ← auto-created by setup.bat
```

---

## How It Works

- Connects to **your real Chrome** via CDP (port 9222) — Chrome handles all
  Shopee authentication tokens automatically
- Iterates `page=0..8` (9 pages) on the category/search URL you paste (or the
  search URL built from your keyword)
- Scrolls each page to trigger lazy loading
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
| "URL is not a category page... / not a search page..." | Paste a category URL (`-cat.<numbers>`), a search URL (`?keyword=...`), or a plain keyword |
| "Cannot connect to Chrome" | Run `start_chrome_debug.bat` first |
| 0 products found | Make sure you're logged in to Shopee in the debug Chrome window |
| credentials.json error | Re-download JSON key from Google Cloud Console |
| Chrome not found | Edit `start_chrome_debug.bat` with your actual Chrome path |
