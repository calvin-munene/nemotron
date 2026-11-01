import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveBotEncryptionKey, resolveStarSigningSecret } from "../src/runtimeSecrets.js";
import { encryptManagedBotToken, decryptManagedBotToken, managedBotEncryptionStatus } from "../src/managedBots.js";
import { runtimeConfig, safeConfigurationStatus, validateRuntimeConfiguration } from "../src/config.js";
import { createStarPurchasePayload, validateStarPurchasePayload } from "../src/starPayments.js";
import { createSecretaryActivationPayload, validateSecretaryActivationPayload } from "../src/secretaryPayments.js";

const sessionSecret = "test-only-session-root-0123456789-abcdef";
const env = { SESSION_SECRET: sessionSecret };
const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCD";

test("automatic keys are deterministic, domain-separated, and stable across processes", () => {
  const encryption = resolveBotEncryptionKey(env);
  const signing = resolveStarSigningSecret(env);
  assert.equal(encryption.length, 32);
  assert.notDeepEqual(encryption, Buffer.from(signing, "base64"));
  assert.deepEqual(encryption, resolveBotEncryptionKey({ ...env }));
  assert.equal(signing, resolveStarSigningSecret({ ...env }));
  const resolverUrl = new URL("../src/runtimeSecrets.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { resolveBotEncryptionKey, resolveStarSigningSecret } from ${JSON.stringify(resolverUrl)};
     const env = ${JSON.stringify(env)};
     const stable = resolveBotEncryptionKey(env).equals(Buffer.from(${JSON.stringify(encryption.toString("base64"))}, "base64"))
       && resolveStarSigningSecret(env) === ${JSON.stringify(signing)};
     process.exit(stable ? 0 : 1);`
  ], { encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
});

test("explicit keys retain precedence and invalid overrides never fall back", () => {
  const explicit = crypto.randomBytes(32);
  const overrides = {
    ...env,
    BOT_CREDENTIAL_ENCRYPTION_KEY: explicit.toString("base64"),
    TELEGRAM_STAR_SIGNING_SECRET: "test-only-explicit-stars-secret-0123456789"
  };
  assert.deepEqual(resolveBotEncryptionKey(overrides), explicit);
  assert.equal(resolveStarSigningSecret(overrides), overrides.TELEGRAM_STAR_SIGNING_SECRET);
  assert.throws(() => resolveBotEncryptionKey({ ...env, BOT_CREDENTIAL_ENCRYPTION_KEY: "invalid" }), /misconfigured/);
  assert.throws(() => resolveStarSigningSecret({ ...env, TELEGRAM_STAR_SIGNING_SECRET: "short" }), /at least 32 bytes/);
});

test("missing and short roots fail without exposing their contents", () => {
  for (const candidate of [{}, { SESSION_SECRET: "short-test-root" }]) {
    for (const resolver of [resolveBotEncryptionKey, resolveStarSigningSecret]) {
      assert.throws(() => resolver(candidate), (error) => {
        assert.doesNotMatch(error.message, /short-test-root/);
        return /at least 32 bytes/.test(error.message);
      });
    }
  }
});

test("derived managed-bot keys encrypt and decrypt credentials across restarts", () => {
  const profileId = crypto.randomUUID();
  const record = encryptManagedBotToken(token, { profileId, env });
  assert.equal(record.keyVersion, "session-hkdf-v1");
  assert.equal(decryptManagedBotToken(record, { profileId, env: { ...env } }), token);
  assert.throws(() => decryptManagedBotToken(record, {
    profileId, env: { SESSION_SECRET: sessionSecret + "-rotated" }
  }), /could not be decrypted/);
  assert.throws(() => decryptManagedBotToken({ ...record, authTag: crypto.randomBytes(16).toString("base64") }, { profileId, env }), /could not be decrypted/);
  assert.deepEqual(managedBotEncryptionStatus(env), { configured: true, keyVersion: "session-hkdf-v1" });
});

test("configuration recognizes derived keys without revealing key material", () => {
  const config = validateRuntimeConfiguration({
    ...env, NVIDIA_API_KEY: "test-provider", TELEGRAM_BOT_TOKEN: "test-bot",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook", TELEGRAM_ADMIN_USER_ID: "123",
    TELEGRAM_STARS_REQUIRED: "true", DATABASE_URL: "postgresql://test.invalid/db",
    PUBLIC_URL: "https://example.test"
  });
  assert.equal(config.telegram.starSigningConfigured, true);
  assert.equal(config.botCredentialEncryptionConfigured, true);
  const serialized = JSON.stringify([config, safeConfigurationStatus(env), managedBotEncryptionStatus(env)]);
  for (const material of [sessionSecret, resolveStarSigningSecret(env), resolveBotEncryptionKey(env).toString("base64")]) {
    assert.equal(serialized.includes(material), false);
  }
  assert.equal(runtimeConfig({ SESSION_SECRET: "short" }).telegram.starSigningConfigured, false);
});

test("Stars and Secretary payloads use automatic signing and retain explicit compatibility", () => {
  const previousRoot = process.env.SESSION_SECRET;
  const previousSigning = process.env.TELEGRAM_STAR_SIGNING_SECRET;
  process.env.SESSION_SECRET = sessionSecret;
  delete process.env.TELEGRAM_STAR_SIGNING_SECRET;
  try {
    const purchase = createStarPurchasePayload({ userId: "123", amount: 5 });
    assert.equal(validateStarPurchasePayload(purchase, {
      userId: "123", currency: "XTR", totalAmount: 5
    }).valid, true);
    const secretary = createSecretaryActivationPayload({ userId: "123", connectionId: "test-connection" });
    assert.equal(validateSecretaryActivationPayload(secretary, {
      userId: "123", connectionId: "test-connection", currency: "XTR", totalAmount: 500
    }).valid, true);
    process.env.TELEGRAM_STAR_SIGNING_SECRET = "test-only-explicit-stars-secret-0123456789";
    const explicitPurchase = createStarPurchasePayload({ userId: "123", amount: 5 });
    assert.equal(validateStarPurchasePayload(explicitPurchase, {
      userId: "123", currency: "XTR", totalAmount: 5
    }).valid, true);
    const explicitSecretary = createSecretaryActivationPayload({ userId: "123", connectionId: "test-connection" });
    assert.equal(validateSecretaryActivationPayload(explicitSecretary, {
      userId: "123", connectionId: "test-connection", currency: "XTR", totalAmount: 500
    }).valid, true);
    assert.equal(validateSecretaryActivationPayload(secretary, {
      userId: "123", connectionId: "test-connection", currency: "XTR", totalAmount: 500
    }).valid, false);
    assert.equal(validateStarPurchasePayload(purchase, {
      userId: "123", currency: "XTR", totalAmount: 5
    }).valid, false);
  } finally {
    if (previousRoot === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousRoot;
    if (previousSigning === undefined) delete process.env.TELEGRAM_STAR_SIGNING_SECRET;
    else process.env.TELEGRAM_STAR_SIGNING_SECRET = previousSigning;
  }
});