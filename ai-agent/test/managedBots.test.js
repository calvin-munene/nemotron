import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  decryptManagedBotToken,
  encryptManagedBotToken,
  managedBotEncryptionStatus,
  testManagedBotConnection
} from "../src/managedBots.js";

const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; });

function environment() {
  return {
    BOT_CREDENTIAL_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    BOT_CREDENTIAL_KEY_VERSION: "test-v1"
  };
}

test("managed bot tokens are authenticated, encrypted, profile-bound, and never returned in plaintext", () => {
  const env = environment();
  const profileId = crypto.randomUUID();
  const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCD";
  const encrypted = encryptManagedBotToken(token, { profileId, env });
  assert.equal(encrypted.keyVersion, "test-v1");
  assert.doesNotMatch(JSON.stringify(encrypted), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(decryptManagedBotToken(encrypted, { profileId, env }), token);
  assert.throws(() => decryptManagedBotToken(encrypted, { profileId: crypto.randomUUID(), env }), /could not be decrypted/);
  assert.deepEqual(managedBotEncryptionStatus(env), { configured: true, keyVersion: "test-v1" });
  assert.equal(managedBotEncryptionStatus({}).configured, false);
});
test("managed bot connectivity returns only safe bot metadata", async () => {
  const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCD";
  let requested = "";
  global.fetch = async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({ ok: true, result: { id: 987654321, is_bot: true, username: "managed_test_bot", first_name: "Managed" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const result = await testManagedBotConnection(token);
  assert.equal(result.connected, true);
  assert.deepEqual(result.bot, { id: "987654321", username: "managed_test_bot", firstName: "Managed" });
  assert.match(requested, /\/getMe$/);
  assert.doesNotMatch(JSON.stringify(result), /abcdefghijklmnopqrstuvwxyz/);
});
