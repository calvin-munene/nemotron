import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  consumeTelegramWebAppInitData,
  issueTelegramWebAppSession,
  resetTelegramWebAuthForTests,
  verifyTelegramWebAppSession
} from "../src/telegramWebAuth.js";

const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalSigningSecret = process.env.TELEGRAM_STAR_SIGNING_SECRET;

function signedInitData({ authDate, userId = 123, token = "123:test-token" }) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAE-test-query",
    user: JSON.stringify({ id: userId, first_name: "Ada", username: "ada" })
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test.beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_STAR_SIGNING_SECRET = "test-session-signing-secret";
  resetTelegramWebAuthForTests();
});

test.after(() => {
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalSigningSecret === undefined) delete process.env.TELEGRAM_STAR_SIGNING_SECRET;
  else process.env.TELEGRAM_STAR_SIGNING_SECRET = originalSigningSecret;
  resetTelegramWebAuthForTests();
});

test("accepts a fresh authentic launch once and issues a bounded session", () => {
  const now = 1_800_000_000_000;
  const launch = consumeTelegramWebAppInitData(signedInitData({ authDate: now / 1000 }), { now });
  assert.equal(launch.ok, true);
  assert.equal(launch.userId, "123");

  const sessionToken = issueTelegramWebAppSession(launch, { now });
  const session = verifyTelegramWebAppSession(sessionToken, { now: now + 1_000 });
  assert.equal(session.userId, "123");
  assert.match(session.sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(verifyTelegramWebAppSession(sessionToken, { now: now + 3_700_000 }), null);
});

test("rejects replayed, stale, future, and forged Telegram launch data", () => {
  const now = 1_800_000_000_000;
  const fresh = signedInitData({ authDate: now / 1000 });
  assert.equal(consumeTelegramWebAppInitData(fresh, { now }).ok, true);
  assert.equal(consumeTelegramWebAppInitData(fresh, { now }).code, "replayed");

  const stale = signedInitData({ authDate: now / 1000 - 301 });
  assert.equal(consumeTelegramWebAppInitData(stale, { now }).code, "stale");
  const future = signedInitData({ authDate: now / 1000 + 31 });
  assert.equal(consumeTelegramWebAppInitData(future, { now }).code, "stale");
  const forged = `${signedInitData({ authDate: now / 1000, userId: 456 })}x`;
  assert.equal(consumeTelegramWebAppInitData(forged, { now }).code, "invalid");
});
