# Shopee Scraper — Category Edition (Windows)

Paste a Shopee **category URL** and the app scrapes **9 pages** of products,
respecting whatever sort order is in the URL (defaults to `sortBy=sales` /
สินค้าขายดี if missing).

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
1. Paste a Shopee category URL, e.g.

   `https://shopee.co.th/เครื่องสำอางสำหรับผิวหน้า-cat.11044959.11045208?page=0&sortBy=sales`

2. Pick number of pages (1–9, default 9)
3. Click **▶ Start Scraping**
4. Double-click any row to open the product link
5. Export via **💾 Export CSV** or **📊 Push to Google Sheets**

---

## How URLs are walked

The URL you paste is treated as a template:

- `page=` is replaced with `0, 1, 2, …` up to the page count you chose
- `sortBy=` is preserved (or set to `sales` if missing)
- Any other query parameters (filters, etc.) are kept as-is
- The category ID (`cat.XXXX.YYYY` portion) is used to name the Sheet tab / CSV file

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
- Iterates `page=0..8` (9 pages) on the category URL you paste
- Scrolls each page to trigger lazy loading
- Reads rendered HTML via `page.evaluate()` JS — no API calls, no bot
  detection issues
- Extracts stars, price, and sold count using partial class matching
  (`[class*="..."]`) since Shopee uses generated class names

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Invalid URL" / "missing -cat." | Make sure you copied the category page URL (must contain `-cat.<numbers>`), not a search URL |
| "Cannot connect to Chrome" | Run `start_chrome_debug.bat` first |
| 0 products found | Make sure you're logged in to Shopee in the debug Chrome window |
| credentials.json error | Re-download JSON key from Google Cloud Console |
| Chrome not found | Edit `start_chrome_debug.bat` with your actual Chrome path |
