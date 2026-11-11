import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { collectYouTubeCaptions } = createRequire(import.meta.url)('../../extension/content/youtube-captions.js');

test('YouTube caption collector returns grouped original and auto-translated timestamp cues', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, response: globalThis.ytInitialPlayerResponse };
  const playerResponse = {
    videoDetails: { lengthSeconds: '20' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async url => {
    const translated = new URL(url).searchParams.get('tlang') === 'vi';
    return { ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: translated ? 'Xin chào ' : 'Hello ' }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: translated ? 'thế giới.' : 'world.' }] },
      { tStartMs: 5000, dDurationMs: 2500, segs: [{ utf8: translated ? 'Bạn khỏe không?' : 'How are you?' }] },
    ] }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.source, 'youtube-captions');
    assert.equal(result.duration, 20);
    assert.equal(result.cues.length, 2);
    assert.equal(result.cues[0].text, 'Hello world.');
    assert.equal(result.cues[0].translatedText, 'Xin chào thế giới.');
    assert.equal(result.cues[0].needsTranslation, false);
    assert.equal(result.cues[1].start, 5);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.ytInitialPlayerResponse = saved.response;
  }
});

test('YouTube caption collector prefers authored English over automatic English', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { lengthSeconds: '10' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=auto' },
      { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=authored' },
    ] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    const value = new URL(url).searchParams.get('v') === 'authored' ? 'Publisher transcript.' : 'Automatic transcript.';
    return { ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: value }] },
    ] }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'Publisher transcript.');
    assert.equal(result.sourceLabel, 'Phụ đề EN');
    assert.ok(requested.every(url => new URL(url).searchParams.get('v') === 'authored'));
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('short rolling ASR fragments stay together as one grammatical sentence', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { lengthSeconds: '10' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async url => {
    const vi = new URL(url).searchParams.get('tlang') === 'vi';
    const lines = vi ? ['Đây là.', 'một câu tiếng Anh.', 'hoàn chỉnh.'] : ['This is.', 'a complete English.', 'sentence.'];
    return { ok: true, async json() { return { events: lines.map((value, index) => ({
      tStartMs: index * 1000, dDurationMs: 1000, segs: [{ utf8: value }],
    })) }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues.length, 1);
    assert.equal(result.cues[0].text, 'This is a complete English sentence.');
    assert.equal(result.cues[0].duration, 3);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('continuous speech keeps up to eighteen seconds of sentence context', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { lengthSeconds: '30' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async () => ({ ok: true, async json() { return { events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'This long' }] },
    { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: 'continuous statement' }] },
    { tStartMs: 6000, dDurationMs: 3000, segs: [{ utf8: 'keeps the complete' }] },
    { tStartMs: 9000, dDurationMs: 3000, segs: [{ utf8: 'grammatical context' }] },
    { tStartMs: 12000, dDurationMs: 3000, segs: [{ utf8: 'for translation.' }] },
  ] }; } });
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues.length, 1);
    assert.equal(result.cues[0].duration, 15);
    assert.match(result.cues[0].text, /complete grammatical context/);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('YouTube caption collector returns null when the player exposes no caption track', async () => {
  const saved = { document: globalThis.document, response: globalThis.ytInitialPlayerResponse };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => ({ videoDetails: { lengthSeconds: '20' } }) }) };
  globalThis.ytInitialPlayerResponse = undefined;
  try { assert.equal((await collectYouTubeCaptions('en', 'vi')).cues.length, 0); }
  finally { globalThis.document = saved.document; globalThis.ytInitialPlayerResponse = saved.response; }
});

test('YouTube caption collector keeps English ASR when tlang is ignored so GPU translation can skip STT', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { lengthSeconds: '10' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async () => ({ ok: true, async json() { return { events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Source text.' }] },
  ] }; } });
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'Source text.');
    assert.equal(result.cues[0].needsTranslation, true);
    assert.equal(result.sourceLabel, 'Phụ đề EN tự động');
  }
  finally { globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; }
});

