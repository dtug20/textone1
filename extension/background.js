import { controlSource } from './content/source-control.js';
import { collectYouTubeCaptions } from './content/youtube-captions.js';
import { debugLog, devSink, isDevInstall } from './lib/debug-log.js';
let starting = false;
let operation = 0;
let sourceTabId = null;
let sourceMode = null;
const webAudioCache = new Map();

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function youtubeId(url) {
  try {
    const parsed = new URL(url);
    const value = parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : parsed.hostname.endsWith('youtube.com') && parsed.pathname === '/watch' ? parsed.searchParams.get('v') : '';
    return /^[A-Za-z0-9_-]{11}$/.test(value || '') ? value : '';
  } catch { return ''; }
}

async function source(tabId, action, data = {}) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: controlSource, args: [action, data] });
  if (result?.error) throw new Error(result.error);
  return result || {};
}
function sessionLanguages(token) {
  try {
    const encoded = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded));
    return { source: claims.source, target: claims.target, mode: claims.mode, cloneVoice: Boolean(claims.cloneVoice), expires: claims.expires };
  } catch { return {}; }
}
async function captions(tabId, token) {
  const languages = sessionLanguages(token);
  if (languages.mode !== 'dub' || !languages.source || !languages.target) {
    await debugLog('captions:skipped', { reason: 'Mã phiên không ở chế độ thuyết minh', mode: languages.mode, source: languages.source, target: languages.target });
    return null;
  }
  const started = Date.now();
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: collectYouTubeCaptions,
      args: [languages.source, languages.target],
    });
  } catch (error) {
    await debugLog('captions:inject-failed', { error: error.message });
    return null;
  }
  await debugLog('captions:collected', {
    ms: Date.now() - started, cues: result?.cues?.length || 0, reason: result?.reason || '',
    sourceLabel: result?.sourceLabel || '', duration: result?.duration, trace: result?.trace || [],
    first: result?.cues?.slice(0, 3).map(cue => ({ start: cue.start, duration: cue.duration, text: cue.text, translatedText: cue.translatedText, needsTranslation: cue.needsTranslation })) || [],
  });
  return result?.cues?.length ? result : null;
}

async function startSession(message) {
  if (starting) throw new Error('Đang khởi động phiên.');
  starting = true;
  const currentOperation = ++operation;
  try {
    const [tab] = message.tabId ? [await chrome.tabs.get(message.tabId)] : await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Mở tab YouTube hoặc trang có âm thanh trước.');
    const languages = sessionLanguages(message.token);
    if (languages.expires && languages.expires <= Date.now()) throw new Error('Mã phiên đã hết hạn. Tạo mã mới tại textone.id.vn/realtime rồi dán lại vào đây.');
    const cloneVoice = Boolean(message.cloneVoice ?? languages.cloneVoice);
    await debugLog('session:start', { tabId: tab.id, url: tab.url, server: message.server, mode: languages.mode, source: languages.source, target: languages.target, cloneVoice, expiresInSeconds: languages.expires ? Math.round((languages.expires - Date.now()) / 1000) : null });
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA', 'WEB_RTC'], justification: 'Capture tab audio and play translated narration while popup is closed.' });
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    sourceTabId = tab.id;
    const startTab = async (sourceLabel = 'Âm thanh tab') => {
      sourceMode = 'tab';
      await debugLog('session:tab-fallback', { reason: sourceLabel });
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      if (currentOperation !== operation) return { ok: true };
      const result = await chrome.runtime.sendMessage({ ...message, cloneVoice, target: 'offscreen', input: 'tab', streamId, position: 0, sourceLabel });
      await debugLog('session:tab-started', { error: result?.error || '' });
      if (!result?.error) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/live-timeline.js'] });
      return result;
    };
    const videoId = youtubeId(tab.url || '');
    if (!videoId) return startTab();
    const captionData = await captions(tab.id, message.token).catch(async (error) => { await debugLog('captions:error', { error: error.message }); return null; });
    if (!captionData) return startTab('Âm thanh tab · YouTube không có phụ đề dịch phù hợp');
    sourceMode = 'youtube';
    // A session that ended on a pipeline error leaves the player attached;
    // release it so a new Start does not fail with "Phiên cũ chưa dừng".
    await source(tab.id, 'detach').catch(() => {});
    const attached = await source(tab.id, 'attach', { readAhead: true, volume: message.volume });
    await debugLog('captions:attached', { time: attached.time, duration: attached.duration, paused: attached.paused });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/native-playback-content.js'] });
    const sampleStreamId = cloneVoice ? await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }).catch(() => '') : '';
    // A session that was just stopped keeps its server lease for a moment;
    // retry briefly instead of dropping to the slower tab-audio path.
    let result;
    for (let attempt = 1; attempt <= 4; attempt++) {
      result = await chrome.runtime.sendMessage({ ...message, cloneVoice, streamId: sampleStreamId, target: 'offscreen', input: 'captions', videoId, captions: captionData.cues, duration: captionData.duration, position: attached.time || 0, sourceLabel: captionData.sourceLabel });
      if (!result?.error || !/đang bận|busy/i.test(result.error) || attempt === 4 || currentOperation !== operation) break;
      await debugLog('captions:pipeline-busy', { attempt });
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    if (result?.error && /hết hạn|bị thay thế|hết hạn mức/i.test(result.error)) {
      // Tab audio uses the same session; falling back cannot succeed.
      await debugLog('captions:pipeline-failed', { error: result.error, fallback: false });
      throw new Error(result.error);
    }
    if (result?.error) {
      await debugLog('captions:pipeline-failed', { error: result.error });
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
      await source(tab.id, 'detach', { resume: true }).catch(() => {});
      sourceMode = null;
      return startTab(`Âm thanh tab · pipeline phụ đề lỗi: ${result.error}`);
    }
    await debugLog('captions:pipeline-started', { cues: captionData.cues.length });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/native-ahead.js'] });
    return result;
  } catch (error) {
    await debugLog('session:error', { error: error.message });
    if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
    if (sourceTabId && sourceMode === 'youtube') await source(sourceTabId, 'detach').catch(() => {});
    sourceTabId = null; sourceMode = null;
    throw error;
  } finally { starting = false; }
}

