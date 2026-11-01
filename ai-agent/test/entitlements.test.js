import test from "node:test";
import assert from "node:assert/strict";
import { aiEntitlement } from "../src/entitlements.js";

test("AI entitlement centralizes primary administrator and explicit unlimited grants", () => {
  const env = { TELEGRAM_ADMIN_USER_ID: "6643462826" };
  assert.deepEqual(
    aiEntitlement({ userId: "6643462826", platformRole: "super_admin", env }).source,
    "primary_administrator"
  );
  assert.equal(aiEntitlement({
    userId: "123",
    platformRole: "standard_user",
    userControl: { unlimitedCredits: true },
    env
  }).unlimited, true);
  assert.equal(aiEntitlement({ userId: "124", platformRole: "admin", env }).unlimited, false);
  assert.equal(aiEntitlement({ userId: "125", platformRole: "standard_user", env }).unlimited, false);
});
