import crypto from "node:crypto";
import { runMigrations } from "./migrations.js";
import { normalizePlatformRole } from "./rbac.js";
import { createOperatingStore } from "./operatingStore.js";
import { createMilestoneStore } from "./milestoneStore.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEATURE_KEY = /^[a-z][a-z0-9_]{1,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INT64 = 9_223_372_036_854_775_807n;

function normalizeUserId(value) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > MAX_INT64) throw new TypeError("userId must be a positive Telegram user ID");
  return BigInt(text).toString();
}

function normalizeRequestId(value, { optional = false } = {}) {
  const text = String(value || "");
  if (!text && optional) return null;
  if (!UUID_V4.test(text)) throw new TypeError("requestId must be a UUID v4");
  return text.toLowerCase();
}

function normalizeFeatureKey(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!FEATURE_KEY.test(key)) throw new TypeError("featureKey is invalid");
  return key;
}

function normalizeModelId(value) {
  const modelId = String(value || "").trim();
  if (!MODEL_ID.test(modelId)) throw new TypeError("modelId is invalid");
  return modelId;
}

function normalizeOptionalText(value, field, maximum) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text || text.length > maximum) throw new TypeError(`${field} must contain 1-${maximum} characters`);
  return text;
}

function normalizeLimit(value, fallback = 50, maximum = 250) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("metadata must be an object");
  return value;
}

function normalizeTelegramChatId(value) {
  const text = String(value ?? "");
  if (!/^-?[1-9]\d*$/.test(text) || BigInt(text) > MAX_INT64 || BigInt(text) < -MAX_INT64) {
    throw new TypeError("telegramChatId is invalid");
  }
  return BigInt(text).toString();
}

function normalizeUuid(value, field = "id") {
  const normalized = String(value || "").toLowerCase();
  if (!UUID.test(normalized)) throw new TypeError(`${field} must be a UUID`);
  return normalized;
}

function normalizeBoundedText(value, field, { minimum = 1, maximum }) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TypeError(`${field} must contain ${minimum}-${maximum} characters`);
  }
  return normalized;
}

function conversationRow(row) {
  return {
    id: row.conversation_id,
    userId: String(row.user_id),
    channel: row.channel,
    telegramChatId: row.telegram_chat_id === null ? null : String(row.telegram_chat_id),
    telegramThreadId: row.telegram_thread_id === null ? null : String(row.telegram_thread_id),
    assistantId: row.assistant_id || null,
    selectedModel: row.selected_model || null,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null
  };
}

