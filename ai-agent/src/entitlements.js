import { normalizePlatformRole } from "./rbac.js";

export function aiEntitlement({ userId, userControl = {}, platformRole = "standard_user", env = process.env } = {}) {
  const normalizedUserId = String(userId || "");
  const primaryAdministrator = String(env.TELEGRAM_ADMIN_USER_ID || "").trim();
  const role = normalizePlatformRole(platformRole);
  const source = primaryAdministrator && normalizedUserId === primaryAdministrator
    ? "primary_administrator"
    : userControl?.unlimitedCredits === true
      ? "explicit_user_grant"
      : null;
  return {
    unlimited: Boolean(source),
    source,
    role,
    eligibleForFuturePlanEntitlement: ["super_admin", "admin", "premium_user"].includes(role)
  };
}
