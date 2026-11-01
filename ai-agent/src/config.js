import { resolveStarSigningSecret, sessionSecretSupportsDerivation } from "./runtimeSecrets.js";

const TRUE_VALUES = /^(1|true|yes|on)$/i;

function stringValue(env, name, fallback = "") {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function integerValue(env, name, fallback, { minimum, maximum }) {
  const value = Number(stringValue(env, name, String(fallback)));
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function booleanValue(env, name, fallback = false) {
  const value = stringValue(env, name);
  return value ? TRUE_VALUES.test(value) : fallback;
}

function validHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

function configured(env, name) {
  return Boolean(stringValue(env, name));
}

export function runtimeConfig(env = process.env) {
  const publicUrl = stringValue(env, "PUBLIC_URL", stringValue(env, "RENDER_EXTERNAL_URL"));
  return Object.freeze({
    environment: stringValue(env, "NODE_ENV", "development"),
    port: integerValue(env, "PORT", 3000, { minimum: 1, maximum: 65_535 }),
    logLevel: stringValue(env, "LOG_LEVEL", "info").toLowerCase(),
    deploymentVersion: stringValue(env, "RENDER_GIT_COMMIT", stringValue(env, "DEPLOYMENT_VERSION", "development")),
    publicUrl,
    publicOrigin: validHttpsOrigin(publicUrl) ? new URL(publicUrl).origin : "",
    nvidia: Object.freeze({
      configured: configured(env, "NVIDIA_API_KEY"),
      baseUrl: stringValue(env, "NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
      defaultModel: stringValue(env, "NVIDIA_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b"),
      hourlyRequestLimit: integerValue(env, "NVIDIA_GLOBAL_REQUESTS_PER_HOUR", 300, { minimum: 10, maximum: 1_000_000 }),
      maxConcurrentRequests: integerValue(env, "NVIDIA_MAX_CONCURRENT_REQUESTS", 4, { minimum: 1, maximum: 100 }),
      circuitFailureThreshold: integerValue(env, "NVIDIA_CIRCUIT_FAILURE_THRESHOLD", 5, { minimum: 2, maximum: 50 }),
      circuitCooldownSeconds: integerValue(env, "NVIDIA_CIRCUIT_COOLDOWN_SECONDS", 60, { minimum: 10, maximum: 900 })
    }),
    telegram: Object.freeze({
      configured: configured(env, "TELEGRAM_BOT_TOKEN"),
      webhookConfigured: configured(env, "TELEGRAM_WEBHOOK_SECRET"),
      adminConfigured: configured(env, "TELEGRAM_ADMIN_USER_ID"),
      starsRequired: booleanValue(env, "TELEGRAM_STARS_REQUIRED", false),
      paymentsEnabled: booleanValue(env, "TELEGRAM_PAYMENTS_ENABLED", false) || booleanValue(env, "TELEGRAM_STARS_REQUIRED", false),
      starSigningConfigured: configured(env, "TELEGRAM_STAR_SIGNING_SECRET") || sessionSecretSupportsDerivation(env),
      webAppMaxAgeSeconds: integerValue(env, "TELEGRAM_WEBAPP_MAX_AGE_SECONDS", 300, { minimum: 60, maximum: 3600 }),
      webAppSessionTtlSeconds: integerValue(env, "TELEGRAM_WEBAPP_SESSION_TTL_SECONDS", 3600, { minimum: 300, maximum: 86_400 }),
      oidcClientConfigured: configured(env, "TELEGRAM_OIDC_CLIENT_ID"),
      oidcSecretConfigured: configured(env, "TELEGRAM_OIDC_CLIENT_SECRET"),
      oidcRedirectConfigured: configured(env, "TELEGRAM_OIDC_REDIRECT_URI"),
      webSessionIdleSeconds: integerValue(env, "WEB_SESSION_IDLE_SECONDS", 1800, { minimum: 300, maximum: 86_400 }),
      webSessionAbsoluteSeconds: integerValue(env, "WEB_SESSION_ABSOLUTE_SECONDS", 43_200, { minimum: 900, maximum: 604_800 })
    }),
    database: Object.freeze({ configured: configured(env, "DATABASE_URL") }),
    whatsapp: Object.freeze({
      accessTokenConfigured: configured(env, "WHATSAPP_ACCESS_TOKEN"),
      phoneNumberConfigured: configured(env, "WHATSAPP_PHONE_NUMBER_ID"),
      verifyTokenConfigured: configured(env, "WHATSAPP_VERIFY_TOKEN"),
      appSecretConfigured: configured(env, "META_APP_SECRET")
    }),
    botCredentialEncryptionConfigured: configured(env, "BOT_CREDENTIAL_ENCRYPTION_KEY") || sessionSecretSupportsDerivation(env)
  });
}

export class ConfigurationError extends Error {
  constructor(problems) {
    super(`Invalid application configuration: ${problems.join("; ")}`);
    this.name = "ConfigurationError";
    this.problems = [...problems];
  }
}

export function validateRuntimeConfiguration(env = process.env, { requireNvidia = true } = {}) {
  const config = runtimeConfig(env);
  const problems = [];
  if (!["debug", "info", "warn", "error"].includes(config.logLevel)) problems.push("LOG_LEVEL must be debug, info, warn, or error");
  if (requireNvidia && !config.nvidia.configured) problems.push("NVIDIA_API_KEY is required");
  if (config.publicUrl && !validHttpsOrigin(config.publicUrl)) problems.push("PUBLIC_URL must be an HTTPS origin without credentials or a path");

  if (config.telegram.configured) {
    if (!config.telegram.webhookConfigured) problems.push("TELEGRAM_WEBHOOK_SECRET is required when Telegram is enabled");
    if (!config.publicOrigin) problems.push("PUBLIC_URL is required when Telegram is enabled");
  }
  if (config.telegram.paymentsEnabled) {
    if (!config.telegram.configured) problems.push("TELEGRAM_BOT_TOKEN is required when Telegram Stars are enabled");
    if (!config.telegram.adminConfigured) problems.push("TELEGRAM_ADMIN_USER_ID is required when Telegram Stars are enabled");
    try {
      resolveStarSigningSecret(env);
    } catch (error) {
      problems.push(error.message);
    }
    if (!config.database.configured) problems.push("DATABASE_URL is required when Telegram Stars are enabled");
  }
  const oidcConfigured = [config.telegram.oidcClientConfigured, config.telegram.oidcSecretConfigured, config.telegram.oidcRedirectConfigured];
  if (oidcConfigured.some(Boolean) && !oidcConfigured.every(Boolean)) {
    problems.push("TELEGRAM_OIDC_CLIENT_ID, TELEGRAM_OIDC_CLIENT_SECRET, and TELEGRAM_OIDC_REDIRECT_URI must be configured together");
  }
  if (config.telegram.oidcSecretConfigured && stringValue(env, "TELEGRAM_OIDC_CLIENT_SECRET").length < 16) {
    problems.push("TELEGRAM_OIDC_CLIENT_SECRET must be at least 16 characters");
  }
  if (config.telegram.oidcRedirectConfigured) {
    try {
      const redirect = new URL(stringValue(env, "TELEGRAM_OIDC_REDIRECT_URI"));
      if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash) problems.push("TELEGRAM_OIDC_REDIRECT_URI must be an HTTPS URL");
    } catch {
      problems.push("TELEGRAM_OIDC_REDIRECT_URI must be a valid URL");
    }
  }

  if (problems.length) throw new ConfigurationError(problems);
  return config;
}

export function safeConfigurationStatus(env = process.env) {
  const config = runtimeConfig(env);
  return {
    environment: config.environment,
    deploymentVersion: config.deploymentVersion,
    nvidiaConfigured: config.nvidia.configured,
    telegramConfigured: config.telegram.configured,
    telegramWebhookConfigured: config.telegram.webhookConfigured,
    telegramStarsRequired: config.telegram.starsRequired,
    telegramStarSigningConfigured: config.telegram.starSigningConfigured,
    telegramOidcConfigured: config.telegram.oidcClientConfigured && config.telegram.oidcSecretConfigured && config.telegram.oidcRedirectConfigured,
    databaseConfigured: config.database.configured,
    whatsappConfigured: Object.values(config.whatsapp).every(Boolean),
    botCredentialEncryptionConfigured: config.botCredentialEncryptionConfigured
  };
}
