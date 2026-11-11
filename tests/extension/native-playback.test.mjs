import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { NativeNarration } = createRequire(import.meta.url)('../../extension/audio/native-playback.js');
class Media extends EventTarget {
  currentTime = 0; duration = 6; volume = 0.8; muted = false; playbackRate = 1; paused = true; seeking = false; ended = false;
  async play() { this.paused = false; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { this.currentTime = 0; }
  removeAttribute() {}
}
test('native narration follows the original video clock without changing its rate or position', async () => {
  const video = new Media(); const audio = new Media();
  const sync = new NativeNarration(video, audio);
  sync.add({ start: 10, duration: 4, audio: 'speech.wav' });
  video.currentTime = 12; video.paused = false; sync.sync(true);
  assert.equal(audio.currentTime, 3); assert.equal(audio.playbackRate, 1.5);
  assert.equal(video.currentTime, 12); assert.equal(video.playbackRate, 1);
  video.pause(); assert.equal(audio.paused, true);
  sync.destroy(); assert.equal(video.volume, 0.8);
});
test('short narration keeps its natural speed instead of being stretched across the caption', () => {
  const video = new Media(); const audio = new Media(); audio.duration = 2;
  const sync = new NativeNarration(video, audio);
  sync.add({ start: 10, duration: 4, audio: 'speech.wav' });
  video.currentTime = 11; video.paused = false; sync.sync(true);
  assert.equal(audio.playbackRate, 1);
  assert.equal(audio.currentTime, 1);
  sync.destroy();
});
test('native seek silences the old utterance and selects the correct prepared segment', () => {
  const video = new Media(); const audio = new Media(); const sync = new NativeNarration(video, audio);
  sync.add({ start: 0, duration: 4, audio: 'first.wav' }); sync.add({ start: 20, duration: 4, audio: 'second.wav' });
  sync.sync(true); video.seeking = true; video.dispatchEvent(new Event('seeking')); assert.equal(audio.paused, true);
  video.currentTime = 22; video.seeking = false; video.dispatchEvent(new Event('seeked'));
  assert.equal(audio.src, 'second.wav'); assert.equal(audio.currentTime, 3); sync.destroy();
});
test('missing translation pauses original video instead of playing an unrelated utterance', () => {
  const video = new Media(); const audio = new Media(); const missing = [];
  const sync = new NativeNarration(video, audio, { onMissing: (time) => missing.push(time) });
  video.currentTime = 10; video.paused = false; sync.sync(true);
  assert.equal(video.paused, true); assert.equal(audio.paused, true); assert.deepEqual(missing, [10]); sync.destroy();
});
test('native speed changes also change narration speed; stalls pause narration', () => {
  const video = new Media(); const audio = new Media(); const sync = new NativeNarration(video, audio);
  sync.add({ start: 0, duration: 4, audio: 'speech.wav' }); video.playbackRate = 1.5; video.paused = false; video.dispatchEvent(new Event('ratechange'));
  assert.equal(audio.playbackRate, 2.25); video.dispatchEvent(new Event('waiting')); assert.equal(audio.paused, true); sync.destroy();
});

test('frame and timeupdate callbacks cannot resume audio while the video is stalled', async () => {
  const video = new Media(); const audio = new Media(); const sync = new NativeNarration(video, audio);
  sync.add({ start: 0, duration: 4, audio: 'speech.wav' });
  video.paused = false; sync.sync(true); await new Promise(setImmediate);
  video.dispatchEvent(new Event('waiting'));
  video.dispatchEvent(new Event('timeupdate')); sync.sync(true, 1);
  assert.equal(audio.paused, true);
  video.dispatchEvent(new Event('playing')); await new Promise(setImmediate);
  assert.equal(audio.paused, false); sync.destroy();
});
test('speech timestamps preserve leading and trailing silence and use frame media time', async () => {
  const video = new Media(); const audio = new Media(); audio.duration = 2;
  const sync = new NativeNarration(video, audio);
  sync.add({ start: 10, duration: 4, speechStart: 1, speechEnd: 3, audio: 'speech.wav' });
  video.currentTime = 10; video.paused = false; video.currentTime = 10.5; sync.sync(true, 10.51);
  assert.equal(audio.paused, true);
  video.currentTime = 11.98; sync.sync(true, 12); await new Promise(setImmediate);
  assert.equal(audio.currentTime, 1); assert.equal(audio.playbackRate, 1);
  video.currentTime = 13.5; sync.sync(true, 13.5); assert.equal(audio.paused, true); sync.destroy();
});
test('a late play completion after a seek cannot leave the old utterance playing', async () => {
  const video = new Media(); const audio = new Media(); let resolvePlay;
  audio.play = () => new Promise((resolve) => { resolvePlay = () => { audio.paused = false; resolve(); }; });
  const sync = new NativeNarration(video, audio);
  sync.add({ start: 0, duration: 4, audio: 'old.wav' }); video.paused = false; sync.sync(true);
  video.seeking = true; video.dispatchEvent(new Event('seeking')); video.currentTime = 20;
  resolvePlay(); await new Promise(setImmediate); assert.equal(audio.paused, true); sync.destroy();
});
test('preloads nearby utterances and reuses cached audio when seeking within that window', () => {
  const video = new Media(); const audio = new Media(); const created = [];
  const sync = new NativeNarration(video, audio, { createAudio: () => { const next = new Media(); created.push(next); return next; } });
  for (let i = 0; i < 16; i++) sync.add({ start: i * 4, duration: 4, audio: `${i}.wav` });
  sync.sync(false); assert.equal(created.length, 12);
  const second = created[1]; video.currentTime = 5; sync.sync(false);
  assert.equal(sync.audio, second); assert.equal(second.currentTime, 1.5);
  video.currentTime = 48; sync.sync(false); assert.ok(sync.preloaded.size <= 13);
  sync.destroy(); assert.equal(sync.preloaded.size, 0);
});

test('late play completion at the end of speech cannot fill trailing silence', async () => {
  const video = new Media(); const audio = new Media(); let release;
  audio.play = () => new Promise((resolve) => { release = () => { audio.paused = false; resolve(); }; });
  const sync = new NativeNarration(video, audio);
  sync.add({ start: 0, duration: 4, speechStart: 0, speechEnd: 2, audio: 'speech.wav' });
  video.paused = false; sync.sync(true); video.currentTime = 3; sync.sync(true);
  release(); await new Promise(setImmediate); assert.equal(audio.paused, true); sync.destroy();
});

test('natural end of prepared range is completion, not an untranslated-position error', () => {
  const video = new Media(); const audio = new Media(); let completed = 0; const missing = [];
  const sync = new NativeNarration(video, audio, { onComplete: () => completed++, onMissing: (time) => missing.push(time) });
  sync.add({ start: 10, duration: 4, audio: 'speech.wav' });
  video.currentTime = 14.04; video.paused = false; sync.sync(true);
  assert.equal(completed, 1); assert.deepEqual(missing, []); assert.equal(video.paused, true);
  video.currentTime = 30; video.paused = false; sync.sync(true);
  assert.deepEqual(missing, [30]); sync.destroy();
});

test('a decoded frame before the seek target cannot mark the prepared start as missing', async () => {
  const video = new Media(); const audio = new Media(); const missing = [];
  const sync = new NativeNarration(video, audio, { onMissing: (time) => missing.push(time) });
  sync.add({ start: 13.812, duration: 4, audio: 'speech.wav' });
  video.currentTime = 13.812; video.paused = false;
  sync.sync(true, 13.8); await new Promise(setImmediate);
  assert.deepEqual(missing, []); assert.equal(video.paused, false); assert.equal(audio.paused, false);
  sync.destroy();
});
test('floating point seek rounding at the first cue does not pause playback', async () => {
  const video = new Media(); const audio = new Media(); const missing = [];
  const sync = new NativeNarration(video, audio, { onMissing: (time) => missing.push(time) });
  sync.add({ start: 13.8120001, duration: 4, audio: 'speech.wav' });
  video.currentTime = 13.812; video.paused = false; sync.sync(true); await new Promise(setImmediate);
  assert.deepEqual(missing, []); assert.equal(audio.paused, false); sync.destroy();
});

test('frame timestamp cannot select a different prepared interval than the video playhead', () => {
  const video = new Media(); const audio = new Media(); const missing = [];
  const sync = new NativeNarration(video, audio, { onMissing: (time) => missing.push(time) });
  sync.add({ start: 10, duration: 4, audio: 'first.wav' });
  sync.add({ start: 14.1, duration: 4, audio: 'second.wav' });
  video.currentTime = 14.05; video.paused = false; sync.sync(true, 13.99);
  assert.deepEqual(missing, [14.05]); assert.equal(audio.paused, true); sync.destroy();
});
