// background.js v4 — real mouse events, Export History auto-download, file rename

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

  for (const tab of tabs) {
    if (!tab.url.includes('/sale/order')) {
      await chrome.tabs.update(tab.id, { url: 'https://seller.shopee.co.th/portal/sale/order' });
      await waitForTabLoad(tab.id);
    }

    // Store brand name so onDeterminingFilename can rename the download
    const brand = (tab.title || '').replace(/Shopee Seller Cent(re|er)[\s–\-|]*/i, '').trim() || 'ShopeeExport';
    await chrome.storage.local.set({ pendingDownloadBrand: brand });

    try {
      chrome.runtime.sendMessage({ action: 'tabProgress', tabId: tab.id, status: 'running' }).catch(() => {});
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: shopeeExportFlow,
        args: [{ ...settings, brandName: brand }]
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
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;

  if (!tab.url.includes('/sale/order')) {
    await chrome.tabs.update(tabId, { url: 'https://seller.shopee.co.th/portal/sale/order' });
    await waitForTabLoad(tabId);
  }

  const brand = (tab.title || '').replace(/Shopee Seller Cent(re|er)[\s–\-|]*/i, '').trim() || 'ShopeeExport';
  await chrome.storage.local.set({ pendingDownloadBrand: brand });

  chrome.runtime.sendMessage({ action: 'tabProgress', tabId, status: 'running' }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId },
    func: shopeeExportFlow,
    args: [{ ...settings, brandName: brand }]
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

// ── Auto-rename Shopee exports on download ─────────────────────────────────
// Fires before the file is saved — lets us rename without touching the file system.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!/Order\.all\.order_creation_date\.\d{8}_\d{8}\.xlsx$/i.test(item.filename)) {
    return; // not a Shopee order export — leave filename as-is
  }

  chrome.storage.local.get('pendingDownloadBrand', ({ pendingDownloadBrand }) => {
    const brand = (pendingDownloadBrand || 'ShopeeExport')
      .replace(/[/\\?%*:|"<>]/g, '_') // strip filesystem-unsafe chars
      .trim() || 'ShopeeExport';

    const match = item.filename.match(/(\d{8}_\d{8})\.xlsx$/i);
    const datePart = match ? match[1] : 'unknown';

    suggest({ filename: `${brand}_${datePart}.xlsx`, conflictAction: 'uniquify' });
  });

  return true; // signal that suggest() will be called asynchronously
});

// ── Main injected automation function ──────────────────────────────────────
// Serialised and injected into the Shopee tab — NO closures allowed.
function shopeeExportFlow({ dateMode, dateFrom, dateTo, brandName }) {

  // Will be overridden with the actual shop name read from the page DOM.
  let effectiveBrand = brandName || 'ShopeeExport';

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Try to read the actual shop/store name from the page DOM.
  // Shopee seller center shows the shop name in the navigation header.
  function getShopNameFromDOM() {
    const selectors = [
      '[class*="shop-name"]', '[class*="shopName"]', '[class*="shop_name"]',
      '[class*="store-name"]', '[class*="storeName"]', '[class*="store_name"]',
      '[class*="seller-name"]', '[class*="sellerName"]', '[class*="seller_name"]',
      '.nav-logo__text', '.header-account__name',
    ];
    for (const sel of selectors) {
      const text = document.querySelector(sel)?.textContent?.trim();
      // Require 2–60 chars to avoid matching empty or page-wide blobs
      if (text && text.length >= 2 && text.length <= 60) return text;
    }
    return '';
  }

  // Dispatch real mouse events so React synthetic handlers fire
  function fireClick(el) {
    if (!el) return;
    ['mousedown', 'mouseup', 'click'].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
  }

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

  // Build { year, month(1-12), day } from date string or day-offset
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
    if (dateMode === 'D-1')  return { from: offset(1),  to: offset(1) };
    if (dateMode === 'D-7')  return { from: offset(7),  to: offset(1) };
    if (dateMode === 'D-30') return { from: offset(30), to: offset(1) };
    if (dateMode === 'custom' && dateFrom && dateTo) return { from: parse(dateFrom), to: parse(dateTo) };
    return { from: offset(1), to: offset(1) };
  }

  // Read the month/year shown on the LEFT calendar panel
  function getDisplayedMonth() {
    const monthNames = ['January','February','March','April','May','June','July',
                        'August','September','October','November','December'];

    // Strategy 1: separate month and year labels ("March" + "2026")
    const labels = [...document.querySelectorAll('.eds-picker-header__label.clickable')];
    if (labels.length >= 2) {
      const t0 = labels[0].textContent.trim();
      const t1 = labels[1].textContent.trim();
      const m = monthNames.indexOf(t0);
      const y = parseInt(t1);
      if (m >= 0 && !isNaN(y)) return { month: m + 1, year: y };
    }

    // Strategy 2: combined label ("March2026" or "March 2026") — same element
    const anyLabel = document.querySelector('.eds-picker-header__label');
    if (anyLabel) {
      const text = anyLabel.textContent.trim();
      const yearMatch = text.match(/(\d{4})/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        for (let i = 0; i < monthNames.length; i++) {
          if (text.includes(monthNames[i])) return { month: i + 1, year };
        }
      }
    }

    // Strategy 3: scan any picker-header element for month + year text
    for (const el of document.querySelectorAll('[class*="picker-header"]')) {
      const text = el.textContent.trim();
      const yearMatch = text.match(/(\d{4})/);
      if (!yearMatch) continue;
      const year = parseInt(yearMatch[1]);
      for (let i = 0; i < monthNames.length; i++) {
        if (text.includes(monthNames[i])) return { month: i + 1, year };
      }
    }

    return null;
  }

  // Use native .click() for navigation arrows — they don't need React event dispatch
  // and fireClick() would triple-trigger the handler (mousedown + mouseup + click).
  function clickPrev() {
    // prev buttons: [«_left, <_left] when both share same class — want the LAST (month-back)
    const btns = [...document.querySelectorAll('.eds-picker-header__prev:not(.disabled)')];
    if (btns.length) { btns[btns.length - 1].click(); return true; }
    return false;
  }

  function clickNext() {
    // next buttons: [>_right, »_right] when both share same class — want the FIRST (month-forward)
    const btns = [...document.querySelectorAll('.eds-picker-header__next:not(.disabled)')];
    if (btns.length) { btns[0].click(); return true; }
    return false;
  }

  async function navigateToMonth(targetYear, targetMonth) {
    for (let i = 0; i < 24; i++) {
      const cur = getDisplayedMonth();
      if (!cur) { await sleep(300); continue; }
      const diff = (targetYear - cur.year) * 12 + (targetMonth - cur.month);
      if (diff === 0) return;
      if (diff < 0) clickPrev(); else clickNext();
      await sleep(400);
    }
  }

  async function clickDate(year, month, day) {
    const cur = getDisplayedMonth();
    if (!cur) return;

    const diffLeft  = (year - cur.year) * 12 + (month - cur.month);
    const diffRight = diffLeft - 1;

    if (diffLeft !== 0 && diffRight !== 0) {
      await navigateToMonth(year, month);
      await sleep(300);
    }

    const cur2 = getDisplayedMonth();
    const isLeft = (year === cur2.year && month === cur2.month);

    const tables = document.querySelectorAll('.eds-date-table');
    const table = isLeft ? tables[0] : tables[1];
    if (!table) return;

    const cell = [...table.querySelectorAll('.eds-date-table__cell')].find(c => {
      const cls = String(c.className);
      return c.textContent.trim() === String(day) &&
             !cls.includes('out-of-month') && !cls.includes('disabled');
    });

    if (cell) {
      fireClick(cell);
      await sleep(200);
    }
  }

  // After the export modal is confirmed, the "Latest Reports" panel appears
  // automatically — no button click needed to open it.
  // The new entry starts as "Processing" text. Poll until it shows an enabled
  // orange "Download" button, then click it.
  // onDeterminingFilename (service worker) renames the resulting file.
  async function waitAndDownload(from, to) {
    await sleep(1500); // brief pause for modal to close and panel to render

    function pad(n) { return String(n).padStart(2, '0'); }
    const fromStr = `${from.year}${pad(from.month)}${pad(from.day)}`;
    const toStr   = `${to.year}${pad(to.month)}${pad(to.day)}`;
    const fragment = `${fromStr}_${toStr}`;
    const safeBrand = effectiveBrand.replace(/[/\\?%*:|"<>]/g, '_');
    const desiredFilename = `${safeBrand}_${fragment}.xlsx`;

    // Find an enabled "Download" button (exact text, not "Downloaded") whose
    // ancestor also contains our date fragment. Walk UP from the button itself
    // so we never accidentally reach a container that holds unrelated rows.
    function findDownloadBtn() {
      // Exact-match: "Download" only, never "Downloaded" or "Downloading"
      const isDownloadBtn = (b) =>
        b.textContent.trim().toLowerCase() === 'download' && !b.disabled;

      for (const btn of document.querySelectorAll('button')) {
        if (!isDownloadBtn(btn)) continue;
        // Walk up from this button — does any ancestor contain our fragment?
        let el = btn.parentElement;
        for (let depth = 0; depth < 8 && el; depth++, el = el.parentElement) {
          if (el.textContent.includes(fragment)) return btn;
        }
      }

      // Fallback: direct anchor href containing the fragment
      for (const anchor of document.querySelectorAll('a[href]')) {
        if (anchor.href.includes(fragment) && !anchor.disabled) return anchor;
      }

      return null;
    }

    const deadline = Date.now() + 3 * 60 * 1000; // wait up to 3 minutes
    while (Date.now() < deadline) {
      const el = findDownloadBtn();
      if (el) {
        if (el.tagName === 'A' && el.href) {
          console.log('[OrderExporter] Downloading via link for', fragment);
          chrome.runtime.sendMessage({
            action: 'downloadExport',
            url: el.href,
            filename: desiredFilename
          });
        } else {
          console.log('[OrderExporter] Clicking Download button for', fragment);
          fireClick(el); // onDeterminingFilename renames the file
        }
        return;
      }
      // Not ready yet (still "Processing") — wait and retry
      await sleep(5000);
    }

    console.warn('[OrderExporter] Timed out waiting for Download button for', fragment);
  }

  async function run() {
    // Guard: background navigates the tab before injection; bail if still wrong page
    if (!location.pathname.includes('/sale/order')) {
      console.warn('[OrderExporter] Wrong page, aborting:', location.pathname);
      return;
    }

    // Override brand name with the actual shop name shown in the page DOM.
    // This is more reliable than deriving it from the tab title.
    const domBrand = getShopNameFromDOM();
    if (domBrand) {
      effectiveBrand = domBrand;
      chrome.storage.local.set({ pendingDownloadBrand: domBrand });
      console.log('[OrderExporter] Brand from DOM:', domBrand);
    }

    // 1. Click the Export button
    const exportBtn = await waitFor('button.export.export-with-modal');
    fireClick(exportBtn);
    await sleep(1500);

    // 2. Wait for the export modal
    await waitFor('.eds-modal.export-modal');
    await sleep(500);

    // 3. Open the date picker
    const dateSelector = document.querySelector('.eds-modal.export-modal .eds-selector');
    if (dateSelector) {
      fireClick(dateSelector);
      await sleep(600);
    }

    // 4. Confirm the calendar is open before trying to click dates
    await waitFor('.eds-date-picker__picker', 5000).catch(() =>
      console.warn('[OrderExporter] Calendar did not open — dates may not be set')
    );
    await sleep(300);

    // 5. Set from / to dates by clicking calendar cells
    const { from, to } = getTargetDates();

    await navigateToMonth(from.year, from.month);
    await sleep(400);
    await clickDate(from.year, from.month, from.day);
    await sleep(400);

    await clickDate(to.year, to.month, to.day);
    await sleep(600);

    // 6. Confirm export inside modal
    const modal = document.querySelector('.eds-modal.export-modal');
    const confirmBtn = modal?.querySelector('button.eds-button--primary');
    if (confirmBtn) {
      fireClick(confirmBtn);
      console.log('[OrderExporter] Export triggered ✓');
    }

    // 7. Open Export History, wait for file, download with brand-prefixed name
    await waitAndDownload(from, to);
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
  if (msg.action === 'downloadExport') {
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      conflictAction: 'uniquify'
    }).then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(syncAlarm);
chrome.runtime.onStartup.addListener(syncAlarm);
