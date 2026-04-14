// background.js v3 — uses real Shopee selectors discovered via live inspection

// ── Alarm scheduler ────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dailyExport') {
    const { scheduleEnabled } = await chrome.storage.local.get('scheduleEnabled');
    if (scheduleEnabled) triggerExportOnAllTabs();
  }
});

async function syncAlarm() {
  const { scheduleEnabled, scheduleHour, scheduleMinute } = await chrome.storage.local.get([
    'scheduleEnabled', 'scheduleHour', 'scheduleMinute'
  ]);
  await chrome.alarms.clear('dailyExport');
  if (!scheduleEnabled) return;
  const hour = scheduleHour ?? 8;
  const minute = scheduleMinute ?? 0;
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  chrome.alarms.create('dailyExport', { when: next.getTime(), periodInMinutes: 24 * 60 });
}

chrome.storage.onChanged.addListener((changes) => {
  if ('scheduleEnabled' in changes || 'scheduleHour' in changes || 'scheduleMinute' in changes) {
    syncAlarm();
  }
});

// ── Export coordinator ──────────────────────────────────────────────────────
async function triggerExportOnAllTabs() {
  const settings = await chrome.storage.local.get(['dateMode', 'dateFrom', 'dateTo']);
  const tabs = await chrome.tabs.query({ url: 'https://seller.shopee.co.th/*' });

  // Make sure all tabs are on the orders page first
  for (const tab of tabs) {
    if (!tab.url.includes('/sale/order')) {
      await chrome.tabs.update(tab.id, { url: 'https://seller.shopee.co.th/portal/sale/order' });
      await waitForTabLoad(tab.id);
    }
    try {
      // Notify popup that this tab is starting
      chrome.runtime.sendMessage({ action: 'tabProgress', tabId: tab.id, status: 'running' }).catch(() => {});
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: shopeeExportFlow,
        args: [settings]
      });
      await sleep(4000);
    } catch (e) {
      console.error('[Exporter] Tab', tab.id, e);
      chrome.runtime.sendMessage({ action: 'tabProgress', tabId: tab.id, status: 'error' }).catch(() => {});
    }
  }
}

