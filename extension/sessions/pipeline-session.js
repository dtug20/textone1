import { pipelineEndpoint } from './pipeline-endpoint.js';
import { encodeWav } from '../audio/audio.js';
export class PipelineSession {
  constructor(config) {
    Object.assign(this, config);
    this.generation = 0; this.sequence = 0; this.paused = true; this.alive = true;
    this.capturedAt = new Map(); this.position = config.position || 0;
    this.state = {
      active: true, stage: 'preparing', captured: 0, processed: 0, spoken: 0,
      dropped: 0, pipeline: true, sourceLabel: config.sourceLabel || 'Âm thanh tab',
    };
    this.controller = new AbortController();
    this.scheduled = new Set(); this.playUntil = 0; this.decodeChain = Promise.resolve();
  }
  publish() { void chrome.runtime.sendMessage({ target: 'background', type: 'state', state: this.state }).catch(() => {}); }
  debug(event, data = {}) { try { void chrome.runtime.sendMessage({ target: 'background', type: 'debug-log', event, data }).catch(() => {}); } catch { /* Logging must never break the session. */ } }
  async start() {
    const response = await fetch(`${this.server}/api/realtime/pipeline`, { headers: { Authorization: `Bearer ${this.token}` }, signal: this.controller.signal });
    const config = await response.json().catch(() => ({}));
    if (!this.alive) throw new Error('Phiên đã dừng.');
    if (response.status === 401) throw new Error(config.error || 'Phiên đã hết hạn hoặc bị thay thế.');
    let selectedEndpoint = this.pipelineUrl || config.endpoint || '';
    if (!this.pipelineUrl) {
      const candidates = [
        { health: 'http://192.168.1.198:18802/health', ws: 'ws://192.168.1.198:18802/stream' },
        { health: 'http://localhost:18802/health', ws: 'ws://localhost:18802/stream' },
      ];
      for (const candidate of candidates) {
        const discovery = new AbortController();
        const timer = setTimeout(() => discovery.abort(), 1200);
        try {
          const local = await fetch(candidate.health, { signal: discovery.signal, cache: 'no-store' });
          if (local.ok) { selectedEndpoint = candidate.ws; break; }
        } catch { /* Try next candidate. */ }
        finally { clearTimeout(timer); }
      }
    }
    if (!selectedEndpoint && !response.ok) throw new Error(config.error || 'Pipeline chưa sẵn sàng.');
    const endpoint = pipelineEndpoint(selectedEndpoint);
    this.debug('tab:connecting', { endpoint, status: response.status });
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: this.streamId } }, video: false });
    if (!this.alive) { this.stream.getTracks().forEach(t => t.stop()); return; }
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.audioWorklet.addModule('audio/capture-worklet.js');
    if (!this.alive) return;
    const source = this.context.createMediaStreamSource(this.stream);
    this.monitor = this.context.createGain(); this.monitor.gain.value = this.volume;
    source.connect(this.monitor).connect(this.context.destination);
    this.capture = new AudioWorkletNode(this.context, 'capture');
    source.connect(this.capture).connect(this.context.destination);
    this.capture.port.postMessage({ enabled: false });
    this.capture.port.onmessage = ({ data }) => this.submit(data);
    this.stream.getTracks().forEach(t => t.addEventListener('ended', () => { if (this.alive) void this.fail('Luồng thu tab đã kết thúc.'); }));
    await this.context.resume();
    if (!this.alive) return;
    this.socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kết nối pipeline quá hạn.')), 115000);
      this.socket.onopen = () => this.send({ token: this.token, input: 'tab', position: this.position, protocol: 2, ...(this.cloneVoice ? { cloneVoice: true } : {}) });
      this.socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(data);
          if (event.type === 'ready') { clearTimeout(timer); this.state.stage = 'listening'; this.publish(); resolve(); }
          else if (event.type === 'error') { clearTimeout(timer); reject(new Error(event.error)); void this.fail(event.error); }
          else void this.receive(event).catch(error => this.fail(error.message));
        } catch (error) { clearTimeout(timer); reject(error); }
      };
      this.socket.onerror = () => { clearTimeout(timer); reject(new Error('Không kết nối được pipeline.')); void this.fail('Không kết nối được pipeline.'); };
      this.socket.onclose = () => { clearTimeout(timer); reject(new Error('Pipeline đã ngắt kết nối.')); if (this.alive) void this.fail('Pipeline đã ngắt kết nối. Tạo phiên mới nếu phiên cũ chưa giải phóng.'); };
    });
  }
  send(message) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message)); }
  setCloneVoice(enabled) {
    this.cloneVoice = Boolean(enabled);
    this.send({ type: 'clone-voice', enabled: this.cloneVoice });
  }
  submit(chunk) {
    if (!this.alive || this.paused || this.socket?.readyState !== 1) return;
    if (this.socket.bufferedAmount > 200000) { this.state.dropped++; this.debug('tab:dropped', { reason: 'upload backlog', bufferedAmount: this.socket.bufferedAmount }); this.publish(); return; }
    const samples = chunk?.samples || chunk;
    const boundary = chunk?.boundary === 'window' ? 'window' : 'pause';
    const pcm = encodeWav(samples, 16000).slice(44);
    const packet = new ArrayBuffer(20 + pcm.byteLength); const view = new DataView(packet);
    const sequence = this.sequence++;
    view.setUint32(0, this.generation, true); view.setUint32(4, sequence, true); view.setFloat64(8, Math.max(0, this.position - samples.length / 16000), true);
    view.setUint8(16, boundary === 'pause' ? 1 : 0);
    new Uint8Array(packet, 20).set(new Uint8Array(pcm));
    this.capturedAt.set(sequence, performance.now() - samples.length / 16);
    while (this.capturedAt.size > 20) this.capturedAt.delete(this.capturedAt.keys().next().value);
    this.socket.send(packet); this.state.captured++; this.publish();
  }
  async receive(event) {
    if (!this.alive || (event.generation !== undefined && event.generation !== this.generation)) return;
    if (event.type === 'dropped') { this.state.dropped++; this.debug('tab:dropped', { reason: 'server queue full' }); this.publish(); return; }
    if (event.type === 'transcript') {
      this.state.text = event.text || ''; this.state.translatedText = event.translatedText || '';
      if (event.text && !event.partial) this.state.segments = [...(this.state.segments || []), { text: event.text, translatedText: event.translatedText }].slice(-200);
      this.state.stage = event.partial ? 'listening' : 'synthesizing'; this.publish(); return;
    }
    if (event.type !== 'audio') return;
    this.state.timings = event.timings;
    this.state.processed += event.audio ? 1 : 0;
    if (event.audio && !this.paused) {
      const generation = this.generation;
      const began = this.capturedAt.get(event.sequence);
      if (began === undefined || performance.now() - began > 45000) {
        this.state.dropped++; this.debug('tab:dropped', { reason: began === undefined ? 'unknown sequence' : 'too late', ageMs: began === undefined ? null : Math.round(performance.now() - began), timings: event.timings }); this.publish(); return;
      }
      const audio = Uint8Array.from(atob(event.audio), c => c.charCodeAt(0));
      // Serialize decoding so a later WAV cannot overtake an earlier segment.
      const decoding = this.decodeChain.then(() => this.context.decodeAudioData(audio.buffer));
      this.decodeChain = decoding.catch(() => {});
      const buffer = await decoding;
      if (!this.alive || this.paused || generation !== this.generation) return;
      const now = this.context.currentTime;
      const start = Math.max(now + 0.03, this.playUntil);
      // Bound backlog without cutting the sentence already being spoken.
      if (start - now > 6 || performance.now() - began + (start - now) * 1000 > 45000) {
        this.state.dropped++; this.capturedAt.delete(event.sequence); this.publish(); return;
      }
      const source = this.context.createBufferSource(); source.buffer = buffer;
      source.connect(this.context.destination);
      this.scheduled.add(source);
      source.onended = () => { this.scheduled.delete(source); source.disconnect(); };
      source.start(start); this.playUntil = start + buffer.duration;
      this.state.spoken++; this.state.endToEndMs = Math.round(performance.now() - began + (start - now) * 1000);
      this.state.processingMs = event.timings?.totalMs;
      this.capturedAt.delete(event.sequence);
    }
    this.state.stage = 'listening'; this.publish();
  }
  timeline(value) {
    if (value.changed) { void this.fail('Video nguồn đã thay đổi. Bắt đầu phiên mới.'); return; }
    if (Number.isFinite(value.position)) this.position = value.position;
    if (value.reset || Boolean(value.paused) !== this.paused) {
      this.generation++; this.capturedAt.clear(); this.clearPlayback();
      this.capture?.port.postMessage({ enabled: !value.paused, reset: true });
      this.send({ type: 'reset', generation: this.generation, position: this.position });
    }
    this.paused = Boolean(value.paused);
    this.send({ type: 'position', position: this.position });
  }
  clearPlayback() {
    for (const source of this.scheduled) { source.onended = null; source.stop(); source.disconnect(); }
    this.scheduled.clear(); this.playUntil = 0;
  }
  async fail(error) { this.debug('tab:fail', { error }); this.state.error = error; await this.stop(); }
  async stop() {
    if (!this.alive) return;
    this.alive = false; this.controller.abort(); this.socket?.close(); this.clearPlayback();
    this.stream?.getTracks().forEach(t => t.stop()); await this.context?.close();
    this.capturedAt.clear(); this.state.active = false; this.state.stage = ''; this.publish();
  }
}
