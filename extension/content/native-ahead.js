(() => {
  const state = globalThis.__textoneControlledVideo;
  if (!state || state.narration) return;
  const video = state.video;
  const urls = [];
  const START_CUSHION_SECONDS = 2.5;
  let alive = true, timer, polling = false, generation = 0, controller;
  let waiting = true, wantPlay = !state.paused, resuming = false;
  const events = new AbortController();
  const send = async (type, data = {}) => {
    try { return await chrome.runtime.sendMessage({ target: 'background', type, ...data }); }
    catch (error) { if (/context invalidated/i.test(error.message)) destroy(); throw error; }
  };
  const report = data => send('native-status', data).catch(() => {});
  const build = () => new globalThis.TextoneNativeNarration(video, new Audio(), {
    startSuspended: true, originalVolume: state.liveVolume ?? 0.2, createAudio: () => new Audio(),
    onMissing: () => { waiting = true; wantPlay = true; void report({ stage: 'buffering', error: '' }); },
    onComplete: () => { waiting = true; wantPlay = true; void report({ stage: 'buffering', error: '' }); },
    onSegment: spoken => void report({ stage: 'playing', spoken, error: '' }),
    onError: error => { wantPlay = false; void report({ stage: 'prepared', error }); },
  });
  controller = build();
  const position = reset => send('live-timeline', { timeline: { position: video.currentTime, paused: video.paused, reset, changed: !video.isConnected || location.href !== state.url } }).catch(() => {});
  video.addEventListener('seeking', () => {
    generation++; waiting = true; wantPlay = !video.paused || wantPlay;
    controller.destroy(); controller = build(); video.pause();
    urls.splice(0).forEach(URL.revokeObjectURL);
    void position(true);
  }, { signal: events.signal });
  video.addEventListener('pause', () => { if (!waiting && !controller.buffering) wantPlay = false; }, { signal: events.signal });
  video.addEventListener('play', () => { wantPlay = true; if (waiting) video.pause(); }, { signal: events.signal });
  async function poll() {
    if (!alive || polling) return;
    polling = true;
    try {
      await position(false);
      const response = await send('native-next');
      if (!alive) return;
      if (response?.error) throw new Error(response.error);
      if (response?.generation === generation && response.clip) {
        const clip = response.clip;
        let url = null;
        if (clip.audio) { url = URL.createObjectURL(new Blob([Uint8Array.from(atob(clip.audio), c => c.charCodeAt(0))], { type: 'audio/wav' })); urls.push(url); }
        const timing = Number.isFinite(clip.speechStart) && Number.isFinite(clip.speechEnd) && clip.speechEnd > clip.speechStart ? { speechStart: clip.speechStart, speechEnd: clip.speechEnd } : {};
        controller.add({ start: clip.sourceStart, duration: clip.duration, audio: url, ...timing });
      }
      const now = video.currentTime;
      let end = now;
      for (const clip of controller.clips) if (clip.start <= end + 0.01 && clip.start + clip.duration > end) end = clip.start + clip.duration;
      // Start as soon as the first audible sentence is ready. Waiting for a long
      // block of later sentences kept the video paused with nothing to hear.
      const cushion = Math.min(START_CUSHION_SECONDS, Math.max(0, video.duration - now));
      const speakable = controller.clips.some((clip) => clip.audio && clip.start < end + 0.05 && clip.start + clip.duration > now - 0.05);
      const initialSilenceReady = !speakable && end - now >= Math.min(15, Math.max(cushion, (video.duration || 0) - now));
      if (waiting && !video.seeking && end - now >= cushion - 0.05 && (speakable || initialSilenceReady) && !resuming) {
        const epoch = generation;
        resuming = true;
        try { await controller.prime(now); }
        catch (error) { if (epoch === generation) throw error; }
        if (alive && epoch === generation) {
          waiting = false; controller.activate();
          if (wantPlay) { await video.play(); controller.sync(true); }
          await report({ stage: 'playing', error: '' });
        }
        resuming = false;
      }
      if (response?.active !== false) timer = setTimeout(poll, response?.clip ? 0 : 200);
    } catch (error) { await report({ stage: 'prepared', error: error.message }); }
    finally { polling = false; }
  }
  const receive = (message, sender) => {
    if (sender.id === chrome.runtime.id && message.target === 'native' && message.type === 'volume' && Number.isFinite(message.volume)) video.volume = Math.max(0, Math.min(1, message.volume));
  };
  chrome.runtime.onMessage.addListener(receive);
  function destroy() {
    if (!alive) return;
    alive = false; clearTimeout(timer); events.abort();
    try { chrome.runtime.onMessage.removeListener(receive); } catch { /* Extension reloaded. */ } controller.destroy(); urls.forEach(URL.revokeObjectURL);
    video.muted = state.muted; video.volume = state.volume;
  }
  state.narration = { destroy };
  void poll();
})();