async function exportSingleTab(tabId) {
  const settings = await chrome.storage.local.get(['dateMode', 'dateFrom', 'dateTo']);
  const [tab] = await chrome.tabs.get(tabId).then(t => [t]).catch(() => [null]);
  if (!tab) return;

  if (!tab.url.includes('/sale/order')) {
    await chrome.tabs.update(tabId, { url: 'https://seller.shopee.co.th/portal/sale/order' });
    await waitForTabLoad(tabId);
  }

  chrome.runtime.sendMessage({ action: 'tabProgress', tabId, status: 'running' }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId },
    func: shopeeExportFlow,
    args: [settings]
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout: ' + tabId));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Main injected automation function ──────────────────────────────────────
// This function is serialised and injected into the Shopee tab — NO closures.
function shopeeExportFlow({ dateMode, dateFrom, dateTo }) {

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Wait for a selector to appear in DOM
  function waitFor(selector, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error('Timeout: ' + selector)); }, timeout);
    });
  }

  // Get target dates as { year, month (1-12), day } objects
  function getTargetDates() {
    function parse(str) {
      const d = new Date(str);
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
    }
    function offset(days) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
    }
    if (dateMode === 'D-1')   return { from: offset(1),  to: offset(1) };
    if (dateMode === 'D-7')   return { from: offset(7),  to: offset(1) };
    if (dateMode === 'D-30')  return { from: offset(30), to: offset(1) };
    if (dateMode === 'custom' && dateFrom && dateTo) return { from: parse(dateFrom), to: parse(dateTo) };
    return { from: offset(1), to: offset(1) };
  }

  // Get the month/year currently displayed on the LEFT calendar panel
  function getDisplayedMonth() {
    const headers = [...document.querySelectorAll('.eds-picker-header__label.clickable')];
    // First two labels = left panel (month, year)
    if (headers.length >= 2) {
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const monthText = headers[0].textContent.trim();
      const yearText  = headers[1].textContent.trim();
      return { month: monthNames.indexOf(monthText) + 1, year: parseInt(yearText) };
    }
    return null;
  }

  // Click the prev-month arrow on the left panel
  function clickPrev() {
    const prevBtns = [...document.querySelectorAll('.eds-picker-header__prev:not(.disabled)')];
    if (prevBtns.length) { prevBtns[0].click(); return true; }
    return false;
  }

  // Click the next-month arrow on the right panel
  function clickNext() {
    const nextBtns = [...document.querySelectorAll('.eds-picker-header__next:not(.disabled)')];
    if (nextBtns.length) { nextBtns[nextBtns.length - 1].click(); return true; }
    return false;
  }

  // Navigate calendar so that target month is visible on left panel
  async function navigateToMonth(targetYear, targetMonth) {
    for (let attempts = 0; attempts < 24; attempts++) {
      const current = getDisplayedMonth();
      if (!current) { await sleep(300); continue; }
      const diff = (targetYear - current.year) * 12 + (targetMonth - current.month);
      if (diff === 0) return; // already there
      if (diff < 0) { clickPrev(); } else { clickNext(); }
      await sleep(400);
    }
  }

  // Click a specific date on the calendar
  // panel: 'left' (first/from month) or 'right' (second/to month)
  async function clickDate(year, month, day) {
    // Navigate so this month is visible
    const current = getDisplayedMonth();
    if (!current) return;

    // Left panel shows current.month, right panel shows current.month+1
    const diffFromLeft  = (year - current.year) * 12 + (month - current.month);
    const diffFromRight = diffFromLeft - 1;

    if (diffFromLeft !== 0 && diffFromRight !== 0) {
      await navigateToMonth(year, month);
      await sleep(300);
    }

    // Re-check which panel the month is on
    const cur2 = getDisplayedMonth();
    const isLeftPanel = (year === cur2.year && month === cur2.month);

    // Get all date table cells; left panel = first table, right = second
    const tables = document.querySelectorAll('.eds-date-table');
    const table = isLeftPanel ? tables[0] : tables[1];
    if (!table) return;

    const cells = [...table.querySelectorAll('.eds-date-table__cell')]
      .filter(c => {
        const txt = c.textContent.trim();
        const cls = String(c.className);
        return txt === String(day) && !cls.includes('out-of-month') && !cls.includes('disabled');
      });

    if (cells.length > 0) {
      cells[0].click();
      await sleep(200);
    }
  }

  async function run() {
    // 1. Guard: background.js navigates to /sale/order before injecting this script.
    // If somehow we end up on the wrong page, bail — location.href would destroy
    // this script context immediately so there is nothing useful we can do here.
    if (!location.pathname.includes('/sale/order')) {
      console.warn('[OrderExporter] Wrong page, aborting:', location.pathname);
      return;
    }

    // 2. Click Export button (real class confirmed via live inspection)
    const exportBtn = await waitFor('button.export.export-with-modal');
    exportBtn.click();
    await sleep(1500);

    // 3. Wait for modal
    await waitFor('.eds-modal.export-modal');
    await sleep(500);

    // 4. Click date input to open calendar
    const dateSelector = document.querySelector('.eds-modal.export-modal .eds-selector');
    if (dateSelector) { dateSelector.click(); await sleep(600); }

    // 5. Set dates
    const { from, to } = getTargetDates();

    // Navigate to the FROM month and click it
    await navigateToMonth(from.year, from.month);
    await sleep(400);
    await clickDate(from.year, from.month, from.day);
    await sleep(400);

    // Now click the TO date (may need navigation if different month)
    await clickDate(to.year, to.month, to.day);
    await sleep(600);

    // 6. Click Export button inside modal
    const modal = document.querySelector('.eds-modal.export-modal');
    const confirmBtn = modal?.querySelector('button.eds-button--primary');
    if (confirmBtn) {
      confirmBtn.click();
      console.log('[OrderExporter] Export triggered ✓');
    }
  }

  run().catch(e => console.error('[OrderExporter] Error:', e.message));
}

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'exportNow') {
    triggerExportOnAllTabs().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'exportTab') {
    exportSingleTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'syncAlarm') {
    syncAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(syncAlarm);
chrome.runtime.onStartup.addListener(syncAlarm);
