import { pipelinePermission } from './sessions/pipeline-endpoint.js';
const $ = (id) => document.getElementById(id);
const saved = await chrome.storage.session.get(['server', 'token', 'volume', 'cloneVoice', 'state', 'pipelineUrl']);
// Session storage is wiped when the extension reloads; keep the short-lived
// session code until it expires so a reload does not require pasting it again.
const { savedSession } = await chrome.storage.local.get('savedSession');
if (!saved.token && savedSession?.token && savedSession.expires > Date.now()) Object.assign(saved, { server: saved.server || savedSession.server, token: savedSession.token, pipelineUrl: saved.pipelineUrl || savedSession.pipelineUrl, cloneVoice: saved.cloneVoice ?? savedSession.cloneVoice });
const server = saved.server || 'https://textone.id.vn';
if (saved.token) $('token').value = saved.token;
if ($('clone-voice')) $('clone-voice').checked = Boolean(saved.cloneVoice);
const tokenExpiry = (token) => {
  try { return Number(JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).expires) || 0; } catch { return 0; }
};
function renderLog(list = []) {
  $('debug-log').textContent = list.length
    ? list.slice(-80).map(entry => { const { at, event, ...data } = entry; return `${at.slice(11, 23)} ${event} ${JSON.stringify(data)}`; }).join('\n')
    : 'Chưa có nhật ký.';
}
renderLog((await chrome.storage.local.get('debugLog')).debugLog);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.debugLog) renderLog(changes.debugLog.newValue); });
$('copy-log').onclick = async () => {
  const { debugLog = [] } = await chrome.storage.local.get('debugLog');
  await navigator.clipboard.writeText(debugLog.map(entry => JSON.stringify(entry)).join('\n'));
};
$('clear-log').onclick = () => chrome.storage.local.set({ debugLog: [] });
if (saved.volume !== undefined) $('volume').value = saved.volume;
let lastState = saved.state;
let starting = false;
function updateConnection() {
  try {
    $('setup').href = `${server}/realtime`;
    const payload = $('token').value.trim().split('.')[0];
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (claims.cloneVoice !== undefined && saved.cloneVoice === undefined && $('clone-voice')) {
      $('clone-voice').checked = Boolean(claims.cloneVoice);
    }
    const languages = { en: 'Anh', vi: 'Việt' };
    const cloneLabel = $('clone-voice')?.checked ? ' · Clone giọng video' : '';
    $('session-info').textContent = `${claims.mode === 'dub' ? 'Thuyết minh' : 'Chép lời'} · ${languages[claims.source] || claims.source}${claims.mode === 'dub' ? ` → ${languages[claims.target] || claims.target}${cloneLabel}` : ''} · hết hạn ${new Date(claims.expires).toLocaleTimeString('vi-VN')}`;
    if (claims.expires <= Date.now()) $('session-info').textContent = 'Mã đã hết hạn. Tạo phiên mới trên web rồi dán lại.';
  } catch { $('session-info').textContent = 'Chọn ngôn ngữ và giọng đọc trên web, sau đó dán mã vào đây.'; }
}
function showError(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
function render(state = {}) {
  lastState = state;
  const stages = { preparing: 'Đang khởi động mô hình', buffering: 'Đang chuẩn bị bản dịch phía trước', synthesizing: 'Đang tạo giọng đọc', playing: 'Đang phát đồng bộ với video', prepared: 'Đã dừng phát', listening: 'Đang nghe và dịch video' };
  const waiting = state.active && Number.isFinite(state.requestStartedAt) && ['recognizing', 'synthesizing'].includes(state.stage) ? ` · ${Math.max(0, Math.round((Date.now() - state.requestStartedAt) / 1000))} giây` : '';
  $('status').textContent = starting ? 'Đang kết nối…' : state.active ? `${stages[state.stage] || 'Đang nghe'}${waiting}` : 'Sẵn sàng kết nối';
  $('badge').textContent = state.active ? 'Đang dịch' : 'Sẵn sàng';
  $('indicator').classList.toggle('active', Boolean(state.active));
  $('start').disabled = starting || Boolean(state.active);
  $('stop').disabled = !state.active && !starting;
  $('token').disabled = Boolean(state.active);
  $('processed').textContent = state.processed || 0;
  $('spoken').textContent = state.spoken || 0;
  $('latency').textContent = state.processingMs ? `${(state.processingMs / 1000).toFixed(1)}s` : '—';
  $('diagnostics').textContent = `Đã thu ${state.captured || 0} · bỏ qua ${state.dropped || 0} đoạn${state.timings?.sttMs != null ? ` · nhận dạng/dịch ${state.timings.sttMs} ms` : ''}${state.timings?.ttsMs != null ? ` · giọng đọc ${state.timings.ttsMs} ms` : ''}`;
  if (state.sourceLabel || state.captionSource) $('diagnostics').textContent += ` · nguồn ${state.sourceLabel || state.captionSource}`;
  $('transcript').textContent = state.text || 'Chưa có lời nói được nhận dạng.';
  $('translation').textContent = state.translatedText || 'Bản dịch sẽ xuất hiện tại đây khi video có lời nói.';
  $('export').disabled = !state.segments?.length;
  if (state.timings?.asrMs != null) $('diagnostics').textContent += ` · GPU ASR ${state.timings.asrMs} ms · dịch ${state.timings.translationMs} ms`;
  if (state.timings?.narrationRate) $('diagnostics').textContent += ` · tốc độ giọng ${state.timings.narrationRate}×`;
  if (state.timings?.clonedVoice) $('diagnostics').textContent += ` · clone giọng: ${state.timings.clonedVoice}`;
  if (state.timings?.translationSource) $('diagnostics').textContent += ` · dịch ${state.timings.translationSource}`;
  if (Number.isFinite(state.preparedAhead)) $('diagnostics').textContent += ` · đã chuẩn bị trước ${state.preparedAhead.toFixed(1)} giây`;
  if (Number.isFinite(state.inputRms)) $('diagnostics').textContent += ` · mức thu ${state.inputRms > 0 ? (20 * Math.log10(state.inputRms)).toFixed(0) : '−∞'} dBFS · im lặng ${state.silent || 0} · chưa nhận dạng ${state.noSpeech || 0}`;
  if (state.pendingSaves) $('diagnostics').textContent += ` · đang lưu ${state.pendingSaves} đoạn`;
  showError([state.error, state.saveError].filter(Boolean).join(' · '));
}
updateConnection();
render(lastState);
$('volume-value').textContent = `${Math.round(Number($('volume').value) * 100)}%`;
$('token').addEventListener('input', updateConnection);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.state) render(changes.state.newValue); });
setInterval(() => { if (lastState?.active) render(lastState); }, 1000);
$('volume').oninput = async () => {
  const volume = Number($('volume').value);
  $('volume-value').textContent = `${Math.round(volume * 100)}%`;
  await chrome.storage.session.set({ volume });
  if (lastState?.active) await chrome.runtime.sendMessage({ target: 'background', type: 'volume', volume });
};
if ($('clone-voice')) {
  $('clone-voice').onchange = async () => {
    const cloneVoice = Boolean($('clone-voice').checked);
    saved.cloneVoice = cloneVoice;
    await chrome.storage.session.set({ cloneVoice });
    updateConnection();
    if (lastState?.active) await chrome.runtime.sendMessage({ target: 'background', type: 'clone-voice', cloneVoice });
  };
}
$('start').onclick = async () => {
  starting = true; render(lastState);
  try {
    if (!server.startsWith('https://') && !server.startsWith('http://localhost:')) throw new Error('Dùng HTTPS hoặc localhost.');
    const token = $('token').value.trim();
    if (!token) throw new Error('Bấm Tạo phiên, chọn ngôn ngữ rồi dán mã phiên vào đây.');
    const expiry = tokenExpiry(token);
    if (expiry && expiry <= Date.now()) throw new Error('Mã phiên đã hết hạn. Bấm Tạo phiên ↗, tạo mã mới rồi dán lại vào đây.');
    // Existing developer installs may retain a loopback pipeline override. It
    // is deliberately not exposed as a user-selectable processing mode.
    const pipelineUrl = saved.pipelineUrl || '';
    const cloneVoice = Boolean($('clone-voice')?.checked);
    const pipelineOrigins = ['http://192.168.1.198/*', 'http://localhost/*', 'https://*.modal.run/*', ...(pipelineUrl ? [pipelinePermission(pipelineUrl)] : [])];
    const granted = await chrome.permissions.request({ origins: [`${server}/*`, ...pipelineOrigins] });
    if (!granted) throw new Error('Chưa cấp quyền kết nối máy chủ.');
    await chrome.storage.session.set({ server, token, pipelineUrl, cloneVoice });
    const expires = tokenExpiry(token);
    if (expires > Date.now()) await chrome.storage.local.set({ savedSession: { server, token, pipelineUrl, volume: Number($('volume').value), cloneVoice, expires } });
    const result = await chrome.runtime.sendMessage({ target: 'background', type: 'start', server, token, pipelineUrl, volume: Number($('volume').value), cloneVoice });
    if (result?.error) throw new Error(result.error);
    starting = false; render((await chrome.storage.session.get('state')).state);
  } catch (error) { starting = false; render(lastState); showError(error.message); }
};
$('stop').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
  starting = false;
  if (result?.error) showError(result.error);
};
$('export').onclick = async () => {
  const { state } = await chrome.storage.session.get('state');
  const text = (state?.segments || []).map((segment) => segment.text === segment.translatedText ? segment.text : `${segment.text}\n${segment.translatedText}`).join('\n\n');
  if (!text) { showError('Chưa có transcript.'); return; }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'textone-transcript.txt'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
