import crypto from "node:crypto";
import { resolveStarSigningSecret } from "./runtimeSecrets.js";

export const STAR_TERMS_VERSION = "2026-07-14";
export const MIN_STAR_TOPUP = 1;
export const MAX_STAR_TOPUP = 10_000;
const PURCHASE_TTL_SECONDS = 7 * 24 * 60 * 60;

function signingSecret(value) {
  if (value === undefined) return resolveStarSigningSecret();
  const secret = String(value || "");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("TELEGRAM_STAR_SIGNING_SECRET must contain at least 32 bytes");
  }
  return secret;
}

function parseBase36(value) {
  let result = 0n;
  for (const character of value) {
    const digit = BigInt(parseInt(character, 36));
    if (digit < 0n || digit > 35n) throw new Error("Invalid base36 value");
    result = result * 36n + digit;
  }
  return result;
}

function topupAmount(value) {
  const text = typeof value === "number" ? String(value) : String(value || "").trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const amount = Number(text);
  return Number.isSafeInteger(amount) && amount >= MIN_STAR_TOPUP && amount <= MAX_STAR_TOPUP
    ? amount
    : null;
}

export function parseStarTopupAmount(value) {
  return topupAmount(value);
}

function purchaseSignature(body, secret) {
  return crypto.createHmac("sha256", signingSecret(secret)).update(body).digest("base64url").slice(0, 22);
}

export function createStarPurchasePayload({ userId, amount, secret, now = Date.now(), nonce } = {}) {
  const normalizedAmount = topupAmount(amount);
  if (!normalizedAmount) throw new Error(`Star top-up must be ${MIN_STAR_TOPUP}-${MAX_STAR_TOPUP}`);

  let normalizedUserId;
  try {
    normalizedUserId = BigInt(String(userId));
  } catch {
    throw new Error("A valid Telegram user ID is required");
  }
  if (normalizedUserId <= 0n) throw new Error("A valid Telegram user ID is required");

  const issuedAt = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("A valid issue time is required");
  const expiresAt = issuedAt + PURCHASE_TTL_SECONDS;
  const purchaseNonce = nonce || crypto.randomBytes(6).toString("base64url");
  if (!/^[A-Za-z0-9_-]{8}$/.test(purchaseNonce)) throw new Error("The purchase nonce is invalid");

  const body = [
    "s1",
    normalizedUserId.toString(36),
    normalizedAmount.toString(36),
    expiresAt.toString(36),
    purchaseNonce
  ].join(".");
  return `${body}.${purchaseSignature(body, secret)}`;
}

export function validateStarPurchasePayload(payload, {
  secret,
  userId,
  currency,
  totalAmount,
  now = Date.now(),
  allowExpired = false
} = {}) {
  const match = String(payload || "").match(
    /^s1\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-z]+)\.([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]{22})$/
  );
  if (!match) return { valid: false, error: "This purchase request is invalid." };

  const body = ["s1", ...match.slice(1, 5)].join(".");
  let expected;
  try {
    expected = purchaseSignature(body, secret);
  } catch {
    return { valid: false, error: "Star payments are temporarily unavailable." };
  }
  const actualBuffer = Buffer.from(match[5]);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { valid: false, error: "This purchase request is invalid." };
  }

  let payloadUserId;
  let amount;
  let expiresAt;
  try {
    payloadUserId = parseBase36(match[1]).toString();
    amount = Number(parseBase36(match[2]));
    expiresAt = Number(parseBase36(match[3]));
  } catch {
    return { valid: false, error: "This purchase request is invalid." };
  }

  if (!topupAmount(amount)) return { valid: false, error: "The Star amount is invalid." };
  if (userId !== undefined && String(userId) !== payloadUserId) {
    return { valid: false, error: "This invoice belongs to a different Telegram user." };
  }
  if (currency !== undefined && currency !== "XTR") {
    return { valid: false, error: "This invoice must be paid with Telegram Stars." };
  }
  if (totalAmount !== undefined && Number(totalAmount) !== amount) {
    return { valid: false, error: "The invoice amount no longer matches this purchase." };
  }
  const nowSeconds = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(expiresAt) || (!allowExpired && expiresAt < nowSeconds)) {
    return { valid: false, error: "This purchase request expired. Run /topup again." };
  }

  return {
    valid: true,
    purchase: {
      userId: payloadUserId,
      amount,
      expiresAt,
      nonce: match[4],
      payload: String(payload)
    }
  };
}

export function telegramStarTerms(adminUserId = process.env.TELEGRAM_ADMIN_USER_ID, aiChatCreditCost = 1) {
  const promptCost = Number.isSafeInteger(aiChatCreditCost) && aiChatCreditCost >= 1 ? aiChatCreditCost : 1;
  return [
    `Nemotron Telegram Stars Terms (version ${STAR_TERMS_VERSION})`,
    "",
    "- One Telegram Star purchases one Nemotron AI-message credit.",
    `- Each accepted non-command AI prompt currently uses ${promptCost} credit${promptCost === 1 ? "" : "s"}. Bot commands are free.`,
    "- If NVIDIA generation or final Telegram delivery fails, the reserved credit is restored.",
    "- Credits are tied to the purchasing Telegram account and cannot be transferred.",
    "- Use /balance to view credits and /paysupport for payment help.",
    "- Refund requests are reviewed for unused credits and handled under Telegram's payment rules.",
    "",
    `Payment support administrator ID: ${adminUserId || "not configured"}.`,
    "Telegram support cannot resolve purchases made from this bot.",
    "",
    "Selecting the purchase confirmation button and paying the invoice confirms that you accept these terms."
  ].join("\n");
}
