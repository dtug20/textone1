// Runs in YouTube's MAIN world at document_start. YouTube answers /api/timedtext
// with HTTP 200 and an empty body unless the request carries the proof-of-origin
// token (`pot`) the player just minted. Remember those URLs and the body the
// player already received, so a later refetch is unnecessary. Nothing leaves the page.
(() => {
  if (globalThis.__textoneTimedtextHook) return;
  globalThis.__textoneTimedtextHook = true;
  const seen = globalThis.__textoneTimedtext = globalThis.__textoneTimedtext || [];
  const bodies = globalThis.__textoneTimedtextBodies = globalThis.__textoneTimedtextBodies || [];
  const timedtextUrl = (value) => {
    try {
      const url = new URL(String(value?.url ?? value), location.href);
      if (url.protocol !== 'https:' || !/(^|\.)youtube\.com$/.test(url.hostname) || url.pathname !== '/api/timedtext') return null;
      return url;
    } catch { return null; }
  };
  const rememberUrl = (url) => {
    if (!url?.searchParams.get('pot')) return;
    seen.push(url.toString());
    if (seen.length > 20) seen.splice(0, seen.length - 20);
  };
  const rememberBody = (url, body) => {
    if (!url || !body || body.length < 40 || body.length > 2000000) return;
    if (!/^\s*(?:\)\]\}')?\s*[{\[<]/.test(body)) return;
    const lang = (url.searchParams.get('lang') || '').toLowerCase().split('-')[0];
    const tlang = url.searchParams.get('tlang') || '';
    const videoId = url.searchParams.get('v') || '';
    const kind = url.searchParams.get('kind') || '';
    const existing = bodies.findIndex(item => item.videoId === videoId && item.lang === lang && item.tlang === tlang && item.kind === kind);
    if (existing >= 0) bodies.splice(existing, 1);
    bodies.push({
      url: url.toString(), body,
      lang, tlang, videoId, kind,
    });
    if (bodies.length > 8) bodies.splice(0, bodies.length - 8);
  };
  const readXhrBody = (xhr) => {
    try {
      const type = xhr.responseType || '';
      if (!type || type === 'text') return Promise.resolve(String(xhr.responseText || ''));
      if (type === 'json' && xhr.response) return Promise.resolve(JSON.stringify(xhr.response));
      if (type === 'arraybuffer' && xhr.response instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(xhr.response));
      if (type === 'blob' && xhr.response && typeof xhr.response.text === 'function') return xhr.response.text();
      if (type === 'document' && xhr.response?.documentElement) return Promise.resolve(xhr.response.documentElement.outerHTML || '');
    } catch { /* Fall through. */ }
    return Promise.resolve('');
  };
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === 'function') {
    globalThis.fetch = function fetch(input) {
      const url = timedtextUrl(input);
      if (url) rememberUrl(url);
      const pending = nativeFetch.apply(this, arguments);
      if (url) Promise.resolve(pending).then((response) => {
        try {
          if (!response?.ok || typeof response.clone !== 'function') return;
          response.clone().text().then((body) => rememberBody(url, body)).catch(() => {});
        } catch { /* The page still receives its own response. */ }
      }).catch(() => {});
      return pending;
    };
  }
  const nativeOpen = globalThis.XMLHttpRequest?.prototype?.open;
  const nativeSend = globalThis.XMLHttpRequest?.prototype?.send;
  if (typeof nativeOpen === 'function') {
    XMLHttpRequest.prototype.open = function open(_method, url) {
      try { this.__textoneTimedtextUrl = timedtextUrl(url); } catch { this.__textoneTimedtextUrl = null; }
      if (this.__textoneTimedtextUrl) rememberUrl(this.__textoneTimedtextUrl);
      return nativeOpen.apply(this, arguments);
    };
  }
  if (typeof nativeSend === 'function') {
    XMLHttpRequest.prototype.send = function send() {
      const url = this.__textoneTimedtextUrl;
      if (url) this.addEventListener('load', function onLoad() {
        try { if (this.status >= 200 && this.status < 300) readXhrBody(this).then((body) => rememberBody(url, body)).catch(() => {}); } catch { /* Ignore a failed read. */ }
      });
      return nativeSend.apply(this, arguments);
    };
  }
})();
