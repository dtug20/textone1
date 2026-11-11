// Synchronize a prepared narration timeline to the original HTMLVideoElement.
// No overlay, replacement video, stylesheet, or controls are added to the page.
globalThis.TextoneNativeNarration = class NativeNarration {
  constructor(video, audio, { onMissing = () => {}, onComplete = () => {}, onError = () => {}, onSegment = () => {}, originalVolume = 0.2, createAudio = null, startSuspended = false } = {}) {
    this.video = video; this.audio = audio; this.onMissing = onMissing; this.onComplete = onComplete; this.completed = false; this.onError = onError; this.onSegment = onSegment; this.played = new Set();
    audio.preservesPitch = true;
    this.suspended = startSuspended; this.createAudio = createAudio; this.preloaded = new Map(); this.stalled = false; this.generation = 0; this.playPending = null; this.audioRequests = new WeakMap();
    this.clips = []; this.current = null; this.waitingAt = null; this.alive = true;
    this.saved = { volume: video.volume, muted: video.muted };
    video.volume = originalVolume;
    this.events = new AbortController();
    const on = (target, event, fn) => target.addEventListener(event, fn, { signal: this.events.signal });
    on(video, 'playing', () => { this.stalled = false; this.sync(true); });
    on(video, 'pause', () => { this.generation++; this.audio.pause(); });
    on(video, 'waiting', () => { this.stalled = true; this.generation++; this.audio.pause(); });
    on(video, 'seeking', () => { this.generation++; this.audio.pause(); this.current = null; });
    on(video, 'seeked', () => this.sync(!video.paused));
    on(video, 'ratechange', () => this.sync(!video.paused));
    on(video, 'timeupdate', () => this.sync(!video.paused));
    on(video, 'ended', () => { this.generation++; this.audio.pause(); });
    this.bindAudio(audio);
    const frame = (_, metadata) => {
      if (!this.alive) return;
      this.sync(!video.paused, metadata?.mediaTime);
      this.frameId = video.requestVideoFrameCallback(frame);
    };
    if (typeof video.requestVideoFrameCallback === 'function') this.frameId = video.requestVideoFrameCallback(frame);
  }
  bindAudio(audio) {
    audio.preservesPitch = true; audio.preload = 'auto';
    const on = (event, fn) => audio.addEventListener(event, () => { if (this.alive && this.audio === audio) fn(); }, { signal: this.events.signal });
    on('loadedmetadata', () => this.sync(!this.video.paused));
    on('error', () => { this.video.pause(); this.onError('Không tải được giọng thuyết minh cho đoạn này.'); });
  }
  preload(clip) {
    if (!this.createAudio) return;
    const index = this.clips.indexOf(clip);
    const nearby = this.clips.slice(Math.max(0, index), index + 12).filter((entry) => entry.audio);
    for (const [entry, audio] of this.preloaded) {
      if (!nearby.includes(entry) && audio !== this.audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); this.preloaded.delete(entry); }
    }
    for (const entry of nearby) if (!this.preloaded.has(entry)) {
      const audio = this.createAudio(); this.bindAudio(audio);
      audio.src = entry.audio; this.preloaded.set(entry, audio); audio.load();
    }
  }
  async prime(time) {
    this.sync(false, time);
    const clip = this.clips.find((entry) => time >= entry.start && time < entry.start + entry.duration);
    if (!clip?.audio) return;
    this.preload(clip);
    const audio = this.preloaded.get(clip) || this.audio;
    if (audio.src !== clip.audio && !this.preloaded.has(clip)) { audio.src = clip.audio; audio.load(); }
    if (!clip.audio || audio.readyState === undefined || audio.readyState >= 3) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); audio.removeEventListener('canplay', ready); audio.removeEventListener('error', failed); this.events.signal.removeEventListener('abort', failed); };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Chưa tải được tiếng thuyết minh. Bấm Phát để thử lại.')); };
      const timer = setTimeout(failed, 15000);
      audio.addEventListener('canplay', ready, { once: true }); audio.addEventListener('error', failed, { once: true });
      this.events.signal.addEventListener('abort', failed, { once: true });
    });
  }
  add(clip) {
    if (!(clip.start >= 0) || !(clip.duration > 0) || !Number.isFinite(clip.start + clip.duration)) throw new Error('Invalid narration timing');
    if (this.clips.some((entry) => clip.start < entry.start + entry.duration - 0.01 && clip.start + clip.duration > entry.start + 0.01)) throw new Error('Overlapping narration');
    if ((clip.speechStart !== undefined || clip.speechEnd !== undefined) && !(Number.isFinite(clip.speechStart) && Number.isFinite(clip.speechEnd) && clip.speechStart >= 0 && clip.speechEnd > clip.speechStart && clip.speechEnd <= clip.duration)) throw new Error('Invalid speech timing');
    this.clips.push(clip); this.clips.sort((a, b) => a.start - b.start);
  }
  activate() { this.suspended = false; this.stalled = false; }
  sync(play = false, mediaTime) {
    if (!this.alive || this.suspended || this.video.seeking) { this.audio.pause(); return; }
    play = play && !this.stalled && !this.video.paused;
    // Seeking may display a decoded frame preceding currentTime. Never use that
    // frame's PTS to decide whether a prepared interval exists at the playhead.
    const position = this.video.currentTime;
    const clip = this.clips.find((entry) => position >= entry.start && position < entry.start + entry.duration)
      || this.clips.find((entry) => position < entry.start && entry.start - position <= 0.02);
    const time = clip && Number.isFinite(mediaTime) && mediaTime >= clip.start && mediaTime < clip.start + clip.duration && Math.abs(mediaTime - position) < 0.25
      ? mediaTime : clip ? Math.max(clip.start, position) : position;
    if (!clip) {
      this.audio.pause(); this.current = null;
      if (play && !this.video.ended) {
        this.buffering = true; this.video.pause();
        const last = this.clips.at(-1);
        const end = last ? last.start + last.duration : -1;
        if (time >= end && time <= end + 0.25) {
          if (!this.completed) { this.completed = true; this.onComplete(); }
        } else if (this.waitingAt !== time) { this.waitingAt = time; this.onMissing(time); }
      }
      return;
    }
    this.buffering = false; this.waitingAt = null; this.completed = false;
    if (this.current !== clip) {
      this.generation++; this.audio.pause(); this.playPending = null; this.current = clip;
      this.preload(clip);
      if (clip.audio) {
        const loaded = this.preloaded.get(clip);
        if (loaded) this.audio = loaded;
        else { this.audio.src = clip.audio; this.audio.load(); }
      }
    }
    if (!clip.audio) return;
    const speechStart = clip.start + (clip.speechStart ?? 0);
    const speechEnd = clip.start + (clip.speechEnd ?? clip.duration);
    if (time < speechStart || time >= speechEnd) { this.audio.pause(); return; }
    if (!(this.audio.duration > 0) || !Number.isFinite(this.audio.duration)) return;
    // Fit each utterance inside its original time interval; never change video speed.
    // Never stretch a short WAV to fill the caption interval: that was the main
    // cause of unnaturally slow narration. A short utterance plays at its native
    // pace and leaves silence at the end; only an overlong utterance is sped up.
    // Keep the whole sentence inside its slot. A short caption used to abort the
    // session once the required speed passed 4×, so nothing after it was spoken.
    const needed = this.audio.duration / (speechEnd - speechStart);
    const ratio = Math.min(16 / this.video.playbackRate, Math.max(1, needed));
    const rate = ratio * this.video.playbackRate;
    if (!Number.isFinite(rate) || rate < 0.25) { this.audio.pause(); return; }
    this.audio.playbackRate = rate;
    const offset = Math.max(0, Math.min(this.audio.duration, (time - speechStart) * ratio));
    if (Math.abs(this.audio.currentTime - offset) > 0.08) this.audio.currentTime = offset;
    if (!play) { this.audio.pause(); return; }
    if (this.audio.paused && offset < this.audio.duration && !this.playPending) {
      const audio = this.audio; const generation = this.generation;
      const pending = Promise.resolve(audio.play()); this.playPending = pending; this.audioRequests.set(audio, pending);
      void pending.then(() => {
        if (!this.alive || generation !== this.generation || this.current !== clip || this.video.paused || this.video.seeking || this.stalled || this.video.currentTime < speechStart - 0.001 || this.video.currentTime >= speechEnd) {
          if (this.audioRequests.get(audio) === pending) audio.pause();
          return;
        }
        if (!this.played.has(clip)) { this.played.add(clip); this.onSegment(this.played.size); }
      }).catch((error) => {
        if (error.name === 'AbortError') return;
        if (this.alive && generation === this.generation) { this.video.pause(); this.onError('Bấm Phát trên YouTube để cho phép tiếng thuyết minh.'); }
      }).finally(() => { if (this.playPending === pending) this.playPending = null; });
    }
  }
  destroy() {
    this.alive = false; this.generation++; this.events.abort();
    if (this.frameId !== undefined) this.video.cancelVideoFrameCallback?.(this.frameId); this.audio.pause(); this.audio.removeAttribute('src');
    this.video.volume = this.saved.volume; this.video.muted = this.saved.muted;
    for (const audio of this.preloaded.values()) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    this.preloaded.clear(); this.clips = []; this.current = null;
  }
}
