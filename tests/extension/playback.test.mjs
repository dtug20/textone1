import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { DubPlayer } = createRequire(import.meta.url)('../../extension/audio/playback.js');
class Media extends EventTarget {
  currentTime = 0; duration = 4; playbackRate = 1; paused = true; ended = false; volume = 1;
  load() { queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  removeAttribute() {}
}
test('pause and video stalls silence narration; resuming uses the media clock', async () => {
  const video = new Media(); const audio = new Media(); audio.duration = 6;
  const player = new DubPlayer(video, audio, () => {});
  await player.load({ video: 'https://example.test/v', audio: 'https://example.test/a', duration: 4 });
  assert.equal(video.playbackRate, 1);
  await player.play(); assert.equal(audio.paused, false);
  video.pause(); assert.equal(audio.paused, true);
  video.currentTime = 2; await player.play(); assert.equal(audio.currentTime, 3);
  video.dispatchEvent(new Event('waiting')); assert.equal(audio.paused, true);
  player.destroy();
});
test('video clock ends the aligned segment without an independent audio tail', async () => {
  const video = new Media(); const audio = new Media(); let completed = 0;
  const player = new DubPlayer(video, audio, () => { completed++; });
  await player.load({ video: 'https://example.test/v', audio: 'https://example.test/a', duration: 4 });
  video.ended = true; video.dispatchEvent(new Event('ended')); assert.equal(completed, 1); assert.equal(audio.paused, true);
  audio.ended = true; audio.dispatchEvent(new Event('ended')); assert.equal(completed, 1);
  audio.dispatchEvent(new Event('ended')); assert.equal(completed, 1);
  player.destroy();
});

test('saved playback keeps leading silence, follows rate changes and remains silent during stalls', async () => {
  const video = new Media(); const audio = new Media(); audio.duration = 2;
  const player = new DubPlayer(video, audio);
  await player.load({ video: 'https://example.test/v', audio: 'https://example.test/a', duration: 4, speechStart: 1, speechEnd: 3 });
  await player.play(); assert.equal(audio.paused, true);
  video.currentTime = 2; video.playbackRate = 1.5; video.dispatchEvent(new Event('timeupdate'));
  assert.equal(audio.currentTime, 1); assert.equal(audio.playbackRate, 1.5);
  video.dispatchEvent(new Event('waiting')); video.dispatchEvent(new Event('timeupdate')); assert.equal(audio.paused, true);
  player.destroy();
});

test('extension and web use the identical media clock implementation', () => {
  assert.equal(readFileSync('extension/audio/playback.js', 'utf8'), readFileSync('public/dub-player.js', 'utf8'));
});
