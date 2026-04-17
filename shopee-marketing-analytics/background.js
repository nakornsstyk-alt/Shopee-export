// Service worker for Shopee Ads Analytics Capture extension.
// Handles: day-by-day navigation, API response collection, CSV export.

const MARKETING_BASE = 'https://seller.shopee.sg/portal/marketing/pas/index';
// Preserve the offset param from the known working URL; 616 appears in production URLs.
const URL_OFFSET = 616;
const DELAY_BETWEEN_DAYS_MS = 2500;
const DATA_WAIT_TIMEOUT_MS = 20000;
const DATA_POLL_INTERVAL_MS = 500;

// ─── Timestamp helpers ───────────────────────────────────────────────────────

// Convert "YYYY-MM-DD" to Unix seconds at midnight GMT+8 (Singapore time).
function dateStrToUnixSGT(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Singapore is UTC+8 → subtract 8h to get UTC midnight
  return Math.floor(Date.UTC(y, m - 1, d, -8, 0, 0) / 1000);
}

function buildDayUrl(dateStr) {
  const from = dateStrToUnixSGT(dateStr);
  const to = from + 86399; // 23:59:59 same day
  return `${MARKETING_BASE}?from=${from}&to=${to}&type=new_cpc_homepage&group=custom&offset=${URL_OFFSET}`;
}

// Returns array of "YYYY-MM-DD" strings from dateFrom to dateTo inclusive.
function enumerateDays(dateFrom, dateTo) {
  const days = [];
  const cur = new Date(dateFrom + 'T00:00:00');
  const end = new Date(dateTo + 'T00:00:00');
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

// ─── Tab helpers ─────────────────────────────────────────────────────────────

async function findOrCreateMarketingTab() {
  const tabs = await chrome.tabs.query({ url: 'https://seller.shopee.sg/*' });
  if (tabs.length > 0) return tabs[0].id;
  const tab = await chrome.tabs.create({ url: MARKETING_BASE, active: true });
  return tab.id;
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });
  // Wait for the tab to finish loading
  await new Promise((resolve) => {
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    // Safety timeout in case the event never fires
    setTimeout(resolve, 8000);
  });
}

// ─── Data extraction ──────────────────────────────────────────────────────────

// Injected into page context: returns window.__shopeeAdsResponses__ snapshot.
function getPageResponses() {
  return window.__shopeeAdsResponses__ ? [...window.__shopeeAdsResponses__] : [];
}

// Injected into page context: clears the buffer.
function clearPageResponses() {
  window.__shopeeAdsResponses__ = [];
}

async function waitForData(tabId) {
  const deadline = Date.now() + DATA_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DATA_POLL_INTERVAL_MS);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: getPageResponses,
      world: 'MAIN', // must match where intercept.js writes window.__shopeeAdsResponses__
    });
    const responses = result?.result || [];
    if (responses.length > 0) return responses;
  }
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Data parsing ─────────────────────────────────────────────────────────────

// Try to extract hourly rows from any of the captured API responses for a given date.
// Returns array of row objects, or [] if no parseable data found.
function parseHourlyRows(responses, dateStr) {
  for (const resp of responses) {
    const rows = tryExtractRows(resp.data, dateStr);
    if (rows && rows.length > 0) return rows;
  }
  return [];
}

function tryExtractRows(data, dateStr) {
  if (!data) return null;

  // Shopee API typically wraps data in data.data or data.response
  const payload = data.data || data.response || data;

  // Look for a trend/hourly array anywhere in the payload
  const hourlyArr = findHourlyArray(payload);
  if (!hourlyArr) return null;

  return hourlyArr.map((point, idx) => {
    const hour = String(idx).padStart(2, '0') + ':00';
    return {
      date: dateStr,
      hour,
      impressions: safeNum(point, ['impression', 'impressions', 'imp']),
      clicks: safeNum(point, ['click', 'clicks']),
      ctr_pct: safeFloat(point, ['ctr', 'click_through_rate']),
      items_sold: safeNum(point, ['item_sold', 'items_sold', 'item_sold_count', 'sold']),
      orders: safeNum(point, ['order', 'orders', 'order_count', 'order_num']),
      sales_gmv: safeFloat(point, ['gmv', 'sales', 'revenue', 'sale', 'gmv_from_ads']),
      expense: safeFloat(point, ['expense', 'cost', 'spend', 'ad_cost', 'ad_expense']),
      roas: safeFloat(point, ['roas', 'return_on_ad_spend']),
    };
  });
}

// Walk the object tree looking for an array that looks like hourly data points.
function findHourlyArray(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 5 || !obj || typeof obj !== 'object') return null;

  if (Array.isArray(obj)) {
    // An hourly array for one day should have 24 entries (or at least 8)
    if (obj.length >= 8 && typeof obj[0] === 'object') {
      // Check if entries look like metrics (have numeric values)
      const sample = obj[0];
      const vals = Object.values(sample).filter(v => typeof v === 'number');
      if (vals.length >= 2) return obj;
    }
    return null;
  }

  // Check well-known key names first
  const priorityKeys = ['hourly_data', 'trend_data', 'chart_data', 'hourly', 'trend', 'series', 'data_list'];
  for (const k of priorityKeys) {
    if (obj[k]) {
      const found = findHourlyArray(obj[k], depth + 1);
      if (found) return found;
    }
  }

  // Recurse into all keys
  for (const key of Object.keys(obj)) {
    const found = findHourlyArray(obj[key], depth + 1);
    if (found) return found;
  }

  return null;
}

