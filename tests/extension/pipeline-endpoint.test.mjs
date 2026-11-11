import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { pipelineEndpoint, pipelinePermission } = createRequire(import.meta.url)('../../extension/sessions/pipeline-endpoint.js');
test('private pipeline accepts TLS, direct LAN gateway, or loopback but rejects arbitrary cleartext and credentials', () => {
  assert.equal(pipelineEndpoint('ws://localhost:18802/stream').hostname, 'localhost');
  assert.equal(pipelineEndpoint('ws://192.168.1.198:18802/stream').host, '192.168.1.198:18802');
  assert.equal(pipelinePermission('ws://localhost:18802/stream'), 'http://localhost:18802/*');
  assert.equal(pipelinePermission('ws://192.168.1.198:18802/stream'), 'http://192.168.1.198:18802/*');
  assert.equal(pipelinePermission('wss://voice.example.com/stream'), 'https://voice.example.com/*');
  for (const value of ['ws://192.168.1.198/stream', 'http://localhost:18802', 'wss://user:secret@voice.example.com', 'ws://localhost.evil.com']) {
    assert.throws(() => pipelineEndpoint(value));
  }
});
