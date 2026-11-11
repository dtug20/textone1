import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function processor() {
  let Processor;
  const messages = [];
  vm.runInNewContext(readFileSync(new URL('../../extension/audio/capture-worklet.js', import.meta.url), 'utf8'), {
    sampleRate: 16000, Float32Array, Math,
    AudioWorkletProcessor: class { port = { postMessage: (samples) => messages.push(samples) }; },
    registerProcessor: (_, klass) => { Processor = klass; },
  });
  return { instance: new Processor(), messages };
}
test('silence produces no upload; stereo is downmixed into complete two-second chunks', () => {
  const { instance, messages } = processor();
  instance.process([[new Float32Array(48000)]]);
  assert.equal(messages.length, 0);
  instance.process([[new Float32Array(16000).fill(0.5), new Float32Array(16000).fill(0.25)]]);
  assert.equal(messages.length, 0);
  instance.process([[new Float32Array(16000).fill(0.5), new Float32Array(16000).fill(0.25)]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].samples.length, 32000);
  assert.equal(messages[0].samples[0], 0.375);
  assert.equal(messages[0].boundary, 'window');
  instance.process([[new Float32Array(32000).fill(0.25)]]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].samples.length, 32000);
  assert.equal(messages[1].samples[0], 0.375);
  assert.equal(messages[1].samples[5119], 0.375);
  assert.equal(messages[1].samples[5120], 0.25);
});

test('a short utterance is sent after 750 ms at a natural pause', () => {
  const { instance, messages } = processor();
  instance.process([[new Float32Array(16000 * 10)]]);
  instance.process([[new Float32Array(16000 * 0.5).fill(0.2)]]);
  assert.equal(messages.length, 0);
  instance.process([[new Float32Array(16000 * 0.5)] ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].samples.length, 16000 * 0.75);
  assert.equal(messages[0].boundary, 'pause');
  instance.process([[new Float32Array(16000 * 10)]]);
  assert.equal(messages.length, 1);
});

test('brief pauses do not fragment continuous speech', () => {
  const { instance, messages } = processor();
  instance.process([[new Float32Array(16000).fill(0.2)]]);
  instance.process([[new Float32Array(16000 * 0.2)]]);
  instance.process([[new Float32Array(16000 * 0.8).fill(0.2)]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].samples.length, 32000);
  assert.equal(messages[0].boundary, 'window');
});

test('pausing discards partial speech and resume never mixes audio across a seek', () => {
  const { instance, messages } = processor();
  instance.process([[new Float32Array(16000).fill(0.2)]]);
  instance.port.onmessage({ data: { enabled: false, reset: true } });
  instance.process([[new Float32Array(32000).fill(0.4)]]);
  assert.equal(messages.length, 0);
  instance.port.onmessage({ data: { enabled: true, reset: true } });
  instance.process([[new Float32Array(32000).fill(0.6)]]);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].samples.every(value => Math.abs(value - 0.6) < 0.0001));
});
