import { pipelineEndpoint } from './pipeline-endpoint.js';
import { encodeWav } from '../audio/audio.js';

export class AheadSession {
  constructor(config) {
    Object.assign(this, config);
    this.alive = true; this.generation = 0; this.position = config.position || 0;
    this.clips = []; this.coverage = [];
    this.state = {
      active: true, stage: 'preparing', captured: 0, processed: 0, spoken: 0,
      dropped: 0, pipeline: true, readAhead: true,
      preparedUntil: this.position, preparedAhead: 0,
      sourceLabel: config.sourceLabel || (config.input === 'captions' ? 'Phụ đề YouTube' : 'Audio YouTube'),
    };
    this.controller = new AbortController();
  }
  publish() { void chrome.runtime.sendMessage({ target: 'background', type: 'state', state: this.state }).catch(() => {}); }
  debug(event, data = {}) { try { void chrome.runtime.sendMessage({ target: 'background', type: 'debug-log', event, data }).catch(() => {}); } catch { /* Logging must never break the session. */ } }
  updateCoverage(start, duration) {
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
      this.coverage.push({ start, end: start + duration });
    }
    this.coverage = this.coverage.filter(interval => interval.end >= this.position - 0.01).sort((a, b) => a.start - b.start);
    let end = this.position;
    for (const interval of this.coverage) {
      if (interval.end <= end + 0.01) continue;
      if (interval.start > end + 0.01) break;
      end = interval.end;
    }
    this.state.preparedUntil = end;
    this.state.preparedAhead = Math.max(0, end - this.position);
  }
  async start() {
    const response = await fetch(`${this.server}/api/realtime/pipeline`, { headers: { Authorization: `Bearer ${this.token}` }, signal: this.controller.signal });
    const config = await response.json().catch(() => ({}));
    this.debug('ahead:pipeline-config', { status: response.status, endpoint: config.endpoint || '', error: config.error || '', code: config.code || '' });
    if (response.status === 401) throw new Error(config.error || 'Phiên đã hết hạn hoặc bị thay thế.');
    let selectedEndpoint = this.pipelineUrl || config.endpoint || '';
    if (!this.pipelineUrl) {
      const candidates = [
        { health: 'http://192.168.1.198:18802/health', ws: 'ws://192.168.1.198:18802/stream', timeout: 1800 },
        { health: 'http://localhost:18802/health', ws: 'ws://localhost:18802/stream', timeout: 1200 },
        { health: 'https://dtug20--textone-pipeline-serve.modal.run/health', ws: 'wss://dtug20--textone-pipeline-serve.modal.run/stream', timeout: 5000 },
      ];
      for (const candidate of candidates) {
        const discovery = new AbortController();
        const timer = setTimeout(() => discovery.abort(), candidate.timeout);
        const probed = performance.now();
        try {
          const local = await fetch(candidate.health, { signal: discovery.signal, cache: 'no-store' });
          this.debug('ahead:lan-probe', { url: candidate.health, status: local.status, ms: Math.round(performance.now() - probed) });
          if (local.ok) {
            selectedEndpoint = candidate.ws;
            break;
          }
        } catch (error) {
          this.debug('ahead:lan-probe', { url: candidate.health, error: String(error?.message || error), ms: Math.round(performance.now() - probed) });
        } finally { clearTimeout(timer); }
      }
    }
    if (!selectedEndpoint && !response.ok) throw new Error(config.error || `Pipeline chưa sẵn sàng (HTTP ${response.status}).`);
    try { this.endpoint = pipelineEndpoint(selectedEndpoint); }
    catch (error) { this.debug('ahead:endpoint-invalid', { endpoint: selectedEndpoint, error: error.message }); throw error; }
    // Captions are released after upload; keep a copy to resume after a drop.
    this.captionCopy = [...(this.captions || [])];
    await this.connect(this.position);
  }
  connect(position, recovering = false) {
    const endpoint = this.endpoint;
    this.debug('ahead:connecting', { endpoint, input: this.input, captions: this.captions?.length || 0, duration: this.duration, position, generation: this.generation });
    const opened = performance.now();
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => { this.debug('ahead:timeout', { ms: Math.round(performance.now() - opened) }); reject(new Error('Kết nối pipeline quá hạn.')); socket.close(); }, 115000);
      socket.onopen = () => {
        this.debug('ahead:socket-open', { ms: Math.round(performance.now() - opened) });
        this.send({ token: this.token, input: this.input || 'youtube', videoId: this.videoId, duration: this.duration, position, protocol: 2, ...(this.cloneVoice ? { cloneVoice: true } : {}) });
      };
      socket.onmessage = ({ data }) => {
        if (this.socket !== socket) return;
        try {
          const event = JSON.parse(data);
          if (event.type === 'ready') {
            clearTimeout(timer); ready = true;
            this.debug('ahead:ready', { ms: Math.round(performance.now() - opened), protocol: event.protocol });
            if (this.input === 'captions') this.uploadCaptions();
            // A fresh server starts at generation 0; move it to ours so later
            // events are not discarded as belonging to an old seek.
            if (this.generation > 0) this.send({ type: 'reset', generation: this.generation, position });
            this.send({ type: 'position', position: this.position });
            if (this.cloneVoice && this.streamId && !this.voiceSampled) void this.sampleSpeakerVoice();
            this.state.stage = 'buffering'; this.publish(); resolve();
          }
          else if (event.type === 'error') {
            clearTimeout(timer);
            this.debug('ahead:server-error', { error: event.error, beforeReady: !ready });
            reject(new Error(event.error));
            if (!recovering || ready) void this.fail(event.error);
          }
          else this.receive(event);
        } catch (error) { clearTimeout(timer); reject(error); }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        this.debug('ahead:socket-error', { endpoint, ms: Math.round(performance.now() - opened) });
        reject(new Error(`Không kết nối được pipeline (${endpoint}).`));
      };
      socket.onclose = ({ code, reason, wasClean }) => {
        this.debug('ahead:socket-close', { code, reason, wasClean, alive: this.alive, ready });
        clearTimeout(timer);
        reject(new Error(`Pipeline đóng kết nối trước khi sẵn sàng (code ${code}${reason ? `: ${reason}` : ''}).`));
        if (this.socket !== socket || !this.alive) return;
        if (ready) void this.reconnect(`code ${code}${reason ? `: ${reason}` : ''}`);
        else if (!recovering) void this.fail(`Pipeline đã ngắt kết nối (code ${code}${reason ? `: ${reason}` : ''}).`);
      };
    });
  }
  // A dropped connection (for example a keepalive timeout on a busy GPU host)
  // resumes from the end of the prepared narration instead of ending playback.
  async reconnect(reason) {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      // About a minute in total: long enough for a self-restarting SSH tunnel.
      for (let attempt = 1; attempt <= 9 && this.alive; attempt++) {
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, 1000 * 2 ** (attempt - 1))));
        if (!this.alive) return;
        const position = Math.max(this.position, this.state.preparedUntil || 0);
        this.debug('ahead:reconnect', { attempt, reason, position });
        this.captions = [...(this.captionCopy || [])];
        try { await this.connect(position, true); this.debug('ahead:reconnected', { attempt }); return; }
        catch (error) {
          this.debug('ahead:reconnect-failed', { attempt, error: error.message });
          if (/hết hạn/i.test(error.message)) { void this.fail(error.message); return; }
        }
      }
      if (this.alive) void this.fail(`Pipeline đã ngắt kết nối (${reason}) và không nối lại được.`);
    } finally { this.reconnecting = false; }
  }
  send(message) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message)); }
  setCloneVoice(enabled, streamId) {
    this.cloneVoice = Boolean(enabled);
    if (streamId) this.streamId = streamId;
    this.send({ type: 'clone-voice', enabled: this.cloneVoice });
    if (this.cloneVoice && this.streamId && !this.voiceSampled) void this.sampleSpeakerVoice();
  }
  async sampleSpeakerVoice() {
    if (!this.cloneVoice || !this.streamId || this.voiceSampled || this.samplingVoice) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') return;
    this.samplingVoice = true;
    let stream = null;
    let context = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: this.streamId } },
        video: false,
      });
      if (!this.alive || !this.cloneVoice) return;
      context = new AudioContext({ sampleRate: 16000 });
      const source = context.createMediaStreamSource(stream);
      const monitor = context.createGain();
      monitor.gain.value = this.volume ?? 0.2;
      source.connect(monitor).connect(context.destination);
      const collected = [];
      let totalSamples = 0;
      const targetSamples = 16000 * 2.6;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 9000);
        const processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          if (!this.alive || !this.cloneVoice) { clearTimeout(timer); resolve(); return; }
          const input = event.inputBuffer.getChannelData(0);
          let sumSq = 0;
          for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
          const rms = Math.sqrt(sumSq / input.length);
          if (rms >= 0.012) {
            const copy = new Float32Array(input.length);
            copy.set(input);
            collected.push(copy);
            totalSamples += copy.length;
            if (totalSamples >= targetSamples) {
              clearTimeout(timer);
              resolve();
            }
          }
        };
        const silentOut = context.createGain();
        silentOut.gain.value = 0;
        source.connect(processor);
        processor.connect(silentOut).connect(context.destination);
      });
      if (totalSamples >= 16000 * 0.8 && this.alive && this.cloneVoice) {
        const merged = new Float32Array(totalSamples);
        let offset = 0;
        for (const chunk of collected) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        const wavBuffer = encodeWav(merged, 16000);
        const bytes = new Uint8Array(wavBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        this.voiceSampled = true;
        this.send({ type: 'voice-sample', audio: btoa(binary) });
        this.debug('ahead:voice-sampled', { seconds: Number((totalSamples / 16000).toFixed(2)) });
      }
    } catch (error) {
      this.debug('ahead:voice-sample-error', { error: String(error?.message || error) });
    } finally {
      this.samplingVoice = false;
      try { stream?.getTracks().forEach(t => t.stop()); } catch {}
      try { await context?.close(); } catch {}
    }
  }
  uploadCaptions() {
    let bytes = 0; let largest = 0; let batches = 0;
    for (let index = 0; index < this.captions.length; index += 24) {
      const message = JSON.stringify({ type: 'captions', cues: this.captions.slice(index, index + 24) });
      bytes += message.length; largest = Math.max(largest, message.length); batches++;
      if (this.socket?.readyState === 1) this.socket.send(message);
    }
    this.send({ type: 'captions-end' });
    this.debug('ahead:captions-uploaded', { cues: this.captions.length, batches, bytes, largestBatch: largest });
    this.captions.length = 0;
    this.state.captionSource = 'Phụ đề YouTube';
  }
  receive(event) {
    if (!this.alive || (event.generation !== undefined && event.generation !== this.generation)) return;
    this.received = (this.received || 0) + 1;
    if (event.type === 'error' || this.received <= 6 || (event.type === 'audio' && event.audio && !this.state.processed)) {
      this.debug('ahead:event', { type: event.type, error: event.error || '', sourceStart: event.sourceStart, duration: event.duration, hasAudio: Boolean(event.audio), text: event.text?.slice(0, 120), translatedText: event.translatedText?.slice(0, 120), timings: event.timings });
    }
    if (event.type === 'dropped') { this.state.dropped++; this.publish(); return; }
    if (event.type === 'source') { this.state.duration = event.duration; this.publish(); return; }
    if (event.type === 'transcript') {
      this.state.text = event.text || ''; this.state.translatedText = event.translatedText || '';
      if (!event.partial) this.state.captured++;
      if (event.text && !event.partial) this.state.segments = [...(this.state.segments || []), { text: event.text, translatedText: event.translatedText }].slice(-200);
      this.state.stage = event.partial ? 'buffering' : 'synthesizing'; this.publish(); return;
    }
    if (event.type !== 'audio') return;
    this.clips.push({
      generation: this.generation, sourceStart: event.sourceStart, duration: event.duration,
      speechStart: event.speechStart, speechEnd: event.speechEnd, audio: event.audio,
    });
    while (this.clips.length > 240) this.clips.shift();
    // GPU speech events and immediately-known silence events may arrive out of
    // order. Only report continuous coverage from the current playhead.
    this.updateCoverage(event.sourceStart, event.duration);
    this.state.processed += event.audio ? 1 : 0;
    this.state.timings = event.timings; this.state.processingMs = event.timings?.totalMs;
    this.state.stage = 'buffering'; this.publish();
  }
  next() { return { active: this.alive, generation: this.generation, clip: this.clips.shift(), error: this.state.error || '' }; }
  status(value) {
    for (const key of ['stage', 'error', 'spoken']) if (value[key] !== undefined) this.state[key] = value[key];
  }
  timeline(value) {
    if (value.changed) { void this.fail('Video nguồn đã thay đổi. Bắt đầu phiên mới.'); return; }
    if (Number.isFinite(value.position)) {
      this.position = value.position;
      this.updateCoverage();
    }
    if (value.reset) {
      this.generation++; this.clips.length = 0; this.coverage.length = 0;
      this.state.preparedUntil = this.position; this.state.preparedAhead = 0;
      this.send({ type: 'reset', generation: this.generation, position: this.position });
    }
    this.send({ type: 'position', position: this.position });
  }
  async fail(error) {
    if (!this.alive && !this.state.active) return;
    this.debug('ahead:fail', { error });
    this.state.error = error; this.state.active = false; this.publish();
    this.alive = false; this.controller.abort(); this.socket?.close(); this.clips.length = 0;
  }
  async stop() {
    this.alive = false; this.controller.abort(); this.socket?.close(); this.clips.length = 0;
    this.state.active = false; this.state.stage = ''; this.publish();
  }
}
