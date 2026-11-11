// A shared media clock: pausing/stalling the video also pauses its narration.
export class DubPlayer {
  constructor(video, audio, onEnd) {
    this.video = video; this.audio = audio; this.onEnd = onEnd; this.generation = 0; this.urls = []; this.stalled = false; this.loading = false; this.playPending = null;
    audio.preservesPitch = true;
    this.events = new AbortController();
    const on = (media, event, handler) => media.addEventListener(event, handler, { signal: this.events.signal });
    on(video,'pause', () => audio.pause());
    on(video,'waiting', () => { this.stalled = true; audio.pause(); });
    on(video,'seeking', () => audio.pause());
    on(video,'ratechange', () => this.sync(!video.paused));
    on(video,'playing', () => { this.stalled = false; this.sync(true); });
    on(video,'timeupdate', () => this.sync(!video.paused));
    on(video,'seeked', () => this.sync(!video.paused));
    on(video,'ended', () => { audio.pause(); this.complete(); });
    const frame = () => { this.sync(!video.paused); this.frameId = video.requestVideoFrameCallback(frame); };
    if (video.requestVideoFrameCallback) this.frameId = video.requestVideoFrameCallback(frame);
  }
  complete() { if (this.completed) return; this.completed = true; this.onEnd?.(); }
  sync(play) {
    if (!this.hasAudio || this.loading || this.video.ended || this.video.seeking || this.stalled) { this.audio.pause(); return; }
    const sourceTime = this.video.currentTime;
    if (sourceTime < this.speechStart || sourceTime >= this.speechEnd) { this.audio.pause(); return; }
    const ratio = this.audio.duration / (this.speechEnd - this.speechStart);
    const rate = ratio * this.video.playbackRate;
    if (!(rate >= 0.25 && rate <= 4)) { this.pause(); return; }
    this.audio.playbackRate = rate;
    const time = Math.max(0, Math.min(this.audio.duration, (sourceTime - this.speechStart) * ratio));
    if (Number.isFinite(time) && Math.abs(this.audio.currentTime - time) > 0.08) this.audio.currentTime = time;
    if (play && !this.video.paused && this.audio.paused && !this.playPending) {
      const generation = this.generation;
      const pending = this.audio.play(); this.playPending = pending;
      void pending.then(() => { if (generation !== this.generation || this.video.paused || this.video.seeking || this.stalled || this.video.currentTime < this.speechStart || this.video.currentTime >= this.speechEnd) this.audio.pause(); }).catch((error) => { if (error.name !== 'AbortError' && generation === this.generation) this.pause(); }).finally(() => { if (this.playPending === pending) this.playPending = null; });
    }
  }
  async load(clip) {
    const generation = ++this.generation;
    this.loadController?.abort(); this.loadController = new AbortController();
    const signal = this.loadController.signal; this.loading = true;
    this.video.pause(); this.audio.pause(); this.completed = false;
    this.urls.forEach(URL.revokeObjectURL); this.urls = [];
    const url = (data, type) => {
      if (/^https?:/.test(data)) return data;
      const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type });
      const value = URL.createObjectURL(blob); this.urls.push(value); return value;
    };
    const ready = (media, src) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Tải video quá lâu. Hãy thử lại.')); }, 20_000);
      const cleanup = () => { clearTimeout(timer); media.removeEventListener('loadedmetadata', loaded); media.removeEventListener('error', failed); signal.removeEventListener('abort', failed); };
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Không tải được đoạn video hoặc giọng đọc.')); };
      signal.addEventListener('abort', failed, { once: true });
      media.addEventListener('loadedmetadata', loaded); media.addEventListener('error', failed);
      media.src = src; media.load();
    });
    this.hasAudio = Boolean(clip.audio);
    await Promise.all([ready(this.video, url(clip.video, 'video/webm')), this.hasAudio ? ready(this.audio, url(clip.audio, 'audio/wav')) : Promise.resolve()]);
    if (generation !== this.generation) return;
    const videoDuration = Number.isFinite(this.video.duration) ? this.video.duration : clip.duration;
    const scale = videoDuration / clip.duration;
    this.speechStart = Number.isFinite(clip.speechStart) ? clip.speechStart * scale : 0;
    this.speechEnd = Number.isFinite(clip.speechEnd) ? clip.speechEnd * scale : videoDuration;
    this.loading = false; this.stalled = false;
    this.video.volume = clip.volume ?? 0.2;
    this.video.currentTime = 0;
    if (this.hasAudio) this.audio.currentTime = 0;
  }
  async play() {
    try {
      if (this.loading) throw new Error('Đang tải đoạn video.');
      await this.video.play(); this.sync(true);
      if (this.playPending) await this.playPending;
    } catch (error) { this.pause(); throw error; }
  }
  pause() { this.video.pause(); this.audio.pause(); }
  destroy() { this.generation++; this.loadController?.abort(); if (this.frameId !== undefined) this.video.cancelVideoFrameCallback?.(this.frameId); this.events.abort(); this.pause(); this.urls.forEach(URL.revokeObjectURL); this.video.removeAttribute('src'); this.audio.removeAttribute('src'); }
}
