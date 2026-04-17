// Service worker for Shopee Ads Analytics Capture extension.
// Handles: day-by-day navigation, API response collection, CSV export.

const MARKETING_BASE = 'https://seller.shopee.sg/portal/marketing/pas/index';
// Preserve the offset param from the known working URL; 616 appears in production URLs.
const URL_OFFSET = 616;
const DELAY_BETWEEN_DAYS_MS = 2500;
const DATA_WAIT_TIMEOUT_MS = 30000;
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
// Uses UTC noon to avoid local-timezone date shifts when calling toISOString().
function enumerateDays(dateFrom, dateTo) {
  const days = [];
  const cur = new Date(dateFrom + 'T12:00:00Z');
  const end = new Date(dateTo + 'T12:00:00Z');
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
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
      world: 'MAIN',
    });
    const responses = result?.result || [];
    // Only return once the chart data endpoint has responded — other API calls
    // (translations, config, banners) arrive much earlier and must not trigger early exit.
    const hasChartData = responses.some(r => r.url.includes('get_time_graph'));
    if (hasChartData) return responses;
  }
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Data parsing ─────────────────────────────────────────────────────────────

// Shopee API unit conventions (confirmed from wallet/topup values in production):
//   monetary fields (cost, broad_gmv, etc.): stored as integer × 100000 → divide by 100000 for SGD
//   ctr: stored as decimal (0.01857) → multiply by 100 for %
//   broad_roi (ROAS): stored as integer × 100000 → divide by 100000 for actual ROAS
//   counts (impression, click, broad_order, broad_order_amount): raw integers, no conversion

function parseHourlyRows(responses, dateStr) {
  // Priority: the get_time_graph endpoint is the chart data source
  const tg = responses.find(r => r.url.includes('get_time_graph'));
  if (tg) {
    const rows = parseTimeGraph(tg.data, dateStr);
    if (rows && rows.length > 0) return rows;
  }
  // Fallback for any other structure
  for (const resp of responses) {
    const rows = parseTimeGraph(resp.data, dateStr);
    if (rows && rows.length > 0) return rows;
  }
  return [];
}

// Parses /api/pas/v1/report/get_time_graph/ response.
// Structure: { data: { key, report_by_time: [ { key: "unix_ts", metrics: {...} } ] } }
// The API returns whatever the page's stored date config is (could be 2+ days),
// so we filter strictly to the 24 entries that fall within the target day in SGT.
function parseTimeGraph(data, dateStr) {
  const reportByTime = data?.data?.report_by_time;
  if (!Array.isArray(reportByTime) || reportByTime.length === 0) return null;

  const dayStart = dateStrToUnixSGT(dateStr);       // 00:00 SGT of target day
  const dayEnd   = dayStart + 86399;                // 23:59:59 SGT of target day

  const dayEntries = reportByTime.filter(point => {
    const ts = Number(point.key);
    return !isNaN(ts) && ts >= dayStart && ts <= dayEnd;
  });

  if (dayEntries.length === 0) return null;

  return dayEntries.map(point => {
    const m = point.metrics || {};
    const ts = Number(point.key);
    const hourSGT = ((Math.floor(ts / 3600) + 8) % 24);
    const hour = String(hourSGT).padStart(2, '0') + ':00';

    return {
      date: dateStr,
      hour,
      impressions:    iv(m, 'impression', 'impressions'),
      clicks:         iv(m, 'click', 'clicks'),
      ctr_pct:        pv(m, 'ctr'),
      items_sold:     iv(m, 'broad_order_amount', 'item_sold', 'items_sold'),
      // orders = checkout: matches dashboard "Orders" (confirmed attribution)
      orders:         iv(m, 'checkout'),
      sales_gmv:      mv(m, 'broad_gmv', 'gmv'),
      expense:        mv(m, 'cost', 'expense'),
      roas:           rv(m, 'broad_roi', 'roas'),
      // broad_orders: slightly wider attribution than dashboard Orders (broad_order field)
      broad_orders:   iv(m, 'broad_order'),
      // direct: buyer clicked YOUR specific ad and bought THAT exact product (~7d window)
      // broad includes anyone who clicked any ad and bought anything (~30d window)
      direct_orders:  iv(m, 'direct_order'),
      direct_gmv:     mv(m, 'direct_gmv'),
      cpc:            mv(m, 'cpc'),
    };
  });
}

// integer value (counts: impressions, clicks, orders, items_sold)
function iv(obj) {
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (obj[k] != null) return Math.round(Number(obj[k])) || 0;
  }
  return 0;
}

// monetary value (SGD): Shopee stores as integer × 100000
function mv(obj) {
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (obj[k] != null) return Math.round(Number(obj[k])) / 100000;
  }
  return 0;
}

// percentage value: Shopee stores CTR as decimal (0.01857 → 1.857%)
function pv(obj) {
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (obj[k] != null) return Math.round(Number(obj[k]) * 10000) / 100;
  }
  return 0;
}

// ROAS value: Shopee stores as integer × 100000 (e.g. 484000 → 4.84)
function rv(obj) {
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (obj[k] != null) return Math.round(Number(obj[k])) / 100000;
  }
  return 0;
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function rowsToCSV(rows) {
  const headers = ['date', 'hour', 'impressions', 'clicks', 'ctr_pct', 'items_sold', 'orders', 'sales_gmv', 'expense', 'roas', 'broad_orders', 'direct_orders', 'direct_gmv', 'cpc'];
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
