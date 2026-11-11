class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Short speech turns keep the translator and synthesizer close to the
    // playhead. Two seconds is long enough for useful translation context but
    // prevents a three-second capture delay before inference even starts.
    this.buffer = new Float32Array(sampleRate * 2);
    this.offset = 0;
    this.windowEnergy = 0;
    this.windowSamples = 0;
    this.silentSamples = 0;
    this.hasSpeech = false;
    this.enabled = true;
    this.port.onmessage = ({ data }) => {
      if (typeof data.enabled === 'boolean') this.enabled = data.enabled;
      this.offset = 0; this.windowEnergy = 0; this.windowSamples = 0; this.silentSamples = 0; this.hasSpeech = false;
    };
  }
  flush(boundary) {
    if (this.hasSpeech) {
      const samples = this.buffer.slice(0, this.offset);
      this.port.postMessage({ samples, boundary }, [samples.buffer]);
      if (boundary === 'window') {
        // Preserve both sides of a word cut by the hard two-second window.
        // The server removes repeated words after recognition.
        const overlap = Math.min(Math.round(sampleRate * 0.32), this.offset);
        this.buffer.copyWithin(0, this.offset - overlap, this.offset);
        this.offset = overlap;
        this.windowEnergy = 0;
        this.windowSamples = 0;
        this.silentSamples = 0;
        this.hasSpeech = true;
        return;
      }
    }
    this.offset = 0;
    this.windowEnergy = 0;
    this.windowSamples = 0;
    this.silentSamples = 0;
    this.hasSpeech = false;
  }
  process(inputs) {
    if (!this.enabled) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      this.buffer[this.offset++] = value;
      this.windowEnergy += value * value;
      this.windowSamples++;
      // Check 10 ms windows and emit as soon as a natural pause is available.
      if (this.windowSamples >= sampleRate * 0.01) {
        if (Math.sqrt(this.windowEnergy / this.windowSamples) > 0.003) {
          this.hasSpeech = true;
          this.silentSamples = 0;
        } else {
          this.silentSamples += this.windowSamples;
          if (!this.hasSpeech) this.offset = 0;
        }
        this.windowEnergy = 0;
        this.windowSamples = 0;
      }
      if (this.offset === this.buffer.length) this.flush('window');
      else if (this.hasSpeech && this.offset >= sampleRate * 0.75 && this.silentSamples >= sampleRate * 0.25) this.flush('pause');
    }
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);
