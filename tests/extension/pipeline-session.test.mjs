import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { PipelineSession } = createRequire(import.meta.url)('../../extension/sessions/pipeline-session.js');

test('protocol v2 sends boundary metadata before PCM', () => {
  const session = new PipelineSession({ position: 10 });
  session.paused = false; session.publish = () => {};
  let packet;
  session.socket = { readyState: 1, bufferedAmount: 0, send: value => { packet = value; } };
  session.submit({ samples: new Float32Array(32000).fill(0.25), boundary: 'window' });
  const view = new DataView(packet);
  assert.equal(packet.byteLength, 20 + 64000);
  assert.equal(view.getUint32(0, true), 0);
  assert.equal(view.getUint32(4, true), 0);
  assert.equal(view.getFloat64(8, true), 8);
  assert.equal(view.getUint8(16), 0);
  assert.deepEqual([...new Uint8Array(packet, 17, 3)], [0, 0, 0]);
});

test('tab fallback explains why YouTube captions were unavailable', () => {
  const session = new PipelineSession({ sourceLabel: 'Âm thanh tab · YouTube không có phụ đề dịch phù hợp' });
  assert.equal(session.state.sourceLabel, 'Âm thanh tab · YouTube không có phụ đề dịch phù hợp');
});

test('partial phrase updates status but only committed translation enters history', async () => {
  const session = new PipelineSession({});
  session.publish = () => {};
  await session.receive({ type: 'transcript', generation: 0, partial: true, text: 'a cut wor-', translatedText: 'một từ' });
  assert.equal(session.state.stage, 'listening');
  assert.equal(session.state.segments, undefined);
  await session.receive({ type: 'transcript', generation: 0, partial: false, text: 'a complete word', translatedText: 'một từ đầy đủ' });
  assert.equal(session.state.stage, 'synthesizing');
  assert.deepEqual(session.state.segments, [{ text: 'a complete word', translatedText: 'một từ đầy đủ' }]);
});

test('seek advances generation, stops queued narration and resets the server position', () => {
  const session = new PipelineSession({});
  const sent = [];
  let stopped = false;
  session.paused = false;
  session.socket = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
  session.scheduled.add({ stop() { stopped = true; }, disconnect() {}, onended: null });
  session.timeline({ position: 60, reset: true, paused: true });
  assert.equal(session.generation, 1);
  assert.equal(stopped, true);
  assert.equal(session.scheduled.size, 0);
  assert.deepEqual(sent[0], { type: 'reset', generation: 1, position: 60 });
});

test('stale audio from before a seek is ignored', async () => {
  const session = new PipelineSession({});
  session.generation = 1;
  session.publish = () => {};
  await session.receive({ type: 'audio', generation: 0, audio: 'AA==' });
  assert.equal(session.state.processed, 0);
  assert.equal(session.scheduled.size, 0);
});

test('live WAVs are decoded and scheduled in source order without cutting speech', async () => {
  const session = new PipelineSession({});
  session.paused = false; session.publish = () => {};
  const sources = [];
  session.context = {
    currentTime: 10, destination: {},
    decodeAudioData: async () => ({ duration: 0.9 }),
    createBufferSource: () => {
      const source = { connect() {}, disconnect() {}, stop() { this.stopped = true; }, start(at) { this.at = at; } };
      sources.push(source); return source;
    },
  };
  for (const sequence of [1, 2]) session.capturedAt.set(sequence, performance.now());
  await Promise.all([1, 2].map(sequence => session.receive({ type: 'audio', generation: 0, sequence, audio: 'AA==', timings: {} })));
  assert.equal(sources.length, 2);
  assert.equal(sources[1].at, sources[0].at + 0.9);
  assert.equal(session.state.spoken, 2);
  session.timeline({ position: 5, paused: true });
  assert.ok(sources.every(source => source.stopped));
});

test('excessive narration backlog is dropped instead of drifting behind video', async () => {
  const session = new PipelineSession({});
  session.paused = false; session.publish = () => {}; session.playUntil = 20;
  session.context = { currentTime: 10, decodeAudioData: async () => ({ duration: 1 }) };
  session.capturedAt.set(1, performance.now());
  await session.receive({ type: 'audio', generation: 0, sequence: 1, audio: 'AA==', timings: {} });
  assert.equal(session.state.dropped, 1);
  assert.equal(session.state.spoken, 0);
});

test('live clone-voice toggle notifies pipeline socket', () => {
  const session = new PipelineSession({ cloneVoice: false });
  const sent = [];
  session.socket = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
  session.setCloneVoice(true);
  assert.equal(session.cloneVoice, true);
  assert.deepEqual(sent, [{ type: 'clone-voice', enabled: true }]);
});