function messageRow(row) {
  return {
    id: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    model: row.model || null,
    providerRequestId: row.provider_request_id || null,
    status: row.status,
    usage: row.usage_metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assistantRow(row) {
  return {
    id: row.assistant_id,
    ownerUserId: String(row.owner_user_id),
    name: row.name,
    description: row.description,
    systemInstructions: row.system_instructions,
    tone: row.tone,
    language: row.language,
    technicalLevel: row.technical_level,
    responseLength: row.response_length,
    selectedModel: row.selected_model || null,
    memoryEnabled: row.memory_enabled === true,
    enabled: row.enabled === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function featureRow(row) {
  return {
    key: row.feature_key,
    enabled: row.enabled === true,
    description: row.description || "",
    config: row.config || {},
    updatedBy: row.updated_by === null || row.updated_by === undefined ? null : String(row.updated_by),
    updatedAt: row.updated_at
  };
}

function modelRow(row) {
  return {
    id: row.model_id,
    label: row.label,
    description: row.description || "",
    enabled: row.enabled === true,
    featured: row.featured === true,
    providerAvailable: row.provider_available === true,
    metadata: row.metadata || {},
    lastSeenAt: row.last_seen_at || null,
    updatedBy: row.updated_by === null || row.updated_by === undefined ? null : String(row.updated_by),
    updatedAt: row.updated_at
  };
}

export function sourceIdentifierHash(source, env = process.env) {
  const value = String(source || "unknown");
  const key = env.TELEGRAM_STAR_SIGNING_SECRET || env.TELEGRAM_WEBHOOK_SECRET || "nvid-ai-local-source-hash";
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

export function createPlatformStore({ pool: injectedPool, connectionString = process.env.DATABASE_URL } = {}) {
  let pool = injectedPool || null;
  let ownsPool = false;
  let poolPromise = null;
  let initPromise = null;
  let closed = false;
  let migrationState = { applied: [], currentVersion: null };

  async function resolvePool() {
    if (closed) throw new Error("Platform store is closed");
    if (pool) return pool;
    if (poolPromise) return poolPromise;
    if (!connectionString) throw new Error("DATABASE_URL is required for the platform store");
    poolPromise = import("pg").then(({ Pool }) => {
      pool = new Pool({ connectionString });
      ownsPool = true;
      return pool;
    }).catch((error) => {
      poolPromise = null;
      throw error;
    });
    return poolPromise;
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = resolvePool().then(async (resolvedPool) => {
      migrationState = await runMigrations(resolvedPool);
      return migrationState;
    }).catch((error) => {
      initPromise = null;
      throw error;
    });
    return initPromise;
  }

  async function transaction(work) {
    if (typeof work !== "function") throw new TypeError("transaction work must be a function");
    await init();
    const resolvedPool = await resolvePool();
    const client = await resolvedPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function ensureUserWithClient(client, rawUserId) {
    const userId = normalizeUserId(rawUserId);
    const result = await client.query(
      `INSERT INTO platform_users (user_id, last_seen_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET last_seen_at = NOW()
       RETURNING user_id::text, role, created_at, last_seen_at, updated_at`,
      [userId]
    );
    return result.rows[0];
  }

  async function ensureUser(rawUserId) {
    return transaction((client) => ensureUserWithClient(client, rawUserId));
  }

  async function getUserRole(rawUserId) {
    const row = await ensureUser(rawUserId);
    return normalizePlatformRole(row.role);
  }

  async function setUserRole({ actorUserId, userId: rawUserId, role, requestId }) {
    const actor = normalizeUserId(actorUserId);
    const userId = normalizeUserId(rawUserId);
    const normalizedRole = normalizePlatformRole(role);
    const operationId = normalizeRequestId(requestId);
    return transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationId]);
      const duplicate = await client.query("SELECT action, target_id, metadata FROM audit_logs WHERE request_id = $1", [operationId]);
      if (duplicate.rowCount) {
        const previous = duplicate.rows[0];
        if (previous.action !== "platform_user.role.set" || previous.target_id !== userId || previous.metadata?.role !== normalizedRole) {
          const error = new Error("requestId was already used for a different operation");
          error.statusCode = 409;
          throw error;
        }
        return { duplicate: true, userId, role: normalizedRole };
      }
      await ensureUserWithClient(client, actor);
      await ensureUserWithClient(client, userId);
      const changed = await client.query(
        `UPDATE platform_users SET role = $2, updated_at = NOW() WHERE user_id = $1
         RETURNING user_id::text, role, updated_at`,
        [userId, normalizedRole]
      );
      await client.query(
        `INSERT INTO audit_logs (request_id, actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'platform_user.role.set', 'user', $3, $4::jsonb)`,
        [operationId, actor, userId, JSON.stringify({ role: normalizedRole })]
      );
      return { duplicate: false, userId: changed.rows[0].user_id, role: changed.rows[0].role };
    });
  }

  async function listFeatureFlags() {
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `SELECT feature_key, enabled, description, config, updated_by::text, updated_at
       FROM feature_flags ORDER BY feature_key`
    );
    return result.rows.map(featureRow);
  }

  async function getFeatureFlag(rawFeatureKey) {
    const featureKey = normalizeFeatureKey(rawFeatureKey);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `SELECT feature_key, enabled, description, config, updated_by::text, updated_at
       FROM feature_flags WHERE feature_key = $1`,
      [featureKey]
    );
    return result.rowCount ? featureRow(result.rows[0]) : null;
  }

  async function isFeatureEnabled(featureKey) {
    return (await getFeatureFlag(featureKey))?.enabled === true;
  }

  async function setFeatureFlag({ actorUserId, featureKey: rawFeatureKey, enabled, requestId }) {
    const actor = normalizeUserId(actorUserId);
    const featureKey = normalizeFeatureKey(rawFeatureKey);
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    const operationId = normalizeRequestId(requestId);
    return transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationId]);
      const duplicate = await client.query("SELECT action, target_id, metadata FROM audit_logs WHERE request_id = $1", [operationId]);
      if (duplicate.rowCount) {
        const previous = duplicate.rows[0];
        if (previous.action !== "feature_flag.updated" || previous.target_id !== featureKey || previous.metadata?.enabled !== enabled) {
          const error = new Error("requestId was already used for a different operation");
          error.statusCode = 409;
          throw error;
        }
        const current = await client.query(
          `SELECT feature_key, enabled, description, config, updated_by::text, updated_at
           FROM feature_flags WHERE feature_key = $1`,
          [featureKey]
        );
        return { duplicate: true, feature: current.rowCount ? featureRow(current.rows[0]) : null };
      }
      await ensureUserWithClient(client, actor);
      const changed = await client.query(
        `UPDATE feature_flags SET enabled = $2, updated_by = $3, updated_at = NOW()
         WHERE feature_key = $1
         RETURNING feature_key, enabled, description, config, updated_by::text, updated_at`,
        [featureKey, enabled, actor]
      );
      if (!changed.rowCount) {
        const error = new Error("Unknown feature flag");
        error.statusCode = 404;
        throw error;
      }
      await client.query(
        `INSERT INTO audit_logs (request_id, actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'feature_flag.updated', 'feature_flag', $3, $4::jsonb)`,
        [operationId, actor, featureKey, JSON.stringify({ enabled })]
      );
      return { duplicate: false, feature: featureRow(changed.rows[0]) };
    });
  }

  async function syncAiModels(models) {
    if (!Array.isArray(models) || !models.length) throw new TypeError("models must contain at least one provider model");
    const normalized = models.map((model) => ({
      id: normalizeModelId(model?.id),
      label: normalizeOptionalText(model?.label || model?.id, "label", 200),
      description: model?.description ? normalizeOptionalText(model.description, "description", 1000) : "",
      metadata: {
        ...(model?.tag ? { tag: String(model.tag).slice(0, 100) } : {}),
        ...(model?.ownedBy ? { ownedBy: String(model.ownedBy).slice(0, 100) } : {})
      }
    }));
    return transaction(async (client) => {
      await client.query("UPDATE ai_models SET provider_available = FALSE, updated_at = NOW() WHERE provider_available = TRUE");
      for (const model of normalized) {
        await client.query(
          `INSERT INTO ai_models (model_id, label, description, provider_available, metadata, last_seen_at)
           VALUES ($1, $2, $3, TRUE, $4::jsonb, NOW())
           ON CONFLICT (model_id)
           DO UPDATE SET provider_available = TRUE, metadata = ai_models.metadata || EXCLUDED.metadata,
             last_seen_at = NOW(), updated_at = NOW()`,
          [model.id, model.label, model.description, JSON.stringify(model.metadata)]
        );
      }
      return { synchronized: normalized.length };
    });
  }

  async function listAiModels() {
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `SELECT model_id, label, description, enabled, featured, provider_available, metadata,
              last_seen_at, updated_by::text, updated_at
       FROM ai_models ORDER BY featured DESC, enabled DESC, model_id`
    );
    return result.rows.map(modelRow);
  }

  async function enabledAiModelIds() {
    return (await listAiModels()).filter((model) => model.enabled && model.providerAvailable).map((model) => model.id);
  }

  async function setAiModelControl({ actorUserId, modelId: rawModelId, enabled, featured, label, description, requestId }) {
    const actor = normalizeUserId(actorUserId);
    const modelId = normalizeModelId(rawModelId);
    const operationId = normalizeRequestId(requestId);
    if (enabled !== undefined && typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    if (featured !== undefined && typeof featured !== "boolean") throw new TypeError("featured must be a boolean");
    const normalizedLabel = normalizeOptionalText(label, "label", 200);
    const normalizedDescription = normalizeOptionalText(description, "description", 1000);
    if ([enabled, featured, normalizedLabel, normalizedDescription].every((value) => value === undefined)) {
      throw new TypeError("At least one model control must be provided");
    }
    const requested = { enabled, featured, label: normalizedLabel, description: normalizedDescription };
    return transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationId]);
      const duplicate = await client.query("SELECT action, target_id, metadata FROM audit_logs WHERE request_id = $1", [operationId]);
      if (duplicate.rowCount) {
        const previous = duplicate.rows[0];
        const previousRequest = previous.metadata || {};
        const sameRequest = previousRequest.enabled === enabled
          && previousRequest.featured === featured
          && previousRequest.label === normalizedLabel
          && previousRequest.description === normalizedDescription;
        if (previous.action !== "ai_model.updated" || previous.target_id !== modelId || !sameRequest) {
          const error = new Error("requestId was already used for a different operation");
          error.statusCode = 409;
          throw error;
        }
        const current = await client.query(
          `SELECT model_id, label, description, enabled, featured, provider_available, metadata,
                  last_seen_at, updated_by::text, updated_at FROM ai_models WHERE model_id = $1`,
          [modelId]
        );
        return { duplicate: true, model: current.rowCount ? modelRow(current.rows[0]) : null };
      }
      await ensureUserWithClient(client, actor);
      const changed = await client.query(
        `UPDATE ai_models SET
           enabled = COALESCE($2, enabled),
           featured = COALESCE($3, featured),
           label = COALESCE($4, label),
           description = COALESCE($5, description),
           updated_by = $6,
           updated_at = NOW()
         WHERE model_id = $1
         RETURNING model_id, label, description, enabled, featured, provider_available, metadata,
                   last_seen_at, updated_by::text, updated_at`,
        [modelId, enabled, featured, normalizedLabel, normalizedDescription, actor]
      );
      if (!changed.rowCount) {
        const error = new Error("Unknown NVIDIA model");
        error.statusCode = 404;
        throw error;
      }
      const enabledCount = await client.query("SELECT COUNT(*)::int AS count FROM ai_models WHERE enabled = TRUE AND provider_available = TRUE");
      if (Number(enabledCount.rows[0]?.count || 0) < 1) {
        const error = new Error("At least one NVIDIA model must remain enabled");
        error.statusCode = 409;
        throw error;
      }
      await client.query(
        `INSERT INTO audit_logs (request_id, actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'ai_model.updated', 'ai_model', $3, $4::jsonb)`,
        [operationId, actor, modelId, JSON.stringify(requested)]
      );
      return { duplicate: false, model: modelRow(changed.rows[0]) };
    });
  }

  async function getBillingPrices() {
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `SELECT feature_key, star_cost, updated_by::text, updated_at
       FROM billing_prices ORDER BY feature_key`
    );
    return result.rows.map((row) => ({
      featureKey: row.feature_key,
      starCost: Number(row.star_cost),
      updatedBy: row.updated_by === null || row.updated_by === undefined ? null : String(row.updated_by),
      updatedAt: row.updated_at
    }));
  }

  async function getBillingPrice(featureKey) {
    const prices = await getBillingPrices();
    return prices.find((price) => price.featureKey === normalizeFeatureKey(featureKey)) || null;
  }

  async function setBillingPrice({ actorUserId, featureKey: rawFeatureKey, starCost: rawStarCost, requestId }) {
    const actor = normalizeUserId(actorUserId);
    const featureKey = normalizeFeatureKey(rawFeatureKey);
    const starCost = Number(rawStarCost);
    if (!Number.isSafeInteger(starCost) || starCost < 1 || starCost > 10_000) throw new TypeError("starCost must be an integer between 1 and 10000");
    const operationId = normalizeRequestId(requestId);
    return transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationId]);
      const duplicate = await client.query("SELECT action, target_id, metadata FROM audit_logs WHERE request_id = $1", [operationId]);
      if (duplicate.rowCount) {
        const previous = duplicate.rows[0];
        if (previous.action !== "billing_price.updated" || previous.target_id !== featureKey || previous.metadata?.starCost !== starCost) {
          const error = new Error("requestId was already used for a different operation");
          error.statusCode = 409;
          throw error;
        }
        const current = await client.query(
          "SELECT feature_key, star_cost, updated_by::text, updated_at FROM billing_prices WHERE feature_key = $1",
          [featureKey]
        );
        const row = current.rows[0];
        return {
          duplicate: true,
          price: row ? { featureKey: row.feature_key, starCost: Number(row.star_cost), updatedBy: row.updated_by, updatedAt: row.updated_at } : null
        };
      }
      await ensureUserWithClient(client, actor);
      const changed = await client.query(
        `UPDATE billing_prices SET star_cost = $2, updated_by = $3, updated_at = NOW()
         WHERE feature_key = $1
         RETURNING feature_key, star_cost, updated_by::text, updated_at`,
        [featureKey, starCost, actor]
      );
      if (!changed.rowCount) {
        const error = new Error("Unknown billable feature");
        error.statusCode = 404;
        throw error;
      }
      await client.query(
        `INSERT INTO audit_logs (request_id, actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'billing_price.updated', 'billing_price', $3, $4::jsonb)`,
        [operationId, actor, featureKey, JSON.stringify({ starCost })]
      );
      const row = changed.rows[0];
      return {
        duplicate: false,
        price: { featureKey: row.feature_key, starCost: Number(row.star_cost), updatedBy: String(row.updated_by), updatedAt: row.updated_at }
      };
    });
  }

  async function writeAudit({ requestId, actorUserId, action, targetType = null, targetId = null, result = "success", reason = null, metadata = {} }) {
    const actor = actorUserId === undefined || actorUserId === null ? null : normalizeUserId(actorUserId);
    const operationId = normalizeRequestId(requestId, { optional: true });
    if (typeof action !== "string" || action.length < 1 || action.length > 128) throw new TypeError("action is invalid");
    const safeMetadata = normalizeMetadata(metadata);
    return transaction(async (client) => {
      if (actor) await ensureUserWithClient(client, actor);
      const inserted = await client.query(
        `INSERT INTO audit_logs (request_id, actor_user_id, action, target_type, target_id, result, reason, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING audit_id::text, created_at`,
        [operationId, actor, action, targetType, targetId, result, reason, JSON.stringify(safeMetadata)]
      );
      return { written: inserted.rowCount === 1, auditId: inserted.rows[0]?.audit_id || null };
    });
  }

  async function writeSecurityEvent({ eventType, severity = "info", userId: rawUserId = null, requestId = null, sourceHash = null, metadata = {} }) {
    const userId = rawUserId === null || rawUserId === undefined ? null : normalizeUserId(rawUserId);
    const operationId = normalizeRequestId(requestId, { optional: true });
    if (typeof eventType !== "string" || eventType.length < 1 || eventType.length > 128) throw new TypeError("eventType is invalid");
    if (!["info", "low", "medium", "high", "critical"].includes(severity)) throw new TypeError("severity is invalid");
    const safeMetadata = normalizeMetadata(metadata);
    return transaction(async (client) => {
      if (userId) await ensureUserWithClient(client, userId);
      const inserted = await client.query(
        `INSERT INTO security_events (event_type, severity, user_id, request_id, source_hash, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING security_event_id::text, created_at`,
        [eventType, severity, userId, operationId, sourceHash, JSON.stringify(safeMetadata)]
      );
      return { written: true, securityEventId: inserted.rows[0].security_event_id };
    });
  }

  async function getOverview() {
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(`
      SELECT
        (SELECT COUNT(*)::text FROM platform_users) AS total_users,
        (SELECT COUNT(*)::text FROM platform_users WHERE last_seen_at >= NOW() - INTERVAL '30 days') AS active_users,
        (SELECT COUNT(*)::text FROM platform_users WHERE created_at >= NOW() - INTERVAL '7 days') AS new_users,
        (SELECT COUNT(*)::text FROM audit_logs) AS audit_events,
        (SELECT COUNT(*)::text FROM security_events WHERE created_at >= NOW() - INTERVAL '24 hours') AS recent_security_events,
        (SELECT COUNT(*)::text FROM telegram_groups WHERE active = TRUE) AS active_groups,
        (SELECT COUNT(*)::text FROM group_moderation_actions WHERE created_at >= NOW() - INTERVAL '24 hours') AS recent_moderation_actions,
        (SELECT COUNT(*)::text FROM guard_join_requests WHERE status IN ('queued', 'verification_pending')) AS pending_guard_requests,
        (SELECT COUNT(*)::text FROM secretary_reminders WHERE status = 'scheduled') AS scheduled_reminders,
        (SELECT COUNT(*)::text FROM managed_bot_profiles WHERE status <> 'disabled') AS managed_bots
    `);
    const row = result.rows[0];
    return {
      totalUsers: row.total_users,
      activeUsers: row.active_users,
      newUsers: row.new_users,
      auditEvents: row.audit_events,
      recentSecurityEvents: row.recent_security_events,
      activeGroups: row.active_groups,
      recentModerationActions: row.recent_moderation_actions,
      pendingGuardRequests: row.pending_guard_requests,
      scheduledReminders: row.scheduled_reminders,
      managedBots: row.managed_bots
    };
  }

  async function listAuditLogs({ limit } = {}) {
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `SELECT audit_id::text, request_id::text, actor_user_id::text, action, target_type, target_id, result, reason, metadata, created_at
       FROM audit_logs ORDER BY created_at DESC, audit_id DESC LIMIT $1`,
      [normalizeLimit(limit)]
    );
    return result.rows;
  }

  async function listSecurityEvents({ limit } = {}) {
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `SELECT security_event_id::text, event_type, severity, user_id::text, request_id::text, metadata, created_at
       FROM security_events ORDER BY created_at DESC, security_event_id DESC LIMIT $1`,
      [normalizeLimit(limit)]
    );
    return result.rows;
  }

  async function getOrCreateConversation({
    scopeKey, userId: rawUserId, channel, telegramChatId = null,
    telegramThreadId = null, assistantId = null, selectedModel = null,
    title = "New conversation", conversationId: requestedConversationId = null
  }) {
    const userId = normalizeUserId(rawUserId);
    const scope = normalizeBoundedText(scopeKey, "scopeKey", { maximum: 500 });
    const supportedChannels = new Set([
      "telegram",
      "telegram_business",
      "telegram_guest",
      "telegram_inline",
      "miniapp",
      "web",
      "whatsapp",
      "managed_bot"
    ]);
    if (!supportedChannels.has(channel)) throw new TypeError("channel is invalid");
    const chatId = telegramChatId === null ? null : normalizeTelegramChatId(telegramChatId);
    const threadId = telegramThreadId === null ? null : normalizeTelegramChatId(telegramThreadId);
    const normalizedAssistantId = assistantId ? normalizeUuid(assistantId, "assistantId") : null;
    const normalizedModel = selectedModel ? normalizeModelId(selectedModel) : null;
    const normalizedTitle = normalizeBoundedText(title, "title", { maximum: 160 });
    const conversationId = requestedConversationId
      ? normalizeUuid(requestedConversationId, "conversationId")
      : crypto.randomUUID();
    return transaction(async (client) => {
      await ensureUserWithClient(client, userId);
      await client.query(
        `INSERT INTO conversations (
           conversation_id, scope_key, user_id, telegram_chat_id, telegram_thread_id,
           channel, assistant_id, selected_model, title
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (scope_key) WHERE deleted_at IS NULL DO NOTHING`,
        [conversationId, scope, userId, chatId, threadId, channel, normalizedAssistantId, normalizedModel, normalizedTitle]
      );
      const found = await client.query(
        `SELECT conversation_id, user_id::text, channel, telegram_chat_id::text, telegram_thread_id::text,
                assistant_id, selected_model, title, status, created_at, updated_at, deleted_at
         FROM conversations WHERE scope_key = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [scope, userId]
      );
      if (!found.rowCount) {
        const error = new Error("Conversation scope is not owned by this user");
        error.statusCode = 403;
        throw error;
      }
      return conversationRow(found.rows[0]);
    });
  }

  async function listConversations(rawUserId, { search = "", limit = 50 } = {}) {
    const userId = normalizeUserId(rawUserId);
    const query = String(search || "").trim().slice(0, 160);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `SELECT conversation_id, user_id::text, channel, telegram_chat_id::text, telegram_thread_id::text,
              assistant_id, selected_model, title, status, created_at, updated_at, deleted_at
       FROM conversations
       WHERE user_id = $1 AND deleted_at IS NULL AND ($2 = '' OR title ILIKE '%' || $2 || '%')
       ORDER BY updated_at DESC, conversation_id DESC LIMIT $3`,
      [userId, query, normalizeLimit(limit)]
    );
    return result.rows.map(conversationRow);
  }

  async function getConversation(rawUserId, rawConversationId, { messageLimit = 100 } = {}) {
    const userId = normalizeUserId(rawUserId);
    const conversationId = normalizeUuid(rawConversationId, "conversationId");
    await init();
    const resolvedPool = await resolvePool();
    const conversation = await resolvedPool.query(
      `SELECT conversation_id, user_id::text, channel, telegram_chat_id::text, telegram_thread_id::text,
              assistant_id, selected_model, title, status, created_at, updated_at, deleted_at
       FROM conversations WHERE conversation_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [conversationId, userId]
    );
    if (!conversation.rowCount) return null;
    const messages = await resolvedPool.query(
      `SELECT message_id, conversation_id, role, content, model, provider_request_id,
              status, usage_metadata, created_at, updated_at
       FROM conversation_messages WHERE conversation_id = $1
       ORDER BY created_at, message_id LIMIT $2`,
      [conversationId, normalizeLimit(messageLimit, 100, 250)]
    );
    return { conversation: conversationRow(conversation.rows[0]), messages: messages.rows.map(messageRow) };
  }

  async function renameConversation(rawUserId, rawConversationId, title) {
    const userId = normalizeUserId(rawUserId);
    const conversationId = normalizeUuid(rawConversationId, "conversationId");
    const normalizedTitle = normalizeBoundedText(title, "title", { maximum: 160 });
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE conversations SET title = $3, updated_at = NOW()
         WHERE conversation_id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING conversation_id, user_id::text, channel, telegram_chat_id::text, telegram_thread_id::text,
                   assistant_id, selected_model, title, status, created_at, updated_at, deleted_at`,
        [conversationId, userId, normalizedTitle]
      );
      return result.rowCount ? conversationRow(result.rows[0]) : null;
    });
  }

  async function deleteConversation(rawUserId, rawConversationId) {
    const userId = normalizeUserId(rawUserId);
    const conversationId = normalizeUuid(rawConversationId, "conversationId");
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE conversations SET deleted_at = NOW(), status = 'archived', updated_at = NOW()
         WHERE conversation_id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING conversation_id`,
        [conversationId, userId]
      );
      return result.rowCount > 0;
    });
  }

  async function deleteConversationByScope(rawUserId, scopeKey) {
    const userId = normalizeUserId(rawUserId);
    const scope = normalizeBoundedText(scopeKey, "scopeKey", { maximum: 500 });
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE conversations SET deleted_at = NOW(), status = 'archived', updated_at = NOW()
         WHERE scope_key = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING conversation_id`,
        [scope, userId]
      );
      return result.rowCount > 0;
    });
  }

  async function beginConversationTurn({ conversationId: rawConversationId, userId: rawUserId, text, model, providerRequestId = null }) {
    const conversationId = normalizeUuid(rawConversationId, "conversationId");
    const userId = normalizeUserId(rawUserId);
    const content = normalizeBoundedText(text, "message", { maximum: 20_000 });
    const normalizedModel = model ? normalizeModelId(model) : null;
    const requestId = providerRequestId ? normalizeBoundedText(providerRequestId, "providerRequestId", { maximum: 256 }) : null;
    return transaction(async (client) => {
      const owned = await client.query(
        "SELECT 1 FROM conversations WHERE conversation_id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
        [conversationId, userId]
      );
      if (!owned.rowCount) {
        const error = new Error("Conversation was not found");
        error.statusCode = 404;
        throw error;
      }
      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      await client.query(
        `INSERT INTO conversation_messages (message_id, conversation_id, role, content, model, provider_request_id, status)
         VALUES ($1, $2, 'user', $3, $4, $5, 'completed'),
                ($6, $2, 'assistant', 'Generation in progress', $4, $5, 'generating')`,
        [userMessageId, conversationId, content, normalizedModel, requestId, assistantMessageId]
      );
      await client.query(
        `UPDATE conversations SET selected_model = COALESCE($2, selected_model), updated_at = NOW(),
          title = CASE WHEN title = 'New conversation' THEN LEFT($3, 160) ELSE title END
         WHERE conversation_id = $1`,
        [conversationId, normalizedModel, content]
      );
      return { userMessageId, assistantMessageId };
    });
  }

  async function conversationContext(rawConversationId, { limit = 24 } = {}) {
    const conversationId = normalizeUuid(rawConversationId, "conversationId");
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `SELECT role, content FROM (
         SELECT message_id, role, content, created_at FROM conversation_messages
         WHERE conversation_id = $1 AND status = 'completed'
         ORDER BY created_at DESC, message_id DESC LIMIT $2
       ) recent ORDER BY created_at, message_id`,
      [conversationId, Math.min(48, Math.max(1, Number(limit) || 24))]
    );
    return result.rows.map(({ role, content }) => ({ role, content }));
  }

  async function finishConversationTurn({ assistantMessageId: rawMessageId, content, model, usage = {} }) {
    const messageId = normalizeUuid(rawMessageId, "assistantMessageId");
    const answer = normalizeBoundedText(content, "assistant response", { maximum: 20_000 });
    const normalizedModel = model ? normalizeModelId(model) : null;
    const normalizedUsage = normalizeMetadata(usage);
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE conversation_messages
         SET content = $2, model = COALESCE($3, model), status = 'completed', usage_metadata = $4::jsonb, updated_at = NOW()
         WHERE message_id = $1 AND role = 'assistant' AND status IN ('generating', 'pending')
         RETURNING conversation_id`,
        [messageId, answer, normalizedModel, JSON.stringify(normalizedUsage)]
      );
      if (result.rowCount) await client.query("UPDATE conversations SET updated_at = NOW() WHERE conversation_id = $1", [result.rows[0].conversation_id]);
      return result.rowCount > 0;
    });
  }

  async function failConversationTurn(rawMessageId) {
    const messageId = normalizeUuid(rawMessageId, "assistantMessageId");
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE conversation_messages SET content = 'Generation failed', status = 'failed', updated_at = NOW()
         WHERE message_id = $1 AND role = 'assistant' AND status IN ('generating', 'pending')`,
        [messageId]
      );
      return result.rowCount > 0;
    });
  }

  function normalizeAssistantInput(input = {}) {
    const technicalLevel = String(input.technicalLevel || "adaptive");
    const responseLength = String(input.responseLength || "balanced");
    if (!["simple", "adaptive", "technical", "expert"].includes(technicalLevel)) throw new TypeError("technicalLevel is invalid");
    if (!["concise", "balanced", "detailed"].includes(responseLength)) throw new TypeError("responseLength is invalid");
    return {
      name: normalizeBoundedText(input.name, "name", { maximum: 80 }),
      description: String(input.description || "").trim().slice(0, 500),
      systemInstructions: String(input.systemInstructions || "").trim().slice(0, 5000),
      tone: normalizeBoundedText(input.tone || "adaptive", "tone", { maximum: 40 }),
      language: normalizeBoundedText(input.language || "auto", "language", { maximum: 32 }),
      technicalLevel,
      responseLength,
      selectedModel: input.selectedModel ? normalizeModelId(input.selectedModel) : null,
      memoryEnabled: input.memoryEnabled !== false,
      enabled: input.enabled !== false
    };
  }

  async function createAssistant(rawUserId, input) {
    const userId = normalizeUserId(rawUserId);
    const value = normalizeAssistantInput(input);
    return transaction(async (client) => {
      await ensureUserWithClient(client, userId);
      const result = await client.query(
        `INSERT INTO assistants (
           assistant_id, owner_user_id, name, description, system_instructions, tone,
           language, technical_level, response_length, selected_model, memory_enabled, enabled
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [crypto.randomUUID(), userId, value.name, value.description, value.systemInstructions, value.tone,
          value.language, value.technicalLevel, value.responseLength, value.selectedModel, value.memoryEnabled, value.enabled]
      );
      return assistantRow(result.rows[0]);
    });
  }

  async function listAssistants(rawUserId) {
    const userId = normalizeUserId(rawUserId);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      "SELECT * FROM assistants WHERE owner_user_id = $1 ORDER BY updated_at DESC, assistant_id",
      [userId]
    );
    return result.rows.map(assistantRow);
  }

  async function updateAssistant(rawUserId, rawAssistantId, input) {
    const userId = normalizeUserId(rawUserId);
    const assistantId = normalizeUuid(rawAssistantId, "assistantId");
    const value = normalizeAssistantInput(input);
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE assistants SET name = $3, description = $4, system_instructions = $5, tone = $6,
           language = $7, technical_level = $8, response_length = $9, selected_model = $10,
           memory_enabled = $11, enabled = $12, updated_at = NOW()
         WHERE assistant_id = $1 AND owner_user_id = $2 RETURNING *`,
        [assistantId, userId, value.name, value.description, value.systemInstructions, value.tone,
          value.language, value.technicalLevel, value.responseLength, value.selectedModel, value.memoryEnabled, value.enabled]
      );
      return result.rowCount ? assistantRow(result.rows[0]) : null;
    });
  }

  async function deleteAssistant(rawUserId, rawAssistantId) {
    const userId = normalizeUserId(rawUserId);
    const assistantId = normalizeUuid(rawAssistantId, "assistantId");
    return transaction(async (client) => {
      const result = await client.query("DELETE FROM assistants WHERE assistant_id = $1 AND owner_user_id = $2", [assistantId, userId]);
      return result.rowCount > 0;
    });
  }

  async function claimReplay({ fingerprint, userId: rawUserId, expiresAt }) {
    const normalizedFingerprint = String(fingerprint || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalizedFingerprint)) throw new TypeError("fingerprint is invalid");
    const userId = normalizeUserId(rawUserId);
    const expiry = new Date(expiresAt);
    if (Number.isNaN(expiry.getTime())) throw new TypeError("expiresAt is invalid");
    return transaction(async (client) => {
      await ensureUserWithClient(client, userId);
      await client.query("DELETE FROM telegram_webapp_replays WHERE expires_at <= NOW()");
      const inserted = await client.query(
        `INSERT INTO telegram_webapp_replays (fingerprint, user_id, expires_at)
         VALUES ($1, $2, $3) ON CONFLICT (fingerprint) DO NOTHING RETURNING fingerprint`,
        [normalizedFingerprint, userId, expiry]
      );
      return inserted.rowCount > 0;
    });
  }

  async function acquireLease({ key, ownerId = crypto.randomUUID(), ttlMs = 120_000 }) {
    const leaseKey = normalizeBoundedText(key, "lease key", { maximum: 500 });
    const owner = normalizeUuid(ownerId, "ownerId");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000) throw new TypeError("ttlMs is invalid");
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `INSERT INTO durable_leases (lease_key, owner_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'))
       ON CONFLICT (lease_key) DO UPDATE
         SET owner_id = EXCLUDED.owner_id, expires_at = EXCLUDED.expires_at, updated_at = NOW()
         WHERE durable_leases.expires_at <= NOW()
       RETURNING lease_key, owner_id::text, expires_at`,
      [leaseKey, owner, ttlMs]
    );
    return result.rowCount
      ? { acquired: true, key: leaseKey, ownerId: owner, expiresAt: result.rows[0].expires_at }
      : { acquired: false };
  }

  async function releaseLease({ key, ownerId }) {
    const leaseKey = normalizeBoundedText(key, "lease key", { maximum: 500 });
    const owner = normalizeUuid(ownerId, "ownerId");
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      "DELETE FROM durable_leases WHERE lease_key = $1 AND owner_id = $2",
      [leaseKey, owner]
    );
    return result.rowCount > 0;
  }

  async function consumeSharedRateLimit({ key, limit, windowMs, cost = 1, now = Date.now() }) {
    const limitKey = normalizeBoundedText(key, "rate limit key", { maximum: 500 });
    if (![limit, windowMs, cost].every(Number.isSafeInteger) || limit < 1 || cost < 1 || cost > limit || windowMs < 1_000) {
      throw new TypeError("rate limit values are invalid");
    }
    const windowStart = new Date(Math.floor(Number(now) / windowMs) * windowMs);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `INSERT INTO shared_rate_limits (limit_key, window_start, used)
       VALUES ($1, $2, $3)
       ON CONFLICT (limit_key, window_start) DO UPDATE
         SET used = shared_rate_limits.used + EXCLUDED.used, updated_at = NOW()
         WHERE shared_rate_limits.used + EXCLUDED.used <= $4
       RETURNING used`,
      [limitKey, windowStart, cost, limit]
    );
    return { allowed: result.rowCount > 0, used: result.rowCount ? Number(result.rows[0].used) : limit };
  }

  async function health() {
    const started = Date.now();
    await init();
    const resolvedPool = await resolvePool();
    await resolvedPool.query("SELECT 1 AS ok");
    return { ok: true, latencyMs: Date.now() - started, migrationVersion: migrationState.currentVersion };
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (poolPromise) {
      try {
        await poolPromise;
      } catch {
        return;
      }
    }
    if (ownsPool && pool?.end) await pool.end();
  }

  const operatingStore = createOperatingStore({ transaction, ensureUserWithClient });
  const milestoneStore = createMilestoneStore({ transaction, ensureUserWithClient });

  return {
    init,
    transaction,
    ensureUser,
    getUserRole,
    setUserRole,
    listFeatureFlags,
    getFeatureFlag,
    isFeatureEnabled,
    setFeatureFlag,
    syncAiModels,
    listAiModels,
    enabledAiModelIds,
    setAiModelControl,
    getBillingPrices,
    getBillingPrice,
    setBillingPrice,
    writeAudit,
    writeSecurityEvent,
    getOverview,
    listAuditLogs,
    listSecurityEvents,
    getOrCreateConversation,
    listConversations,
    getConversation,
    renameConversation,
    deleteConversation,
    deleteConversationByScope,
    beginConversationTurn,
    conversationContext,
    finishConversationTurn,
    failConversationTurn,
    createAssistant,
    listAssistants,
    updateAssistant,
    deleteAssistant,
    claimReplay,
    acquireLease,
    releaseLease,
    consumeSharedRateLimit,
    ...operatingStore,
    ...milestoneStore,
    health,
    close
  };
}
