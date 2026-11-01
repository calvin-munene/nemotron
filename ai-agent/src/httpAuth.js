import { verifyTelegramWebAppSession } from "./telegramWebAuth.js";
import { authorizePlatformPermission } from "./rbac.js";

export function bearerToken(req) {
  const value = req?.headers?.authorization;
  const match = typeof value === "string" ? value.match(/^Bearer\s+([^\s]+)$/i) : null;
  return match?.[1] || "";
}

export function authenticatedTelegramSession(req) {
  return verifyTelegramWebAppSession(bearerToken(req));
}

export function mutationOriginAllowed(req, expectedOrigin) {
  const origin = typeof req?.headers?.origin === "string" ? req.headers.origin : "";
  const fetchSite = typeof req?.headers?.["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"] : "";
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;
  if (!origin) return true;
  return Boolean(expectedOrigin && origin === expectedOrigin);
}

export async function authorizeHttpRequest(req, { permission, store, expectedOrigin, mutation = false } = {}) {
  const session = authenticatedTelegramSession(req);
  if (!session) return { allowed: false, status: 401, error: "Fresh Telegram authentication is required" };
  if (mutation && !mutationOriginAllowed(req, expectedOrigin)) {
    return { allowed: false, status: 403, error: "The request origin is not allowed" };
  }
  const authorization = await authorizePlatformPermission({ userId: session.userId, permission, store });
  return authorization.allowed ? { ...authorization, session } : authorization;
}
