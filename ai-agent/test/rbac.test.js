import test from "node:test";
import assert from "node:assert/strict";
import { authorizePlatformPermission, roleHasPermission } from "../src/rbac.js";

test("RBAC grants only declared permissions and preserves configured super admin access", async () => {
  assert.equal(roleHasPermission("admin", "features.manage"), true);
  assert.equal(roleHasPermission("support", "features.manage"), false);
  const store = { async getUserRole() { return "standard_user"; } };
  const superAdmin = await authorizePlatformPermission({
    userId: "42",
    permission: "features.manage",
    store,
    env: { TELEGRAM_ADMIN_USER_ID: "42" }
  });
  assert.equal(superAdmin.allowed, true);
  assert.equal(superAdmin.principal.role, "super_admin");
});

test("RBAC denies restricted roles and unavailable authorization stores", async () => {
  const restricted = await authorizePlatformPermission({
    userId: "42",
    permission: "admin.view",
    store: { async getUserRole() { return "restricted_user"; } },
    env: {}
  });
  assert.equal(restricted.status, 403);
  assert.equal((await authorizePlatformPermission({ userId: "42", permission: "admin.view", store: null })).status, 503);
});
