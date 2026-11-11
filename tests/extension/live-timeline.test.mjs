import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const code = readFileSync(new URL('../../extension/content/live-timeline.js', import.meta.url), 'utf8');
test('live observer sends pause and seek boundaries without modifying native player', async () => {
  const handlers = new Map(); const messages = [];
  const video = { clientWidth: 100, clientHeight: 100, paused: false, seeking: false, ended: false, readyState: 4, isConnected: true,
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  const context = { document: { querySelectorAll: () => [video] }, location: { href: 'https://youtube.com/watch?v=test' },
    chrome: { runtime: { id: 'test', sendMessage: async message => { messages.push(message); return { ok: true }; } } },
    setInterval: () => 1, clearInterval: () => {} };
  vm.runInNewContext(code, context);
  assert.equal(messages[0].timeline.paused, false);
  video.paused = true;
  await handlers.get('pause')({ type: 'pause' });
  assert.equal(messages.at(-1).timeline.paused, true);
  await handlers.get('seeking')({ type: 'seeking' });
  assert.equal(messages.at(-1).timeline.reset, true);
  context.location.href = 'https://youtube.com/watch?v=other';
  await handlers.get('playing')({ type: 'playing' });
  assert.equal(messages.at(-1).timeline.changed, true);
  assert.equal(handlers.size, 0);
});
