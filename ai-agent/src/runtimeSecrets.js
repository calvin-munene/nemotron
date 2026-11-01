import crypto from "node:crypto";

// Keep these identifiers stable: changing either changes the derived keys.
const SALT = "nvid-ai:runtime-secrets:hkdf-sha256:v1";

export function sessionSecretSupportsDerivation(env = process.env) {
  return Buffer.byteLength(String(env.SESSION_SECRET || ""), "utf8") >= 32;
}

function deriveKey(purpose, env) {
  if (!sessionSecretSupportsDerivation(env)) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes for automatic key derivation");
  }
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(env.SESSION_SECRET, "utf8"),
    SALT,
    purpose,
    32
  ));
}

export function resolveStarSigningSecret(env = process.env) {
  const explicit = String(env.TELEGRAM_STAR_SIGNING_SECRET || "");
  if (explicit.trim()) {
    if (Buffer.byteLength(explicit, "utf8") < 32) {
      throw new Error("TELEGRAM_STAR_SIGNING_SECRET must contain at least 32 bytes");
    }
    return explicit;
  }
  return deriveKey("telegram-stars-signing", env).toString("base64");
}

export function resolveBotEncryptionKey(env = process.env) {
  const encoded = String(env.BOT_CREDENTIAL_ENCRYPTION_KEY || "").trim();
  if (!encoded) return deriveKey("managed-bot-encryption", env);
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new Error("Managed bot credential encryption is misconfigured");
  }
  return key;
}

export function botEncryptionKeyVersion(env = process.env) {
  const fallback = String(env.BOT_CREDENTIAL_ENCRYPTION_KEY || "").trim() ? "v1" : "session-hkdf-v1";
  return String(env.BOT_CREDENTIAL_KEY_VERSION || fallback).slice(0, 64);
}