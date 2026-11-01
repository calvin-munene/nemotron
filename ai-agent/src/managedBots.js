import crypto from "node:crypto";
import { botEncryptionKeyVersion, resolveBotEncryptionKey } from "./runtimeSecrets.js";

const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{20,}$/;

function encryptionKey(env = process.env) {
  return resolveBotEncryptionKey(env);
}

function normalizedToken(value) {
  const token = String(value || "").trim();
  if (!BOT_TOKEN.test(token)) throw new TypeError("Telegram bot token format is invalid");
  return token;
}

function additionalData(profileId) {
  const value = String(profileId || "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new TypeError("botProfileId is invalid");
  return Buffer.from(`nvid-ai:managed-bot:${value}`, "utf8");
}

export function managedBotEncryptionStatus(env = process.env) {
  try {
    encryptionKey(env);
    return { configured: true, keyVersion: botEncryptionKeyVersion(env) };
  } catch {
    return { configured: false, keyVersion: null };
  }
}

export function encryptManagedBotToken(tokenValue, { profileId, env = process.env } = {}) {
  const token = normalizedToken(tokenValue);
  const key = encryptionKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData(profileId));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: botEncryptionKeyVersion(env),
    tokenFingerprint: crypto.createHash("sha256").update(token).digest("hex")
  };
}

export function decryptManagedBotToken(record, { profileId, env = process.env } = {}) {
  if (!record || typeof record !== "object") throw new TypeError("Encrypted credential is required");
  const key = encryptionKey(env);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(additionalData(profileId));
    decipher.setAuthTag(Buffer.from(record.authTag || record.auth_tag, "base64"));
    const token = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
    return normalizedToken(token);
  } catch (cause) {
    throw new Error("Managed bot credential could not be decrypted", { cause });
  }
}

export async function testManagedBotConnection(tokenValue, { timeoutMs = 10_000 } = {}) {
  const token = normalizedToken(tokenValue);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    return { connected: false, errorCode: "telegram_unreachable" };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return { connected: false, errorCode: "telegram_invalid_response" };
  }
  if (!response.ok || data?.ok !== true || data?.result?.is_bot !== true) {
    return { connected: false, errorCode: response.status === 401 ? "invalid_bot_token" : "telegram_rejected" };
  }
  return {
    connected: true,
    bot: {
      id: String(data.result.id),
      username: data.result.username || null,
      firstName: data.result.first_name || null
    }
  };
}
