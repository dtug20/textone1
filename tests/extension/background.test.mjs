import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const sessionToken = Buffer.from(JSON.stringify({ source: 'en', target: 'vi', mode: 'dub' })).toString('base64url') + '.signature';

function harness(url, { captionData = null, captionStartError = '' } = {}) {
  let listener;
  const captures = [];
  const injections = [];
  const messages = [];
  const logs = [];
  vm.runInNewContext(readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, ''), {
    URL, atob, Date, setTimeout, setInterval,
    debugLog: async (event, data) => { logs.push({ event, ...data }); },
    isDevInstall: () => false, devSink: 'http://localhost:18810',
    controlSource: async () => ({}),
    chrome: {
      runtime: {
        id: 'textone',
        onMessage: { addListener: (fn) => { listener = fn; } },
        sendMessage: async (message) => { messages.push(message); return message.input === 'captions' && captionStartError ? { error: captionStartError } : { ok: true }; },
      },
      scripting: { executeScript: async (options) => { injections.push(options); return [{ result: options.world === 'MAIN' ? captionData : options.func ? { time: 5, duration: 60 } : true }]; } },
      tabs: { query: async () => [{ id: 42, url }], sendMessage: async message => { messages.push(message); return { ok: true }; }, onRemoved: { addListener() {} } },
      offscreen: { hasDocument: async () => true },
      tabCapture: { getMediaStreamId: async ({ targetTabId }) => { captures.push(targetTabId); return 'test-stream'; } },
      storage: { session: { set: async () => {} } },
      action: { setBadgeText: async () => {} },
    }, collectYouTubeCaptions: async () => null,
  });
  const send = (message, sender = { id: 'textone' }) => new Promise((reply) => listener({ target: 'background', ...message }, sender, reply));
  return { send, captures, messages, injections, logs };
}

test('YouTube uses one timestamped read-ahead pipeline and does not capture the tab', async () => {
  const captionData = { duration: 60, cues: [{ start: 5, duration: 4, text: 'Hello.', translatedText: 'Xin chào.' }] };
  const h = harness('https://www.youtube.com/watch?v=Hu4Yvq-g7_Y', { captionData });
  const result = await h.send({ type: 'start', server: 'https://textone.id.vn', token: sessionToken, volume: 0.2 });
  assert.equal(result.error, undefined);
  assert.deepEqual(h.captures, []);
  const start = h.messages.find(message => message.target === 'offscreen' && message.type === 'start');
  assert.equal(start.input, 'captions');
  assert.equal(start.videoId, 'Hu4Yvq-g7_Y');
  assert.equal(start.position, 5);
  assert.equal(start.captions[0].translatedText, 'Xin chào.');
  assert.ok(h.injections.some(options => options.files?.[0] === 'content/native-playback-content.js'));
  assert.ok(h.injections.some(options => options.files?.[0] === 'content/native-ahead.js'));
});

test('YouTube without usable translated captions automatically falls back to tab capture', async () => {
  const h = harness('https://www.youtube.com/watch?v=Hu4Yvq-g7_Y');
  const result = await h.send({ type: 'start', server: 'https://textone.id.vn', token: sessionToken, volume: 0.2 });
  assert.equal(result.error, undefined);
  assert.deepEqual(h.captures, [42]);
  assert.equal(h.messages.at(-1).input, 'tab');
  assert.match(h.messages.at(-1).sourceLabel, /không có phụ đề/);
  assert.ok(h.injections.some(options => options.files?.[0] === 'content/live-timeline.js'));
});

test('caption pipeline startup failure restores the native player and falls back to tab capture', async () => {
  const captionData = { duration: 60, cues: [{ start: 5, duration: 4, text: 'Hello.', translatedText: 'Xin chào.' }] };
  const h = harness('https://www.youtube.com/watch?v=Hu4Yvq-g7_Y', { captionData, captionStartError: 'caption gateway unavailable' });
  const result = await h.send({ type: 'start', server: 'https://textone.id.vn', token: sessionToken, volume: 0.2 });
  assert.equal(result.error, undefined);
  assert.deepEqual(h.captures, [42]);
  assert.ok(h.messages.some(message => message.target === 'offscreen' && message.type === 'stop'));
  assert.match(h.messages.at(-1).sourceLabel, /caption gateway unavailable/);
  assert.ok(h.logs.some(entry => entry.event === 'captions:pipeline-failed' && entry.error === 'caption gateway unavailable'));
});

for (const url of ['https://www.youtube.com/watch?v=test', 'https://www.facebook.com/reel/123', 'https://www.tiktok.com/@test/video/123']) {
  test(`the single live pipeline captures ${new URL(url).hostname}`, async () => {
    const h = harness(url);
    const result = await h.send({ type: 'start', server: 'https://textone.id.vn', token: 'token', volume: 0.2 });
    assert.equal(result.error, undefined);
    assert.deepEqual(h.captures, [42]);
    assert.equal(h.messages.at(-1).target, 'offscreen');
    assert.equal(h.messages.at(-1).streamId, 'test-stream');
    assert.deepEqual(Array.from(h.injections[0].files), ['content/live-timeline.js']);
  });
}

test('obsolete pipeline selection fields do not turn an invalid YouTube URL into read-ahead', async () => {
  const h = harness('https://www.youtube.com/watch?v=test');
  await h.send({ type: 'start', server: 'https://textone.id.vn', token: 'token', playbackMode: 'youtube' });
  assert.deepEqual(h.captures, [42]);
  assert.deepEqual(Array.from(h.injections[0].files), ['content/live-timeline.js']);
});

test('internal Chrome pages cannot start capture', async () => {
  const h = harness('chrome://extensions/');
  assert.ok((await h.send({ type: 'start' })).error);
  assert.equal(h.captures.length, 0);
});

test('timeline messages are accepted only from the captured tab', async () => {
  const h = harness('https://www.youtube.com/watch?v=test');
  await h.send({ type: 'start', server: 'https://textone.id.vn', token: 'token' });
  assert.equal((await h.send({ type: 'live-timeline', timeline: { position: 1 } }, { id: 'textone', tab: { id: 42 } })).error, undefined);
  assert.ok((await h.send({ type: 'live-timeline', timeline: { position: 2 } }, { id: 'textone', tab: { id: 7 } })).error);
});
