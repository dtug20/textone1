// Runs in Chrome's isolated world on the explicitly selected source tab.
export async function controlSource(action, data = {}) {
  try {
  const key = '__textoneControlledVideo';
  if (action === 'attach') {
    const videos = [...document.querySelectorAll('video')].filter((v) => v.readyState >= 1);
    const video = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!video || !Number.isFinite(video.duration)) throw new Error('Chế độ đồng bộ cần video có thể tạm dừng. Hãy mở và phát một video YouTube trước.');
    if (document.querySelector('.html5-video-player.ad-showing')) throw new Error('Hãy chờ quảng cáo kết thúc rồi bắt đầu lại.');
    if (globalThis[key]) throw new Error('Phiên cũ chưa dừng.');
    if ((!data.readAhead && typeof video.captureStream !== 'function') || video.mediaKeys) throw new Error('Video này không cho phép thu trực tiếp để đồng bộ.');
    globalThis[key] = { video, paused: video.paused, muted: video.muted, volume: video.volume, rate: video.playbackRate, url: location.href, liveVolume: data.volume };
    if (Number.isFinite(data.time)) video.currentTime = Math.max(0, Math.min(video.duration - 0.1, data.time));
    video.pause();
    if (!data.readAhead) video.playbackRate = 1;
  }
  const state = globalThis[key];
  if (!state?.video) throw new Error('Không có phiên video đang chạy.');
  if (action !== 'detach' && (!state.video.isConnected || state.url !== location.href)) throw new Error('Video nguồn đã thay đổi. Dừng và bắt đầu phiên mới.');
  const video = state.video;
  if (action === 'capture-audio') { video.muted = false; video.volume = 1; }
  if (action === 'offer') {
    state.stream = video.captureStream();
    if (!state.stream.getVideoTracks().length) throw new Error('Chưa lấy được hình hoặc tiếng. Phát video vài giây rồi thử lại.');
    state.peer = new RTCPeerConnection({ iceServers: [] });
    for (const track of state.stream.getVideoTracks()) state.peer.addTrack(track, state.stream);
    await state.peer.setLocalDescription(await state.peer.createOffer());
    await new Promise((resolve, reject) => {
      if (state.peer.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(() => reject(new Error('Không kết nối được luồng video cục bộ.')), 10000);
      state.peer.onicegatheringstatechange = () => { if (state.peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
    });
    return { description: state.peer.localDescription.toJSON() };
  }
  if (action === 'answer') await state.peer.setRemoteDescription(data.description);
  if (action === 'play') {
    if (document.querySelector('.html5-video-player.ad-showing')) throw new Error('Video đang phát quảng cáo. Dừng phiên và tiếp tục sau quảng cáo.');
    await video.play();
  }
  if (action === 'pause') video.pause();
  if (action === 'detach') {
    video.pause(); // Leave the source where capture stopped; never unexpectedly autoplay on Stop.
    state.narration?.destroy();
    state.inline?.destroy();
    state.peer?.close(); state.stream?.getTracks().forEach((track) => track.stop());
    video.muted = state.muted; video.volume = state.volume;
    video.playbackRate = state.rate;
    delete globalThis[key];
    if (data.resume && !state.paused) await video.play();
  }
  return { time: video.currentTime, duration: video.duration, ended: video.ended, paused: video.paused, wasPaused: state.paused };
  } catch (error) { return { error: error.message || 'Không thể điều khiển video.' }; }
}
