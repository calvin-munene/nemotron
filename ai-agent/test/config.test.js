import test from "node:test";
import assert from "node:assert/strict";
import { ConfigurationError, runtimeConfig, safeConfigurationStatus, validateRuntimeConfiguration } from "../src/config.js";

test("runtime configuration exposes safe typed settings without secret values", () => {
  const env = {
    NODE_ENV: "production",
    PORT: "8080",
    PUBLIC_URL: "https://nvidbot.onrender.com",
    NVIDIA_API_KEY: "provider-secret-value",
    TELEGRAM_BOT_TOKEN: "bot-secret-value",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
    DATABASE_URL: "postgresql://user:password@example.test/db"
  };
  const config = runtimeConfig(env);
  assert.equal(config.port, 8080);
  assert.equal(config.publicOrigin, "https://nvidbot.onrender.com");
  assert.equal(config.nvidia.configured, true);
  assert.equal(config.telegram.configured, true);
  assert.equal(config.database.configured, true);
  assert.doesNotMatch(JSON.stringify(config), /provider-secret-value|bot-secret-value|password/);
});

test("production dependencies are validated as a consistent set", () => {
  assert.throws(
    () => validateRuntimeConfiguration({ TELEGRAM_BOT_TOKEN: "configured" }),
    (error) => error instanceof ConfigurationError
      && error.problems.includes("NVIDIA_API_KEY is required")
      && error.problems.includes("TELEGRAM_WEBHOOK_SECRET is required when Telegram is enabled")
  );

  const config = validateRuntimeConfiguration({
    NVIDIA_API_KEY: "configured",
    TELEGRAM_BOT_TOKEN: "configured",
    TELEGRAM_WEBHOOK_SECRET: "configured",
    PUBLIC_URL: "https://nvidbot.onrender.com"
  });
  assert.equal(config.telegram.configured, true);
});

test("safe configuration status reports only presence and deployment metadata", () => {
  const status = safeConfigurationStatus({
    NODE_ENV: "production",
    DEPLOYMENT_VERSION: "abc123",
    NVIDIA_API_KEY: "secret",
    TELEGRAM_STAR_SIGNING_SECRET: "another-secret"
  });
  assert.deepEqual(status, {
    environment: "production",
    deploymentVersion: "abc123",
    nvidiaConfigured: true,
    telegramConfigured: false,
    telegramWebhookConfigured: false,
    telegramStarsRequired: false,
    telegramStarSigningConfigured: true,
    telegramOidcConfigured: false,
    databaseConfigured: false,
    whatsappConfigured: false,
    botCredentialEncryptionConfigured: false
  });
});
