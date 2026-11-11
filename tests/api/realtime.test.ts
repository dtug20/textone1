import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { issueSession, verifySession } from "../../src/lib/realtime/session";
import { encodeWav } from "../../extension/audio/audio.js";
const secret = "test-secret-with-at-least-32-characters";
const input = { orgId: "org_a", userId: "user_a", voiceId: "voice_a", source: "en", target: "vi", mode: "dub" } as const;
test("session preserves tenant scope and rejects tampering and wrong keys", () => {
    const { token } = issueSession(input, secret);
    assert.equal(verifySession(token, secret).orgId, "org_a");
    assert.throws(() => verifySession(token + "x", secret));
    assert.throws(() => verifySession(token, secret + "wrong"));
    assert.throws(() => verifySession("invalid", secret));
    assert.throws(() => issueSession(input, "short"));
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), orgId: "org_b" })).toString("base64url");
    assert.throws(() => verifySession(`${forged}.${signature}`, secret));
    const cloned = issueSession({ ...input, cloneVoice: true }, secret);
    assert.equal(verifySession(cloned.token, secret).cloneVoice, true);
});
test("correctly signed expired sessions are rejected", () => {
    const issued = issueSession(input, secret);
    const claims = verifySession(issued.token, secret);
    const payload = Buffer.from(JSON.stringify({ ...claims, expires: Date.now() - 1 })).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    assert.throws(() => verifySession(`${payload}.${signature}`, secret), /expired/);
});
test("WAV chunks include independent headers and clipped PCM16 samples", () => {
    const buffer = encodeWav(new Float32Array([-2, 0, 2]), 16000);
    const view = new DataView(buffer);
    assert.equal(Buffer.from(buffer).toString("ascii", 0, 4), "RIFF");
    assert.equal(view.getUint32(24, true), 16000);
    assert.equal(view.getUint32(40, true), 6);
    assert.equal(view.getInt16(44, true), -32768);
    assert.equal(view.getInt16(46, true), 0);
    assert.equal(view.getInt16(48, true), 32767);
});