async function stopSession() {
  operation++;
  if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  const tabId = sourceTabId; const mode = sourceMode;
  sourceTabId = null; sourceMode = null;
  if (tabId && mode === 'youtube') await source(tabId, 'detach').catch(() => {});
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'background') return;
  if (message.type === 'state') {
    chrome.storage.session.set({ state: message.state });
    chrome.action.setBadgeText({ text: message.state.active ? 'LIVE' : '' });
    reply({ ok: true });
    return;
  }
  if (message.type === 'debug-log') {
    void debugLog(String(message.event || 'offscreen'), message.data || {});
    reply({ ok: true });
    return;
  }
  (async () => {
    if (message.type === 'live-timeline') {
      if (sender.tab?.id !== sourceTabId) throw new Error('Tab không thuộc phiên.');
      return chrome.runtime.sendMessage({ target: 'offscreen', type: 'live-timeline', timeline: message.timeline });
    }
    if (message.type === 'native-next') {
      if (sender.tab?.id !== sourceTabId || sourceMode !== 'youtube') throw new Error('Tab không thuộc phiên.');
      return chrome.runtime.sendMessage({ target: 'offscreen', type: 'next' });
    }
    if (message.type === 'native-status') {
      if (sender.tab?.id !== sourceTabId || sourceMode !== 'youtube') throw new Error('Tab không thuộc phiên.');
      const { state = {} } = await chrome.storage.session.get('state');
      const next = { ...state, ...message, active: state.active !== false };
      delete next.target; delete next.type;
      if (message.error || message.stage === 'prepared') await debugLog('player:status', { stage: message.stage, error: message.error || '' });
      if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'native-status', status: next });
      await chrome.storage.session.set({ state: next });
      return { ok: true };
    }
    if (message.type === 'volume') {
      if (sourceMode === 'youtube' && sourceTabId) return chrome.tabs.sendMessage(sourceTabId, { target: 'native', type: 'volume', volume: message.volume });
      if (await chrome.offscreen.hasDocument()) return chrome.runtime.sendMessage({ target: 'offscreen', type: 'volume', volume: message.volume });
      return { ok: true };
    }
    if (message.type === 'clone-voice') {
      const cloneVoice = Boolean(message.cloneVoice);
      const streamId = cloneVoice && sourceMode === 'youtube' && sourceTabId
        ? await chrome.tabCapture.getMediaStreamId({ targetTabId: sourceTabId }).catch(() => '')
        : '';
      if (await chrome.offscreen.hasDocument()) {
        return chrome.runtime.sendMessage({ target: 'offscreen', type: 'clone-voice', cloneVoice, streamId });
      }
      return { ok: true };
    }
    if (message.type === 'sync-session-token') {
      const token = String(message.token || '').trim();
      const server = String(message.server || 'https://textone.id.vn').replace(/\/$/, '');
      const languages = sessionLanguages(token);
      if (token && languages.expires && languages.expires > Date.now()) {
        await chrome.storage.session.set({ server, token, cloneVoice: Boolean(languages.cloneVoice) });
        await chrome.storage.local.set({ savedSession: { server, token, pipelineUrl: '', volume: 0.2, cloneVoice: Boolean(languages.cloneVoice), expires: languages.expires } });
        await debugLog('session:auto-synced', { server, mode: languages.mode, source: languages.source, target: languages.target, cloneVoice: Boolean(languages.cloneVoice), expiresInSeconds: Math.round((languages.expires - Date.now()) / 1000) });
      }
      return { ok: true };
    }
    if (message.type === 'web-lan-tts') {
      const started = Date.now();
      const response = await fetch('http://localhost:3000/api/realtime/lan-tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.payload || {}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.id) {
        await debugLog('web:lan-tts-failed', { status: response.status, error: result?.error || 'unknown' });
        return { ok: false, error: result?.error || `HTTP ${response.status}` };
      }
      if (result.audioBase64) {
        webAudioCache.set(result.id, result.audioBase64);
        while (webAudioCache.size > 12) webAudioCache.delete(webAudioCache.keys().next().value);
      }
      await debugLog('web:lan-tts', { id: result.id, language: result.language, engine: result.engine, ms: Date.now() - started });
      return { ok: true, id: result.id, audioBase64: result.audioBase64 };
    }
    if (message.type === 'web-fetch-audio') {
      const genId = String(message.generationId || '');
      if (genId && webAudioCache.has(genId)) {
        return { ok: true, audioBase64: webAudioCache.get(genId) };
      }
      const response = await fetch(String(message.url || ''), { cache: 'no-store' });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const audioBase64 = arrayBufferToBase64(await response.arrayBuffer());
      if (genId) {
        webAudioCache.set(genId, audioBase64);
        while (webAudioCache.size > 12) webAudioCache.delete(webAudioCache.keys().next().value);
      }
      return { ok: true, audioBase64 };
    }
    if (message.type === 'stop') return stopSession();
    if (message.type !== 'start') throw new Error('Yêu cầu không hợp lệ.');
    return startSession(message);
  })().then(reply).catch((error) => reply({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((id) => {
  if (id === sourceTabId) {
    sourceTabId = null;
    sourceMode = null;
    void chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
  }
});

// Unpacked installs only: a local dev server can reload the extension when its
// files change and replay the last session start, so a fix can be retested
// without clicking through chrome://extensions and the popup.
if (isDevInstall()) {
  let loadedVersion = null;
  let polling = false;
  const runCommand = async (command) => {
    if (command.token) {
      const expires = sessionLanguages(command.token).expires || Date.now() + 15 * 60 * 1000;
      await chrome.storage.local.set({ savedSession: { server: command.server || 'https://textone.id.vn', token: command.token, pipelineUrl: '', volume: 0.2, expires } });
    }
    const { savedSession } = await chrome.storage.local.get('savedSession');
    if (command.type === 'stop') return stopSession();
    if (command.type === 'collect') {
      // Caption collection needs only the language pair, not a live session.
      const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/watch*', 'https://m.youtube.com/watch*'] });
      const tab = tabs.find(item => item.active) || tabs[0];
      if (!tab) return { error: 'Không có tab YouTube đang mở.' };
      const claims = btoa(JSON.stringify({ mode: 'dub', source: command.source || 'en', target: command.target || 'vi' })).replace(/=+$/, '');
      const data = await captions(tab.id, `${claims}.dev`);
      if (data) await debugLog('dev:cues', { url: tab.url, duration: data.duration, cues: data.cues });
      return data ? { ok: true } : { error: 'Không lấy được phụ đề' };
    }
    if (command.type !== 'start') return { error: 'Unknown command' };
    if (!savedSession?.token || savedSession.expires <= Date.now()) return { error: 'Chưa có mã phiên còn hạn. Dán mã vào popup và bấm Bắt đầu một lần.' };
    const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/watch*', 'https://m.youtube.com/watch*'] });
    const tab = tabs.find(item => item.active) || tabs[0];
    if (!tab) return { error: 'Không có tab YouTube đang mở.' };
    if (command.reloadTab) {
      await chrome.tabs.reload(tab.id);
      await new Promise(resolve => {
        const done = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
        chrome.tabs.onUpdated.addListener(done);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 20000);
      });
      await new Promise(resolve => setTimeout(resolve, command.settleMs ?? 4000));
    }
    await stopSession().catch(() => {});
    return startSession({ type: 'start', server: savedSession.server, token: savedSession.token, pipelineUrl: savedSession.pipelineUrl || '', volume: savedSession.volume ?? 0.2, cloneVoice: Boolean(command.cloneVoice ?? savedSession.cloneVoice), tabId: tab.id });
  };
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await chrome.runtime.getPlatformInfo(); // Extension API activity keeps the worker alive while debugging.
      const response = await fetch(`${devSink}/state`, { cache: 'no-store' });
      if (!response.ok) return;
      const state = await response.json();
      if (loadedVersion === null) loadedVersion = state.version;
      else if (state.version !== loadedVersion) {
        await debugLog('dev:reload', { from: loadedVersion, to: state.version });
        chrome.runtime.reload();
        return;
      }
      const { devHandled } = await chrome.storage.local.get('devHandled');
      if (state.command?.id && state.command.id !== devHandled) {
        await chrome.storage.local.set({ devHandled: state.command.id });
        await debugLog('dev:command', { id: state.command.id, type: state.command.type, withToken: Boolean(state.command.token) });
        const result = await runCommand(state.command).catch(error => ({ error: error.message }));
        await debugLog('dev:command-result', { id: state.command.id, result: result?.error ? { error: result.error } : { ok: true } });
      }
    } catch { /* Dev server is not running. */ } finally { polling = false; }
  };
  setInterval(poll, 1500);
  void poll();
  void debugLog('dev:worker-started', { version: chrome.runtime.getManifest().version });
}
