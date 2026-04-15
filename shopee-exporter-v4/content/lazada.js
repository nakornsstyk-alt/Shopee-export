// Lazada Seller Center content script
// Minimal — all automation runs via injected lazadaExportFlow in background.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') sendResponse({ alive: true, url: location.href });
});
