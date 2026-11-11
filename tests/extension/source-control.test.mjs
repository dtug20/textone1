import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function harness({ drm = false, ad = false } = {}) {
  const video = { readyState: 4, duration: 600, currentTime: 20, playbackRate: 1.25, paused: false, muted: false, volume: 0.6, mediaKeys: drm ? {} : null, isConnected: true, clientWidth: 800, clientHeight: 450,
    captureStream: () => ({}), pause() { this.paused = true; }, async play() { this.paused = false; } };
  const context = { document: { querySelectorAll: () => [video], querySelector: () => ad ? {} : null }, location: { href: 'https://www.youtube.com/watch?v=test' }, Number, Math };
  vm.runInNewContext(readFileSync('extension/content/source-control.js', 'utf8').replace('export async function controlSource', 'async function controlSource'), context);
  return { video, context, control: context.controlSource };
}
test('source attach pauses video; tab capture unmutes input and stop restores user settings', async () => {
  const h = harness(); assert.equal((await h.control('attach')).time, 20);
  assert.equal(h.video.muted, false); assert.equal(h.video.paused, true); assert.equal(h.video.playbackRate, 1);
  await h.control('capture-audio'); assert.equal(h.video.volume, 1);
  await h.control('play'); assert.equal(h.video.paused, false);
  await h.control('detach'); assert.equal(h.video.muted, false); assert.equal(h.video.playbackRate, 1.25); assert.equal(h.video.paused, true);
  assert.equal(h.video.volume, 0.6);
  assert.equal(h.context.__textoneControlledVideo, undefined);
});
test('unsupported DRM and ads return actionable errors without mutating source', async () => {
  for (const options of [{ drm: true }, { ad: true }]) {
    const h = harness(options); assert.ok((await h.control('attach')).error); assert.equal(h.video.muted, false);
  }
});
test('seek starts new capture at a bounded source time', async () => {
  const h = harness(); await h.control('attach', { time: 900 }); assert.equal(h.video.currentTime, 599.9);
  await h.control('detach'); await h.control('attach', { time: -10 }); assert.equal(h.video.currentTime, 0);
});
test('caption startup fallback restores the original playing state', async () => {
  const h = harness();
  const attached = await h.control('attach', { readAhead: true });
  assert.equal(attached.wasPaused, false);
  assert.equal(h.video.paused, true);
  await h.control('detach', { resume: true });
  assert.equal(h.video.paused, false);
});
test('source navigation errors propagate explicitly instead of becoming an undefined injection result', async () => {
  const h = harness(); await h.control('attach'); h.context.location.href = 'https://www.youtube.com/watch?v=new';
  assert.match((await h.control('play')).error, /thay đổi/);
  await h.control('detach');
  assert.equal(h.video.muted, false);
  assert.equal(h.video.volume, 0.6);
  assert.equal(h.context.__textoneControlledVideo, undefined);
});
