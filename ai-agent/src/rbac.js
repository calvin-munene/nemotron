export const PLATFORM_ROLES = Object.freeze([
  "super_admin",
  "admin",
  "moderator",
  "support",
  "premium_user",
  "standard_user",
  "restricted_user",
  "banned_user"
]);

const ROLE_PERMISSIONS = Object.freeze({
  super_admin: new Set(["*"]),
  admin: new Set([
    "admin.view", "users.view", "users.manage", "groups.view", "groups.manage",
    "billing.view", "billing.manage", "models.manage", "features.manage", "bots.manage", "logs.view", "security_events.view"
  ]),
  moderator: new Set(["groups.view", "groups.moderate", "logs.view"]),
  support: new Set(["users.view", "billing.view"]),
  premium_user: new Set([]),
  standard_user: new Set([]),
  restricted_user: new Set([]),
  banned_user: new Set([])
});

export function normalizePlatformRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!PLATFORM_ROLES.includes(role)) throw new TypeError("Unknown platform role");
  return role;
}

export function roleHasPermission(role, permission) {
  const permissions = ROLE_PERMISSIONS[normalizePlatformRole(role)];
  return permissions.has("*") || permissions.has(permission);
}

export function configuredSuperAdminId(env = process.env) {
  const value = env.TELEGRAM_ADMIN_USER_ID?.trim() || "";
  return /^[1-9]\d*$/.test(value) ? value : "";
}

export async function platformPrincipal(userId, store, env = process.env) {
  const resolvedUserId = String(userId || "");
  if (!/^[1-9]\d*$/.test(resolvedUserId)) return null;
  const role = resolvedUserId === configuredSuperAdminId(env)
    ? "super_admin"
    : await store.getUserRole(resolvedUserId);
  return { userId: resolvedUserId, role };
}

export async function authorizePlatformPermission({ userId, permission, store, env = process.env }) {
  if (!store) return { allowed: false, status: 503, error: "Platform authorization is unavailable" };
  const principal = await platformPrincipal(userId, store, env);
  if (!principal) return { allowed: false, status: 401, error: "Authentication is required" };
  if (["banned_user", "restricted_user"].includes(principal.role)) {
    return { allowed: false, status: 403, error: "This account is restricted" };
  }
  if (!roleHasPermission(principal.role, permission)) {
    return { allowed: false, status: 403, error: "You do not have permission to perform this action" };
  }
  return { allowed: true, principal };
}
