// Runs in ISOLATED world on https://textone.id.vn/* and http://localhost/*
(() => {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'textone-web-main') return;
    const { id, action, payload, url, generationId } = event.data;
    const type = action === 'lan-tts' ? 'web-lan-tts' : action === 'fetch-audio' ? 'web-fetch-audio' : '';
    if (!type) return;
    chrome.runtime.sendMessage({ target: 'background', type, payload, url, generationId })
      .then((response) => {
        window.postMessage({ source: 'textone-web-bridge-reply', id, response: response || { ok: false } }, location.origin);
      })
      .catch((error) => {
        window.postMessage({ source: 'textone-web-bridge-reply', id, response: { ok: false, error: error?.message || 'Extension error' } }, location.origin);
      });
  });

  // Automatically sync newly minted realtime session codes from /realtime into the extension
  let lastSyncedToken = '';
  const checkRealtimeToken = () => {
    if (!location.pathname.startsWith('/realtime')) return;
    const textarea = document.querySelector('textarea[aria-label="Mã phiên"]');
    const token = textarea?.value?.trim() || '';
    if (!token || token === lastSyncedToken || !token.includes('.')) return;
    lastSyncedToken = token;
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'sync-session-token',
      server: location.origin,
      token,
    }).catch(() => { });
  };
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(checkRealtimeToken);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }
  window.addEventListener('DOMContentLoaded', checkRealtimeToken);
})();

