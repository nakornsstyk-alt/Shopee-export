// content/shopee.js v3
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') sendResponse({ alive: true, url: location.href });
});
