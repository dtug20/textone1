import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { NativeNarration } = createRequire(import.meta.url)('../../extension/audio/native-playback.js');
class Media extends EventTarget {
  currentTime = 0; duration = 3; volume = 0.8; muted = false; playbackRate = 1; paused = true; isConnected = true; seeking = false;
  play() { this.paused = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  load() { this.currentTime = 0; }
  removeAttribute() {}
}
test('read-ahead waits for contiguous coverage then follows native pause and seek without DOM changes', async () => {
  const video = new Media(); video.duration = 60;
  const state = { video, volume: 0.8, muted: false, url: 'https://www.youtube.com/watch?v=Hu4Yvq-g7_Y' };
  const clips = [0, 3, 6, 9, 12].map(sourceStart => ({sourceStart,duration:3,audio:'d2F2'}));
  const timers = []; const messages = []; let generation = 0;
  vm.runInNewContext(readFileSync('extension/content/native-ahead.js', 'utf8'), {
    __textoneControlledVideo: state, TextoneNativeNarration: NativeNarration, Audio: Media, AbortController, Blob, Uint8Array, URL, atob,
    location: {href:state.url}, document:new Proxy({}, {get(){throw Error('Must not mutate DOM');}}),
    setTimeout: fn => {timers.push(fn);return timers.length;},clearTimeout(){},
    chrome:{runtime:{id:'test',onMessage:{addListener(){},removeListener(){}},sendMessage:async message=>{
      messages.push(message);
      if(message.type==='live-timeline' && message.timeline.reset)generation++;
      return message.type==='native-next'?{active:true,generation,clip:clips.shift()}:{ok:true};
    }}},
  });
  await new Promise(setImmediate);
  assert.equal(video.paused,false);
  assert.equal(video.currentTime,0);
  video.pause();
  timers.shift()();await new Promise(setImmediate);
  assert.equal(video.paused,true);
  video.currentTime=30;video.dispatchEvent(new Event('seeking'));
  await new Promise(setImmediate);
  assert.ok(messages.some(x=>x.timeline?.reset && x.timeline.position===30));
  state.narration.destroy();assert.equal(video.volume,0.8);
});

test('native content bundle matches the tested media controller', () => {
  assert.equal(
    readFileSync('extension/content/native-playback-content.js', 'utf8'),
    readFileSync('extension/audio/native-playback.js', 'utf8').replace('export class NativeNarration', 'globalThis.TextoneNativeNarration = class NativeNarration'),
  );
});
