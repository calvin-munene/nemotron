import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEGRAM_OIDC_ISSUER,
  beginTelegramOidcLogin,
  completeTelegramOidcLogin,
  resetTelegramOidcCacheForTests,
  validateTelegramIdToken
} from "../src/telegramOidc.js";

const env = {
  TELEGRAM_OIDC_CLIENT_ID: "123456789",
  TELEGRAM_OIDC_CLIENT_SECRET: "test-telegram-oidc-secret-that-is-long-enough",
  TELEGRAM_OIDC_REDIRECT_URI: "https://nvidbot.onrender.com/auth/telegram/callback"
};

function jwt(privateKey, claims, kid = "telegram-key-1") {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

test("Telegram website login uses durable state, PKCE, nonce, signed identity, and one-time code handling", async () => {
  resetTelegramOidcCacheForTests();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, { kid: "telegram-key-1", use: "sig", alg: "RS256" });
  let request = null;
  let used = false;
  const store = {
    async createWebLoginRequest(value) {
      request = {
        state_hash: value.stateHash,
        nonce: value.nonce,
        code_verifier_ciphertext: value.codeVerifierCiphertext,
        redirect_uri: value.redirectUri,
        return_to: value.returnTo
      };
    },
    async consumeWebLoginRequest(stateHash) {
      if (used || stateHash !== request.state_hash) return null;
      used = true;
      return request;
    }
  };
  const started = await beginTelegramOidcLogin({ store, returnTo: "/home", env, now: 1_800_000_000_000 });
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  const state = authorization.searchParams.get("state");
  const nowSeconds = 1_800_000_100;
  const idToken = jwt(privateKey, {
    iss: TELEGRAM_OIDC_ISSUER,
    aud: env.TELEGRAM_OIDC_CLIENT_ID,
    sub: "987654321",
    nonce: request.nonce,
    iat: nowSeconds - 5,
    exp: nowSeconds + 300,
    preferred_username: "verified_user"
  });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/token")) {
      assert.match(String(options.body), /code_verifier=/);
      assert.match(String(options.headers.authorization), /^Basic /);
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const completed = await completeTelegramOidcLogin({ state, code: "one-time-code", store, env, fetchImpl, now: nowSeconds * 1000 });
  assert.equal(completed.userId, "987654321");
  assert.equal(completed.user.username, "verified_user");
  await assert.rejects(completeTelegramOidcLogin({ state, code: "replayed-code", store, env, fetchImpl, now: nowSeconds * 1000 }), /already used|state is invalid/i);
});

test("Telegram OIDC rejects the wrong audience even with a valid Telegram signature", async () => {
  resetTelegramOidcCacheForTests();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "telegram-key-1", use: "sig", alg: "RS256" };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = jwt(privateKey, { iss: TELEGRAM_OIDC_ISSUER, aud: "another-client", sub: "1", nonce: "nonce", iat: nowSeconds, exp: nowSeconds + 300 });
  await assert.rejects(validateTelegramIdToken(token, {
    nonce: "nonce",
    env,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } })
  }), /issuer or audience/i);
});
