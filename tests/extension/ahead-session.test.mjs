import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { AheadSession } = createRequire(import.meta.url)('../../extension/sessions/ahead-session.js');

test('read-ahead queues complete timestamped clips and clears them on seek', () => {
  const session = new AheadSession({ position: 10 });
  session.publish = () => {};
  const sent = [];
  session.socket = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
  session.receive({ type: 'audio', generation: 0, sourceStart: 10, duration: 6, speechStart: 0.2, speechEnd: 5.8, audio: 'd2F2', timings: { totalMs: 900 } });
  const first = session.next();
  assert.equal(first.clip.sourceStart, 10);
  assert.equal(first.clip.speechEnd, 5.8);
  assert.equal(session.state.processingMs, 900);
  assert.equal(session.state.preparedUntil, 16);
  assert.equal(session.state.preparedAhead, 6);
  session.receive({ type: 'audio', generation: 0, sourceStart: 16, duration: 6, audio: 'd2F2', timings: {} });
  session.timeline({ position: 42, reset: true });
  assert.equal(session.next().clip, undefined);
  assert.equal(session.state.preparedAhead, 0);
  assert.deepEqual(sent[0], { type: 'reset', generation: 1, position: 42 });
  assert.deepEqual(sent[1], { type: 'position', position: 42 });
  session.status({ stage: 'playing', spoken: 2 });
  assert.equal(session.state.stage, 'playing');
  assert.equal(session.state.spoken, 2);
});

test('caption session uploads bounded timestamp batches and releases source text', () => {
  const captions = Array.from({ length: 25 }, (_, index) => ({ start: index * 3, duration: 2, text: `s${index}`, translatedText: `t${index}` }));
  const session = new AheadSession({ input: 'captions', captions });
  session.publish = () => {};
  const sent = [];
  session.socket = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
  session.uploadCaptions();
  assert.equal(sent.length, 3);
  assert.equal(sent[0].cues.length, 24);
  assert.equal(sent[1].cues.length, 1);
  assert.equal(sent[2].type, 'captions-end');
  assert.equal(session.captions.length, 0);
  assert.equal(session.state.captionSource, 'Phụ đề YouTube');
});

test('a dropped connection after ready reconnects and resumes from the prepared end', async () => {
  const sockets = [];
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); } send(value) { this.sent.push(JSON.parse(value)); } close() {} };
  try {
    const captions = [{ start: 0, duration: 2, text: 'a', translatedText: 'b' }];
    const session = new AheadSession({ input: 'captions', captions, token: 't', duration: 60, position: 4 });
    session.publish = () => {}; session.endpoint = 'ws://localhost:18802/stream'; session.captionCopy = [...captions];
    session.generation = 2; session.state.preparedUntil = 12;
    const ready = session.connect(4);
    sockets[0].onopen(); sockets[0].onmessage({ data: JSON.stringify({ type: 'ready', protocol: 2 }) });
    await ready;
    assert.deepEqual(sockets[0].sent.map(m => m.type ?? 'hello'), ['hello', 'captions', 'captions-end', 'reset', 'position']);
    assert.deepEqual(sockets[0].sent[3], { type: 'reset', generation: 2, position: 4 });
    const resumed = [];
    session.connect = async (position, recovering) => { resumed.push({ position, recovering, captions: session.captions.length }); };
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realTimeout(fn, 0);
    try {
      sockets[0].onclose({ code: 1011, reason: 'keepalive ping timeout', wasClean: false });
      await new Promise(resolve => realTimeout(resolve, 20));
    } finally { globalThis.setTimeout = realTimeout; }
    assert.deepEqual(resumed, [{ position: 12, recovering: true, captions: 1 }]);
    assert.equal(session.alive, true);
  } finally { globalThis.WebSocket = saved; }
});

test('prepared-ahead status counts only continuous clips received out of order', () => {
  const session = new AheadSession({ position: 0 });
  session.publish = () => {};
  session.receive({ type: 'audio', generation: 0, sourceStart: 0, duration: 2, audio: null, timings: {} });
  session.receive({ type: 'audio', generation: 0, sourceStart: 6, duration: 4, audio: null, timings: {} });
  assert.equal(session.state.preparedAhead, 2);
  session.receive({ type: 'audio', generation: 0, sourceStart: 2, duration: 4, audio: 'd2F2', timings: {} });
  assert.equal(session.state.preparedAhead, 10);
  session.timeline({ position: 4 });
  assert.equal(session.state.preparedAhead, 6);
});

test('cloneVoice flag is sent in handshake and can be toggled live during a session', async () => {
  const sockets = [];
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); } send(value) { this.sent.push(JSON.parse(value)); } close() {} };
  try {
    const captions = [{ start: 0, duration: 2, text: 'a', translatedText: 'b' }];
    const session = new AheadSession({ input: 'captions', captions, token: 't', duration: 60, position: 0, cloneVoice: true });
    session.publish = () => {}; session.endpoint = 'ws://localhost:18802/stream'; session.captionCopy = [...captions];
    const ready = session.connect(0);
    sockets[0].onopen(); sockets[0].onmessage({ data: JSON.stringify({ type: 'ready', protocol: 2 }) });
    await ready;
    assert.equal(sockets[0].sent[0].cloneVoice, true);
    session.setCloneVoice(false);
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'clone-voice', enabled: false });
    session.setCloneVoice(true);
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'clone-voice', enabled: true });
  } finally { globalThis.WebSocket = saved; }
});
