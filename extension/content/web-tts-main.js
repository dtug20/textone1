// Runs in MAIN world on https://textone.id.vn/* at document_start.
// Bridges Web TTS generation requests directly to the LAN model on 192.168.1.198:18803
// (persisting to DB + R2 via the extension background worker) and proxies R2 audio
// fetches through the extension worker so WaveSurfer plays without CORS errors.
(() => {
  if (globalThis.__textoneWebTtsHook) return;
  globalThis.__textoneWebTtsHook = true;

  const pending = new Map();
  const audioCache = new Map();
  let seq = 0;

  const base64ToBytes = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  const rememberAudio = (id, b64) => {
    if (!id || !b64) return;
    try {
      audioCache.set(id, b64);
      if (b64.length < 2_500_000) sessionStorage.setItem(`textone_wav_${id}`, b64);
    } catch { /* Ignore storage quota errors. */ }
  };

  const recallAudio = (id) => {
    if (!id) return null;
    const mem = audioCache.get(id);
    if (mem) return mem;
    try {
      const stored = sessionStorage.getItem(`textone_wav_${id}`);
      if (stored) {
        audioCache.set(id, stored);
        return stored;
      }
    } catch { /* Ignore storage errors. */ }
    return null;
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'textone-web-bridge-reply') return;
    const resolver = pending.get(event.data.id);
    if (!resolver) return;
    pending.delete(event.data.id);
    resolver(event.data.response);
  });

  const askBridge = (action, data, timeoutMs = 25000) => new Promise((resolve) => {
    const id = `req_${Date.now()}_${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'Bridge timeout' });
    }, timeoutMs);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response || { ok: false });
    });
    window.postMessage({ source: 'textone-web-main', id, action, ...data }, location.origin);
  });

  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== 'function') return;

  globalThis.fetch = async function fetch(input, init) {
    let urlString = '';
    try {
      urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url || '';
    } catch { urlString = ''; }

    // 1. Intercept tRPC generations.create to synthesize directly on 192.168.1.198:18803
    if (urlString.includes('/api/trpc/generations.create')) {
      try {
        let rawBody = '';
        if (typeof init?.body === 'string') rawBody = init.body;
        else if (input instanceof Request) rawBody = await input.clone().text();
        if (rawBody) {
          const parsed = JSON.parse(rawBody);
          const isBatch = Array.isArray(parsed) || Object.prototype.hasOwnProperty.call(parsed, '0') || urlString.includes('batch=1');
          const payload = parsed?.['0']?.json ?? parsed?.json ?? parsed;
          if (payload?.text && payload?.voiceId) {
            const orgId = globalThis.Clerk?.organization?.id || '';
            const res = await askBridge('lan-tts', { payload: { ...payload, orgId } }, 30000);
            if (res?.ok && res.id) {
              if (res.audioBase64) rememberAudio(res.id, res.audioBase64);
              const body = isBatch
                ? [{ result: { data: { json: { id: res.id } } } }]
                : { result: { data: { json: { id: res.id } } } };
              return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }
        }
      } catch { /* Fall back to native fetch if parsing or bridge fails. */ }
    }

    // 2. Intercept R2 media.textone.id.vn or /api/audio/[id] to serve cached or CORS-proxied WAV
    if (urlString.startsWith('https://media.textone.id.vn/') || urlString.includes('/api/audio/')) {
      try {
        const cleanUrl = urlString.split('?')[0];
        const generationId = cleanUrl.split('/').filter(Boolean).pop() || '';
        const cachedB64 = recallAudio(generationId);
        if (cachedB64) {
          return new Response(base64ToBytes(cachedB64), {
            status: 200,
            headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=3600' },
          });
        }
        if (urlString.startsWith('https://media.textone.id.vn/')) {
          const proxied = await askBridge('fetch-audio', { url: urlString, generationId }, 20000);
          if (proxied?.ok && proxied.audioBase64) {
            rememberAudio(generationId, proxied.audioBase64);
            return new Response(base64ToBytes(proxied.audioBase64), {
              status: 200,
              headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=3600' },
            });
          }
        }
      } catch { /* Fall back to native fetch. */ }
    }

    return nativeFetch.apply(this, arguments);
  };
})();

