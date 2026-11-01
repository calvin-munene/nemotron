import { createPlatformStore } from "./platformStore.js";
import { logger } from "./logger.js";
import { activateApprovedFeatures } from "./featureActivation.js";

let platformStore = null;
let initialization = null;
let status = { configured: Boolean(process.env.DATABASE_URL), ready: false, error: null, migrationVersion: null };

export function setPlatformStoreForTests(store) {
  platformStore = store;
  initialization = store ? Promise.resolve() : null;
  status = { configured: Boolean(store), ready: Boolean(store), error: null, migrationVersion: null };
}

export function getPlatformStore() {
  return platformStore;
}

export function platformRuntimeStatus() {
  return { ...status };
}

export async function initializePlatformFoundation() {
  if (initialization) return initialization;
  if (!process.env.DATABASE_URL) {
    status = { configured: false, ready: true, error: null, migrationVersion: null };
    initialization = Promise.resolve(status);
    return initialization;
  }
  platformStore = createPlatformStore();
  status = { configured: true, ready: false, error: null, migrationVersion: null };
  initialization = platformStore.init().then(async (migration) => {
    await activateApprovedFeatures(platformStore);
    status = { configured: true, ready: true, error: null, migrationVersion: migration.currentVersion };
    logger.info("platform.foundation.ready", { appliedMigrations: migration.applied, migrationVersion: migration.currentVersion });
    return status;
  }).catch((error) => {
    status = { configured: true, ready: false, error: "database_unavailable", migrationVersion: null };
    logger.error("platform.foundation.failed", { error });
    initialization = null;
    throw error;
  });
  return initialization;
}

export async function platformHealth() {
  if (!status.configured) return { ok: true, configured: false, migrationVersion: null };
  if (!platformStore || !status.ready) return { ok: false, configured: true, migrationVersion: status.migrationVersion };
  try {
    const result = await platformStore.health();
    return { ...result, configured: true };
  } catch (error) {
    logger.error("platform.health.failed", { error });
    return { ok: false, configured: true, migrationVersion: status.migrationVersion };
  }
}
