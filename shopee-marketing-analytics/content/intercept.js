// Runs at document_start in MAIN world — intercepts fetch & XHR before page JS loads.
// Collects all JSON API responses and stores them in window.__shopeeAdsResponses__.
// Background script polls this array to retrieve marketing data.

(function () {
  if (window.__shopeeAdsInterceptInstalled__) return;
  window.__shopeeAdsInterceptInstalled__ = true;
  window.__shopeeAdsResponses__ = [];

  const AD_KEYWORDS = [
    'performance', 'ads_performance', 'trend', 'hourly',
    'pas', 'cpc', 'campaign', 'report', 'analytic'
  ];

  function looksLikeAdsData(url, data) {
    if (!data || typeof data !== 'object') return false;
    const urlLower = url.toLowerCase();
    if (AD_KEYWORDS.some(k => urlLower.includes(k))) return true;
    // Check response shape: must have some hourly/trend array
    const str = JSON.stringify(data).toLowerCase();
    return str.includes('hourly') || str.includes('trend') || str.includes('impression');
  }

  function storeResponse(url, data) {
    if (!looksLikeAdsData(url, data)) return;
    const entry = { url, data, ts: Date.now() };
    window.__shopeeAdsResponses__.push(entry);
    window.dispatchEvent(new CustomEvent('shopeeAdsDataCaptured', { detail: entry }));
  }

  // --- Intercept fetch ---
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return originalFetch.apply(this, arguments).then(function (response) {
      try {
        const clone = response.clone();
        clone.json().then(function (data) {
          storeResponse(url, data);
        }).catch(function () {});
      } catch (e) {}
      return response;
    });
  };

  // --- Intercept XMLHttpRequest ---
  const OrigXHR = window.XMLHttpRequest;
  function InterceptedXHR() {
    const xhr = new OrigXHR();
    let _url = '';

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url) {
      _url = url;
      return origOpen.apply(xhr, arguments);
    };

    xhr.addEventListener('load', function () {
      try {
        const data = JSON.parse(xhr.responseText);
        storeResponse(_url, data);
      } catch (e) {}
    });

    return xhr;
  }
  InterceptedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = InterceptedXHR;
})();
