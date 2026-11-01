import crypto from "node:crypto";

const DEFAULT_MAX_AGE_SECONDS = 5 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
const FUTURE_CLOCK_SKEW_SECONDS = 30;
const MAX_REPLAY_ENTRIES = 10_000;
const consumedLaunches = new Map();

function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

function sessionSigningKey(token = botToken()) {
  if (!token) return null;
  const additionalSecret = process.env.TELEGRAM_STAR_SIGNING_SECRET?.trim() || "";
  return crypto
    .createHash("sha256")
    .update("NvidBot Telegram WebApp session\0")
    .update(token)
    .update("\0")
    .update(additionalSecret)
    .digest();
}

function safeEqualHex(leftHex, rightHex) {
  if (!/^[a-f0-9]{64}$/i.test(leftHex || "") || !/^[a-f0-9]{64}$/i.test(rightHex || "")) return false;
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanupReplayCache(nowSeconds) {
  for (const [fingerprint, expiresAt] of consumedLaunches) {
    if (expiresAt <= nowSeconds) consumedLaunches.delete(fingerprint);
  }
  while (consumedLaunches.size > MAX_REPLAY_ENTRIES) {
    consumedLaunches.delete(consumedLaunches.keys().next().value);
  }
}

/**
 * Validate and consume one Telegram launch credential. The raw initData is a
 * short-lived bootstrap credential; callers should use issueSessionToken for
 * subsequent requests instead of replaying it.
 */
export function consumeTelegramWebAppInitData(initData, { now = Date.now() } = {}) {
  const token = botToken();
  if (!token || typeof initData !== "string" || !initData) return { ok: false, code: "missing" };

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { ok: false, code: "invalid" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const telegramSecret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const expectedHash = crypto.createHmac("sha256", telegramSecret).update(dataCheckString).digest("hex");
  if (!safeEqualHex(expectedHash, receivedHash)) return { ok: false, code: "invalid" };

  const nowSeconds = Math.floor(Number(now) / 1000);
  const authDateText = params.get("auth_date") || "";
  if (!/^\d{1,16}$/.test(authDateText)) return { ok: false, code: "stale" };
  const authDate = Number(authDateText);
  const maxAge = boundedEnvironmentInteger(
    "TELEGRAM_WEBAPP_MAX_AGE_SECONDS",
    DEFAULT_MAX_AGE_SECONDS,
    60,
    3600
  );
  if (!Number.isSafeInteger(authDate)
      || authDate > nowSeconds + FUTURE_CLOCK_SKEW_SECONDS
      || nowSeconds - authDate > maxAge) {
    return { ok: false, code: "stale" };
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "{}");
  } catch {
    return { ok: false, code: "invalid" };
  }
  const userId = String(user?.id ?? "");
  if (!/^[1-9]\d*$/.test(userId)) return { ok: false, code: "invalid" };

  cleanupReplayCache(nowSeconds);
  const fingerprint = crypto.createHash("sha256").update(initData).digest("hex");
  if (consumedLaunches.has(fingerprint)) return { ok: false, code: "replayed" };
  consumedLaunches.set(fingerprint, authDate + maxAge + FUTURE_CLOCK_SKEW_SECONDS);

  return {
    ok: true,
    userId,
    user,
    authDate,
    fingerprint,
    expiresAt: (authDate + maxAge + FUTURE_CLOCK_SKEW_SECONDS) * 1000
  };
}

export function issueTelegramWebAppSession({ userId, user }, { now = Date.now() } = {}) {
  const key = sessionSigningKey();
  if (!key) throw new Error("Telegram WebApp session signing is not configured");
  const issuedAt = Math.floor(Number(now) / 1000);
  const ttl = boundedEnvironmentInteger(
    "TELEGRAM_WEBAPP_SESSION_TTL_SECONDS",
    DEFAULT_SESSION_TTL_SECONDS,
    300,
    86_400
  );
  const payload = Buffer.from(JSON.stringify({
    typ: "tg_webapp",
    sub: String(userId),
    sid: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + ttl,
    user: {
      id: user?.id,
      username: user?.username,
      first_name: user?.first_name,
      last_name: user?.last_name,
      language_code: user?.language_code
    }
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyTelegramWebAppSession(token, { now = Date.now() } = {}) {
  const key = sessionSigningKey();
  if (!key || typeof token !== "string") return null;
  const [payloadText, signature, extra] = token.split(".");
  if (!payloadText || !signature || extra !== undefined) return null;
  const expected = crypto.createHmac("sha256", key).update(payloadText).digest();
  let received;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const nowSeconds = Math.floor(Number(now) / 1000);
  if (payload?.typ !== "tg_webapp"
      || !/^[1-9]\d*$/.test(String(payload?.sub || ""))
      || typeof payload?.sid !== "string"
      || !Number.isSafeInteger(payload?.iat)
      || !Number.isSafeInteger(payload?.exp)
      || payload.exp <= nowSeconds
      || payload.iat > nowSeconds + FUTURE_CLOCK_SKEW_SECONDS) {
    return null;
  }
  return { userId: String(payload.sub), sessionId: payload.sid, user: payload.user || {} };
}

export function resetTelegramWebAuthForTests() {
  consumedLaunches.clear();
}
