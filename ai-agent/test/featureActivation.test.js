import test from "node:test";
import assert from "node:assert/strict";
import { activateApprovedFeatures, activateApprovedModel } from "../src/featureActivation.js";

test("approved feature activation is audited, idempotent, and preserves later admin disables", async () => {
  const flags = new Map();
  const requests = new Set();
  const calls = [];
  const store = { async setFeatureFlag(input) {
    calls.push(input);
    if (requests.has(input.requestId)) return { duplicate: true };
    requests.add(input.requestId);
    flags.set(input.featureKey, input.enabled);
    return { duplicate: false };
  }};
  const env = {
    TELEGRAM_ADMIN_USER_ID: "123",
    NVID_FEATURE_ACTIVATION: "group_management,guard_mode,secretary_automation,managed_bots"
  };
  await activateApprovedFeatures(store, env);
  assert.equal(flags.get("group_management"), true);
  assert.equal(flags.get("secretary_automation"), true);
  flags.set("guard_mode", false);
  await activateApprovedFeatures(store, env);
  assert.equal(flags.get("guard_mode"), false);
  assert.equal(requests.size, 4);
  assert.ok(calls.every(({ actorUserId, requestId }) => actorUserId === "123"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)));
});

test("the approved current model uses an audited, stable activation operation", async () => {
  const calls = [];
  const store = { async setAiModelControl(input) { calls.push(input); } };
  const env = { TELEGRAM_ADMIN_USER_ID: "123", NVID_MODEL_ACTIVATION: "nvidia/current-model" };
  await activateApprovedModel(store, env);
  await activateApprovedModel(store, env);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].enabled, true);
  assert.equal(calls[0].modelId, "nvidia/current-model");
  await assert.rejects(activateApprovedModel(store, { ...env, NVID_MODEL_ACTIVATION: "invalid model" }), /valid model/);
});

test("activation fails closed without an owner, with unknown features, or on a failed update", async () => {
  const store = { async setFeatureFlag() { throw new Error("write failed"); } };
  await activateApprovedFeatures(store, {});
  await assert.rejects(activateApprovedFeatures(store, { NVID_FEATURE_ACTIVATION: "group_management" }), /super-admin/);
  await assert.rejects(activateApprovedFeatures(store, {
    TELEGRAM_ADMIN_USER_ID: "123", NVID_FEATURE_ACTIVATION: "unknown"
  }), /unsupported/);
  await assert.rejects(activateApprovedFeatures(store, {
    TELEGRAM_ADMIN_USER_ID: "123", NVID_FEATURE_ACTIVATION: "group_management"
  }), /write failed/);
});