// ─── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function isoDate(n=0){ const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function log(msg, type=''){
  const t = new Date().toLocaleTimeString('en-GB',{hour12:false});
  $('logStrip').innerHTML = `<div class="log-entry ${type}">${t}  ${esc(msg)}</div>`;
}

// ─── State ───────────────────────────────────────────────────────────────────
let tabs = [];
let statuses = {};
let mode = 'D-1';

// ─── Tab detection ───────────────────────────────────────────────────────────
async function refreshTabs() {
  // Safety net: if chrome.tabs.query never settles, clear Loading after 5 s
  const fallbackTimer = setTimeout(() => {
    if ($('tabList').querySelector('.no-tabs')?.textContent.includes('Loading')) {
      $('tabList').innerHTML = `<div class="no-tabs">
        Could not load tabs.<br>
        <a id="openLink">Open Shopee Seller Center ↗</a>
      </div>`;
      $('openLink')?.addEventListener('click', () =>
        chrome.tabs.create({ url: 'https://seller.shopee.co.th/portal/sale/order' })
      );
    }
  }, 5000);
  try {
    const results = await chrome.tabs.query({ url: 'https://seller.shopee.co.th/*' });
    clearTimeout(fallbackTimer);
    tabs = results;
    $('tabCount').textContent = tabs.length;
    renderTabs();
    if (tabs.length > 0) {
      log(`Found ${tabs.length} Shopee tab(s) ✓`, 'ok');
    } else {
      log('No Shopee tabs open yet', 'warn');
    }
  } catch (err) {
    clearTimeout(fallbackTimer);
    tabs = [];
    $('tabCount').textContent = '0';
    $('tabList').innerHTML = `<div class="no-tabs">
      Could not read tabs.<br>
      <a id="openLink">Open Shopee Seller Center ↗</a>
    </div>`;
    $('openLink')?.addEventListener('click', () =>
      chrome.tabs.create({ url: 'https://seller.shopee.co.th/portal/sale/order' })
    );
    log('Tab query failed: ' + err.message, 'err');
  }
}