test('each complete sentence finishes before the next spoken sentence', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { lengthSeconds: '12' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async url => {
    const vi = new URL(url).searchParams.get('tlang') === 'vi';
    const lines = vi
      ? [['Vâng.', 0, 1500], ['Tôi đồng ý với điều đó.', 2200, 2500], ['Cảm ơn.', 6000, 2000]]
      : [['Yes.', 0, 1500], ['I agree with that.', 2200, 2500], ['Thanks.', 6000, 2000]];
    return { ok: true, async json() { return { events: lines.map(([text, tStartMs, dDurationMs]) => ({ tStartMs, dDurationMs, segs: [{ utf8: text }] })) }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.deepEqual(result.cues.map(cue => cue.text), ['Yes.', 'I agree with that.', 'Thanks.']);
    assert.equal(result.cues[0].start + result.cues[0].duration, result.cues[1].start);
    assert.equal(result.cues[1].start + result.cues[1].duration, result.cues[2].start);
    assert.equal(result.cues[1].start, 2.2);
    assert.equal(result.cues[2].start, 6);
    assert.equal(result.cues[0].needsTranslation, false);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('one caption with two sentences becomes two slots that meet exactly', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { lengthSeconds: '8' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async url => {
    const vi = new URL(url).searchParams.get('tlang') === 'vi';
    const text = vi ? 'Xin chào. Bạn khỏe không?' : 'Hello. How are you?';
    return { ok: true, async json() { return { events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: text }] }] }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.deepEqual(result.cues.map(cue => [cue.text, cue.translatedText]), [
      ['Hello.', 'Xin chào.'],
      ['How are you?', 'Bạn khỏe không?'],
    ]);
    assert.equal(result.cues[0].start + result.cues[0].duration, result.cues[1].start);
    assert.equal(result.cues[1].start, 1);
    assert.equal(result.cues[1].duration, 3);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('an authored translation stays on the spoken sentence it overlaps', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { lengthSeconds: '8' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=en' },
      { languageCode: 'vi', baseUrl: 'https://www.youtube.com/api/timedtext?v=vi' },
    ] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async url => {
    const vi = new URL(url).searchParams.get('v') === 'vi';
    const lines = vi
      ? [['Xin chào.', 0, 3000], ['Bạn khỏe không?', 3000, 3000]]
      : [['Hello.', 0, 3000], ['How are you?', 3000, 3000]];
    return { ok: true, async json() { return { events: lines.map(([text, tStartMs, dDurationMs]) => ({ tStartMs, dDurationMs, segs: [{ utf8: text }] })) }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.deepEqual(result.cues.map(cue => [cue.text, cue.translatedText, cue.needsTranslation]), [
      ['Hello.', 'Xin chào.', false],
      ['How are you?', 'Bạn khỏe không?', false],
    ]);
    assert.equal(result.cues[0].start + result.cues[0].duration, result.cues[1].start);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('a failed translated-caption request still keeps the English transcript', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { videoId: 'test', lengthSeconds: '10' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async url => {
    if (new URL(url).searchParams.get('tlang')) return { ok: false, status: 400, async json() { return {}; } };
    return { ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'Hello from the source track.' }] },
    ] }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'Hello from the source track.');
    assert.equal(result.cues[0].needsTranslation, true);
    assert.equal(result.sourceLabel, 'Phụ đề EN tự động');
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('captions are read from the initial player response when the live player omits them', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, response: globalThis.ytInitialPlayerResponse };
  globalThis.document = { querySelector: (selector) => selector === 'video' ? { duration: 12 } : { getPlayerResponse: () => ({ videoDetails: { videoId: 'test' } }) } };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.ytInitialPlayerResponse = {
    videoDetails: { videoId: 'test' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ vssId: 'a.en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.fetch = async () => ({ ok: true, async json() { return { events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Automatic English.' }] },
  ] }; } });
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.duration, 12);
    assert.equal(result.cues[0].text, 'Automatic English.');
    assert.equal(result.cues[0].start, 1);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.ytInitialPlayerResponse = saved.response;
  }
});

