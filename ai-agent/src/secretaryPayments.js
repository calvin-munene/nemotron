import crypto from "node:crypto";
import { resolveStarSigningSecret } from "./runtimeSecrets.js";

export const SECRETARY_PRODUCT_ID = "secretary_lifetime_activation";
export const SECRETARY_ACTIVATION_STARS = 500;
export const SECRETARY_ENTITLEMENT_VERSION = 1;
const TTL_SECONDS = 7 * 24 * 60 * 60;

function secret(value) {
  if (value === undefined) return resolveStarSigningSecret();
  const resolved = String(value || "");
  if (Buffer.byteLength(resolved) < 32) throw new Error("Telegram Stars signing is not configured");
  return resolved;
}

function signature(body, value) {
  return crypto.createHmac("sha256", secret(value)).update(`secretary\0${body}`).digest("base64url").slice(0, 22);
}

function fingerprint(connectionId) {
  const value = String(connectionId || "");
  if (!value || value.length > 256) throw new TypeError("connectionId is invalid");
  return crypto.createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

function base36(value) {
  let parsed = 0n;
  for (const character of String(value)) {
    const digit = parseInt(character, 36);
    if (!Number.isInteger(digit) || digit < 0 || digit > 35) throw new Error("invalid base36");
    parsed = parsed * 36n + BigInt(digit);
  }
  return parsed;
}

export function createSecretaryActivationPayload({ userId, connectionId, secret: signingKey, now = Date.now(), nonce } = {}) {
  const owner = BigInt(String(userId || "0"));
  if (owner <= 0n) throw new TypeError("userId is invalid");
  const expiresAt = Math.floor(Number(now) / 1000) + TTL_SECONDS;
  const paymentNonce = nonce || crypto.randomBytes(9).toString("base64url");
  if (!/^[A-Za-z0-9_-]{12}$/.test(paymentNonce)) throw new TypeError("nonce is invalid");
  const body = [
    "sa1",
    owner.toString(36),
    SECRETARY_ENTITLEMENT_VERSION.toString(36),
    fingerprint(connectionId),
    expiresAt.toString(36),
    paymentNonce
  ].join(".");
  return `${body}.${signature(body, signingKey)}`;
}

export function validateSecretaryActivationPayload(payload, {
  userId,
  connectionId,
  currency,
  totalAmount,
  secret: signingKey,
  now = Date.now(),
  allowExpired = false
} = {}) {
  const match = String(payload || "").match(/^sa1\.([0-9a-z]+)\.([0-9a-z]+)\.([A-Za-z0-9_-]{16})\.([0-9a-z]+)\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{22})$/);
  if (!match) return { valid: false, error: "This Secretary activation request is invalid." };
  const body = match[0].split(".").slice(0, -1).join(".");
  let expected;
  try { expected = signature(body, signingKey); } catch { return { valid: false, error: "Secretary payments are temporarily unavailable." }; }
  const received = Buffer.from(match[6]);
  const expectedBuffer = Buffer.from(expected);
  if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) {
    return { valid: false, error: "This Secretary activation request is invalid." };
  }
  let owner;
  let version;
  let expiresAt;
  try {
    owner = base36(match[1]).toString();
    version = Number(base36(match[2]));
    expiresAt = Number(base36(match[4]));
  } catch {
    return { valid: false, error: "This Secretary activation request is invalid." };
  }
  if (version !== SECRETARY_ENTITLEMENT_VERSION) return { valid: false, error: "This Secretary activation version is no longer supported." };
  if (userId !== undefined && String(userId) !== owner) return { valid: false, error: "This invoice belongs to another Telegram account." };
  if (connectionId !== undefined && fingerprint(connectionId) !== match[3]) return { valid: false, error: "This invoice belongs to another business connection." };
  if (currency !== undefined && currency !== "XTR") return { valid: false, error: "This invoice must be paid with Telegram Stars." };
  if (totalAmount !== undefined && Number(totalAmount) !== SECRETARY_ACTIVATION_STARS) return { valid: false, error: "The Secretary activation price is 500 Telegram Stars." };
  if (!allowExpired && expiresAt < Math.floor(Number(now) / 1000)) return { valid: false, error: "This Secretary activation request expired. Create a new invoice." };
  return {
    valid: true,
    purchase: {
      productId: SECRETARY_PRODUCT_ID,
      version,
      userId: owner,
      connectionFingerprint: match[3],
      amount: SECRETARY_ACTIVATION_STARS,
      expiresAt,
      nonce: match[5],
      payload: String(payload)
    }
  };
}

export function secretaryConnectionFingerprint(connectionId) {
  return fingerprint(connectionId);
}