function safeNum(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return Number(obj[k]) || 0;
    // Try snake_case variants already covered; also try camelCase
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (obj[camel] !== undefined) return Number(obj[camel]) || 0;
  }
  return 0;
}

function safeFloat(obj, keys) {
  const n = safeNum(obj, keys);
  return Math.round(n * 10000) / 10000;
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function rowsToCSV(rows) {
  const headers = ['date', 'hour', 'impressions', 'clicks', 'ctr_pct', 'items_sold', 'orders', 'sales_gmv', 'expense', 'roas'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => r[h] !== undefined ? r[h] : '').join(','));
  }
  return lines.join('\n');
}

async function downloadCSV(csvText, filename) {
  const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvText);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

// ─── Main capture loop ────────────────────────────────────────────────────────

let captureState = {
  running: false,
  days: [],
  currentIdx: 0,
  rows: [],
  tabId: null,
  error: null,
};

async function startCapture(dateFrom, dateTo) {
  if (captureState.running) return;

  const days = enumerateDays(dateFrom, dateTo);
  captureState = { running: true, days, currentIdx: 0, rows: [], tabId: null, error: null };

  notifyPopup({ type: 'captureStarted', total: days.length });

  try {
    captureState.tabId = await findOrCreateMarketingTab();

    for (let i = 0; i < days.length; i++) {
      captureState.currentIdx = i;
      const dateStr = days[i];
      const url = buildDayUrl(dateStr);

      notifyPopup({ type: 'progress', current: i + 1, total: days.length, date: dateStr, rowsCollected: captureState.rows.length });

      // Clear BEFORE navigating so we don't erase data captured during page load.
      // (clear also runs in MAIN world so it reaches the same window as the intercept)
      try {
        await chrome.scripting.executeScript({
          target: { tabId: captureState.tabId },
          func: clearPageResponses,
          world: 'MAIN',
        });
      } catch (_) { /* tab may not be on seller.shopee.sg yet — safe to ignore */ }

      await navigateTab(captureState.tabId, url);

      // Wait for API data to arrive (intercept captures calls made during/after page load)
      const responses = await waitForData(captureState.tabId);

      // Always save raw responses so field names can be inspected if values are wrong
      if (responses.length > 0) {
        await chrome.storage.local.set({ lastRawResponses: responses.slice(0, 3) });
      }

      if (responses.length === 0) {
        // Store empty rows for this day so the user sees the gap
        for (let h = 0; h < 24; h++) {
          captureState.rows.push({
            date: dateStr,
            hour: String(h).padStart(2, '0') + ':00',
            impressions: 0, clicks: 0, ctr_pct: 0,
            items_sold: 0, orders: 0, sales_gmv: 0,
            expense: 0, roas: 0,
          });
        }
      } else {
        const dayRows = parseHourlyRows(responses, dateStr);
        if (dayRows.length > 0) {
          captureState.rows.push(...dayRows);
        } else {
          // Parsing succeeded at capturing but couldn't map fields — fill zeros.
          // Check chrome.storage.local → lastRawResponses to see actual API field names.
          for (let h = 0; h < 24; h++) {
            captureState.rows.push({
              date: dateStr,
              hour: String(h).padStart(2, '0') + ':00',
              impressions: 0, clicks: 0, ctr_pct: 0,
              items_sold: 0, orders: 0, sales_gmv: 0,
              expense: 0, roas: 0,
            });
          }
        }
      }

      // Persist incrementally
      await chrome.storage.local.set({ capturedRows: captureState.rows });

      if (i < days.length - 1) {
        await sleep(DELAY_BETWEEN_DAYS_MS);
      }
    }
  } catch (err) {
    captureState.error = err.message;
    notifyPopup({ type: 'error', message: err.message });
  }

  captureState.running = false;
  await chrome.storage.local.set({ capturedRows: captureState.rows });
  notifyPopup({ type: 'captureComplete', rowCount: captureState.rows.length });
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup may not be open
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startCapture') {
    startCapture(msg.dateFrom, msg.dateTo);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'getStatus') {
    sendResponse({
      running: captureState.running,
      currentIdx: captureState.currentIdx,
      total: captureState.days.length,
      rowCount: captureState.rows.length,
      date: captureState.days[captureState.currentIdx] || '',
    });
    return false;
  }

  if (msg.action === 'exportCSV') {
    chrome.storage.local.get('capturedRows', async ({ capturedRows }) => {
      const rows = capturedRows || [];
      if (rows.length === 0) {
        sendResponse({ ok: false, error: 'No data to export' });
        return;
      }
      const csv = rowsToCSV(rows);
      const first = rows[0].date;
      const last = rows[rows.length - 1].date;
      const filename = `shopee_ads_hourly_${first}_to_${last}.csv`;
      await downloadCSV(csv, filename);
      sendResponse({ ok: true, filename });
    });
    return true; // async
  }

  if (msg.action === 'clearData') {
    captureState.rows = [];
    chrome.storage.local.remove('capturedRows');
    sendResponse({ ok: true });
    return false;
  }
});