test('default English captions are loaded from the timedtext list when the player omits them', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => ({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '30' } }) }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/youtubei/')) return { ok: false, status: 400, async json() { return {}; } };
    if (parsed.searchParams.get('type') === 'list') {
      return { ok: true, async text() { return '<transcript_list><track lang_code="en" kind="asr" lang_default="true"/></transcript_list>'; } };
    }
    assert.equal(parsed.searchParams.get('lang'), 'en');
    assert.equal(parsed.searchParams.get('kind'), 'asr');
    return { ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Default English captions.' }] },
    ] }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'Default English captions.');
    assert.equal(result.cues[0].needsTranslation, true);
    assert.equal(result.sourceLabel, 'Phụ đề EN tự động');
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

const emptyBody = { ok: true, status: 200, async json() { throw new SyntaxError('Unexpected end of JSON input'); }, async text() { return ''; } };
const json3 = events => ({ ok: true, async json() { return { events }; }, async text() { return JSON.stringify({ events }); } });
const gatedTrack = { languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&exp=xpe&caps=asr' };

test('a pot-gated caption URL reuses the token from the player request', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, captured: globalThis.__textoneTimedtext };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => ({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '20' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [gatedTrack] } } }) }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  globalThis.__textoneTimedtext = ['https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=TOKEN&potc=1&c=WEB&fmt=json3'];
  const requested = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url); requested.push(parsed);
    if (parsed.pathname === '/api/timedtext' && parsed.searchParams.get('pot') === 'TOKEN' && parsed.searchParams.get('c') === 'WEB' && !parsed.searchParams.get('tlang')) {
      return json3([{ tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Token protected captions.' }] }]);
    }
    return emptyBody;
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'Token protected captions.');
    assert.equal(result.cues[0].needsTranslation, true);
    assert.ok(requested.every(url => !url.pathname.startsWith('/youtubei/')));
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.__textoneTimedtext = saved.captured;
  }
});

test('captions are switched on through the player API to mint a token, then restored', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, captured: globalThis.__textoneTimedtext };
  globalThis.__textoneTimedtext = [];
  const calls = [];
  const player = {
    getPlayerResponse: () => ({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '20' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [gatedTrack] } } }),
    loadModule: name => calls.push(['load', name]),
    unloadModule: name => calls.push(['unload', name]),
    getOption: (module, option) => option === 'tracklist' ? [{ languageCode: 'en', kind: 'asr' }] : {},
    setOption: (module, option, value) => {
      calls.push(['set', value?.languageCode || '']);
      if (value?.languageCode) void globalThis.fetch('https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=MINTED&potc=1&c=WEB&fmt=json3');
    },
  };
  globalThis.document = { querySelector: () => player };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('pot') === 'MINTED') return json3([{ tStartMs: 500, dDurationMs: 2500, segs: [{ utf8: 'Minted by the player.' }] }]);
    return emptyBody;
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'Minted by the player.');
    assert.deepEqual(calls, [['load', 'captions'], ['set', 'en'], ['set', ''], ['unload', 'captions']]);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.__textoneTimedtext = saved.captured;
  }
});

test('the iOS InnerTube client supplies caption URLs when web URLs are empty', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, captured: globalThis.__textoneTimedtext, bodies: globalThis.__textoneTimedtextBodies };
  globalThis.__textoneTimedtext = [];
  globalThis.__textoneTimedtextBodies = [];
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => ({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '20' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [gatedTrack] } } }) }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  let body;
  let clientHeader;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/youtubei/v1/player') {
      body = JSON.parse(init.body);
      clientHeader = init.headers?.['X-YouTube-Client-Name'];
      return { ok: true, async json() { return { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&ios=1' },
      ] } } }; } };
    }
    if (parsed.searchParams.get('ios') === '1' && parsed.searchParams.get('fmt') === 'json3' && !parsed.searchParams.get('tlang')) {
      return json3([{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'iOS client captions.' }] }]);
    }
    return emptyBody;
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(body.context.client.clientName, 'IOS');
    assert.equal(body.context.client.clientVersion, '20.10.38');
    assert.equal(clientHeader, '5');
    assert.equal(body.videoId, 'abcdefghijk');
    assert.equal(result.cues[0].text, 'iOS client captions.');
    assert.equal(result.cues[0].start, 1);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.__textoneTimedtext = saved.captured; globalThis.__textoneTimedtextBodies = saved.bodies;
  }
});