function renderTabs() {
  const list = $('tabList');
  if (!tabs.length) {
    list.innerHTML = `<div class="no-tabs">
      No Shopee seller tabs found.<br>
      <a id="openLink">Open Shopee Seller Center ↗</a>
    </div>`;
    $('openLink')?.addEventListener('click', () =>
      chrome.tabs.create({ url: 'https://seller.shopee.co.th/portal/sale/order' })
    );
    return;
  }
  list.innerHTML = tabs.map(t => {
    const st = statuses[t.id] || 'idle';
    const label = {idle:'Ready',running:'Exporting…',done:'Done ✓',error:'Error'}[st];
    const title = (t.title||'').replace(/Shopee Seller Cent(re|er)[\s–\-|]*/i,'').trim() || 'Shopee Brand';
    const path  = (t.url||'').replace('https://seller.shopee.co.th','') || '/';
    return `<div class="tab-item">
      <span class="tab-favicon">🛍</span>
      <div class="tab-info">
        <div class="tab-title" title="${esc(t.title)}">${esc(title)}</div>
        <div class="tab-url">${esc(path)}</div>
      </div>
      <span class="tab-status ${st}" data-sid="${t.id}">${esc(label)}</span>
      <button class="tab-btn" data-tid="${t.id}">Export</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tid = Number(btn.dataset.tid);
      await saveSettings();
      setStatus(tid, 'running');
      btn.disabled = true;
      log(`Exporting tab ${tid}…`);
      chrome.runtime.sendMessage({ action: 'exportTab', tabId: tid }, () => {
        setTimeout(() => { setStatus(tid, 'done'); btn.disabled = false; log('Export triggered ✓', 'ok'); }, 9000);
      });
    });
  });
}

function setStatus(tabId, st) {
  statuses[tabId] = st;
  const el = document.querySelector(`.tab-status[data-sid="${tabId}"]`);
  if (!el) return;
  el.className = `tab-status ${st}`;
  el.textContent = {idle:'Ready',running:'Exporting…',done:'Done ✓',error:'Error'}[st];
}

// ─── Preset buttons ──────────────────────────────────────────────────────────
function selectMode(m) {
  mode = m;
  ['D-1','D-7','D-30','custom'].forEach(id => {
    const btn = $('btn-' + id);
    if (btn) btn.classList.toggle('active', id === m);
  });
  const from = $('dateFrom'), to = $('dateTo');
  if (m === 'custom') {
    from.disabled = false; to.disabled = false;
    if (!from.value) from.value = isoDate(7);
    if (!to.value)   to.value   = isoDate(1);
  } else {
    const map = { 'D-1':[1,1], 'D-7':[7,1], 'D-30':[30,1] };
    const [f, t_] = map[m] || [1,1];
    from.value = isoDate(f); to.value = isoDate(t_);
    from.disabled = true; to.disabled = true;
  }
  saveSettings();
}

function updateNextRun() {
  const el = $('nextRun');
  if (!$('schedToggle').checked) { el.textContent = ''; return; }
  const [h,m] = $('schedTime').value.split(':').map(Number);
  const next = new Date(); next.setHours(h,m,0,0);
  if (next <= new Date()) next.setDate(next.getDate()+1);
  el.innerHTML = `Next: <span>${next.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})} ${$('schedTime').value}</span>`;
}

// ─── Settings persistence ────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const s = await chrome.storage.local.get(['dateMode','dateFrom','dateTo','scheduleEnabled','scheduleHour','scheduleMinute']);
    mode = s.dateMode || 'D-1';
    if (s.dateFrom) $('dateFrom').value = s.dateFrom;
    if (s.dateTo)   $('dateTo').value   = s.dateTo;
    selectMode(mode);
    $('schedToggle').checked = !!s.scheduleEnabled;
    const h = String(s.scheduleHour   ?? 8).padStart(2,'0');
    const m = String(s.scheduleMinute ?? 0).padStart(2,'0');
    $('schedTime').value = `${h}:${m}`;
    updateNextRun();
  } catch(e) {
    console.error('loadSettings error', e);
  }
}

async function saveSettings() {
  try {
    const [h,m] = $('schedTime').value.split(':').map(Number);
    await chrome.storage.local.set({
      dateMode: mode,
      dateFrom: $('dateFrom').value,
      dateTo:   $('dateTo').value,
      scheduleEnabled: $('schedToggle').checked,
      scheduleHour: h, scheduleMinute: m
    });
    chrome.runtime.sendMessage({ action: 'syncAlarm' }).catch(()=>{});
  } catch(e) {
    console.error('saveSettings error', e);
  }
}

async function boot() {
  await loadSettings();
  await refreshTabs();
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  $('btn-D-1')   .addEventListener('click', () => selectMode('D-1'));
  $('btn-D-7')   .addEventListener('click', () => selectMode('D-7'));
  $('btn-D-30')  .addEventListener('click', () => selectMode('D-30'));
  $('btn-custom').addEventListener('click', () => selectMode('custom'));

  $('dateFrom').addEventListener('change', saveSettings);
  $('dateTo')  .addEventListener('change', saveSettings);

  $('schedToggle').addEventListener('change', () => { saveSettings(); updateNextRun(); });
  $('schedTime')  .addEventListener('change', () => { saveSettings(); updateNextRun(); });

  $('exportBtn').addEventListener('click', async () => {
    if (!tabs.length) {
      log('No Shopee tabs found. Open seller.shopee.co.th first.', 'err');
      return;
    }
    await saveSettings();
    const btn = $('exportBtn');
    btn.disabled = true;
    $('btnIcon').innerHTML = '<div class="spinner"></div>';
    $('btnText').textContent = `Exporting ${tabs.length} brand(s)…`;
    tabs.forEach(t => setStatus(t.id, 'running'));
    log(`Starting export on ${tabs.length} tab(s)…`);

    chrome.runtime.sendMessage({ action: 'exportNow' }, () => {
      setTimeout(() => {
        tabs.forEach(t => { if (statuses[t.id] === 'running') setStatus(t.id, 'done'); });
        btn.disabled = false;
        $('btnIcon').textContent = '✓';
        $('btnText').textContent = 'Export All Brands Now';
        log(`Export complete on ${tabs.length} tab(s) ✓`, 'ok');
        setTimeout(() => { $('btnIcon').textContent = '⬇'; }, 2500);
      }, tabs.length * 9000);
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'tabProgress') setStatus(msg.tabId, msg.status);
  });

  boot();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshTabs();
  });

});
