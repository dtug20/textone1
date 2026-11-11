import { PipelineSession } from './sessions/pipeline-session.js';
import { AheadSession } from './sessions/ahead-session.js';
let pipelineSession = null;
async function stop() {
  if (pipelineSession) { const old = pipelineSession; pipelineSession = null; await old.stop(); }
}
async function start(message) {
  await stop();
  pipelineSession = ['youtube', 'captions'].includes(message.input) ? new AheadSession(message) : new PipelineSession(message);
  try { await pipelineSession.start(); } catch (error) { await stop(); throw error; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'offscreen') return;
  if (message.type === 'live-timeline') {
    if (!pipelineSession) { reply({ inactive: true }); return; }
    pipelineSession.timeline(message.timeline || {}); reply({ ok: true }); return;
  }
  if (message.type === 'next') {
    reply(pipelineSession?.next?.() || { active: false }); return;
  }
  if (message.type === 'native-status') {
    pipelineSession?.status?.(message.status || {}); reply({ ok: true }); return;
  }
  if (message.type === 'volume') {
    if (pipelineSession?.monitor) pipelineSession.monitor.gain.value = message.volume;
    reply({ ok: true }); return;
  }
  if (message.type === 'clone-voice') {
    pipelineSession?.setCloneVoice?.(Boolean(message.cloneVoice), message.streamId);
    reply({ ok: true }); return;
  }
  (message.type === 'start' ? start(message) : stop()).then(() => reply({ ok: true })).catch((error) => reply({ error: error.message }));
  return true;
});
