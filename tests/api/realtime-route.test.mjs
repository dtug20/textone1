import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { z } from 'zod';
const require = createRequire(import.meta.url);
const { issueSession, verifySession } = require('../../src/lib/realtime/session.ts');
const { encodeWav } = require('../../extension/audio/audio.js');

// Execute the actual route with in-memory DB/upstream boundaries, without credentials or GPU calls.
const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/api/realtime/chunk/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const secret = 'test-secret-with-at-least-32-characters';
function harness({ stored = {}, mode = 'transcribe', upstream, fast = false } = {}) {
  const { token } = issueSession({ orgId: 'org_a', userId: 'user_a', voiceId: 'voice_a', source: 'en', target: 'vi', mode }, secret);
  const claims = verifySession(token, secret);
  const row = stored === null ? null : { id: claims.id, orgId: claims.orgId, expiresAt: new Date(claims.expires), nextAllowedAt: new Date(0), chunks: 0, ...stored };
  const calls = { updates: [], reads: 0, fetches: [], voices: 0 };
  const prisma = {
    realtimeSession: {
      async updateMany({ where, data }) {
        calls.updates.push({ where, data });
        if (!row || row.id !== where.id || (where.orgId && row.orgId !== where.orgId)) return { count: 0 };
        if (where.expiresAt && row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        if (where.chunks && row.chunks >= where.chunks.lt) return { count: 0 };
        if (where.nextAllowedAt?.lte && row.nextAllowedAt > where.nextAllowedAt.lte) return { count: 0 };
        if (where.nextAllowedAt instanceof Date && row.nextAllowedAt.getTime() !== where.nextAllowedAt.getTime()) return { count: 0 };
        row.nextAllowedAt = data.nextAllowedAt;
        row.chunks += data.chunks?.increment || 0;
        return { count: 1 };
      },
      async findFirst({ where }) {
        calls.reads++;
        return row?.id === where.id && row?.orgId === where.orgId ? row : null;
      },
    },
    voice: { async findFirst() { calls.voices++; return { r2ObjectKey: 'voices/test' }; } },
  };
  const exports = {};
  const imports = {
    zod: { z }, '@/lib/db': { prisma }, '@/lib/realtime/session': { verifySession },
    '@/lib/env': { env: { CHATTERBOX_API_KEY: 'test', CHATTERBOX_API_URL: 'https://tts.test', VITERBOX_API_URL: 'https://vi.test' } },
  };
  vm.runInNewContext(compiled, {
    exports, require: (name) => { assert.ok(imports[name], `Unexpected import: ${name}`); return imports[name]; },
    process: { env: { REALTIME_SESSION_SECRET: secret, REALTIME_API_URL: 'https://speech.test', ...(fast ? { FAST_TTS_API_URL: 'http://192.168.1.198:18803' } : {}) } },
    Buffer, Date, URL, Response, AbortSignal, AbortController, ReadableStream, TextEncoder, performance,
    fetch: async (url, options) => {
      calls.fetches.push({ url: String(url), options });
      if (String(url).endsWith('/health')) return Response.json({ ready: true });
      if (upstream) return upstream(url, options);
      return /\/(generate|synthesize)$/.test(String(url)) ? new Response(encodeWav(new Float32Array(16000), 16000)) : Response.json({ text: 'hello', translatedText: 'xin chào' });
    },
  });
  const request = (authorization = `Bearer ${token}`, accept = 'application/json') => new Request('https://app.test/api/realtime/chunk', {
    method: 'POST', headers: { authorization, accept }, body: encodeWav(new Float32Array(16000), 16000),
  });
  return { post: (authorization, accept) => exports.POST(request(authorization, accept)), row, calls };
}

for (const [name, stored, status, code] of [
  ['revoked', null, 401, 'SESSION_REVOKED'],
  ['different tenant', { orgId: 'org_b' }, 401, 'SESSION_REVOKED'],
  ['expired', { expiresAt: new Date(0) }, 401, 'SESSION_EXPIRED'],
  ['exhausted', { chunks: 300 }, 409, 'SESSION_EXHAUSTED'],
  ['busy', { nextAllowedAt: new Date(Date.now() + 60000) }, 429, 'SESSION_BUSY'],
]) {
  test(`route distinguishes ${name} sessions without calling speech services`, async () => {
    const h = harness({ stored });
    const response = await h.post();
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.equal(h.calls.fetches.length, 0);
    assert.equal(response.headers.get('Retry-After'), status === 429 ? '1' : null);
  });
}

test('invalid signatures are rejected before accessing DB or upstream', async () => {
  const h = harness();
  assert.equal((await h.post('Bearer invalid')).status, 401);
  assert.equal(h.calls.updates.length, 0);
  assert.equal(h.calls.fetches.length, 0);
});

test('successful chunks release the lease and accept the next chunk immediately', async () => {
  const h = harness();
  assert.equal((await h.post()).status, 200);
  assert.equal((await h.post()).status, 200);
  assert.equal(h.row.chunks, 2);
  assert.equal(h.calls.reads, 0);
  assert.equal(h.calls.voices, 0);
});

test('upstream failures release the lease so recovery does not wait 60 seconds', async () => {
  const h = harness({ upstream: () => new Response('unavailable', { status: 503 }) });
  assert.equal((await h.post()).status, 502);
  assert.ok(h.row.nextAllowedAt.getTime() <= Date.now());
  assert.equal((await h.post()).status, 502);
});

test('voice lookup overlaps STT and delayed cleanup cannot unlock a newer lease', async () => {
  let finish;
  const h = harness({ mode: 'dub', upstream: () => new Promise((resolve) => { finish = resolve; }) });
  const response = h.post();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.fetches.filter(x => !x.url.endsWith('/health')).length, 1);
  assert.equal(h.calls.voices, 1);
  const newerLease = new Date(Date.now() + 120000);
  h.row.nextAllowedAt = newerLease;
  finish(Response.json({ text: '', translatedText: '' }));
  assert.equal((await response).status, 200);
  assert.equal(h.row.nextAllowedAt, newerLease);
});

