// background.js v5 — multi-platform: Shopee + Lazada

// ── Helpers ─────────────────────────────────────────────────────────────────
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

function detectPlatformFromUrl(url) {
  if (url.includes('seller.shopee.')) return 'shopee';
  if (url.includes('sellercenter.lazada.')) return 'lazada';
  return 'unknown';
}

function extractBrandFromTitle(title, platform) {
  if (platform === 'shopee') return (title || '').replace(/Shopee Seller Cent(re|er)[\s–\-|]*/i, '').trim();
  if (platform === 'lazada') return (title || '').replace(/Lazada Seller Cent(re|er)[\s–\-|]*/i, '').trim();
  return (title || '').trim();
}

// Compute { from, to } date objects from stored settings
function computeDateRange(settings) {
  const { dateMode, dateFrom, dateTo } = settings;
  function offset(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  function parse(str) {
    const d = new Date(str);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  if (dateMode === 'D-1')  return { from: offset(1),  to: offset(1) };
  if (dateMode === 'D-7')  return { from: offset(7),  to: offset(1) };
  if (dateMode === 'D-30') return { from: offset(30), to: offset(1) };
  if (dateMode === 'custom' && dateFrom && dateTo) return { from: parse(dateFrom), to: parse(dateTo) };
  return { from: offset(1), to: offset(1) };
}

// ── Platform config ──────────────────────────────────────────────────────────
// Each platform entry describes how to find tabs and which flow to inject.
// lazadaExportFlow is a stub pending DOM inspection — see §lazadaExportFlow below.
const PLATFORM_CONFIG = {
  shopee: {
    patterns:  ['https://seller.shopee.co.th/*'],
    orderPath: '/portal/sale/order',
    flow:      shopeeExportFlow,
  },
  lazada: {
    patterns:  ['https://sellercenter.lazada.co.th/*', 'https://sellercenter.lazada.sg/*'],
    orderPath: '/order/orderList',
    flow:      lazadaExportFlow,
  },
};

// ── Alarm scheduler ──────────────────────────────────────────────────────────
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

// ── Export coordinator ───────────────────────────────────────────────────────
async function triggerExportOnAllTabs() {
  const settings = await chrome.storage.local.get(['dateMode', 'dateFrom', 'dateTo']);

  for (const [platformKey, cfg] of Object.entries(PLATFORM_CONFIG)) {
    const tabArrays = await Promise.all(cfg.patterns.map(p => chrome.tabs.query({ url: p })));
    const platformTabs = tabArrays.flat();
    for (const tab of platformTabs) {
      try {
        await runExportOnTab(tab, platformKey, cfg, settings);
      } catch (e) {
        console.error('[Exporter] Tab', tab.id, e);
        chrome.runtime.sendMessage({ action: 'tabProgress', tabId: tab.id, status: 'error' }).catch(() => {});
      }
    }
  }
}

async function exportSingleTab(tabId) {
  const settings = await chrome.storage.local.get(['dateMode', 'dateFrom', 'dateTo']);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;

  const platformKey = detectPlatformFromUrl(tab.url);
  const cfg = PLATFORM_CONFIG[platformKey];
  if (!cfg) {
    console.warn('[Exporter] Unknown platform for tab', tabId, tab.url);
    return;
  }

  try {
    await runExportOnTab(tab, platformKey, cfg, settings);
  } catch (e) {
    console.error('[Exporter] Tab', tabId, e);
    chrome.runtime.sendMessage({ action: 'tabProgress', tabId, status: 'error' }).catch(() => {});
  }
}

async function runExportOnTab(tab, platformKey, cfg, settings) {
  // Navigate to orders page if not already there
  const orderPathSegment = cfg.orderPath.replace(/^\//, '').split('/')[0];
  if (!tab.url.includes(orderPathSegment)) {
    const origin = tab.url.match(/https?:\/\/[^/]+/)?.[0] || '';
    await chrome.tabs.update(tab.id, { url: origin + cfg.orderPath });
    await waitForTabLoad(tab.id);
    // Re-fetch tab so url/title are fresh after navigation
    tab = await chrome.tabs.get(tab.id).catch(() => tab);
  }

  const brand = extractBrandFromTitle(tab.title, platformKey) || platformKey + 'Export';

  // Pre-compute date fragment so onDeterminingFilename can use it for Lazada renames
  const { from, to } = computeDateRange(settings);
  const pad = n => String(n).padStart(2, '0');
  const dateFragment = `${from.year}${pad(from.month)}${pad(from.day)}_${to.year}${pad(to.month)}${pad(to.day)}`;

  await chrome.storage.local.set({
    pendingDownloadBrand:        brand,
    pendingDownloadPlatform:     platformKey,
    pendingDownloadDateFragment: dateFragment,
  });

  chrome.runtime.sendMessage({ action: 'tabProgress', tabId: tab.id, status: 'running' }).catch(() => {});

  // platformName is capitalized for use in filenames (e.g. 'Shopee', 'Lazada')
  const platformName = platformKey.charAt(0).toUpperCase() + platformKey.slice(1);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func:   cfg.flow,
    args:   [{ ...settings, brandName: brand, platformName }],
  });
}

// ── Auto-rename downloads ────────────────────────────────────────────────────
// Shopee: filename matches known pattern → rename directly from it.
// Lazada: filename is a random 32-char hex hash → rename using stored context.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const basename = item.filename.split(/[/\\]/).pop();
  const isShopeeExport = /Order\.all\.order_creation_date\.\d{8}_\d{8}\.xlsx$/i.test(basename);
  const isLazadaExport = /^[a-f0-9]{32}\.xlsx$/i.test(basename);

  if (!isShopeeExport && !isLazadaExport) return; // not ours — leave as-is

  chrome.storage.local.get(
    ['pendingDownloadBrand', 'pendingDownloadPlatform', 'pendingDownloadDateFragment'],
    ({ pendingDownloadBrand, pendingDownloadPlatform, pendingDownloadDateFragment }) => {
      const brand = (pendingDownloadBrand || 'Export')
        .replace(/[/\\?%*:|"<>]/g, '_').trim() || 'Export';

      // Platform display name for filename prefix (Shopee / Lazada / TikTok …)
      const PLATFORM_DISPLAY = { shopee: 'Shopee', lazada: 'Lazada', tiktok: 'TikTok' };
      const platformDisplay = PLATFORM_DISPLAY[pendingDownloadPlatform] || 'Export';

      if (isShopeeExport) {
        const match = basename.match(/(\d{8}_\d{8})\.xlsx$/i);
        const datePart = match ? match[1] : 'unknown';
        suggest({ filename: `${platformDisplay}_${brand}_${datePart}.xlsx`, conflictAction: 'uniquify' });

      } else if (isLazadaExport && pendingDownloadPlatform === 'lazada') {
        const datePart = pendingDownloadDateFragment || 'unknown';
        suggest({ filename: `${platformDisplay}_${brand}_${datePart}.xlsx`, conflictAction: 'uniquify' });
        // Clear platform flag to avoid accidentally renaming other xlsx files
        chrome.storage.local.remove('pendingDownloadPlatform');
      }
    }
  );

  return true; // async suggest
});

// ── Shopee export flow ───────────────────────────────────────────────────────
// Serialised and injected into the Shopee tab — NO closures allowed.
function shopeeExportFlow({ dateMode, dateFrom, dateTo, brandName, platformName }) {

  let effectiveBrand = brandName || 'ShopeeExport';
  const platform = platformName || 'Shopee';

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getShopNameFromDOM() {
    const selectors = [
      '.subaccount-name',                                          // confirmed Shopee selector
      '[class*="shop-name"]', '[class*="shopName"]', '[class*="shop_name"]',
      '[class*="store-name"]', '[class*="storeName"]', '[class*="store_name"]',
      '[class*="seller-name"]', '[class*="sellerName"]', '[class*="seller_name"]',
      '[class*="subaccount"]', '[class*="account-name"]',
      '.nav-logo__text', '.header-account__name',
    ];
    for (const sel of selectors) {
      const text = document.querySelector(sel)?.textContent?.trim();
      if (text && text.length >= 2 && text.length <= 60) return text;
    }
    return '';
  }

  function fireClick(el) {
    if (!el) return;
    ['mousedown', 'mouseup', 'click'].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
  }

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

  function getDisplayedMonth() {
    const monthNames = ['January','February','March','April','May','June','July',
                        'August','September','October','November','December'];

    const labels = [...document.querySelectorAll('.eds-picker-header__label.clickable')];
    if (labels.length >= 2) {
      const m = monthNames.indexOf(labels[0].textContent.trim());
      const y = parseInt(labels[1].textContent.trim());
      if (m >= 0 && !isNaN(y)) return { month: m + 1, year: y };
    }

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

  function clickPrev() {
    const btns = [...document.querySelectorAll('.eds-picker-header__prev:not(.disabled)')];
    if (btns.length) { btns[btns.length - 1].click(); return true; }
    return false;
  }

  function clickNext() {
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

  async function waitAndDownload(from, to) {
    await sleep(1500);

    function pad(n) { return String(n).padStart(2, '0'); }
    const fromStr = `${from.year}${pad(from.month)}${pad(from.day)}`;
    const toStr   = `${to.year}${pad(to.month)}${pad(to.day)}`;
    const fragment = `${fromStr}_${toStr}`;
    const safeBrand = effectiveBrand.replace(/[/\\?%*:|"<>]/g, '_');
    const desiredFilename = `${platform}_${safeBrand}_${fragment}.xlsx`;

    function findProcessingRow() {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim().toLowerCase().includes('processing')) continue;
        let el = node.parentElement;
        for (let d = 0; d < 10 && el; d++, el = el.parentElement) {
          if (el.textContent.includes(fragment)) return el;
        }
      }
      return null;
    }

    function findDownloadInScope(scope) {
      const isDownloadBtn = b =>
        b.textContent.trim().toLowerCase() === 'download' && !b.disabled;

      if (scope) {
        for (const btn of scope.querySelectorAll('button')) {
          if (isDownloadBtn(btn)) return btn;
        }
        return null;
      }
      for (const btn of document.querySelectorAll('button')) {
        if (!isDownloadBtn(btn)) continue;
        let el = btn.parentElement;
        for (let depth = 0; depth < 8 && el; depth++, el = el.parentElement) {
          if (el.textContent.includes(fragment)) return btn;
        }
      }
      for (const anchor of document.querySelectorAll('a[href]')) {
        if (anchor.href.includes(fragment) && !anchor.disabled) return anchor;
      }
      return null;
    }

    // Phase 1: wait for "Processing" row (up to 30 s)
    let ourRow = null;
    let rowParent = null;
    let rowIndex = -1;
    const phase1Deadline = Date.now() + 30000;

    console.log('[OrderExporter] Phase 1: waiting for Processing entry for', fragment);
    while (Date.now() < phase1Deadline) {
      const row = findProcessingRow();
      if (row) {
        ourRow    = row;
        rowParent = row.parentElement;
        rowIndex  = rowParent ? Array.from(rowParent.children).indexOf(row) : -1;
        console.log('[OrderExporter] Phase 1 done — Processing row at index', rowIndex);
        break;
      }
      await sleep(2000);
    }

    if (!ourRow) {
      console.warn('[OrderExporter] Phase 1 timeout — no Processing row found; will search globally');
    }

    // Phase 2: wait for Download button (up to 3 min)
    const downloadDeadline = Date.now() + 3 * 60 * 1000;

    while (Date.now() < downloadDeadline) {
      let el = null;

      if (ourRow) {
        if (!document.body.contains(ourRow)) {
          if (rowParent && document.body.contains(rowParent) && rowIndex >= 0) {
            const refreshed = rowParent.children[rowIndex];
            if (refreshed && refreshed.textContent.includes(fragment)) {
              ourRow = refreshed;
            } else {
              ourRow = null;
            }
          } else {
            ourRow = null;
          }
        }
        if (ourRow) el = findDownloadInScope(ourRow);
      }

      if (!el && !ourRow) {
        el = findDownloadInScope(null);
      }

      if (el) {
        if (el.tagName === 'A' && el.href) {
          console.log('[OrderExporter] Downloading via link for', fragment);
          chrome.runtime.sendMessage({ action: 'downloadExport', url: el.href, filename: desiredFilename });
        } else {
          console.log('[OrderExporter] Clicking Download button for', fragment);
          fireClick(el);
        }
        return;
      }

      await sleep(5000);
    }

    console.warn('[OrderExporter] Timed out waiting for Download button for', fragment);
  }

  async function run() {
    if (!location.pathname.includes('/sale/order')) {
      console.warn('[OrderExporter] Wrong page, aborting:', location.pathname);
      return;
    }

    const domBrand = getShopNameFromDOM();
    if (domBrand) {
      effectiveBrand = domBrand;
      chrome.storage.local.set({ pendingDownloadBrand: domBrand });
      console.log('[OrderExporter] Brand from DOM:', domBrand);
    }

    const exportBtn = await waitFor('button.export.export-with-modal');
    fireClick(exportBtn);
    await sleep(1500);

    await waitFor('.eds-modal.export-modal');
    await sleep(500);

    const dateSelector = document.querySelector('.eds-modal.export-modal .eds-selector');
    if (dateSelector) {
      fireClick(dateSelector);
      await sleep(600);
    }

    await waitFor('.eds-date-picker__picker', 5000).catch(() =>
      console.warn('[OrderExporter] Calendar did not open — dates may not be set')
    );
    await sleep(300);

    const { from, to } = getTargetDates();

    await navigateToMonth(from.year, from.month);
    await sleep(400);
    await clickDate(from.year, from.month, from.day);
    await sleep(400);

    await clickDate(to.year, to.month, to.day);
    await sleep(600);

    const modal = document.querySelector('.eds-modal.export-modal');
    const confirmBtn = modal?.querySelector('button.eds-button--primary');
    if (confirmBtn) {
      fireClick(confirmBtn);
      console.log('[OrderExporter] Export triggered ✓');
    }

    await waitAndDownload(from, to);
  }

  run().catch(e => console.error('[OrderExporter] Error:', e.message));
}

// ── Lazada export flow ───────────────────────────────────────────────────────
// Serialised and injected into the Lazada tab — NO closures from background scope.
// Selectors confirmed via live DOM inspection (Alibaba Fusion "next" component library).
function lazadaExportFlow({ dateMode, dateFrom, dateTo, brandName, platformName }) {

  // Shop name is not exposed in the Lazada DOM; use the tab-title-derived brandName.
  const effectiveBrand = brandName || 'LazadaExport';
  void platformName; // passed through to onDeterminingFilename via storage

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function fireClick(el) {
    if (!el) return;
    ['mousedown', 'mouseup', 'click'].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
  }

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

  // Lazada calendar uses Thai month names (Alibaba Fusion "next" component library)
  const THAI_MONTHS = [
    'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'
  ];

  // Read the month/year currently shown in the LEFT calendar panel.
  // Left panel header has two buttons: [0] = Thai month name, [1] = year number.
  function getLeftPanelMonth() {
    const header = document.querySelector('.next-calendar-panel-header-left');
    if (!header) return null;
    const btns      = [...header.querySelectorAll('button')];
    const monthText = btns[0]?.textContent?.trim();
    const yearText  = btns[1]?.textContent?.trim();
    const monthIdx  = THAI_MONTHS.indexOf(monthText);
    const year      = parseInt(yearText, 10);
    if (monthIdx < 0 || isNaN(year)) return null;
    return { month: monthIdx + 1, year };
  }

  // Navigate the two-panel range picker until the left panel shows targetYear/targetMonth.
  async function navigateToLeftMonth(targetYear, targetMonth) {
    for (let i = 0; i < 24; i++) {
      const cur = getLeftPanelMonth();
      if (!cur) { await sleep(300); continue; }
      const diff = (targetYear - cur.year) * 12 + (targetMonth - cur.month);
      if (diff === 0) return;
      if (diff < 0) {
        const btn = document.querySelector('.next-calendar-panel-header-left .next-calendar-btn-prev-month')
                 || document.querySelector('.next-calendar-btn-prev-month');
        if (btn) fireClick(btn);
      } else {
        const btn = document.querySelector('.next-calendar-panel-header-right .next-calendar-btn-next-month')
                 || document.querySelector('.next-calendar-btn-next-month');
        if (btn) fireClick(btn);
      }
      await sleep(400);
    }
  }

  // Click the cell for `day` inside the given panel (left or right).
  // Skips cells that overflow from the previous/next month.
  function clickDateInPanel(panelSelector, day) {
    const cells = document.querySelectorAll(`${panelSelector} .next-calendar-cell`);
    for (const cell of cells) {
      const cls = cell.className;
      if (cls.includes('prev-month') || cls.includes('next-month')) continue;
      const dateEl = cell.querySelector('.next-calendar-date');
      if (dateEl && dateEl.textContent.trim() === String(day)) {
        fireClick(cell);
        return true;
      }
    }
    return false;
  }

  async function setDateRange(from, to) {
    // 1. Click "กำหนดเอง" (Custom) tag to reveal the date-range picker
    const customTag = [...document.querySelectorAll('.next-tag-checkable')].find(el =>
      (el.querySelector('.next-tag-body') || el).textContent.trim().includes('กำหนดเอง')
    );
    if (!customTag) {
      console.warn('[OrderExporter-Lazada] Custom date tag not found');
      return false;
    }
    fireClick(customTag);
    await sleep(600);

    // 2. Click the range-picker trigger to open the calendar
    const trigger = document.querySelector('.next-range-picker-trigger');
    if (!trigger) {
      console.warn('[OrderExporter-Lazada] Date range trigger not found');
      return false;
    }
    fireClick(trigger);
    await waitFor('.next-calendar-range', 5000).catch(() =>
      console.warn('[OrderExporter-Lazada] Calendar did not open in time')
    );
    await sleep(400);

    // 3. Navigate left panel to FROM month
    await navigateToLeftMonth(from.year, from.month);
    await sleep(400);

    // 4. Click FROM date in left panel
    if (!clickDateInPanel('.next-calendar-body-left', from.day)) {
      console.warn('[OrderExporter-Lazada] FROM date cell not found:', from);
    }
    await sleep(400);

    // 5. Click TO date
    // After clicking FROM, left panel = FROM month, right panel = FROM month + 1.
    // For TO in the same month as FROM → click in left panel.
    // For TO one month ahead          → click in right panel (already visible).
    // For TO N months ahead (N > 1)   → advance (N-1) more times, then click in right panel.
    const fromOrdinal = from.year * 12 + from.month;
    const toOrdinal   = to.year   * 12 + to.month;
    const diff        = toOrdinal - fromOrdinal;

    if (diff === 0) {
      // Same month as FROM — use left panel
      if (!clickDateInPanel('.next-calendar-body-left', to.day)) {
        console.warn('[OrderExporter-Lazada] TO date cell not found in left panel:', to);
      }
    } else {
      // Advance until right panel shows TO month (right = left + 1, so advance diff-1 extra times)
      for (let i = 0; i < diff - 1; i++) {
        const btn = document.querySelector('.next-calendar-panel-header-right .next-calendar-btn-next-month')
                 || document.querySelector('.next-calendar-btn-next-month');
        if (btn) fireClick(btn);
        await sleep(400);
      }
      if (!clickDateInPanel('.next-calendar-body-right', to.day)) {
        console.warn('[OrderExporter-Lazada] TO date cell not found in right panel:', to);
      }
    }
    await sleep(400);

    // 6. Click the confirm button "กำหนด"
    const footer = document.querySelector('.next-date-picker-panel-footer');
    const confirmBtn = footer
      ? [...footer.querySelectorAll('button')].find(b => b.textContent.trim() === 'กำหนด')
      : [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'กำหนด');
    if (confirmBtn) {
      fireClick(confirmBtn);
      console.log('[OrderExporter-Lazada] Date range confirmed ✓');
    } else {
      console.warn('[OrderExporter-Lazada] Confirm button (กำหนด) not found');
    }
    await sleep(800);
    return true;
  }

  async function triggerExport() {
    // Open the "ส่งออก" (Export) split-button menu
    const menuBtn = document.querySelector('button.next-menu-btn');
    if (!menuBtn) {
      console.warn('[OrderExporter-Lazada] Export menu button not found');
      return false;
    }
    fireClick(menuBtn);
    await sleep(600);

    // Click "Export All" from the dropdown
    const exportAllItem = [...document.querySelectorAll('.next-menu-item')]
      .find(el => el.textContent.trim().includes('Export All'));
    if (!exportAllItem) {
      console.warn('[OrderExporter-Lazada] "Export All" menu item not found');
      return false;
    }
    fireClick(exportAllItem);
    console.log('[OrderExporter-Lazada] Export All triggered ✓');
    // Lazada download is immediate — onDeterminingFilename handles rename
    return true;
  }

  async function run() {
    if (!location.pathname.includes('/order')) {
      console.warn('[OrderExporter-Lazada] Wrong page, aborting:', location.pathname);
      return;
    }

    console.log('[OrderExporter-Lazada] Starting export for brand:', effectiveBrand);

    const { from, to } = getTargetDates();
    const ok = await setDateRange(from, to);
    if (!ok) {
      console.warn('[OrderExporter-Lazada] Failed to set date range — aborting');
      return;
    }

    await sleep(500);
    await triggerExport();
  }

  run().catch(e => console.error('[OrderExporter-Lazada] Error:', e.message));
}

// ── Message handler ──────────────────────────────────────────────────────────
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