test('a caption body the player already received is used when the caption URL is empty', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, captured: globalThis.__textoneTimedtext, bodies: globalThis.__textoneTimedtextBodies };
  globalThis.__textoneTimedtext = [];
  const payload = { events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Captured from the player.' }] }] };
  globalThis.__textoneTimedtextBodies = [
    { url: 'https://www.youtube.com/api/timedtext?v=zzzzzzzzzzz&lang=en&fmt=json3', body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Wrong video.' }] }] }), lang: 'en', tlang: '', videoId: 'zzzzzzzzzzz' },
    { url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&fmt=json3&tlang=vi', body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Wrong translated body.' }] }] }), lang: 'en', tlang: 'vi', videoId: 'abcdefghijk' },
    { url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&fmt=json3', body: `)]}'\n${JSON.stringify(payload)}`, lang: 'en', tlang: '', videoId: 'abcdefghijk' },
  ];
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => ({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '20' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [gatedTrack] } } }) }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  const requested = [];
  globalThis.fetch = async url => { requested.push(String(url)); return emptyBody; };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'Captured from the player.');
    assert.equal(result.cues[0].needsTranslation, true);
    assert.equal(requested.length, 0);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.__textoneTimedtext = saved.captured; globalThis.__textoneTimedtextBodies = saved.bodies;
  }
});

test('a captured pot URL is replayed with c=WEB when the player omitted it', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, captured: globalThis.__textoneTimedtext, bodies: globalThis.__textoneTimedtextBodies };
  globalThis.__textoneTimedtext = ['https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=TOKEN&potc=1&fmt=json3'];
  globalThis.__textoneTimedtextBodies = [];
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => ({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '20' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [gatedTrack] } } }) }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  const requested = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    requested.push(parsed);
    if (parsed.searchParams.get('pot') === 'TOKEN' && parsed.searchParams.get('c') === 'WEB' && !parsed.searchParams.get('tlang')) {
      return json3([{ tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Client named captions.' }] }]);
    }
    return emptyBody;
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'Client named captions.');
    assert.ok(requested.some(url => url.searchParams.get('c') === 'WEB' && url.searchParams.get('pot') === 'TOKEN'));
    assert.ok(requested.every(url => url.searchParams.get('pot') === 'TOKEN'));
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.__textoneTimedtext = saved.captured; globalThis.__textoneTimedtextBodies = saved.bodies;
  }
});

test('srv1 caption XML is read when json3 is not JSON', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, bodies: globalThis.__textoneTimedtextBodies };
  globalThis.__textoneTimedtextBodies = [];
  const playerResponse = {
    videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '20' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  globalThis.fetch = async () => ({ ok: true, async json() { throw new SyntaxError('not json'); }, async text() { return '<transcript><text start="1.25" dur="2.5">From srv1.</text></transcript>'; } });
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].text, 'From srv1.');
    assert.equal(result.cues[0].start, 1.25);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.__textoneTimedtextBodies = saved.bodies;
  }
});

test('the transcript panel endpoint is used when every caption URL is empty', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, captured: globalThis.__textoneTimedtext, data: globalThis.ytInitialData };
  globalThis.__textoneTimedtext = [];
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => ({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '20' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [gatedTrack] } } }) }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  const params = Buffer.from('\n\x0babcdefghijk\x12\x02en').toString('base64url');
  globalThis.ytInitialData = { engagementPanels: [{ engagementPanelSectionListRenderer: { content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params } } } } } }] };
  let posted;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/youtubei/v1/player') return { ok: false, status: 400, async json() { return {}; } };
    if (parsed.pathname === '/youtubei/v1/get_transcript') {
      posted = JSON.parse(init.body);
      return { ok: true, async json() { return { actions: [{ segments: [
        { transcriptSegmentRenderer: { startMs: '0', endMs: '2500', snippet: { runs: [{ text: 'From the transcript panel.' }] } } },
        { transcriptSegmentRenderer: { startMs: '3000', endMs: '5000', snippet: { runs: [{ text: 'Second line.' }] } } },
      ] }] }; } };
    }
    if (parsed.searchParams.get('type') === 'list') return { ok: false, status: 404, async text() { return ''; } };
    return emptyBody;
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(posted.params, params);
    assert.deepEqual(result.cues.map(cue => cue.text), ['From the transcript panel.', 'Second line.']);
    assert.equal(result.cues[1].start, 3);
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch; globalThis.__textoneTimedtext = saved.captured; globalThis.ytInitialData = saved.data;
  }
});

test('subtitle translator credits are not spoken as part of the first sentence', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { videoId: 'test', lengthSeconds: '20' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=en' },
      { languageCode: 'vi', baseUrl: 'https://www.youtube.com/api/timedtext?v=vi' },
    ] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async url => {
    const vi = new URL(url).searchParams.get('v') === 'vi';
    const events = vi
      ? [{ tStartMs: 0, dDurationMs: 800, segs: [{ utf8: 'Translator: Đỗ Thị Hoa Reviewer: Thị Tú Nguyễn' }] }, { tStartMs: 830, dDurationMs: 4000, segs: [{ utf8: '( Tiếng cười và vỗ tay) Khi tôi làm cố vấn chính sách.' }] }]
      : [{ tStartMs: 830, dDurationMs: 4000, segs: [{ utf8: '(Laughter) When I worked as a policy advisor.' }] }];
    return { ok: true, async json() { return { events }; } };
  };
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    assert.equal(result.cues[0].translatedText, 'Khi tôi làm cố vấn chính sách.');
    assert.equal(result.cues[0].text, 'When I worked as a policy advisor.');
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('overlapping rolling ASR lines never produce overlapping slots', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const playerResponse = {
    videoDetails: { videoId: 'test', lengthSeconds: '40' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => playerResponse }) };
  globalThis.location = { href: 'https://www.youtube.com/watch?v=test' };
  globalThis.fetch = async () => ({ ok: true, async json() { return { events: [
    { tStartMs: 17000, dDurationMs: 6000, segs: [{ utf8: 'What is your favorite food? Uh, ribs. I think so.' }] },
    { tStartMs: 20810, dDurationMs: 3000, segs: [{ utf8: 'That is probably one of my favorite foods.' }] },
    { tStartMs: 22000, dDurationMs: 4000, segs: [{ utf8: 'It is easy. Okay.' }] },
  ] }; } });
  try {
    const result = await collectYouTubeCaptions('en', 'vi');
    for (let index = 1; index < result.cues.length; index++) {
      const previous = result.cues[index - 1];
      assert.ok(result.cues[index].start >= previous.start + previous.duration - 0.01, `cue ${index} overlaps the previous one`);
    }
    assert.ok(result.cues.every(cue => cue.duration >= 0.08 && cue.duration <= 18));
  } finally {
    globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
  }
});

test('YouTube caption collector does not mislabel an unrelated caption language as English', async () => {
  const saved = { document: globalThis.document };
  globalThis.document = { querySelector: () => ({ getPlayerResponse: () => ({
    videoDetails: { lengthSeconds: '10' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'ja', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } },
  }) }) };
  try { assert.equal((await collectYouTubeCaptions('en', 'vi')).cues.length, 0); }
  finally { globalThis.document = saved.document; }
});
