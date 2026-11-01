import crypto from "node:crypto";

export const TELEGRAM_OIDC_ISSUER = "https://oauth.telegram.org";
export const TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/auth`;
export const TELEGRAM_OIDC_TOKEN_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/token`;
export const TELEGRAM_OIDC_JWKS_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/.well-known/jwks.json`;

let cachedJwks = null;
let cachedJwksAt = 0;

function config(env = process.env) {
  const clientId = String(env.TELEGRAM_OIDC_CLIENT_ID || "").trim();
  const clientSecret = String(env.TELEGRAM_OIDC_CLIENT_SECRET || "").trim();
  const redirectUri = String(env.TELEGRAM_OIDC_REDIRECT_URI || "").trim();
  if (!clientId || !clientSecret || !redirectUri) throw Object.assign(new Error("Telegram website login is not configured"), { statusCode: 503 });
  if (!/^[1-9]\d*$/.test(clientId)) throw new Error("TELEGRAM_OIDC_CLIENT_ID is invalid");
  if (clientSecret.length < 16) throw new Error("TELEGRAM_OIDC_CLIENT_SECRET is invalid");
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash) throw new Error("TELEGRAM_OIDC_REDIRECT_URI must be an HTTPS URL");
  return { clientId, clientSecret, redirectUri: redirect.toString() };
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function verifierKey(clientSecret) {
  return crypto.createHash("sha256").update("Nvid AI Telegram OIDC PKCE\0").update(clientSecret).digest();
}

function encryptVerifier(verifier, clientSecret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", verifierKey(clientSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(verifier, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptVerifier(value, clientSecret) {
  const [ivText, tagText, bodyText, extra] = String(value || "").split(".");
  if (!ivText || !tagText || !bodyText || extra !== undefined) throw new Error("Stored PKCE verifier is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", verifierKey(clientSecret), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
}

function safeReturnTo(value) {
  const path = String(value || "/");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/.test(path)) return "/";
  return path.slice(0, 1000);
}

export async function beginTelegramOidcLogin({ store, returnTo = "/", sourceHash = null, env = process.env, now = Date.now() } = {}) {
  if (!store?.createWebLoginRequest) throw Object.assign(new Error("Website login storage is unavailable"), { statusCode: 503 });
  const settings = config(env);
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const expiresAt = new Date(Number(now) + 10 * 60_000);
  await store.createWebLoginRequest({
    stateHash: hash(state),
    nonce,
    codeVerifierCiphertext: encryptVerifier(codeVerifier, settings.clientSecret),
    redirectUri: settings.redirectUri,
    returnTo: safeReturnTo(returnTo),
    sourceHash,
    expiresAt
  });
  const url = new URL(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: "code",
    scope: "openid profile",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  }).toString();
  return { authorizationUrl: url.toString(), expiresAt };
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function telegramJwks(fetchImpl, now) {
  if (cachedJwks && Number(now) - cachedJwksAt < 60 * 60_000) return cachedJwks;
  const response = await fetchImpl(TELEGRAM_OIDC_JWKS_ENDPOINT, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw Object.assign(new Error("Telegram login keys are temporarily unavailable"), { statusCode: 503 });
  const body = await response.json();
  if (!Array.isArray(body?.keys)) throw new Error("Telegram JWKS response is invalid");
  cachedJwks = body.keys;
  cachedJwksAt = Number(now);
  return cachedJwks;
}

export async function validateTelegramIdToken(idToken, { nonce, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const settings = config(env);
  const [headerText, payloadText, signatureText, extra] = String(idToken || "").split(".");
  if (!headerText || !payloadText || !signatureText || extra !== undefined) throw Object.assign(new Error("Telegram returned an invalid identity token"), { statusCode: 401 });
  let header;
  let claims;
  try { header = decodeJson(headerText); claims = decodeJson(payloadText); } catch { throw Object.assign(new Error("Telegram returned an invalid identity token"), { statusCode: 401 }); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw Object.assign(new Error("Telegram identity token algorithm is not allowed"), { statusCode: 401 });
  const keys = await telegramJwks(fetchImpl, now);
  const jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && (!candidate.use || candidate.use === "sig"));
  if (!jwk) throw Object.assign(new Error("Telegram identity signing key was not found"), { statusCode: 401 });
  const validSignature = crypto.verify("RSA-SHA256", Buffer.from(`${headerText}.${payloadText}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signatureText, "base64url"));
  if (!validSignature) throw Object.assign(new Error("Telegram identity signature is invalid"), { statusCode: 401 });
  const nowSeconds = Math.floor(Number(now) / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || "")];
  if (claims.iss !== TELEGRAM_OIDC_ISSUER || !audiences.includes(settings.clientId)) throw Object.assign(new Error("Telegram identity issuer or audience is invalid"), { statusCode: 401 });
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds || !Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds + 30) throw Object.assign(new Error("Telegram identity token has expired"), { statusCode: 401 });
  if (typeof nonce !== "string" || claims.nonce !== nonce) throw Object.assign(new Error("Telegram login nonce is invalid"), { statusCode: 401 });
  const userId = String(claims.sub || claims.id || "");
  if (!/^[1-9]\d*$/.test(userId)) throw Object.assign(new Error("Telegram identity is invalid"), { statusCode: 401 });
  return {
    userId,
    user: {
      id: userId,
      username: claims.preferred_username || null,
      first_name: claims.given_name || null,
      last_name: claims.family_name || null,
      language_code: claims.locale || null
    },
    claims: { iss: claims.iss, aud: claims.aud, sub: userId, iat: claims.iat, exp: claims.exp }
  };
}

export async function completeTelegramOidcLogin({ state, code, store, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!store?.consumeWebLoginRequest) throw Object.assign(new Error("Website login storage is unavailable"), { statusCode: 503 });
  const settings = config(env);
  const stateValue = String(state || "");
  const codeValue = String(code || "");
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(stateValue) || !codeValue || codeValue.length > 4096) throw Object.assign(new Error("Telegram login callback is invalid"), { statusCode: 400 });
  const request = await store.consumeWebLoginRequest(hash(stateValue));
  if (!request) throw Object.assign(new Error("Telegram login state is invalid, expired, or already used"), { statusCode: 401 });
  if (request.redirect_uri !== settings.redirectUri) throw Object.assign(new Error("Telegram login redirect is not registered"), { statusCode: 401 });
  const verifier = decryptVerifier(request.code_verifier_ciphertext, settings.clientSecret);
  const response = await fetchImpl(TELEGRAM_OIDC_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: codeValue,
      redirect_uri: settings.redirectUri,
      client_id: settings.clientId,
      code_verifier: verifier
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw Object.assign(new Error("Telegram login code was rejected or already used"), { statusCode: 401 });
  const tokens = await response.json();
  const identity = await validateTelegramIdToken(tokens.id_token, { nonce: request.nonce, env, fetchImpl, now });
  return { ...identity, returnTo: safeReturnTo(request.return_to) };
}

export function telegramOidcConfigured(env = process.env) {
  try { config(env); return true; } catch { return false; }
}

export function resetTelegramOidcCacheForTests() {
  cachedJwks = null;
  cachedJwksAt = 0;
}
