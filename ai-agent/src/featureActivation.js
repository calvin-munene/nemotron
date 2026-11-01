import crypto from "node:crypto";
import { configuredSuperAdminId } from "./rbac.js";

const ALLOWED_FEATURES = new Set([
  "group_management", "ai_moderation", "guard_mode",
  "secretary_automation", "managed_bots", "bot_management"
]);

function activationRequestId(owner, feature) {
  const hash = crypto.createHash("sha256")
    .update(`nvid-ai:approved-feature-activation:v1:${owner}:${feature}`).digest("hex");
  // A deterministic operation ID allows the store's audited idempotency guard
  // to preserve subsequent admin edits across restarts and deployments.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function activateApprovedFeatures(store, env = process.env) {
  const raw = String(env.NVID_FEATURE_ACTIVATION || "").trim();
  if (!raw) return;
  const features = [...new Set(raw.split(",").map((key) => key.trim()))];
  if (raw.length > 256 || features.some((key) => !ALLOWED_FEATURES.has(key))) {
    throw new Error("NVID_FEATURE_ACTIVATION contains an unsupported feature");
  }
  const owner = configuredSuperAdminId(env);
  if (!owner || !store?.setFeatureFlag) {
    throw new Error("Feature activation requires a configured super-admin and database");
  }
  for (const featureKey of features) {
    await store.setFeatureFlag({
      actorUserId: owner, featureKey, enabled: true,
      requestId: activationRequestId(owner, featureKey)
    });
  }
}

export async function activateApprovedModel(store, env = process.env) {
  const modelId = String(env.NVID_MODEL_ACTIVATION || "").trim();
  if (!modelId) return;
  const owner = configuredSuperAdminId(env);
  if (!owner || !store?.setAiModelControl || !/^[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$/.test(modelId)) {
    throw new Error("Model activation requires a valid model, configured super-admin, and database");
  }
  await store.setAiModelControl({
    actorUserId: owner, modelId, enabled: true, featured: true,
    requestId: activationRequestId(owner, `model:${modelId}`)
  });
}