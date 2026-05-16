# Shopee Ads Analytics Capture — Chrome Extension

Captures **hourly CPC ads performance data** from the Shopee Seller Centre marketing page and exports it to CSV. Designed to produce one row per hour per day so you can cross-reference ad spend against raw order data.

---

## What It Does

1. You pick a date range (e.g. "Last 30 days") in the popup.
2. The extension opens/reuses a Shopee Seller Centre tab and navigates to the marketing analytics page **one day at a time** — this forces Shopee to return hourly granularity (Shopee collapses to 3-hour buckets when the date range is wider than 4 days).
3. For each day it waits for the chart API to respond, captures the JSON, and parses 24 hourly rows.
4. After all days are done, click **Export CSV** to download the data.

---

## Output CSV Format

| Column | Description |
|---|---|
| `date` | Integer `YYYYMMDD` e.g. `20260115` — plain number, sorts and filters correctly in Google Sheets |
| `hour` | `HH:00` in Singapore Time (SGT = UTC+8), e.g. `09:00` |
| `impressions` | Ad impressions |
| `clicks` | Ad clicks |
| `ctr_pct` | Click-through rate in % (e.g. `1.86`) |
| `items_sold` | Items sold attributed to ads (`broad_order_amount`) |
| `order` | Orders confirmed as paid — matches Shopee dashboard "Orders" (`checkout` field) |
| `sales_gmv` | GMV attributed to ads in SGD (`broad_gmv`) |
| `expense` | Ad spend in SGD |
| `roas` | Return on Ad Spend (`broad_roi`) |
| `broad_orders` | Broader attribution window orders (`broad_order`) |
| `direct_orders` | Direct click-attributed orders (`direct_order`) |
| `direct_gmv` | GMV from direct orders in SGD |

A 30-day export produces **720 rows** (30 days × 24 hours).

### Using the date column in Google Sheets

The `date` column is a plain integer (`20260115`). To convert it to a date for display:

```
=DATE(LEFT(A2,4), MID(A2,3,2), RIGHT(A2,2))
```

Or just keep it as a number for VLOOKUP / key matching — it is sortable and unambiguous across locales.

---

## File Structure

```
shopee-marketing-analytics/
├── manifest.json            Chrome MV3 manifest
├── background.js            Service worker — navigation, data collection, CSV export
├── popup.html               Extension popup UI
├── popup.js                 Popup controller
├── content/
│   └── intercept.js         Fetch/XHR hook injected at page load
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## How to Install (Load Unpacked)

> Requires Chrome or any Chromium-based browser (Edge, Brave, Arc, etc.)

1. Download or clone this folder (`shopee-marketing-analytics/`) to your computer.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle, top-right corner).
4. Click **Load unpacked**.
5. Select the `shopee-marketing-analytics/` folder.
6. The extension icon (Shopee orange) appears in your toolbar. Pin it for easy access.

> No build step, no npm, no dependencies — it is plain JavaScript.

---

## How to Use

### Prerequisites

- You must be **logged in** to [seller.shopee.sg](https://seller.shopee.sg) before starting a capture.
- The extension only works on `seller.shopee.sg` (Singapore seller centre). If you use a different country's seller centre, update `host_permissions` and `MARKETING_BASE` in `background.js`.

### Capture steps

1. Click the extension icon to open the popup.
2. Select a **date range** using the pickers or preset buttons:
   - Today / Yesterday
   - Last 7 days / Last 30 days
   - This month
3. Click **Start Capture**.
4. A Shopee marketing tab opens (or an existing one is reused) and navigates day by day automatically. **Do not close that tab** during capture.
5. The popup shows progress: `Day 5 of 30 — 120 rows so far`.
6. When complete, click **Export CSV** — the file downloads automatically.
7. Click **Clear collected data** before starting a new capture range to avoid mixing data.

### Tips

- Capture can take time: each day requires a full page load (~5–10 s) plus a 2.5 s delay between days. A 30-day range takes roughly **5–7 minutes**.
- You can close the popup during capture and reopen it — the background service worker keeps running and the popup re-syncs on open.
- The last raw API responses are saved to `chrome.storage.local` under `lastRawResponses`. Useful for debugging if values look wrong.

---

## How It Works (Technical)

### Why one day at a time?

Shopee's chart API automatically switches granularity based on the selected range:
- **1–4 days selected → hourly (24 pts/day)** ✓
- **5+ days → 3-hour buckets or daily** ✗

The extension always builds a URL with a **single-day** `from`/`to` window and iterates day by day to force hourly output.

### URL structure

```
https://seller.shopee.sg/portal/marketing/pas/index
  ?from=<unix_timestamp_midnight_SGT>
  &to=<unix_timestamp_23:59:59_SGT>
  &type=new_cpc_homepage
  &group=custom
  &offset=616
