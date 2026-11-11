import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness({ failStart = false } = {}) {
  let listener;
  const sessions = [];
  class PipelineSession {
    constructor(config) { this.config = config; this.monitor = { gain: { value: config.volume } }; this.timelines = []; sessions.push(this); }
    async start() { if (failStart) throw new Error('start failed'); this.started = true; }
    async stop() { this.stopped = true; }
    timeline(value) { this.timelines.push(value); }
  }
  class AheadSession extends PipelineSession {
    next() { return { active: true, generation: 0, clip: { sourceStart: 0, duration: 6 } }; }
  }
  vm.runInNewContext(readFileSync(new URL('../../extension/offscreen.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, ''), {
    PipelineSession, AheadSession,
    chrome: { runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } } },
  });
  const send = (type, extra = {}) => new Promise((reply) => listener({ target: 'offscreen', type, ...extra }, { id: 'extension' }, reply));
  return { send, sessions };
}

test('offscreen starts exactly one pipeline session and replaces it cleanly', async () => {
  const h = harness();
  assert.equal((await h.send('start', { token: 'one', volume: 0.2 })).ok, true);
  assert.equal(h.sessions[0].started, true);
  assert.equal((await h.send('start', { token: 'two', volume: 0.3 })).ok, true);
  assert.equal(h.sessions[0].stopped, true);
  assert.equal(h.sessions[1].started, true);
  await h.send('stop');
  assert.equal(h.sessions[1].stopped, true);
});

test('YouTube starts read-ahead and exposes timestamped clips to the content player', async () => {
  const h = harness();
  await h.send('start', { input: 'youtube', videoId: 'Hu4Yvq-g7_Y', position: 12 });
  assert.equal(h.sessions[0].config.input, 'youtube');
  const response = await h.send('next');
  assert.equal(response.active, true);
  assert.equal(response.clip.duration, 6);
});

test('YouTube captions use the same timestamped read-ahead player', async () => {
  const h = harness();
  await h.send('start', { input: 'captions', captions: [{ start: 1, duration: 2 }], duration: 20, position: 0 });
  assert.equal(h.sessions[0].config.input, 'captions');
  assert.equal((await h.send('next')).active, true);
});

test('timeline and volume are forwarded to the active pipeline', async () => {
  const h = harness();
  assert.equal((await h.send('live-timeline', { timeline: { position: 1 } })).inactive, true);
  await h.send('start', { volume: 0.2 });
  await h.send('live-timeline', { timeline: { position: 7, paused: false } });
  await h.send('volume', { volume: 0.65 });
  assert.deepEqual(h.sessions[0].timelines, [{ position: 7, paused: false }]);
  assert.equal(h.sessions[0].monitor.gain.value, 0.65);
});

test('failed startup stops and releases the session', async () => {
  const h = harness({ failStart: true });
  assert.equal((await h.send('start')).error, 'start failed');
  assert.equal(h.sessions[0].stopped, true);
  assert.equal((await h.send('live-timeline')).inactive, true);
});
