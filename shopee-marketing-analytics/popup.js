// Popup controller for Shopee Ads Analytics Capture extension.

const $ = id => document.getElementById(id);

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function offsetDayStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function setDateRange(from, to) {
  $('dateFrom').value = from;
  $('dateTo').value = to;
}

// ─── UI state ─────────────────────────────────────────────────────────────────

function setStatus(text, cls) {
  const el = $('statusText');
  el.className = 'status-text ' + (cls || 'idle');
  el.innerHTML = text;
}

function setProgress(current, total) {
  const wrap = $('progressWrap');
  const bar = $('progressBar');
  if (total > 0) {
    wrap.style.display = 'block';
    bar.style.width = Math.round((current / total) * 100) + '%';
  } else {
    wrap.style.display = 'none';
    bar.style.width = '0%';
  }
}

function updateStats(days, rows, orders) {
  $('statDays').textContent = days;
  $('statRows').textContent = rows;
  $('statOrders').textContent = orders;
}

function setCapturing(on) {
  $('captureBtn').disabled = on;
  $('captureBtn').innerHTML = on
    ? '<span class="spinner"></span>Capturing…'
    : 'Start Capture';
  $('exportBtn').disabled = on;
  $('clearBtn').disabled = on;
}

// ─── Load stored data on open ─────────────────────────────────────────────────

async function loadStoredData() {
  const { capturedRows } = await chrome.storage.local.get('capturedRows');
  const rows = capturedRows || [];
  if (rows.length > 0) {
    const days = new Set(rows.map(r => r.date)).size;
    const orders = rows.reduce((s, r) => s + (r.orders || 0), 0);
    updateStats(days, rows.length, orders);
    $('exportBtn').disabled = false;
    $('clearBtn').disabled = false;
    setStatus(`${rows.length} rows from ${days} day(s) ready to export.`, 'success');
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Default: yesterday
  setDateRange(offsetDayStr(-1), offsetDayStr(-1));

  await loadStoredData();

  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      if (p === 'today') setDateRange(todayStr(), todayStr());
      else if (p === 'yesterday') setDateRange(offsetDayStr(-1), offsetDayStr(-1));
      else if (p === '7d') setDateRange(offsetDayStr(-7), offsetDayStr(-1));
      else if (p === '30d') setDateRange(offsetDayStr(-30), offsetDayStr(-1));
      else if (p === 'thismonth') setDateRange(firstOfMonth(), todayStr());
    });
  });

  // Start capture
  $('captureBtn').addEventListener('click', async () => {
    const dateFrom = $('dateFrom').value;
    const dateTo = $('dateTo').value;

    if (!dateFrom || !dateTo) {
      setStatus('Please select both start and end dates.', 'error');
      return;
    }
    if (dateFrom > dateTo) {
      setStatus('Start date must be before or equal to end date.', 'error');
      return;
    }

    setCapturing(true);
    setProgress(0, 1);
    setStatus('<span class="spinner"></span>Starting capture…', 'running');

    chrome.runtime.sendMessage({ action: 'startCapture', dateFrom, dateTo });
  });

  // Export CSV
  $('exportBtn').addEventListener('click', () => {
    $('exportBtn').disabled = true;
    $('exportBtn').textContent = 'Exporting…';
    chrome.runtime.sendMessage({ action: 'exportCSV' }, (resp) => {
      $('exportBtn').disabled = false;
      $('exportBtn').textContent = 'Export CSV';
      if (resp && resp.ok) {
        setStatus(`Exported: ${resp.filename}`, 'success');
      } else {
        setStatus('Export failed: ' + (resp?.error || 'unknown error'), 'error');
      }
    });
  });

  // Clear data
  $('clearBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearData' }, () => {
      updateStats(0, 0, 0);
      $('exportBtn').disabled = true;
      $('clearBtn').disabled = true;
      setProgress(0, 0);
      setStatus('Data cleared.', 'idle');
    });
  });

  // Listen for progress messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'captureStarted') {
      setProgress(0, msg.total);
    } else if (msg.type === 'progress') {
      setProgress(msg.current, msg.total);
      setStatus(
        `<span class="spinner"></span>Day ${msg.current} of ${msg.total}: ${msg.date} — ${msg.rowsCollected} rows so far`,
        'running'
      );
      updateStats(msg.current, msg.rowsCollected, '…');
    } else if (msg.type === 'captureComplete') {
      setCapturing(false);
      setProgress(1, 1);
      $('exportBtn').disabled = false;
      $('clearBtn').disabled = false;
      // Reload full stats from storage
      loadStoredData().then(() => {
        setStatus(`Capture complete — ${msg.rowCount} hourly rows collected.`, 'success');
      });
    } else if (msg.type === 'error') {
      setCapturing(false);
      setProgress(0, 0);
      setStatus('Error: ' + msg.message, 'error');
    }
  });

  // Poll background status in case popup was closed during capture
  const { running, current, total, rowCount, date } = await chrome.runtime.sendMessage({ action: 'getStatus' }).catch(() => ({}));
  if (running) {
    setCapturing(true);
    setProgress(current || 0, total || 1);
    setStatus(
      `<span class="spinner"></span>Day ${(current || 0) + 1} of ${total || '?'}: ${date || ''} — ${rowCount || 0} rows so far`,
      'running'
    );
  }
});