test('Vietnamese dubbing uses the Piper model on the LAN host when it is configured', async () => {
  const h = harness({ mode: 'dub', fast: true });
  const response = await h.post();
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(result.audio, 'base64').toString('ascii', 0, 4), 'RIFF');
  const synth = h.calls.fetches.find(call => call.url.endsWith('/synthesize'));
  assert.equal(synth.url, 'http://192.168.1.198:18803/synthesize');
  assert.deepEqual(JSON.parse(synth.options.body), { text: 'xin chào', length_scale: 0.76 });
  assert.equal(h.calls.fetches.some(call => call.url.includes('vi.test')), false);
});

test('dub returns generated audio and timing data', async () => {
  const h = harness({ mode: 'dub' });
  const response = await h.post();
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(result.audio, 'base64').toString('ascii', 0, 4), 'RIFF');
  assert.equal(typeof result.timings.totalMs, 'number');
  assert.equal(h.calls.fetches.length, 3);
});

test('TTS failure preserves recognized text for JSON clients instead of losing the whole segment', async () => {
  const h = harness({ mode: 'dub', upstream: url => String(url).endsWith('/generate') ? new Response('crashed', { status: 500 }) : Response.json({ text: 'hello', translatedText: 'xin chào' }) });
  const response = await h.post();
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.text, 'hello');
  assert.equal(result.audio, null);
  assert.equal(result.code, 'TTS_FAILED');
  assert.ok(h.row.nextAllowedAt.getTime() <= Date.now());
});

test('stream delivers transcript before TTS completes, then audio after releasing lease', async () => {
  let finishTts;
  const h = harness({ mode: 'dub', upstream: url => String(url).endsWith('/generate') ? new Promise(resolve => { finishTts = resolve; }) : Response.json({ text: 'hello', translatedText: 'xin chào' }) });
  const response = await h.post(undefined, 'application/x-ndjson');
  assert.match(response.headers.get('Content-Type'), /ndjson/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('"type":"transcript"')) received += decoder.decode((await reader.read()).value);
  assert.match(received, /xin chào/);
  assert.ok(h.row.nextAllowedAt.getTime() > Date.now());
  await new Promise(resolve => setImmediate(resolve));
  finishTts(new Response(encodeWav(new Float32Array(16000), 16000)));
  while (true) { const part = await reader.read(); if (part.done) break; received += decoder.decode(part.value); }
  assert.match(received, /"type":"result"/);
  assert.ok(h.row.nextAllowedAt.getTime() <= Date.now());
});

test('ASR speech boundaries and model timings survive the chunk response', async () => {
  const h = harness({ upstream: async () => Response.json({ text: 'hello', translatedText: 'xin chào', speechStart: 0.25, speechEnd: 0.9, modelTimings: { queueMs: 1, asrMs: 120, translationMs: 30 } }) });
  const result = await (await h.post()).json();
  assert.equal(result.speechStart, 0.25); assert.equal(result.speechEnd, 0.9);
  assert.deepEqual(result.modelTimings, { queueMs: 1, asrMs: 120, translationMs: 30 });
});
