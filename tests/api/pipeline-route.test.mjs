import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
const code = ts.transpileModule(readFileSync(new URL('../../src/app/api/realtime/pipeline/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const row = { nextAllowedAt: new Date(0), chunks: 0 }; const calls = [];
  const imports = { 'node:crypto': { timingSafeEqual }, zod: { z }, '@/lib/env': { env: { CHATTERBOX_API_KEY: 'service-key' } },
    '@/lib/realtime/video-auth': { videoSession: async request => request.headers.get('authorization') === 'Bearer session' ? { id: 'id', orgId: 'org', mode: 'dub', source: 'en', target: 'vi', expires: Date.now()+900000, voiceId: 'voice' } : null, boundedBody: async request => Buffer.from(await request.arrayBuffer()) },
    '@/lib/db': { prisma: { voice: { findFirst: async () => ({ r2ObjectKey: 'private-voice' }) }, realtimeSession: { updateMany: async ({where,data}) => {
      calls.push({where,data});
      if (where.nextAllowedAt instanceof Date ? where.nextAllowedAt.getTime() !== row.nextAllowedAt.getTime() : row.nextAllowedAt > where.nextAllowedAt.lte) return { count: 0 };
      if (where.chunks && row.chunks > where.chunks.lte) return { count: 0 };
      row.nextAllowedAt = data.nextAllowedAt; row.chunks += data.chunks?.increment || 0; return { count: 1 };
    } } } } };
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => imports[name], Buffer, Date, Math, Response, process: { env: { REALTIME_PIPELINE_URL: 'wss://test.modal.run/stream' } } });
  const request = (data, key = 'service-key', token = 'session') => new Request('https://app.test/api/realtime/pipeline', {method:'POST', headers: {'x-api-key':key, authorization:`Bearer ${token}`}, body: JSON.stringify(data)});
  return { row, calls, post: (data,key,token) => exports.POST(request(data,key,token)), get: () => exports.GET(request({})) };
}
test('worker credentials and session are both required before lease acquisition', async () => {
  const h = harness();
  assert.equal((await h.post({action:'acquire'}, 'wrong')).status, 403);
  assert.equal((await h.post({action:'acquire'}, undefined, 'wrong')).status, 401);
  assert.equal(h.calls.length, 0);
});
test('only one pipeline can hold a session and its quota is bounded', async () => {
  const h = harness();
  const first = await (await h.post({action:'acquire'})).json();
  assert.equal(h.row.chunks, 5);
  assert.equal((await h.post({action:'acquire'})).status, 409);
  h.row.chunks = 300;
  assert.equal((await h.post({action:'renew', lease:first.lease, reserve:true})).status, 409);
  assert.equal((await h.post({action:'release', lease:first.lease})).status, 200);
});
test('stale lease cannot release a newer owner; browser config contains no voice or service key', async () => {
  const h = harness();
  await h.post({action:'acquire'});
  const expected = h.row.nextAllowedAt.getTime();
  assert.equal((await h.post({action:'release', lease:new Date(1).toISOString()})).status, 409);
  assert.equal(h.row.nextAllowedAt.getTime(), expected);
  assert.deepEqual(await (await h.get()).json(), {endpoint:'wss://test.modal.run/stream'});
});

test('pipeline API bypasses interactive Clerk redirect and keeps capability authentication in the handler', () => {
  const source = readFileSync(new URL('../../src/proxy.ts', import.meta.url), 'utf8');
  const pattern = source.match(/if \((\/\^.*?\/)\.test\(req.nextUrl.pathname\)\)/)?.[1];
  assert.ok(pattern);
  const regex = new RegExp(pattern.slice(1, -1));
  assert.ok(regex.test('/api/realtime/pipeline'));
  assert.equal(regex.test('/api/realtime/session'), false);
  assert.equal(regex.test('/api/realtime/pipeline-admin'), false);
});
