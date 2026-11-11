import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
function route({ session = { id: 'session_a', orgId: 'org_a' }, owner = true, exists = false, failUpload = false } = {}) {
  const writes = []; const deletions = []; const queries = [];
  const imports = { zod: { z }, 'node:crypto': { randomUUID },
    '@/lib/db': { prisma: {
      translatedVideo: { findFirst: async ({ where }) => { queries.push(where); return owner ? { id: 'video_a' } : null; } },
      translatedVideoSegment: { findUnique: async () => exists ? { id: 'part_a' } : null, create: async ({ data }) => { writes.push(data); } },
    } },
    '@/lib/r2': { uploadAudio: async ({ key }) => { writes.push(key); if (failUpload) throw new Error('Storage down'); }, deleteAudio: async (key) => { deletions.push(key); } },
    '@/lib/realtime/video-auth': { videoSession: async () => session, boundedBody: async (req, max) => { const bytes = Buffer.from(await req.arrayBuffer()); if (bytes.length > max) throw new Error('Too large'); return bytes; } },
  };
  const exports = {};
  const compiled = ts.transpileModule(readFileSync('src/app/api/realtime/videos/[id]/segments/route.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, { exports, require: (name) => imports[name], Buffer, Response, File, Promise, JSON });
  function request({ metadata, size = 10, audio = null } = {}) {
    const form = new FormData();
    form.set('metadata', metadata ?? JSON.stringify({ sequence: 0, sourceStart: 0, duration: 4, text: 'hello', translation: 'xin chào' }));
    const bytes = Buffer.alloc(size); if (size >= 4) bytes.writeUInt32BE(0x1a45dfa3);
    form.set('video', new Blob([bytes], { type: 'video/webm' }), 'clip.webm');
    if (audio) form.set('audio', new Blob([audio]), 'clip.wav');
    return new Request('https://app.test/api/realtime/videos/video_a/segments', { method: 'POST', body: form });
  }
  return { writes, deletions, queries, post: (options) => exports.POST(request(options), { params: Promise.resolve({ id: 'video_a' }) }) };
}
test('saved segments require a valid current session', async () => {
  const h = route({ session: null }); assert.equal((await h.post()).status, 401); assert.equal(h.writes.length, 0);
});
test('video owner is checked against both organization and session before uploading', async () => {
  const h = route({ owner: false }); assert.equal((await h.post()).status, 404); assert.equal(h.writes.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.queries[0])), { id: 'video_a', orgId: 'org_a', sessionId: 'session_a' });
});
test('invalid metadata, oversized video, invalid WAV and sequence overflow cannot be saved', async () => {
  for (const input of [{ metadata: '{' }, { size: 2_000_001 }, { audio: 'not-wav' }, { metadata: JSON.stringify({ sequence: 300, sourceStart: 0, duration: 4, text: '', translation: '' }) }]) {
    const h = route(); assert.equal((await h.post(input)).status, 400); assert.equal(h.writes.length, 0);
  }
});
test('successful video save uses a tenant-scoped server-generated object key', async () => {
  const h = route(); assert.equal((await h.post()).status, 200); assert.match(h.writes[0], /^translated\/org_a\/video_a\/.+\.webm$/);
  assert.equal(h.writes[1].videoId, 'video_a'); assert.equal(h.writes[1].translation, 'xin chào');
});
test('retries are idempotent and storage failures leave no published segment', async () => {
  const h = route({ exists: true }); assert.equal((await h.post()).status, 200); assert.equal(h.writes.length, 0);
  const failed = route({ failUpload: true }); assert.equal((await failed.post()).status, 503);
  assert.equal(failed.deletions.length, 1); assert.equal(failed.writes.filter((x) => typeof x === 'object').length, 0);
});

test('saved speech timing is retained and invalid or incomplete intervals are rejected', async () => {
  const metadata = { sequence: 0, sourceStart: 12, duration: 4, text: 'hello', translation: 'xin chào', speechStart: 0.5, speechEnd: 3 };
  const h = route(); assert.equal((await h.post({ metadata: JSON.stringify(metadata) })).status, 200);
  assert.equal(h.writes[1].speechStart, 0.5); assert.equal(h.writes[1].speechEnd, 3);
  for (const patch of [{ speechStart: -1 }, { speechEnd: 5 }, { speechEnd: 0.25 }, { speechStart: undefined }]) {
    const invalid = route(); assert.equal((await invalid.post({ metadata: JSON.stringify({ ...metadata, ...patch }) })).status, 400);
    assert.equal(invalid.writes.length, 0);
  }
});
