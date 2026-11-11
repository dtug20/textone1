// Runs in YouTube's MAIN world through chrome.scripting.executeScript. The
// caption request stays in the user's tab; cookies and caption URLs never leave
// the page. Only bounded timestamped text is returned to the extension.
export async function collectYouTubeCaptions(sourceLanguage, targetLanguage) {
  // Diagnostic steps returned to the service worker. URLs are reduced to the
  // parameters that matter; the `pot` value itself is never recorded.
  const trace = [];
  const note = (step, data = {}) => { if (trace.length < 120) trace.push({ step, ms: Math.round(performance.now() - began), ...data }); };
  const began = performance.now();
  const describe = value => {
    try {
      const url = new URL(value, location.href);
      return { path: url.pathname, lang: url.searchParams.get('lang') || '', kind: url.searchParams.get('kind') || '', fmt: url.searchParams.get('fmt') || '', tlang: url.searchParams.get('tlang') || '', pot: url.searchParams.has('pot'), xpe: url.searchParams.get('exp') === 'xpe', c: url.searchParams.get('c') || '' };
    } catch { return { invalid: true }; }
  };
  const fail = reason => { note('give-up', { reason }); return { cues: [], reason, trace }; };
  try {
    const maxSentenceSeconds = 18;
    const player = document.querySelector('#movie_player');
    const flexy = document.querySelector('ytd-watch-flexy');
    const videoId = new URL(location.href).searchParams.get('v') || '';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const timedFetch = async (input, init = {}, ms = 8000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try { return await fetch(input, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
    };
    const config = key => { try { return globalThis.ytcfg?.get?.(key) ?? globalThis.ytcfg?.data_?.[key]; } catch { return undefined; } };
    const pools = [player?.getPlayerResponse?.(), globalThis.ytInitialPlayerResponse, flexy?.playerResponse, flexy?.data?.playerResponse, player?.playerResponse];
    try {
      const args = globalThis.ytplayer?.config?.args;
      for (const value of [args?.raw_player_response, args?.player_response]) pools.push(typeof value === 'string' ? JSON.parse(value) : value);
    } catch { /* Ignore a malformed legacy player config. */ }
    const candidates = pools.filter(item => item && typeof item === 'object');
    const response = candidates.find(item => (!videoId || item.videoDetails?.videoId === videoId) && item.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length)
      || candidates.find(item => item.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length)
      || candidates[0]
      || {};
    const renderer = response?.captions?.playerCaptionsTracklistRenderer;
    const readTracks = () => {
      let optionTracks = [];
      try { optionTracks = player?.getOption?.('captions', 'tracklist') || []; } catch { optionTracks = []; }
      const live = player?.getPlayerResponse?.();
      const listed = [...(live?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []), ...(renderer?.captionTracks || [])];
      return [...listed, ...(Array.isArray(optionTracks) ? optionTracks : [])]
        .map(track => ({ ...track, baseUrl: track?.baseUrl || track?.url || '' }));
    };
    const playingAd = () => {
      const node = document.querySelector('#movie_player, .html5-video-player');
      return Boolean(node?.classList?.contains?.('ad-showing') || node?.classList?.contains?.('ad-interrupting'));
    };
    if (playingAd()) {
      note('ad', { result: 'waiting for the main video' });
      for (let attempt = 0; attempt < 50 && playingAd(); attempt++) await sleep(500);
    }
    let tracks = readTracks();
    const language = value => String(value || '').toLowerCase().split('-')[0];
    const trackLanguage = track => language(track?.languageCode || String(track?.vssId || '').replace(/^a\./, '').replace(/^\./, ''));
    const source = language(sourceLanguage);
    const target = language(targetLanguage);
    note('player-data', {
      videoId, source, target,
      responses: candidates.length,
      responseVideoId: response?.videoDetails?.videoId || '',
      playability: response?.playabilityStatus?.status || '',
      adShowing: playingAd(),
      hook: Boolean(globalThis.__textoneTimedtextHook),
      captured: (globalThis.__textoneTimedtext || []).length,
      capturedBodies: (globalThis.__textoneTimedtextBodies || []).length,
      tracks: tracks.map(track => ({ lang: trackLanguage(track), kind: track.kind || '', name: track.name?.simpleText || track.displayName || '', url: track.baseUrl ? describe(track.baseUrl) : null })),
    });
    const isYouTube = url => url.protocol === 'https:' && (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'));
    const allowed = value => {
      const url = new URL(value, location.href);
      if (!isYouTube(url)) throw new Error('Caption host is not allowed');
      return url;
    };
    // Timedtext URLs YouTube's own player requested, carrying its `pot` token.
    const tokenUrls = () => {
      const seen = [...(globalThis.__textoneTimedtext || [])];
      try { for (const entry of performance.getEntriesByType('resource')) seen.push(entry.name); } catch { /* No resource timing. */ }
      return seen.flatMap(value => {
        try {
          const url = new URL(value, location.href);
          return isYouTube(url) && url.pathname === '/api/timedtext' && url.searchParams.get('pot')
            && (!videoId || url.searchParams.get('v') === videoId) ? [url] : [];
        } catch { return []; }
      });
    };
    // Switch a caption track on through the player API so the player mints the
    // token, then restore the viewer's caption setting.
    const requestPlayerCaptions = async () => {
      if (tokenUrls().length) { note('player-token', { result: 'already captured' }); return; }
      if (typeof player?.setOption !== 'function') { note('player-token', { result: 'player API unavailable' }); return; }
      const seen = globalThis.__textoneTimedtext = globalThis.__textoneTimedtext || [];
      const record = value => {
        try {
          const url = new URL(String(value?.url ?? value), location.href);
          if (isYouTube(url) && url.pathname === '/api/timedtext' && url.searchParams.get('pot')) seen.push(url.toString());
        } catch { /* Ignore unrelated requests. */ }
      };
      const nativeFetch = globalThis.fetch;
      const nativeOpen = globalThis.XMLHttpRequest?.prototype?.open;
      const nativeSend = globalThis.XMLHttpRequest?.prototype?.send;
      const storeBody = (url, body) => {
        const text = String(body || '');
        if (text.length < 40 || text.length > 2000000 || !/^\s*(?:\)\]\}')?\s*[{\[<]/.test(text)) return;
        if (url.pathname !== '/api/timedtext') return;
        const rows = globalThis.__textoneTimedtextBodies = globalThis.__textoneTimedtextBodies || [];
        const lang = (url.searchParams.get('lang') || '').toLowerCase().split('-')[0];
        const tlang = url.searchParams.get('tlang') || '';
        const vid = url.searchParams.get('v') || '';
        const kind = url.searchParams.get('kind') || '';
        const existing = rows.findIndex(item => item.videoId === vid && item.lang === lang && item.tlang === tlang && item.kind === kind);
        if (existing >= 0) rows.splice(existing, 1);
        rows.push({
          url: url.toString(), body: text,
          lang, tlang, videoId: vid, kind,
        });
        if (rows.length > 8) rows.splice(0, rows.length - 8);
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
      let inFlight = 0;
      const wrappedFetch = function (input) {
        record(input);
        let tracked = false;
        try {
          const u = new URL(String(input?.url ?? input), location.href);
          if (u.pathname === '/api/timedtext') { tracked = true; inFlight++; }
        } catch { /* Ignore invalid URL. */ }
        const pending = nativeFetch.apply(this, arguments);
        Promise.resolve(pending).then((response) => {
          try {
            if (!response?.ok || typeof response.clone !== 'function') { if (tracked) inFlight = Math.max(0, inFlight - 1); return; }
            const url = new URL(String(input?.url ?? input), location.href);
            response.clone().text().then((body) => storeBody(url, body)).catch(() => {}).finally(() => { if (tracked) inFlight = Math.max(0, inFlight - 1); });
          } catch { if (tracked) inFlight = Math.max(0, inFlight - 1); }
        }).catch(() => { if (tracked) inFlight = Math.max(0, inFlight - 1); });
        return pending;
      };
      const wrappedOpen = function (_method, url) {
        try { this.__textoneTimedtextUrl = new URL(String(url), location.href); } catch { this.__textoneTimedtextUrl = null; }
        record(url);
        return nativeOpen.apply(this, arguments);
      };
      const wrappedSend = function () {
        const url = this.__textoneTimedtextUrl;
        if (url?.pathname === '/api/timedtext') {
          inFlight++;
          this.addEventListener('loadend', function onLoadEnd() {
            try {
              if (this.status >= 200 && this.status < 300) {
                readXhrBody(this).then((body) => storeBody(url, body)).catch(() => {}).finally(() => { inFlight = Math.max(0, inFlight - 1); });
                return;
              }
            } catch { /* Ignore a failed read. */ }
            inFlight = Math.max(0, inFlight - 1);
          });
        }
        return nativeSend.apply(this, arguments);
      };
      const wrapFetch = typeof nativeFetch === 'function';
      if (wrapFetch) globalThis.fetch = wrappedFetch;
      if (nativeOpen) XMLHttpRequest.prototype.open = wrappedOpen;
      if (nativeSend) XMLHttpRequest.prototype.send = wrappedSend;
      let previous = null;
      try { previous = player.getOption?.('captions', 'track') || null; } catch { previous = null; }
      try {
        player.loadModule?.('captions');
        let options = [];
        for (let attempt = 0; attempt < 20; attempt++) {
          try { options = player.getOption?.('captions', 'tracklist') || []; } catch { options = []; }
          if (options.length) break;
          await sleep(150);
        }
        const choice = options.find(track => trackLanguage(track) === source && track.kind !== 'asr')
          || options.find(track => trackLanguage(track) === source)
          || { languageCode: source };
        note('player-token', { result: 'enabling captions', previous: previous?.languageCode || '', options: options.map(track => `${trackLanguage(track)}${track.kind ? `/${track.kind}` : ''}`), choice: `${trackLanguage(choice)}${choice.kind ? `/${choice.kind}` : ''}` });
        player.setOption('captions', 'track', choice);
        const hasBody = () => (globalThis.__textoneTimedtextBodies || []).some(row => (!videoId || row.videoId === videoId) && row.lang === source && !row.tlang && row.body?.length > 40);
        for (let attempt = 0; attempt < 50 && !tokenUrls().length && !hasBody(); attempt++) await sleep(150);
        for (let wait = 0; wait < 15 && !hasBody() && (inFlight > 0 || tokenUrls().length); wait++) await sleep(150);
        note('player-token', { result: tokenUrls().length ? 'token captured' : 'no timedtext request with pot after 7.5 s', captured: seen.length, bodies: (globalThis.__textoneTimedtextBodies || []).length, urls: tokenUrls().slice(-2).map(url => describe(url)) });
      } catch (error) { note('player-token', { result: 'error', error: String(error?.message || error) }); } finally {
        if (wrapFetch && globalThis.fetch === wrappedFetch) globalThis.fetch = nativeFetch;
        if (nativeOpen && XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = nativeOpen;
        if (nativeSend && XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = nativeSend;
        try {
          if (previous?.languageCode) player.setOption('captions', 'track', previous);
          else { player.setOption('captions', 'track', {}); player.unloadModule?.('captions'); }
        } catch { /* Leave captions as the player has them. */ }
      }
    };
    const tokenized = value => {
      const captured = tokenUrls();
      const latest = captured.at(-1);
      if (!latest) return [];
      const track = new URL(value, location.href);
      // `pot` is ignored unless the request also names the web client.
      const ensureClient = url => {
        if (url.searchParams.get('pot') && !url.searchParams.get('c')) url.searchParams.set('c', 'WEB');
        return url;
      };
      const withToken = ensureClient(new URL(track));
      for (const key of ['pot', 'potc', 'c', 'cver', 'cplayer', 'cbr', 'cbrver', 'cos', 'cosver', 'cplatform']) {
        if (latest.searchParams.has(key) && !withToken.searchParams.has(key)) withToken.searchParams.set(key, latest.searchParams.get(key));
      }
      ensureClient(withToken);
      // The player's own signed URL, pointed at this track's language.
      const retargeted = ensureClient(new URL(latest));
      for (const key of ['lang', 'kind', 'name', 'tlang']) {
        retargeted.searchParams.delete(key);
        if (track.searchParams.has(key)) retargeted.searchParams.set(key, track.searchParams.get(key));
      }
      const exact = captured
        .filter(url => language(url.searchParams.get('lang')) === language(track.searchParams.get('lang')) && !url.searchParams.get('tlang'))
        .map(url => ensureClient(new URL(url)).toString());
      return [...new Set([...exact, withToken.toString(), retargeted.toString()])];
    };
    const eventsFromJson3 = data => (data.events || []).map(event => ({
      start: Number(event.tStartMs) / 1000,
      duration: Number(event.dDurationMs || 0) / 1000,
      text: (event.segs || []).map(segment => segment.utf8 || '').join('').replace(/\s+/g, ' ').trim(),
    })).filter(event => Number.isFinite(event.start) && event.start >= 0 && event.text);
    const decodeXml = value => String(value || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    const eventsFromSrv3 = xml => [...String(xml || '').matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)].flatMap(match => {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
      const text = decodeXml(match[2]);
      const start = Number(attrs.t) / 1000;
      const duration = Number(attrs.d || 0) / 1000;
      return text && Number.isFinite(start) && start >= 0 ? [{ start, duration, text }] : [];
    });
    // srv1 times are seconds. srv3 times are milliseconds.
    const eventsFromSrv1 = xml => [...String(xml || '').matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)].flatMap(match => {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
      const text = decodeXml(match[2]);
      const start = Number(attrs.start);
      const duration = Number(attrs.dur || 0);
      return text && Number.isFinite(start) && start >= 0 ? [{ start, duration, text }] : [];
    });
    const eventsFromBody = body => {
      const text = String(body || '').replace(/^\uFEFF/, '').replace(/^\)\]\}'\s*/, '').trim();
      if (!text) return [];
      if (text[0] === '{' || text[0] === '[') {
        try { return eventsFromJson3(JSON.parse(text)); } catch { return []; }
      }
      if (/<text\b/i.test(text)) return eventsFromSrv1(text);
      if (/<p\b/i.test(text)) return eventsFromSrv3(text);
      return [];
    };
    // A body the player already downloaded wins: replaying that URL is often empty.
    const cachedSource = (wantLang = source, wantTlang = '') => {
      const rows = globalThis.__textoneTimedtextBodies || [];
      for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index];
        if (!row?.body) continue;
        if (wantTlang ? row.tlang !== wantTlang : row.tlang) continue;
        if (videoId && row.videoId !== videoId) continue;
        if (wantLang && row.lang && row.lang !== wantLang) continue;
        const events = eventsFromBody(row.body);
        if (!events.length) continue;
        let kind = row.kind || '';
        if (!kind) {
          try { kind = new URL(row.url, location.href).searchParams.get('kind') || ''; } catch { /* The body is still usable. */ }
        }
        return { events, kind };
      }
      return null;
    };
    const load = async (track, translatedLanguage = '') => {
      if (!track?.baseUrl) return [];
      const plain = [track.baseUrl];
      const preferPlain = Boolean(track.origin && track.origin !== 'web' && track.origin !== 'player');
      const urls = preferPlain ? [...plain, ...tokenized(track.baseUrl)] : [...tokenized(track.baseUrl), ...plain];
      const seen = new Set();
      for (const value of urls) {
        let seed;
        try { seed = allowed(value); } catch (error) { note('fetch', { origin: track.origin || 'web', error: String(error?.message || error).slice(0, 80) }); continue; }
        // exp=xpe answers HTTP 200 with an empty body until a player pot is attached.
        if (!seed.searchParams.get('pot') && seed.searchParams.get('exp') === 'xpe') {
          note('fetch', { origin: track.origin || 'web', ...describe(seed), skipped: 'exp=xpe without pot' });
          continue;
        }
        const formats = [];
        const current = seed.searchParams.get('fmt');
        if (current && ['json3', 'srv3', 'srv1'].includes(current)) formats.push(current);
        for (const format of ['json3', 'srv3', 'srv1']) if (!formats.includes(format)) formats.push(format);
        for (const format of formats) {
          try {
            const url = new URL(seed);
            url.searchParams.set('fmt', format);
            if (url.searchParams.get('pot') && !url.searchParams.get('c')) url.searchParams.set('c', 'WEB');
            if (translatedLanguage) url.searchParams.set('tlang', translatedLanguage);
            else url.searchParams.delete('tlang');
            const key = url.toString();
            if (seen.has(key)) continue;
            seen.add(key);
            const result = await timedFetch(url, { credentials: preferPlain ? 'omit' : 'include', cache: 'no-store' });
            if (!result.ok) {
              note('fetch', { origin: track.origin || 'web', ...describe(url), status: result.status });
              if (result.status === 429) break;
              continue;
            }
            let events = [];
            try {
              const rawText = typeof result.clone === 'function' ? await result.clone().text().catch(() => '') : '';
              if (format === 'json3') {
                try { events = eventsFromJson3(rawText ? JSON.parse(rawText.replace(/^\uFEFF/, '').replace(/^\)\]\}'\s*/, '')) : await result.json()); }
                catch { events = eventsFromBody(rawText || await result.text()); }
              } else {
                const xmlText = rawText || await result.text();
                events = format === 'srv1' ? eventsFromSrv1(xmlText) : eventsFromSrv3(xmlText);
                if (!events.length) events = eventsFromBody(xmlText);
              }
            } catch (error) { note('fetch', { origin: track.origin || 'web', ...describe(url), status: result.status, events: 0, parse: String(error?.message || error).slice(0, 80) }); continue; }
            note('fetch', { origin: track.origin || 'web', ...describe(url), status: result.status, events: events.length });
            if (events.length) return events;
          } catch (error) { note('fetch', { origin: track.origin || 'web', ...describe(value), fmt: format, error: String(error?.message || error).slice(0, 80) }); }
        }
      }
      return [];
    };
    // The Android client stopped returning captions in 2026. iOS still publishes
    // timedtext URLs that do not need a web `pot` token; TVHTML5 is the backup.
    const innertubeTracks = async () => {
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return [];
      const clients = [
        {
          name: 'IOS', id: '5', version: '20.10.38',
          client: {
            clientName: 'IOS', clientVersion: '20.10.38', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
            userAgent: 'com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
            osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US',
          },
        },
        {
          name: 'TVHTML5', id: '7', version: '7.20250312.16.00',
          client: { clientName: 'TVHTML5', clientVersion: '7.20250312.16.00', hl: 'en', gl: 'US' },
        },
      ];
      const found = [];
      for (const client of clients) {
        try {
          const url = new URL('https://www.youtube.com/youtubei/v1/player');
          url.searchParams.set('prettyPrint', 'false');
          const key = config('INNERTUBE_API_KEY');
          if (key) url.searchParams.set('key', key);
          const result = await timedFetch(url, {
            method: 'POST', credentials: 'omit', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': client.id, 'X-YouTube-Client-Version': client.version },
            body: JSON.stringify({ context: { client: client.client }, videoId, contentCheckOk: true, racyCheckOk: true }),
          }, 6000);
          if (!result.ok) { note('innertube', { client: client.name, status: result.status }); continue; }
          const data = await result.json();
          const tracks = (data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [])
            .map(track => ({ ...track, baseUrl: track?.baseUrl || '', origin: client.name.toLowerCase() }));
          note('innertube', { client: client.name, status: result.status, playability: data?.playabilityStatus?.status || '', tracks: tracks.map(track => `${trackLanguage(track)}${track.kind ? `/${track.kind}` : ''}`) });
          found.push(...tracks);
          if (tracks.length) break;
        } catch (error) { note('innertube', { client: client.name, error: String(error?.message || error) }); }
      }
      return found;
    };
    const findDeep = (roots, pick, limit = 200000) => {
      const found = [];
      const stack = roots.filter(Boolean);
      let visited = 0;
      while (stack.length && visited++ < limit) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        const value = pick(node);
        if (value) found.push(value);
        for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push(child);
      }
      return found;
    };
    // The same request as YouTube's "Show transcript" panel.
    const transcriptEvents = async () => {
      const roots = [globalThis.ytInitialData, flexy?.data, flexy?.__data?.data, document.querySelector('ytd-app')?.data?.response];
      const params = findDeep(roots, node => typeof node.getTranscriptEndpoint?.params === 'string' ? node.getTranscriptEndpoint.params : '')
        .find(value => {
          try {
            const normalized = decodeURIComponent(value).replace(/-/g, '+').replace(/_/g, '/');
            const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
            return !videoId || atob(padded).includes(videoId);
          }
          catch { return false; }
        });
      if (!params) { note('transcript', { result: 'no transcript params for this video' }); return []; }
      const version = config('INNERTUBE_CLIENT_VERSION') || '2.20260701.00.00';
      const url = new URL('https://www.youtube.com/youtubei/v1/get_transcript');
      url.searchParams.set('prettyPrint', 'false');
      const key = config('INNERTUBE_API_KEY');
      if (key) url.searchParams.set('key', key);
      const headers = { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': String(config('INNERTUBE_CONTEXT_CLIENT_NAME') || 1), 'X-YouTube-Client-Version': version };
      const visitor = config('VISITOR_DATA');
      if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
      const result = await timedFetch(url, {
        method: 'POST', credentials: 'include', cache: 'no-store', headers,
        body: JSON.stringify({ context: config('INNERTUBE_CONTEXT') || { client: { clientName: 'WEB', clientVersion: version } }, params }),
      });
      if (!result.ok) { note('transcript', { status: result.status }); return []; }
      const data = await result.json();
      const events = findDeep([data], node => node.transcriptSegmentRenderer || null).map(segment => {
        const text = (segment.snippet?.runs || []).map(run => run.text || '').join('') || segment.snippet?.simpleText || '';
        const start = Number(segment.startMs) / 1000;
        const end = Number(segment.endMs) / 1000;
        return { start, duration: Math.max(0, end - start), text: text.replace(/\s+/g, ' ').trim() };
      }).filter(event => Number.isFinite(event.start) && event.start >= 0 && event.text).sort((a, b) => a.start - b.start);
      note('transcript', { status: result.status, segments: events.length });
      return events;
    };
    const looksLikeSource = events => {
      if (source !== 'en') return true;
      const letters = events.map(event => event.text).join(' ').match(/\p{L}/gu) || [];
      return letters.length > 0 && letters.filter(letter => /[A-Za-z]/.test(letter)).length / letters.length > 0.85;
    };
    const listedTracks = async () => {
      const url = new URL('https://www.youtube.com/api/timedtext');
      url.searchParams.set('type', 'list');
      url.searchParams.set('v', videoId);
      const result = await timedFetch(url, { credentials: 'include', cache: 'no-store' });
      if (!result.ok) { note('legacy-list', { status: result.status }); return []; }
      const xml = await result.text();
      note('legacy-list', { status: result.status, bytes: xml.length });
      return [...xml.matchAll(/<track\b([^>]*)\/?>/gi)].flatMap(match => {
        const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
        if (!attrs.lang_code) return [];
        const base = new URL('https://www.youtube.com/api/timedtext');
        base.searchParams.set('v', videoId);
        base.searchParams.set('lang', attrs.lang_code);
        if (attrs.kind) base.searchParams.set('kind', attrs.kind);
        return [{ languageCode: attrs.lang_code, kind: attrs.kind || '', baseUrl: base.toString() }];
      });
    };
    const syntheticEnglish = () => ['', 'asr'].map(kind => {
      const url = new URL('https://www.youtube.com/api/timedtext');
      url.searchParams.set('v', videoId);
      url.searchParams.set('lang', 'en');
      if (kind) url.searchParams.set('kind', kind);
      return { languageCode: 'en', kind, baseUrl: url.toString() };
    });
    const tried = new Set();
    const readSource = async (candidates) => {
      const ordered = candidates.filter(track => trackLanguage(track) === source && track?.baseUrl);
      // Publisher captions first, then YouTube's default automatic English.
      for (const track of [...ordered.filter(item => item.kind !== 'asr'), ...ordered.filter(item => item.kind === 'asr')]) {
        const key = `${track.origin || 'web'}:${track.kind || ''}:${track.baseUrl}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const events = await load(track);
        if (events.length) return { track, events };
      }
      return null;
    };
    // Each source is tried only when the previous one produced no text.
    let found = null;
    const fromPlayer = cachedSource();
    if (fromPlayer) {
      note('player-body', { events: fromPlayer.events.length, kind: fromPlayer.kind });
      found = { track: { languageCode: source, kind: fromPlayer.kind, baseUrl: '', origin: 'player' }, events: fromPlayer.events };
    }
    if (!found) found = await readSource(tracks);
    if (!found) {
      await requestPlayerCaptions();
      const minted = cachedSource();
      if (minted) {
        note('player-body', { events: minted.events.length, kind: minted.kind, result: 'minted' });
        found = { track: { languageCode: source, kind: minted.kind, baseUrl: '', origin: 'player' }, events: minted.events };
      }
    }
    if (!found) {
      tracks = [...tracks, ...readTracks()];
      found = await readSource(tracks);
    }
    let alternate = [];
    if (!found) {
      try { alternate = await innertubeTracks(); } catch (error) { note('innertube', { error: String(error?.message || error) }); alternate = []; }
      found = await readSource(alternate);
    }
    if (!found) {
      try {
        const events = await transcriptEvents();
        if (events.length && looksLikeSource(events)) found = { track: { languageCode: source, kind: 'asr', baseUrl: '' }, events };
        else if (events.length) note('transcript', { result: 'rejected: not the source language' });
      } catch (error) { note('transcript', { error: String(error?.message || error) }); }
    }
    if (!found && source === 'en' && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      let extra = [];
      try { extra = await listedTracks(); } catch (error) { note('legacy-list', { error: String(error?.message || error) }); extra = []; }
      if (!extra.some(track => trackLanguage(track) === 'en')) extra = syntheticEnglish();
      found = await readSource(extra);
    }
    if (!found) return fail('Không nguồn nào trả về phụ đề tiếng Anh');
    note('source-found', { origin: found.track.origin || (found.track.baseUrl ? 'web' : 'transcript'), kind: found.track.kind || '', events: found.events.length });
    const sourceTrack = found.track;
    const original = found.events;
    const allTracks = [...tracks, ...alternate];
    const targetTrack = allTracks.find(track => trackLanguage(track) === target && track.kind !== 'asr' && track.baseUrl)
      || allTracks.find(track => trackLanguage(track) === target && track.baseUrl);
    // A failed or empty translated track must not discard the source transcript.
    // The gateway can translate those sentences; tab audio is the slower fallback.
    let translated = original;
    if (source !== target) {
      try {
        const loaded = targetTrack ? await load(targetTrack) : await load(sourceTrack, target);
        if (loaded.length) translated = loaded;
        note('target-captions', { via: targetTrack ? 'target track' : 'tlang', events: loaded.length });
      } catch (error) { note('target-captions', { error: String(error?.message || error) }); }
    }
    // Some caption endpoints silently ignore an unsupported `tlang` and return
    // the source track. Do not read that text with the target-language voice.
    const liveDetails = player?.getPlayerResponse?.()?.videoDetails;
    const listedDuration = Number((liveDetails?.videoId === videoId && liveDetails?.lengthSeconds) || response?.videoDetails?.lengthSeconds);
    const mediaDuration = Number(document.querySelector('video')?.duration);
    const duration = listedDuration > 0 ? listedDuration : mediaDuration;
    if (!(duration > 0) || !Number.isFinite(duration)) return fail(`Không đọc được thời lượng video (${listedDuration} / ${mediaDuration})`);
    const appendUnique = (base, next) => {
      const left = base.trim().split(/\s+/); const right = next.trim().split(/\s+/);
      let overlap = 0;
      for (let size = 1; size <= Math.min(12, left.length, right.length); size++) {
        if (left.slice(-size).join(' ').toLocaleLowerCase() === right.slice(0, size).join(' ').toLocaleLowerCase()) overlap = size;
      }
      return [...left, ...right.slice(overlap)].join(' ').trim();
    };
    // Sound annotations such as "(Laughter)" or "( Tiếng cười và vỗ tay)" are not speech.
    const soundTag = /\(\s*(?:[^()]{0,40}?\b)?(?:laughter|laughs|applause|music|cheering|cheers|sighs|tiếng cười|cười|vỗ tay|tiếng vỗ tay|nhạc|âm nhạc|tiếng nhạc)(?:[^()]{0,40})?\)/giu;
    const clean = (value) => String(value || '').replace(/<[^>]+>/g, ' ').replace(/\[[^\]]{0,80}\]/g, ' ').replace(soundTag, ' ').replace(/[♪♫]+/g, ' ').replace(/\s+/g, ' ').trim();
    const noise = (value) => /^\s*(?:\[[^\]]+\]|[♪♫]+)\s*$/.test(value);
    // ASR often inserts a period before the sentence has actually finished.
    // Keep the words, but give the translator one grammatical sentence.
    const repair = (value) => value.replace(/[.!?…]+(?=\s+\p{Ll})/gu, (punct, offset, sourceText) => (
      /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)$/i.test(sourceText.slice(0, offset)) ? punct : ''
    )).replace(/\s+([,.;!?…])/g, '$1').replace(/\s+/g, ' ').trim();
    const isContinuation = (value) => /^\p{Ll}|^[0-9]/u.test(value.replace(/^[\s"'“‘(\[]+/, ''));
    const startsNewSentence = (value) => /^\p{Lu}/u.test(value.replace(/^[\s"'“‘(\[]+/, ''));
    const isClosed = (value) => /[.!?…]['"”’)\]]*$/.test(value) && !/(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i.test(value);
    const splitCompleteSentences = (value) => {
      const sentences = [];
      let cursor = 0;
      const pattern = /[.!?…]+['"”’)\]]*/g;
      while (pattern.exec(value)) {
        const chunk = value.slice(cursor, pattern.lastIndex).trim();
        const nextWord = value.slice(pattern.lastIndex).trimStart();
        if (chunk && isClosed(chunk) && (!nextWord || startsNewSentence(nextWord))) {
          sentences.push(chunk);
          cursor = pattern.lastIndex;
        }
      }
      const rest = value.slice(cursor).trim();
      if (rest) sentences.push(rest);
      return sentences;
    };
    const sentencesFrom = (events) => {
      const sorted = [...events].sort((a, b) => a.start - b.start);
      const pieces = [];
      for (let eventIndex = 0; eventIndex < sorted.length; eventIndex++) {
        const event = sorted[eventIndex];
        const raw = String(event.text || '');
        const newSpeaker = /^\s*(?:>>|[-–—]\s+)/.test(raw);
        const text = clean(raw.replace(/^\s*(?:>>|[-–—]\s*)/, ''));
        if (!text || noise(raw) || noise(text)) continue;
        // Subtitle credits ("Translator: … Reviewer: …") are not speech.
        if (/^(?:translator|reviewer|transcriber|subtitles? by|người dịch|người duyệt|người kiểm duyệt|biên dịch|dịch giả|phụ đề)\s*:/i.test(text)) continue;
        const start = Math.max(0, event.start);
        const rawDuration = Math.max(0.08, event.duration || 2);
        let nextStart = null;
        for (let k = eventIndex + 1; k < sorted.length; k++) {
          if (sorted[k].start > start + 0.04) { nextStart = sorted[k].start; break; }
        }
        // Rolling ASR events report a multi-second display window (e.g. 5s) even
        // though the next line begins 1.5s later. Clamp to nextStart so group.end
        // reflects when the line finishes speaking, not when it scrolls off screen.
        const rawEnd = nextStart !== null && nextStart > start && nextStart < start + rawDuration
          ? nextStart
          : start + rawDuration;
        const end = Math.min(duration, Math.max(start + 0.08, rawEnd));
        const parts = splitCompleteSentences(text);
        const weights = parts.map((part) => Math.max(1, part.split(/\s+/).length));
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        const span = Math.max(0.08, end - start);
        let pieceStart = Math.max(start, pieces.at(-1)?.start ?? 0);
        parts.forEach((part, index) => {
          const length = span * weights[index] / total;
          pieces.push({ start: pieceStart, end: pieceStart + length, text: part, newSpeaker: newSpeaker && index === 0 });
          pieceStart += length;
        });
      }
      const groups = [];
      let group = null;
      for (const piece of pieces) {
        const gap = group ? piece.start - group.end : Infinity;
        const continuation = isContinuation(piece.text);
        // A finished sentence always becomes its own spoken slot. Fragments of
        // the same sentence stay together so the translation keeps full meaning.
        const boundary = group && (piece.newSpeaker || gap > 0.8 || piece.end - group.start > maxSentenceSeconds
          || (isClosed(group.text) && !continuation && (startsNewSentence(piece.text) || gap > 0.45)));
        if (boundary) { groups.push(group); group = null; }
        if (!group) group = { start: piece.start, end: piece.end, text: piece.text };
        else {
          group.end = Math.max(group.end, piece.end);
          group.text = appendUnique(group.text, piece.text);
        }
      }
      if (group) groups.push(group);
      const repaired = groups.map((item) => ({ ...item, text: repair(item.text) })).filter((item) => item.text);
      const merged = [];
      for (let i = 0; i < repaired.length; i++) {
        const cur = repaired[i];
        const nxt = repaired[i + 1];
        const avail = nxt ? nxt.start - cur.start : cur.end - cur.start;
        const words = cur.text.split(/\s+/).length;
        if (avail < 0.6 && words >= 4 && nxt && nxt.end - cur.start <= maxSentenceSeconds) {
          nxt.start = cur.start;
          nxt.text = appendUnique(cur.text, nxt.text);
          continue;
        }
        if (avail < 0.4 && merged.length && cur.end - merged.at(-1).start <= maxSentenceSeconds) {
          const prev = merged.at(-1);
          prev.end = Math.max(prev.end, cur.end);
          prev.text = appendUnique(prev.text, cur.text);
          continue;
        }
        merged.push(cur);
      }
      return merged;
    };
    const sourceSentences = sentencesFrom(original);
    const targetSentences = source === target ? sourceSentences : sentencesFrom(translated);
    const used = new Set();
    const round = (value) => Math.round(value * 1000) / 1000;
    const cues = [];
    for (let index = 0; index < sourceSentences.length && cues.length < 2000; index++) {
      const sentence = sourceSentences[index];
      const next = sourceSentences[index + 1];
      let best = -1; let bestOverlap = 0;
      targetSentences.forEach((candidate, candidateIndex) => {
        if (used.has(candidateIndex)) return;
        const overlap = Math.min(sentence.end, candidate.end) - Math.max(sentence.start, candidate.start);
        const coverage = overlap / Math.max(0.08, candidate.end - candidate.start);
        // Only claim a subtitle sentence when most of it belongs to this speech.
        if (overlap > 0.05 && coverage >= 0.6 && overlap > bestOverlap) { bestOverlap = overlap; best = candidateIndex; }
      });
      const matched = best >= 0 ? targetSentences[best] : null;
      const translatedText = matched?.text || sentence.text;
      const same = translatedText.toLocaleLowerCase() === sentence.text.toLocaleLowerCase();
      // Slots must never overlap: the gateway rejects the whole caption batch.
      const previous = cues.at(-1);
      const start = round(Math.max(0, sentence.start, previous ? previous.start + previous.duration : 0));
      const nextStart = next ? round(Math.max(0, next.start)) : null;
      // The slot ends when the next sentence is spoken. The pause in between is
      // room to finish this line; it is not time to keep talking over the next one.
      const slotEnd = round(Math.min(duration, nextStart !== null
        ? Math.min(nextStart, start + maxSentenceSeconds)
        : Math.min(round(sentence.end), start + maxSentenceSeconds)));
      const cueDuration = round(slotEnd - start);
      if (!(cueDuration >= 0.08)) {
        // No audible room before the next sentence. Keep the words on that sentence.
        if (next) next.text = appendUnique(sentence.text, next.text);
        continue;
      }
      if (start + cueDuration > duration + 0.1) continue;
      if (matched) used.add(best);
      cues.push({
        start, duration: Math.min(maxSentenceSeconds, cueDuration), text: sentence.text.slice(0, 1000),
        translatedText: translatedText.slice(0, 1000),
        // Speak a real subtitle translation immediately. A second GPU pass is only
        // needed when the caption text is still in the source language.
        needsTranslation: source !== target && same,
      });
    }
    note('cues', { sourceEvents: original.length, sourceSentences: sourceSentences.length, targetSentences: targetSentences.length, cues: cues.length, needsTranslation: cues.filter(cue => cue.needsTranslation).length });
    if (!cues.length) return fail('Có phụ đề nhưng không ghép được câu nào');
    return {
      duration, cues, source: 'youtube-captions', trace,
      sourceLabel: `Phụ đề ${source.toUpperCase()}${sourceTrack.kind === 'asr' ? ' tự động' : ''}`,
    };
  } catch (error) {
    return fail(`Lỗi khi đọc phụ đề: ${String(error?.message || error)}`);
  }
}