```

Timestamps are Unix seconds. SGT is UTC+8, so midnight SGT = `Date.UTC(y, m-1, d, -8, 0, 0) / 1000`.

### Data interception (`content/intercept.js`)

Runs at `document_start` in the **MAIN** world (same `window` as the page's own JavaScript — this is critical). It:

1. Wraps `window.fetch` and `XMLHttpRequest` to clone every JSON response.
2. Filters responses that look like ads data (URL keywords: `pas`, `report`, `analytic`, etc., or body contains `impression`).
3. Pushes each captured response into `window.__shopeeAdsResponses__`.

The MAIN world requirement is why `manifest.json` has `"world": "MAIN"` on the content script. Without it, Chrome puts the script in an ISOLATED world with a separate `window` object — the intercept runs but writes to a different `window`, and the background reads an empty array.

### Waiting for chart data (`background.js: waitForData`)

The background polls `window.__shopeeAdsResponses__` every 500 ms (up to 30 s timeout). It only returns once a response whose URL contains `get_time_graph` is present. This prevents early exit triggered by translation/config API calls that arrive seconds before the chart data.

### Parsing (`background.js: parseTimeGraph`)

The target API is `/api/pas/v1/report/get_time_graph/`. Response shape:

```json
{
  "data": {
    "report_by_time": [
      {
        "key": "1743436800",
        "metrics": {
          "impression": 42,
          "click": 3,
          "ctr": 0.07142,
          "cost": 1234500,
          "broad_gmv": 8765400,
          "broad_roi": 710000,
          "checkout": 2,
          ...
        }
      }
    ]
  }
}
```

Because the API returns whatever date range the **page last had open** (not necessarily today's day), the parser filters `report_by_time` entries to only those whose `key` timestamp falls within `[dayStart, dayStart + 86399]`.

### Shopee unit conversions

| Field type | Stored as | Conversion |
|---|---|---|
| Monetary (`cost`, `broad_gmv`, `direct_gmv`) | integer × 100,000 | ÷ 100,000 → SGD |
| ROAS (`broad_roi`) | integer × 100,000 | ÷ 100,000 |
| CTR | decimal (e.g. `0.01857`) | × 100 → % |
| Counts (`impression`, `click`, `checkout`, etc.) | raw integer | no conversion |

---

## Replicating / Recreating From Scratch

If you need to rebuild this extension (e.g. for a different country or a modified schema), follow these steps:

### 1. `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Shopee Ads Analytics Capture",
  "version": "1.0.0",
  "permissions": ["tabs", "scripting", "storage", "downloads"],
  "host_permissions": ["https://seller.shopee.sg/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://seller.shopee.sg/portal/marketing/*"],
    "js": ["content/intercept.js"],
    "run_at": "document_start",
    "world": "MAIN"
  }],
  "action": { "default_popup": "popup.html" }
}
```

**Critical**: `"world": "MAIN"` — without this the intercept is invisible to the background's `executeScript` reads.

### 2. `content/intercept.js`

- Wrap `window.fetch` — clone the response, parse JSON, call `storeResponse(url, data)`.
- Wrap `XMLHttpRequest` — capture `responseText` on the `load` event.
- `storeResponse` pushes to `window.__shopeeAdsResponses__`.
- Guard with `if (window.__shopeeAdsInterceptInstalled__) return;` to prevent double-install on page re-use.

### 3. `background.js`

Key functions:

| Function | Purpose |
|---|---|
| `dateStrToUnixSGT(dateStr)` | `"YYYY-MM-DD"` → Unix seconds at midnight SGT |
| `enumerateDays(from, to)` | Returns array of date strings, one per day |
| `buildDayUrl(dateStr)` | Builds the marketing URL for exactly one day |
| `navigateTab(tabId, url)` | Navigates and waits for `status: 'complete'` |
| `waitForData(tabId)` | Polls `window.__shopeeAdsResponses__` until `get_time_graph` arrives |
| `parseTimeGraph(data, dateStr)` | Extracts + filters hourly rows from API response |
| `rowsToCSV(rows)` | Converts row array to CSV string |
| `startCapture(dateFrom, dateTo)` | Main loop: iterate days, collect, persist |

### 4. Finding the right API endpoint

If Shopee changes their API path:

1. Log in and open `seller.shopee.sg/portal/marketing/pas/index`.
2. Open DevTools → Network tab → filter by `Fetch/XHR`.
3. Set the chart to a single-day custom range.
4. Look for a request returning an array of 24 objects, each with a Unix timestamp and a nested metrics object.
5. Update the `get_time_graph` string in `waitForData` and `parseTimeGraph` to match the new endpoint path.

### 5. Finding field names

If metrics fields change, run this in the browser console on the marketing page after the chart loads:

```javascript
copy(window.__shopeeAdsResponses__.find(r => r.url.includes('get_time_graph'))?.data?.data?.report_by_time?.[0]?.metrics)
```

This copies the metrics object for the first hour to your clipboard. Paste into a text editor to see all field names and raw values.

---

## Known Limitations

- **Singapore only** — `host_permissions` and the base URL are hardcoded to `seller.shopee.sg`. For TH/MY/PH you need to change the domain and re-verify the API path and field names.
- **Login required** — the extension cannot log in for you. If your session expires mid-capture, the day's data will be empty (zero-fill rows are added as placeholders).
- **Today's data is partial** — if you capture today, you only get hours up to the current time.
- **Ads data only covers running campaigns** — hours with no active ads return all zeros (still written to CSV so the day is complete).
- **Rate limiting** — 2.5 s delay between days is conservative but not guaranteed to avoid Shopee anti-bot measures. If you see systematic empty days, increase `DELAY_BETWEEN_DAYS_MS` in `background.js`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| All zeros in CSV | Not logged in to Shopee | Log in and retry |
| All zeros — data appears on screen | `world: MAIN` missing from manifest content script | Ensure `"world": "MAIN"` in manifest, reload extension |
| Capture skips to next day before chart loads | Page load slow / 30 s timeout too short | Increase `DATA_WAIT_TIMEOUT_MS` in `background.js` |
| 48 rows per day instead of 24 | Shopee API returned a 2-day window | Verify `parseTimeGraph` day-filter logic using `dayStart`/`dayEnd` |
| Orders in CSV don't match dashboard | Wrong field mapped to `order` | Confirm `checkout` field = dashboard "Orders"; `broad_order` is wider attribution |
| Extension not capturing anything | Script injected in ISOLATED world | Check manifest for `"world": "MAIN"` on content script |

---

## Branch / Repository

- **Repository**: `nakornsstyk-alt/shopee-export`
- **Branch**: `claude/shopee-marketing-analytics-W3tX3`
- **Folder**: `shopee-marketing-analytics/`
