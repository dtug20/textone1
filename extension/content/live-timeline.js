// Observe the native player only; no DOM, volume or playback mutations.
(() => {
  globalThis.__textoneLiveTimeline?.();
  const video = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!video) throw new Error('Không tìm thấy video. Mở video YouTube rồi thử lại.');
  const url = location.href;
  const events = ['pause', 'playing', 'seeking', 'seeked', 'ratechange', 'waiting', 'ended'];
  let timer;
  let dead = false;
  const cleanup = () => {
    dead = true;
    clearInterval(timer);
    for (const event of events) video.removeEventListener(event, report);
  };
  const report = async (event) => {
    if (dead) return;
    try {
      if (!chrome.runtime?.id) return cleanup();
      const changed = location.href !== url || !video.isConnected;
      const result = await chrome.runtime.sendMessage({ target: 'background', type: 'live-timeline', timeline: {
        position: video.currentTime,
        reset: changed || ['seeking', 'ratechange'].includes(event?.type),
        paused: changed || video.paused || video.seeking || video.ended || video.readyState < 3,
        changed,
      } });
      if (changed || result?.inactive) cleanup();
    } catch { cleanup(); }
  };
  for (const event of events) video.addEventListener(event, report);
  timer = setInterval(report, 500);
  globalThis.__textoneLiveTimeline = cleanup;
  void report();
})();
