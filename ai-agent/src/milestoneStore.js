import { effectiveFreePolicy } from "./freeAllowance.js";
import crypto from "node:crypto";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRETARY_ACTIVE = new Set(["active_admin_approved", "active_paid"]);

function userId(value, field = "userId") {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > MAX_INT64) throw new TypeError(`${field} is invalid`);
  return BigInt(text).toString();
}

function chatId(value, field = "chatId") {
  const text = String(value ?? "");
  if (!/^-?[1-9]\d*$/.test(text) || BigInt(text) > MAX_INT64 || BigInt(text) < -MAX_INT64) throw new TypeError(`${field} is invalid`);
  return BigInt(text).toString();
}

function bounded(value, field, maximum, { optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return null;
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum) throw new TypeError(`${field} is invalid`);
  return text;
}

function uuid(value, field = "id") {
  const text = String(value || "").toLowerCase();
  if (!UUID.test(text)) throw new TypeError(`${field} must be a UUID`);
  return text;
}

function positiveInteger(value, field, { minimum = 0, maximum = 1_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError(`${field} is invalid`);
  return number;
}

function safeJson(value, field = "metadata") {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function codeHash(code) {
  const normalized = String(code || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^NVID-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(normalized)) throw new TypeError("Voucher code is invalid");
  return { normalized, hash: crypto.createHash("sha256").update(normalized).digest("hex") };
}

function sessionHash(token) {
  const value = String(token || "");
  if (value.length < 32 || value.length > 512) throw new TypeError("Session token is invalid");
  return crypto.createHash("sha256").update(value).digest("hex");
}

function secretaryConnection(row) {
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    ownerUserId: String(row.owner_user_id),
    userChatId: row.user_chat_id == null ? null : String(row.user_chat_id),
    enabled: row.enabled === true,
    canReply: row.can_reply === true,
    rights: row.rights || {},
    accessStatus: row.access_status,
    accessActive: SECRETARY_ACTIVE.has(row.access_status),
    autoReplyEnabled: row.auto_reply_enabled === true,
    businessStyle: row.business_style,
    customStyle: row.custom_style || null,
    defaultLanguage: row.default_language,
    retentionDays: Number(row.retention_days || 30),
    onboardingSentAt: row.onboarding_sent_at || null,
    lastVerifiedAt: row.last_verified_at,
    updatedAt: row.updated_at
  };
}

export function createMilestoneStore({ transaction, ensureUserWithClient }) {
  if (typeof transaction !== "function" || typeof ensureUserWithClient !== "function") throw new TypeError("Milestone store requires transaction helpers");

  async function ensureSecretaryAccess({ connectionId: rawConnectionId, ownerUserId: rawOwner, primaryAdminId = null }) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const owner = userId(rawOwner, "ownerUserId");
    const primary = primaryAdminId ? userId(primaryAdminId, "primaryAdminId") : null;
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`secretary:${connectionId}`]);
      if (owner === primary) {
        await client.query(
          `INSERT INTO secretary_entitlements
            (entitlement_id, owner_user_id, connection_id, product_id, source, status, granted_by)
           VALUES ($1, $2, $3, 'secretary_lifetime_activation', 'primary_admin', 'active', $2)
           ON CONFLICT (connection_id, product_id, entitlement_version)
           DO UPDATE SET status = 'active', suspended_at = NULL`,
          [crypto.randomUUID(), owner, connectionId]
        );
        await client.query(
          `UPDATE telegram_business_connections SET access_status = 'active_admin_approved', auto_reply_enabled = enabled,
             access_decided_at = NOW(), access_decided_by = $2, updated_at = NOW() WHERE connection_id = $1`,
          [connectionId, owner]
        );
      } else {
        const entitlement = await client.query(
          `SELECT source FROM secretary_entitlements WHERE connection_id = $1 AND owner_user_id = $2 AND status = 'active'
           ORDER BY granted_at DESC LIMIT 1`, [connectionId, owner]
        );
        if (entitlement.rowCount) {
          await client.query(
            `UPDATE telegram_business_connections SET access_status = $3,
               auto_reply_enabled = CASE WHEN enabled AND can_reply THEN auto_reply_enabled ELSE FALSE END, updated_at = NOW()
             WHERE connection_id = $1 AND owner_user_id = $2`,
            [connectionId, owner, entitlement.rows[0].source === "telegram_stars" ? "active_paid" : "active_admin_approved"]
          );
        }
      }
      const result = await client.query("SELECT * FROM telegram_business_connections WHERE connection_id = $1 AND owner_user_id = $2", [connectionId, owner]);
      return secretaryConnection(result.rows[0]);
    });
  }

  async function requestSecretaryAccess({ connectionId: rawConnectionId, ownerUserId: rawOwner }) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const owner = userId(rawOwner, "ownerUserId");
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`secretary-request:${connectionId}`]);
      const connection = await client.query("SELECT access_status FROM telegram_business_connections WHERE connection_id = $1 AND owner_user_id = $2 FOR UPDATE", [connectionId, owner]);
      if (!connection.rowCount) throw Object.assign(new Error("Business connection was not found"), { statusCode: 404 });
      if (SECRETARY_ACTIVE.has(connection.rows[0].access_status)) return { duplicate: true, status: connection.rows[0].access_status };
      const cooldown = await client.query(
        `SELECT cooldown_until FROM secretary_access_requests
         WHERE connection_id = $1 AND status = 'denied' ORDER BY decided_at DESC LIMIT 1`,
        [connectionId]
      );
      if (cooldown.rows[0]?.cooldown_until && new Date(cooldown.rows[0].cooldown_until) > new Date()) {
        throw Object.assign(new Error("A new access request can be submitted after the cooldown"), { statusCode: 429 });
      }
      const requestId = crypto.randomUUID();
      const inserted = await client.query(
        `INSERT INTO secretary_access_requests (request_id, connection_id, owner_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (connection_id) WHERE status = 'pending' DO NOTHING
         RETURNING request_id, status, created_at`,
        [requestId, connectionId, owner]
      );
      await client.query("UPDATE telegram_business_connections SET access_status = 'approval_requested', auto_reply_enabled = FALSE, updated_at = NOW() WHERE connection_id = $1", [connectionId]);
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, result, metadata)
         VALUES ($1, 'secretary.access.requested', 'business_connection', $2, $3, '{}'::jsonb)`,
        [owner, connectionId, inserted.rowCount ? "success" : "duplicate"]
      );
      return { duplicate: !inserted.rowCount, requestId: inserted.rows[0]?.request_id || null, status: "approval_requested" };
    });
  }

  async function decideSecretaryAccess({ requestId: rawRequestId, actorUserId: rawActor, decision, reason = null, cooldownSeconds = 86400 }) {
    const requestId = uuid(rawRequestId, "requestId");
    const actor = userId(rawActor, "actorUserId");
    const action = String(decision || "").toLowerCase();
    if (!["approve", "deny"].includes(action)) throw new TypeError("decision is invalid");
    const explanation = reason ? bounded(reason, "reason", 1000) : null;
    const cooldown = positiveInteger(cooldownSeconds, "cooldownSeconds", { minimum: 60, maximum: 2_592_000 });
    return transaction(async (client) => {
      await ensureUserWithClient(client, actor);
      const selected = await client.query("SELECT * FROM secretary_access_requests WHERE request_id = $1 FOR UPDATE", [requestId]);
      if (!selected.rowCount) throw Object.assign(new Error("Access request was not found"), { statusCode: 404 });
      const request = selected.rows[0];
      if (request.status !== "pending") return { duplicate: true, status: request.status, ownerUserId: String(request.owner_user_id) };
      const approved = action === "approve";
      await client.query(
        `UPDATE secretary_access_requests SET status = $2, reason = $3, decided_by = $4, decided_at = NOW(),
           cooldown_until = CASE WHEN $2 = 'denied' THEN NOW() + ($5 * INTERVAL '1 second') ELSE NULL END, updated_at = NOW()
         WHERE request_id = $1`,
        [requestId, approved ? "approved" : "denied", explanation, actor, cooldown]
      );
      if (approved) {
        await client.query(
          `INSERT INTO secretary_entitlements
            (entitlement_id, owner_user_id, connection_id, product_id, source, status, granted_by)
           VALUES ($1, $2, $3, 'secretary_lifetime_activation', 'admin_approved', 'active', $4)
           ON CONFLICT (connection_id, product_id, entitlement_version)
           DO UPDATE SET status = 'active', source = 'admin_approved', granted_by = EXCLUDED.granted_by, suspended_at = NULL`,
          [crypto.randomUUID(), request.owner_user_id, request.connection_id, actor]
        );
      }
      const connectionStatus = approved ? "active_admin_approved" : "denied";
      await client.query(
        `UPDATE telegram_business_connections SET access_status = $2, auto_reply_enabled = $3,
           access_decided_at = NOW(), access_decided_by = $4, updated_at = NOW() WHERE connection_id = $1`,
        [request.connection_id, connectionStatus, approved, actor]
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, result, reason, metadata)
         VALUES ($1, $2, 'business_connection', $3, 'success', $4, jsonb_build_object('requestId', $5::text))`,
        [actor, `secretary.access.${approved ? "approved" : "denied"}`, request.connection_id, explanation, requestId]
      );
      return { duplicate: false, status: connectionStatus, connectionId: request.connection_id, ownerUserId: String(request.owner_user_id) };
    });
  }

  async function activateSecretaryPayment({ connectionId: rawConnectionId, ownerUserId: rawOwner, telegramPaymentChargeId, metadata = {} }) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const owner = userId(rawOwner, "ownerUserId");
    const chargeId = bounded(telegramPaymentChargeId, "telegramPaymentChargeId", 256);
    const safeMetadata = safeJson(metadata);
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`secretary-payment:${chargeId}`]);
      const collision = await client.query("SELECT owner_user_id::text, connection_id FROM secretary_entitlements WHERE telegram_payment_charge_id = $1", [chargeId]);
      if (collision.rowCount) {
        if (collision.rows[0].owner_user_id !== owner || collision.rows[0].connection_id !== connectionId) {
          throw Object.assign(new Error("Payment charge ID is already bound to another entitlement"), { statusCode: 409 });
        }
        return { activated: false, duplicate: true, status: "active_paid" };
      }
      const connection = await client.query("SELECT owner_user_id::text FROM telegram_business_connections WHERE connection_id = $1 FOR UPDATE", [connectionId]);
      if (!connection.rowCount || connection.rows[0].owner_user_id !== owner) throw Object.assign(new Error("Payment does not match this business connection owner"), { statusCode: 409 });
      const inserted = await client.query(
        `INSERT INTO secretary_entitlements
          (entitlement_id, owner_user_id, connection_id, product_id, source, status, telegram_payment_charge_id, metadata)
         VALUES ($1, $2, $3, 'secretary_lifetime_activation', 'telegram_stars', 'active', $4, $5::jsonb)
         ON CONFLICT (connection_id, product_id, entitlement_version)
         DO UPDATE SET status = 'active', source = 'telegram_stars',
           telegram_payment_charge_id = COALESCE(secretary_entitlements.telegram_payment_charge_id, EXCLUDED.telegram_payment_charge_id),
           suspended_at = NULL
         RETURNING entitlement_id, telegram_payment_charge_id`,
        [crypto.randomUUID(), owner, connectionId, chargeId, JSON.stringify(safeMetadata)]
      );
      if (inserted.rows[0].telegram_payment_charge_id !== chargeId) throw Object.assign(new Error("This connection already has a different payment entitlement"), { statusCode: 409 });
      await client.query("UPDATE telegram_business_connections SET access_status = 'active_paid', auto_reply_enabled = enabled, access_decided_at = NOW(), updated_at = NOW() WHERE connection_id = $1", [connectionId]);
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, result, metadata)
         VALUES ($1, 'secretary.payment.activated', 'business_connection', $2, 'success', jsonb_build_object('paymentRecorded', true))`,
        [owner, connectionId]
      );
      return { activated: true, duplicate: false, status: "active_paid" };
    });
  }

  async function recordSecretaryRefund({ telegramPaymentChargeId, ownerUserId: rawOwner }) {
    const chargeId = bounded(telegramPaymentChargeId, "telegramPaymentChargeId", 256);
    const owner = userId(rawOwner, "ownerUserId");
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE secretary_entitlements SET status = 'refunded', suspended_at = COALESCE(suspended_at, NOW())
         WHERE telegram_payment_charge_id = $1 AND owner_user_id = $2 AND status <> 'refunded'
         RETURNING connection_id`, [chargeId, owner]
      );
      if (!result.rowCount) return { changed: false };
      await client.query("UPDATE telegram_business_connections SET access_status = 'suspended', auto_reply_enabled = FALSE, updated_at = NOW() WHERE connection_id = $1", [result.rows[0].connection_id]);
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, 'secretary.payment.refunded', 'business_connection', $2, jsonb_build_object('paymentRecorded', true))`,
        [owner, result.rows[0].connection_id]
      );
      return { changed: true, connectionId: result.rows[0].connection_id };
    });
  }

  async function listSecretaryAccessRequests({ status = null, ownerUserId = null, limit = 100 } = {}) {
    const owner = ownerUserId == null ? null : userId(ownerUserId, "ownerUserId");
    const size = positiveInteger(limit, "limit", { minimum: 1, maximum: 250 });
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT requests.request_id, requests.connection_id, requests.owner_user_id::text, requests.status,
                requests.reason, requests.decided_by::text, requests.decided_at, requests.cooldown_until,
                requests.created_at, users.username, users.first_name, users.last_name
         FROM secretary_access_requests AS requests
         JOIN platform_users AS users ON users.user_id = requests.owner_user_id
         WHERE ($1::text IS NULL OR requests.status = $1) AND ($2::bigint IS NULL OR requests.owner_user_id = $2)
         ORDER BY requests.created_at DESC LIMIT $3`,
        [status, owner, size]
      );
      return result.rows.map((row) => ({
        requestId: row.request_id, connectionId: row.connection_id, ownerUserId: row.owner_user_id,
        status: row.status, reason: row.reason || null, decidedBy: row.decided_by || null,
        decidedAt: row.decided_at || null, cooldownUntil: row.cooldown_until || null,
        createdAt: row.created_at, username: row.username || null,
        displayName: [row.first_name, row.last_name].filter(Boolean).join(" ") || null
      }));
    });
  }

  async function updateSecretarySettings({ connectionId: rawConnectionId, ownerUserId: rawOwner, changes = {} }) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const owner = userId(rawOwner, "ownerUserId");
    const style = changes.businessStyle === undefined ? null : String(changes.businessStyle);
    if (style !== null && !["formal", "friendly", "concise", "custom"].includes(style)) throw new TypeError("businessStyle is invalid");
    const customStyle = changes.customStyle === undefined ? undefined : changes.customStyle === null ? null : bounded(changes.customStyle, "customStyle", 1000);
    const language = changes.defaultLanguage === undefined ? null : bounded(changes.defaultLanguage, "defaultLanguage", 32);
    const retention = changes.retentionDays === undefined ? null : positiveInteger(changes.retentionDays, "retentionDays", { minimum: 1, maximum: 365 });
    const autoReply = changes.autoReplyEnabled === undefined ? null : changes.autoReplyEnabled === true;
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE telegram_business_connections SET
           business_style = COALESCE($3, business_style), custom_style = CASE WHEN $4::boolean THEN $5 ELSE custom_style END,
           default_language = COALESCE($6, default_language), retention_days = COALESCE($7, retention_days),
           auto_reply_enabled = CASE WHEN $8::boolean IS NULL THEN auto_reply_enabled ELSE ($8 AND access_status IN ('active_admin_approved', 'active_paid') AND enabled AND can_reply) END,
           updated_at = NOW()
         WHERE connection_id = $1 AND owner_user_id = $2 RETURNING *`,
        [connectionId, owner, style, changes.customStyle !== undefined, customStyle ?? null, language, retention, autoReply]
      );
      return secretaryConnection(result.rows[0]);
    });
  }

  async function setSecretaryAccessStatus({ connectionId: rawConnectionId, ownerUserId: rawOwner, status }) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const owner = userId(rawOwner, "ownerUserId");
    const next = String(status || "");
    if (!["pending_access", "approval_requested", "payment_required", "payment_pending", "denied", "suspended", "revoked", "connection_disabled"].includes(next)) throw new TypeError("Secretary access status is invalid");
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE telegram_business_connections SET access_status = $3,
           auto_reply_enabled = CASE WHEN $3 IN ('pending_access', 'approval_requested', 'payment_required', 'payment_pending', 'denied', 'suspended', 'revoked', 'connection_disabled') THEN FALSE ELSE auto_reply_enabled END,
           updated_at = NOW() WHERE connection_id = $1 AND owner_user_id = $2 RETURNING *`,
        [connectionId, owner, next]
      );
      return secretaryConnection(result.rows[0]);
    });
  }

  async function getSecretaryContactSettings(rawConnectionId, rawChatId) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const contactChatId = chatId(rawChatId, "contactChatId");
    return transaction(async (client) => {
      const result = await client.query("SELECT * FROM secretary_contact_settings WHERE connection_id = $1 AND contact_chat_id = $2", [connectionId, contactChatId]);
      const row = result.rows[0];
      return row ? {
        connectionId, contactChatId, languageOverride: row.language_override || null,
        toneOverride: row.tone_override || null, autoReplyEnabled: row.auto_reply_enabled === true,
        memoryEnabled: row.memory_enabled === true, retentionDays: Number(row.retention_days),
        introductionSentAt: row.introduction_sent_at || null
      } : { connectionId, contactChatId, languageOverride: null, toneOverride: null, autoReplyEnabled: true, memoryEnabled: true, retentionDays: 30, introductionSentAt: null };
    });
  }

  async function markSecretaryIntroductionSent(rawConnectionId, rawChatId) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const contactChatId = chatId(rawChatId, "contactChatId");
    return transaction(async (client) => {
      await client.query(
        `INSERT INTO secretary_contact_settings (connection_id, contact_chat_id, introduction_sent_at)
         VALUES ($1, $2, NOW()) ON CONFLICT (connection_id, contact_chat_id)
         DO UPDATE SET introduction_sent_at = COALESCE(secretary_contact_settings.introduction_sent_at, NOW()), updated_at = NOW()`,
        [connectionId, contactChatId]
      );
      return true;
    });
  }

  async function listSecretaryContacts({ connectionId: rawConnectionId, ownerUserId: rawOwner, limit = 100 }) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const owner = userId(rawOwner, "ownerUserId");
    const size = positiveInteger(limit, "limit", { minimum: 1, maximum: 250 });
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT settings.contact_chat_id::text, settings.language_override, settings.tone_override,
                settings.auto_reply_enabled, settings.memory_enabled, settings.retention_days,
                settings.introduction_sent_at, settings.updated_at
         FROM secretary_contact_settings AS settings
         JOIN telegram_business_connections AS connections ON connections.connection_id = settings.connection_id
         WHERE settings.connection_id = $1 AND connections.owner_user_id = $2
         ORDER BY settings.updated_at DESC LIMIT $3`, [connectionId, owner, size]
      );
      return result.rows;
    });
  }

  async function updateSecretaryContactSettings({ connectionId: rawConnectionId, contactChatId: rawContact, ownerUserId: rawOwner, changes = {} }) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const contact = chatId(rawContact, "contactChatId");
    const owner = userId(rawOwner, "ownerUserId");
    const language = changes.languageOverride === undefined ? undefined : changes.languageOverride === null || changes.languageOverride === "" ? null : bounded(changes.languageOverride, "languageOverride", 32).toLowerCase();
    const tone = changes.toneOverride === undefined ? undefined : changes.toneOverride === null || changes.toneOverride === "" ? null : String(changes.toneOverride);
    if (tone !== undefined && tone !== null && !["adaptive", "formal", "friendly", "concise"].includes(tone)) throw new TypeError("toneOverride is invalid");
    const retention = changes.retentionDays === undefined ? undefined : positiveInteger(changes.retentionDays, "retentionDays", { minimum: 1, maximum: 365 });
    return transaction(async (client) => {
      const connection = await client.query("SELECT connection_id FROM telegram_business_connections WHERE connection_id = $1 AND owner_user_id = $2", [connectionId, owner]);
      if (!connection.rowCount) throw Object.assign(new Error("Business connection was not found"), { statusCode: 404 });
      await client.query("INSERT INTO secretary_contact_settings (connection_id, contact_chat_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [connectionId, contact]);
      const result = await client.query(
        `UPDATE secretary_contact_settings SET
           language_override = CASE WHEN $3 THEN $4 ELSE language_override END,
           tone_override = CASE WHEN $5 THEN $6 ELSE tone_override END,
           auto_reply_enabled = COALESCE($7, auto_reply_enabled), memory_enabled = COALESCE($8, memory_enabled),
           retention_days = COALESCE($9, retention_days), updated_at = NOW()
         WHERE connection_id = $1 AND contact_chat_id = $2 RETURNING *`,
        [connectionId, contact, language !== undefined, language ?? null, tone !== undefined, tone ?? null,
          changes.autoReplyEnabled === undefined ? null : changes.autoReplyEnabled === true,
          changes.memoryEnabled === undefined ? null : changes.memoryEnabled === true, retention ?? null]
      );
      return result.rows[0];
    });
  }

  async function markSecretaryOnboardingSent(rawConnectionId, rawOwner) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const owner = userId(rawOwner, "ownerUserId");
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE telegram_business_connections SET onboarding_sent_at = COALESCE(onboarding_sent_at, NOW()), updated_at = NOW()
         WHERE connection_id = $1 AND owner_user_id = $2 AND onboarding_sent_at IS NULL RETURNING connection_id`,
        [connectionId, owner]
      );
      return result.rowCount > 0;
    });
  }

  async function reserveFreeUsage({ idempotencyKey, ownerUserId: rawOwner, subjectUserId = null, featureKey = "ai_chat", channel, groupId = null, businessConnectionId = null, conversationKey = null }) {
    const key = bounded(idempotencyKey, "idempotencyKey", 500);
    const owner = userId(rawOwner, "ownerUserId");
    const subject = subjectUserId == null ? null : userId(subjectUserId, "subjectUserId");
    const feature = bounded(featureKey, "featureKey", 64);
    const resolvedChannel = bounded(channel, "channel", 64);
    const group = groupId == null ? null : chatId(groupId, "groupId");
    const connection = businessConnectionId == null ? null : bounded(businessConnectionId, "businessConnectionId", 256);
    const conversation = conversationKey == null ? null : bounded(conversationKey, "conversationKey", 500);
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      if (subject) await ensureUserWithClient(client, subject);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`free-usage:${owner}:${feature}:${resolvedChannel}`]);
      const duplicate = await client.query("SELECT usage_id, billing_source, status FROM ai_usage_events WHERE idempotency_key = $1", [key]);
      if (duplicate.rowCount) return { reserved: false, duplicate: true, ...duplicate.rows[0] };
      const user = await client.query("SELECT role, plan FROM platform_users WHERE user_id = $1", [owner]);
      const role = user.rows[0]?.role || "standard_user";
      const plan = user.rows[0]?.plan || "standard";
      const policy = await client.query(
        `SELECT free_successes, window_seconds, scope_type, scope_id FROM ai_usage_policies
         WHERE active AND (expires_at IS NULL OR expires_at > NOW()) AND feature_key = $1
           AND channel IN ($2, '*') AND (
             (scope_type = 'user' AND scope_id = $3) OR
             (scope_type = 'business_connection' AND scope_id = COALESCE($4, '')) OR
             (scope_type = 'group' AND scope_id = COALESCE($5, '')) OR
             (scope_type = 'role' AND scope_id = $6) OR
             (scope_type = 'plan' AND scope_id = $7) OR
             (scope_type = 'global' AND scope_id = '*')
           )
         ORDER BY CASE scope_type WHEN 'user' THEN 1 WHEN 'business_connection' THEN 2 WHEN 'group' THEN 3 WHEN 'role' THEN 4 WHEN 'plan' THEN 5 ELSE 6 END,
                  CASE WHEN channel = $2 THEN 0 ELSE 1 END
         LIMIT 1`,
        [feature, resolvedChannel, owner, connection, group, role, plan]
      );
      const { freeLimit, windowSeconds } = effectiveFreePolicy(policy.rows[0], feature);
      const count = await client.query(
        `SELECT COUNT(*)::int AS used, MIN(created_at) AS oldest FROM ai_usage_events
         WHERE owner_user_id = $1 AND feature_key = $2 AND channel = $3
           AND billing_source = 'free' AND status IN ('reserved', 'completed')
           AND created_at > NOW() - ($4 * INTERVAL '1 second')`,
        [owner, feature, resolvedChannel, windowSeconds]
      );
      const used = Number(count.rows[0]?.used || 0);
      const resetAt = count.rows[0]?.oldest ? new Date(new Date(count.rows[0].oldest).getTime() + windowSeconds * 1000) : new Date(Date.now() + windowSeconds * 1000);
      if (used >= freeLimit) return { reserved: false, duplicate: false, exhausted: true, freeLimit, used, windowSeconds, resetAt };
      const usageId = crypto.randomUUID();
      await client.query(
        `INSERT INTO ai_usage_events
          (usage_id, idempotency_key, owner_user_id, subject_user_id, feature_key, channel, group_id,
           business_connection_id, conversation_key, billing_source, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'free', 'reserved')`,
        [usageId, key, owner, subject, feature, resolvedChannel, group, connection, conversation]
      );
      return { reserved: true, duplicate: false, usageId, billingSource: "free", freeLimit, used: used + 1, windowSeconds };
    });
  }

  async function recordUsageReservation({ idempotencyKey, ownerUserId: rawOwner, subjectUserId = null, featureKey = "ai_chat", channel, billingSource, creditCost = 0, groupId = null, businessConnectionId = null, conversationKey = null }) {
    const key = bounded(idempotencyKey, "idempotencyKey", 500);
    const owner = userId(rawOwner, "ownerUserId");
    const subject = subjectUserId == null ? null : userId(subjectUserId, "subjectUserId");
    if (!["credit", "unlimited"].includes(billingSource)) throw new TypeError("billingSource is invalid");
    const cost = positiveInteger(creditCost, "creditCost", { minimum: 0, maximum: 10000 });
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      if (subject) await ensureUserWithClient(client, subject);
      const result = await client.query(
        `INSERT INTO ai_usage_events
          (usage_id, idempotency_key, owner_user_id, subject_user_id, feature_key, channel, group_id,
           business_connection_id, conversation_key, billing_source, status, credit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved', $11)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING usage_id`,
        [crypto.randomUUID(), key, owner, subject, bounded(featureKey, "featureKey", 64), bounded(channel, "channel", 64),
          groupId == null ? null : chatId(groupId, "groupId"), businessConnectionId == null ? null : bounded(businessConnectionId, "businessConnectionId", 256),
          conversationKey == null ? null : bounded(conversationKey, "conversationKey", 500), billingSource, cost]
      );
      return { recorded: result.rowCount > 0, usageId: result.rows[0]?.usage_id || null };
    });
  }

  async function finishUsageEvent(idempotencyKey, { success, failureCategory = null, providerModel = null, providerLatencyMs = null } = {}) {
    const key = bounded(idempotencyKey, "idempotencyKey", 500);
    const category = failureCategory == null ? null : bounded(failureCategory, "failureCategory", 64);
    const latency = providerLatencyMs == null ? null : positiveInteger(providerLatencyMs, "providerLatencyMs", { maximum: 3_600_000 });
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE ai_usage_events SET status = $2, failure_category = $3, provider_model = $4,
           provider_latency_ms = $5, completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE completed_at END, updated_at = NOW()
         WHERE idempotency_key = $1 AND status = 'reserved'
         RETURNING usage_id, billing_source, status`,
        [key, success ? "completed" : "failed", category, providerModel, latency]
      );
      return { changed: result.rowCount > 0, event: result.rows[0] || null };
    });
  }

  async function getUsageAllowance(rawOwner, { featureKey = "ai_chat", channel = "telegram" } = {}) {
    const owner = userId(rawOwner, "ownerUserId");
    return transaction(async (client) => {
      const policy = await client.query(
        `SELECT free_successes, window_seconds, scope_type, scope_id FROM ai_usage_policies
         WHERE feature_key = $2 AND channel IN ($3, '*') AND active
           AND (expires_at IS NULL OR expires_at > NOW())
           AND ((scope_type = 'user' AND scope_id = $1)
              OR (scope_type = 'role' AND scope_id = (SELECT role FROM platform_users WHERE user_id = $1::bigint))
              OR (scope_type = 'plan' AND scope_id = (SELECT plan FROM platform_users WHERE user_id = $1::bigint))
             OR (scope_type = 'global' AND scope_id = '*'))
         ORDER BY CASE scope_type WHEN 'user' THEN 1 WHEN 'role' THEN 4 WHEN 'plan' THEN 5 ELSE 6 END,
                  CASE WHEN channel = $3 THEN 0 ELSE 1 END LIMIT 1`,
        [owner, featureKey, channel]
      );
      const { freeLimit, windowSeconds } = effectiveFreePolicy(policy.rows[0], featureKey);
      const usage = await client.query(
        `SELECT COUNT(*)::int AS used, MIN(created_at) AS oldest
         FROM ai_usage_events WHERE owner_user_id = $1 AND feature_key = $2 AND channel = $3
           AND billing_source = 'free' AND status IN ('reserved', 'completed')
           AND created_at > NOW() - ($4 * INTERVAL '1 second')`,
        [owner, featureKey, channel, windowSeconds]
      );
      const used = Number(usage.rows[0]?.used || 0);
      const resetAt = usage.rows[0]?.oldest ? new Date(new Date(usage.rows[0].oldest).getTime() + windowSeconds * 1000) : new Date();
      return { freeLimit, used, remaining: Math.max(0, freeLimit - used), windowSeconds, resetAt };
    });
  }

  async function setUsagePolicy({ actorUserId: rawActor, scopeType, scopeId = "*", featureKey = "ai_chat", channel = "*", freeSuccesses, windowSeconds, requestId: rawRequestId }) {
    const actor = userId(rawActor, "actorUserId");
    const operationId = uuid(rawRequestId, "requestId");
    const type = String(scopeType || "");
    if (!["global", "plan", "role", "user", "group", "business_connection"].includes(type)) throw new TypeError("scopeType is invalid");
    const free = positiveInteger(freeSuccesses, "freeSuccesses", { maximum: 100000 });
    const window = positiveInteger(windowSeconds, "windowSeconds", { minimum: 60, maximum: 2_592_000 });
    return transaction(async (client) => {
      await ensureUserWithClient(client, actor);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationId]);
      const duplicate = await client.query("SELECT audit_id FROM audit_logs WHERE request_id = $1", [operationId]);
      if (duplicate.rowCount) return { duplicate: true };
      const result = await client.query(
        `INSERT INTO ai_usage_policies
          (policy_id, scope_type, scope_id, feature_key, channel, free_successes, window_seconds, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (scope_type, scope_id, feature_key, channel)
         DO UPDATE SET free_successes = EXCLUDED.free_successes, window_seconds = EXCLUDED.window_seconds,
           active = TRUE, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING *`,
        [crypto.randomUUID(), type, bounded(scopeId, "scopeId", 256), bounded(featureKey, "featureKey", 64), bounded(channel, "channel", 64), free, window, actor]
      );
      await client.query(
        `INSERT INTO audit_logs (request_id, actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'usage_policy.updated', 'usage_policy', $3, jsonb_build_object('freeSuccesses', $4::int, 'windowSeconds', $5::int))`,
        [operationId, actor, `${type}:${scopeId}:${featureKey}:${channel}`, free, window]
      );
      return { duplicate: false, policy: result.rows[0] };
    });
  }

  async function listUsagePolicies({ limit = 100 } = {}) {
    const size = positiveInteger(limit, "limit", { minimum: 1, maximum: 250 });
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT policy_id, scope_type, scope_id, feature_key, channel, free_successes,
                window_seconds, active, updated_by::text, created_at, updated_at
         FROM ai_usage_policies
         ORDER BY updated_at DESC, scope_type, scope_id
         LIMIT $1`,
        [size]
      );
      return result.rows.map((policy) => ({
        ...policy,
        window_seconds: effectiveFreePolicy(policy, policy.feature_key || "ai_chat").windowSeconds
      }));
    });
  }

  async function createVoucher({ actorUserId: rawActor, requestId: rawRequestId, creditAmount, maximumRedemptions = 1, perUserLimit = 1, eligiblePlans = [], eligibleRoles = [], assignedUserId = null, validFrom = new Date(), expiresAt = null, internalNote = null }) {
    const actor = userId(rawActor, "actorUserId");
    const requestId = uuid(rawRequestId);
    const amount = positiveInteger(creditAmount, "creditAmount", { minimum: 1, maximum: 1_000_000 });
    const maximum = positiveInteger(maximumRedemptions, "maximumRedemptions", { minimum: 1, maximum: 1_000_000 });
    const perUser = positiveInteger(perUserLimit, "perUserLimit", { minimum: 1, maximum: 1000 });
    if (!Array.isArray(eligiblePlans) || !Array.isArray(eligibleRoles) || eligiblePlans.length > 50 || eligibleRoles.length > 50) throw new TypeError("Voucher eligibility is invalid");
    const plans = [...new Set(eligiblePlans.map((value) => bounded(value, "eligiblePlan", 64)))];
    const roles = [...new Set(eligibleRoles.map((value) => bounded(value, "eligibleRole", 64)))];
    const assigned = assignedUserId == null ? null : userId(assignedUserId, "assignedUserId");
    const note = bounded(internalNote, "internalNote", 1000, { optional: true });
    const start = new Date(validFrom);
    const expiry = expiresAt == null ? null : new Date(expiresAt);
    if (!Number.isFinite(start.getTime()) || expiry && (!Number.isFinite(expiry.getTime()) || expiry <= start)) throw new TypeError("Voucher dates are invalid");
    return transaction(async (client) => {
      await ensureUserWithClient(client, actor);
      if (assigned) await ensureUserWithClient(client, assigned);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`voucher:create:${requestId}`]);
      const prior = await client.query(
        `SELECT voucher_id, display_prefix, credit_amount, maximum_redemptions, per_user_limit, valid_from, expires_at
         FROM credit_vouchers WHERE creation_request_id = $1`,
        [requestId]
      );
      if (prior.rowCount) {
        const existing = prior.rows[0];
        return {
          duplicate: true,
          voucherId: existing.voucher_id,
          code: null,
          displayPrefix: existing.display_prefix,
          creditAmount: Number(existing.credit_amount),
          maximumRedemptions: Number(existing.maximum_redemptions),
          perUserLimit: Number(existing.per_user_limit),
          validFrom: existing.valid_from,
          expiresAt: existing.expires_at
        };
      }
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bytes = crypto.randomBytes(16);
      const groups = Array.from({ length: 4 }, (_, group) => Array.from({ length: 4 }, (_, index) => alphabet[bytes[group * 4 + index] % alphabet.length]).join(""));
      const code = `NVID-${groups.join("-")}`;
      const hashed = codeHash(code);
      const voucherId = crypto.randomUUID();
      await client.query(
        `INSERT INTO credit_vouchers
          (voucher_id, creation_request_id, code_hash, display_prefix, credit_amount, maximum_redemptions, per_user_limit,
           eligible_plans, eligible_roles, assigned_user_id, created_by, valid_from, expires_at, internal_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)`,
        [voucherId, requestId, hashed.hash, code.slice(0, 10), amount, maximum, perUser, JSON.stringify(plans), JSON.stringify(roles), assigned, actor, start, expiry, note]
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, 'voucher.created', 'voucher', $2, jsonb_build_object('credits', $3::int, 'maximumRedemptions', $4::int))`,
        [actor, voucherId, amount, maximum]
      );
      return { duplicate: false, voucherId, code, displayPrefix: code.slice(0, 10), creditAmount: amount, maximumRedemptions: maximum, perUserLimit: perUser, validFrom: start, expiresAt: expiry };
    });
  }

  async function redeemVoucher({ userId: rawUser, code }) {
    const user = userId(rawUser);
    const hashed = codeHash(code);
    return transaction(async (client) => {
      await ensureUserWithClient(client, user);
      await client.query("INSERT INTO telegram_star_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [user]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`voucher:${hashed.hash}`]);
      const selected = await client.query("SELECT * FROM credit_vouchers WHERE code_hash = $1 FOR UPDATE", [hashed.hash]);
      if (!selected.rowCount) throw Object.assign(new Error("Voucher code was not found"), { statusCode: 404 });
      const voucher = selected.rows[0];
      if (!voucher.active || voucher.revoked_at) throw Object.assign(new Error("This voucher has been revoked"), { statusCode: 409 });
      if (new Date(voucher.valid_from) > new Date()) throw Object.assign(new Error("This voucher is not active yet"), { statusCode: 409 });
      if (voucher.expires_at && new Date(voucher.expires_at) <= new Date()) throw Object.assign(new Error("This voucher has expired"), { statusCode: 409 });
      if (Number(voucher.redemptions_used) >= Number(voucher.maximum_redemptions)) throw Object.assign(new Error("This voucher has reached its redemption limit"), { statusCode: 409 });
      if (voucher.assigned_user_id != null && String(voucher.assigned_user_id) !== user) throw Object.assign(new Error("This voucher is assigned to another account"), { statusCode: 403 });
      const profile = await client.query("SELECT role, plan FROM platform_users WHERE user_id = $1", [user]);
      const plans = voucher.eligible_plans || [];
      const roles = voucher.eligible_roles || [];
      if (plans.length && !plans.includes(profile.rows[0].plan) || roles.length && !roles.includes(profile.rows[0].role)) throw Object.assign(new Error("This voucher is not available for your plan"), { statusCode: 403 });
      const redeemed = await client.query("SELECT COUNT(*)::int AS count FROM voucher_redemptions WHERE voucher_id = $1 AND user_id = $2", [voucher.voucher_id, user]);
      if (Number(redeemed.rows[0].count) >= Number(voucher.per_user_limit)) throw Object.assign(new Error("You have already used this voucher"), { statusCode: 409 });
      const redemptionId = crypto.randomUUID();
      await client.query("INSERT INTO voucher_redemptions (redemption_id, voucher_id, user_id, credits_added) VALUES ($1, $2, $3, $4)", [redemptionId, voucher.voucher_id, user, voucher.credit_amount]);
      await client.query("UPDATE credit_vouchers SET redemptions_used = redemptions_used + 1 WHERE voucher_id = $1", [voucher.voucher_id]);
      const account = await client.query("UPDATE telegram_star_accounts SET balance = balance + $2, updated_at = NOW() WHERE user_id = $1 RETURNING balance::text", [user, voucher.credit_amount]);
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, 'voucher.redeemed', 'voucher', $2, jsonb_build_object('creditsAdded', $3::int))`,
        [user, voucher.voucher_id, voucher.credit_amount]
      );
      return { redeemed: true, redemptionId, creditsAdded: Number(voucher.credit_amount), balance: account.rows[0].balance, displayPrefix: voucher.display_prefix };
    });
  }

  async function listVouchers({ limit = 100 } = {}) {
    const size = positiveInteger(limit, "limit", { minimum: 1, maximum: 250 });
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT voucher_id, display_prefix, credit_amount, maximum_redemptions, redemptions_used,
                per_user_limit, eligible_plans, eligible_roles, assigned_user_id::text, created_by::text,
                valid_from, expires_at, active, revoked_at, internal_note, created_at
         FROM credit_vouchers ORDER BY created_at DESC LIMIT $1`, [size]
      );
      return result.rows;
    });
  }

  async function revokeVoucher({ voucherId: rawVoucherId, actorUserId: rawActor, reason = null }) {
    const voucherId = uuid(rawVoucherId, "voucherId");
    const actor = userId(rawActor, "actorUserId");
    return transaction(async (client) => {
      const result = await client.query("UPDATE credit_vouchers SET active = FALSE, revoked_at = COALESCE(revoked_at, NOW()) WHERE voucher_id = $1 RETURNING voucher_id", [voucherId]);
      if (result.rowCount) await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, reason)
         VALUES ($1, 'voucher.revoked', 'voucher', $2, $3)`, [actor, voucherId, reason]
      );
      return { revoked: result.rowCount > 0 };
    });
  }

  async function isGroupUserVerified(rawGroupId, rawUserId) {
    const group = chatId(rawGroupId, "groupId");
    const user = userId(rawUserId);
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT status FROM group_user_verifications WHERE group_id = $1 AND user_id = $2
         AND status = 'verified' AND (expires_at IS NULL OR expires_at > NOW())`, [group, user]
      );
      return result.rowCount > 0;
    });
  }

  async function verifyGroupUser({ groupId: rawGroupId, userId: rawUserId, verifiedBy = "administrator", verificationSeconds = null }) {
    const group = chatId(rawGroupId, "groupId");
    const user = userId(rawUserId);
    if (!["administrator", "exempt", "captcha"].includes(verifiedBy)) throw new TypeError("verifiedBy is invalid");
    const duration = verificationSeconds == null ? null : positiveInteger(verificationSeconds, "verificationSeconds", { minimum: 300, maximum: 31_536_000 });
    return transaction(async (client) => {
      await ensureUserWithClient(client, user);
      await client.query(
        `INSERT INTO group_user_verifications (group_id, user_id, status, verified_at, expires_at, verified_by)
         VALUES ($1, $2, 'verified', NOW(), CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() + ($3 * INTERVAL '1 second') END, $4)
         ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'verified', verified_at = NOW(),
           expires_at = EXCLUDED.expires_at, verified_by = EXCLUDED.verified_by`,
        [group, user, duration, verifiedBy]
      );
      await client.query("UPDATE platform_users SET verified = TRUE, updated_at = NOW() WHERE user_id = $1", [user]);
      return { verified: true };
    });
  }

  function captchaAnswerHash(challengeId, answer) {
    const secret = process.env.TELEGRAM_STAR_SIGNING_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || "local-captcha-key";
    return crypto.createHmac("sha256", secret).update(`${challengeId}\0${answer}`).digest("hex");
  }

  async function createCaptchaChallenge({ groupId: rawGroupId, userId: rawUserId, originalRequest = {}, maxAttempts = 3, ttlSeconds = 300 }) {
    const group = chatId(rawGroupId, "groupId");
    const user = userId(rawUserId);
    const attempts = positiveInteger(maxAttempts, "maxAttempts", { minimum: 1, maximum: 10 });
    const ttl = positiveInteger(ttlSeconds, "ttlSeconds", { minimum: 60, maximum: 1800 });
    const left = crypto.randomInt(2, 10);
    const right = crypto.randomInt(1, 10);
    const answer = left + right;
    const choices = [...new Set([answer, answer + (crypto.randomInt(0, 2) ? 1 : -1), answer + (crypto.randomInt(0, 2) ? 2 : -2)])];
    while (choices.length < 3) choices.push(answer + choices.length + 1);
    for (let index = choices.length - 1; index > 0; index -= 1) {
      const swap = crypto.randomInt(0, index + 1);
      [choices[index], choices[swap]] = [choices[swap], choices[index]];
    }
    const challengeId = crypto.randomUUID();
    return transaction(async (client) => {
      await ensureUserWithClient(client, user);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`captcha:${group}:${user}`]);
      await client.query("UPDATE captcha_challenges SET completed_at = NOW() WHERE group_id = $1 AND user_id = $2 AND completed_at IS NULL", [group, user]);
      await client.query(
        `INSERT INTO captcha_challenges
          (challenge_id, group_id, user_id, answer_hash, prompt, options, original_request, max_attempts, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, NOW() + ($9 * INTERVAL '1 second'))`,
        [challengeId, group, user, captchaAnswerHash(challengeId, answer), `Verification required: What is ${left} + ${right}?`, JSON.stringify(choices), JSON.stringify(safeJson(originalRequest, "originalRequest")), attempts, ttl]
      );
      return { challengeId, prompt: `Verification required: What is ${left} + ${right}?`, options: choices.map((value, index) => ({ index, label: String(value) })), expiresInSeconds: ttl };
    });
  }

  async function answerCaptchaChallenge({ challengeId: rawChallengeId, groupId: rawGroupId, userId: rawUserId, optionIndex, verificationSeconds = 2_592_000 }) {
    const challengeId = uuid(rawChallengeId, "challengeId");
    const group = chatId(rawGroupId, "groupId");
    const user = userId(rawUserId);
    const index = positiveInteger(optionIndex, "optionIndex", { maximum: 10 });
    const duration = positiveInteger(verificationSeconds, "verificationSeconds", { minimum: 300, maximum: 31_536_000 });
    return transaction(async (client) => {
      const result = await client.query("SELECT * FROM captcha_challenges WHERE challenge_id = $1 FOR UPDATE", [challengeId]);
      if (!result.rowCount) return { accepted: false, reason: "not_found" };
      const challenge = result.rows[0];
      if (String(challenge.group_id) !== group || String(challenge.user_id) !== user) return { accepted: false, reason: "wrong_user" };
      if (challenge.completed_at) return { accepted: false, reason: "completed" };
      if (new Date(challenge.expires_at) <= new Date()) {
        await client.query("UPDATE captcha_challenges SET completed_at = NOW() WHERE challenge_id = $1", [challengeId]);
        return { accepted: false, reason: "expired" };
      }
      if (Number(challenge.attempts) >= Number(challenge.max_attempts)) return { accepted: false, reason: "attempts_exhausted" };
      const answer = challenge.options?.[index];
      const correct = answer !== undefined && crypto.timingSafeEqual(Buffer.from(challenge.answer_hash), Buffer.from(captchaAnswerHash(challengeId, answer)));
      await client.query("UPDATE captcha_challenges SET attempts = attempts + 1, completed_at = CASE WHEN $2 OR attempts + 1 >= max_attempts THEN NOW() ELSE NULL END WHERE challenge_id = $1", [challengeId, correct]);
      if (!correct) return { accepted: false, reason: Number(challenge.attempts) + 1 >= Number(challenge.max_attempts) ? "attempts_exhausted" : "incorrect" };
      await client.query(
        `INSERT INTO group_user_verifications (group_id, user_id, verified_at, expires_at, verified_by)
         VALUES ($1, $2, NOW(), NOW() + ($3 * INTERVAL '1 second'), 'captcha')
         ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'verified', verified_at = NOW(),
           expires_at = EXCLUDED.expires_at, verified_by = 'captcha'`, [group, user, duration]
      );
      await client.query("UPDATE platform_users SET verified = TRUE, updated_at = NOW() WHERE user_id = $1", [user]);
      return { accepted: true, reason: "verified", originalRequest: challenge.original_request || {} };
    });
  }

  async function createWebLoginRequest({ stateHash, nonce, codeVerifierCiphertext, redirectUri, returnTo = "/", sourceHash = null, expiresAt }) {
    const state = bounded(stateHash, "stateHash", 64);
    if (!/^[a-f0-9]{64}$/.test(state)) throw new TypeError("stateHash is invalid");
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime())) throw new TypeError("expiresAt is invalid");
    return transaction(async (client) => {
      await client.query("DELETE FROM web_oidc_requests WHERE expires_at <= NOW()");
      await client.query(
        `INSERT INTO web_oidc_requests (state_hash, nonce, code_verifier_ciphertext, redirect_uri, return_to, source_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [state, bounded(nonce, "nonce", 200), bounded(codeVerifierCiphertext, "codeVerifierCiphertext", 2000), bounded(redirectUri, "redirectUri", 2000), bounded(returnTo, "returnTo", 1000), sourceHash, expiry]
      );
      return true;
    });
  }

  async function consumeWebLoginRequest(stateHash) {
    const state = bounded(stateHash, "stateHash", 64);
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE web_oidc_requests SET used_at = NOW() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > NOW()
         RETURNING *`, [state]
      );
      return result.rows[0] || null;
    });
  }

  async function createWebSession({ userId: rawUserId, token, csrfToken, idleExpiresAt, expiresAt }) {
    const user = userId(rawUserId);
    const idle = new Date(idleExpiresAt);
    const expiry = new Date(expiresAt);
    return transaction(async (client) => {
      await ensureUserWithClient(client, user);
      const sessionId = crypto.randomUUID();
      await client.query(
        `INSERT INTO web_sessions (session_id, token_hash, csrf_hash, user_id, idle_expires_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sessionId, sessionHash(token), sessionHash(csrfToken), user, idle, expiry]
      );
      return { sessionId, userId: user, idleExpiresAt: idle, expiresAt: expiry };
    });
  }

  async function getWebSession(token, { touchIdleSeconds = 1800 } = {}) {
    const hash = sessionHash(token);
    const idleSeconds = positiveInteger(touchIdleSeconds, "touchIdleSeconds", { minimum: 300, maximum: 86400 });
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE web_sessions SET last_seen_at = NOW(), idle_expires_at = LEAST(expires_at, NOW() + ($2 * INTERVAL '1 second'))
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW() AND idle_expires_at > NOW()
         RETURNING session_id, user_id::text, csrf_hash, idle_expires_at, expires_at`,
        [hash, idleSeconds]
      );
      return result.rows[0] || null;
    });
  }

  async function revokeWebSession(token) {
    const result = await transaction((client) => client.query("UPDATE web_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE token_hash = $1 RETURNING session_id", [sessionHash(token)]));
    return result.rowCount > 0;
  }

  async function getAdminAnalytics() {
    return transaction(async (client) => {
      const result = await client.query(`
        SELECT
          (SELECT COUNT(*)::int FROM platform_users) AS total_users,
          (SELECT COUNT(*)::int FROM platform_users WHERE created_at > NOW() - INTERVAL '30 days') AS new_users,
          (SELECT COUNT(*)::int FROM platform_users WHERE last_seen_at > NOW() - INTERVAL '7 days') AS active_users,
          (SELECT COUNT(*)::int FROM platform_users WHERE verified) AS verified_users,
          (SELECT COUNT(DISTINCT user_id)::int FROM telegram_star_payments) AS paying_users,
          (SELECT COUNT(*)::int FROM platform_users WHERE status IN ('restricted', 'banned') OR role IN ('restricted_user', 'banned_user')) AS restricted_users,
          (SELECT COUNT(*)::int FROM telegram_business_connections) AS secretary_connections,
          (SELECT COUNT(*)::int FROM secretary_access_requests WHERE status = 'pending') AS pending_secretary_requests,
          (SELECT COUNT(*)::int FROM secretary_entitlements WHERE source = 'telegram_stars' AND status = 'active') AS paid_secretary_activations,
          (SELECT COUNT(*)::int FROM telegram_groups WHERE active) AS active_groups,
          (SELECT COUNT(*)::int FROM ai_usage_events WHERE channel = 'telegram_group' AND status = 'completed') AS group_invocations,
          (SELECT COUNT(*)::int FROM ai_usage_events WHERE channel IN ('telegram_private', 'miniapp', 'web') AND status = 'completed') AS private_ai_requests,
          (SELECT COUNT(*)::int FROM ai_usage_events WHERE channel IN ('telegram_business', 'telegram_secretary') AND status = 'completed') AS secretary_ai_replies,
          (SELECT COUNT(*)::int FROM ai_usage_events WHERE billing_source = 'free' AND status = 'completed') AS free_requests_consumed,
          (SELECT COALESCE(SUM(credit_cost), 0)::bigint::text FROM ai_usage_events WHERE billing_source = 'credit' AND status = 'completed') AS credits_consumed,
          (SELECT COALESCE(SUM(amount), 0)::bigint::text FROM telegram_star_payments WHERE refunded_at IS NULL) AS stars_received,
          (SELECT COALESCE(SUM(credit_amount * maximum_redemptions), 0)::bigint::text FROM credit_vouchers) AS voucher_credits_issued,
          (SELECT COUNT(*)::int FROM voucher_redemptions) AS voucher_redemptions,
          (SELECT COUNT(*)::int FROM ai_usage_events WHERE status = 'failed') AS failed_generations
      `);
      return result.rows[0];
    });
  }

  async function getUserAnalytics(rawUserId) {
    const user = userId(rawUserId);
    return transaction(async (client) => {
      const profile = await client.query(
        `SELECT users.user_id::text, users.username, users.first_name, users.last_name, users.language_code,
                users.role, users.plan, users.status, users.verified, users.created_at, users.last_seen_at,
                users.first_interaction_source, users.last_interaction_source,
                COALESCE(accounts.balance, 0)::text AS balance, COALESCE(controls.unlimited_credits, FALSE) AS unlimited_credits
         FROM platform_users AS users
         LEFT JOIN telegram_star_accounts AS accounts ON accounts.user_id = users.user_id
         LEFT JOIN telegram_user_controls AS controls ON controls.user_id = users.user_id WHERE users.user_id = $1`, [user]
      );
      if (!profile.rowCount) return null;
      // A checked-out pg client executes one query at a time. Keep this sequence explicit so
      // the administrator user view remains reliable with current and future pg releases.
      const usage = await client.query("SELECT channel, billing_source, status, COUNT(*)::int AS count FROM ai_usage_events WHERE owner_user_id = $1 GROUP BY channel, billing_source, status", [user]);
      const payments = await client.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::bigint::text AS stars FROM telegram_star_payments WHERE user_id = $1", [user]);
      const vouchers = await client.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(credits_added), 0)::bigint::text AS credits FROM voucher_redemptions WHERE user_id = $1", [user]);
      const groups = await client.query("SELECT COUNT(DISTINCT group_id)::int AS count FROM group_user_verifications WHERE user_id = $1", [user]);
      const connections = await client.query("SELECT connection_id, access_status, enabled, can_reply, updated_at FROM telegram_business_connections WHERE owner_user_id = $1 ORDER BY updated_at DESC", [user]);
      const access = await client.query("SELECT request_id, connection_id, status, created_at, decided_at FROM secretary_access_requests WHERE owner_user_id = $1 ORDER BY created_at DESC", [user]);
      const notes = await client.query(
        `SELECT note_id, author_user_id::text, note, created_at
         FROM user_admin_notes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [user]
      );
      const policies = await client.query(
        `SELECT policy_id, scope_type, scope_id, feature_key, channel, free_successes,
                window_seconds, active, updated_at
         FROM ai_usage_policies
         WHERE (scope_type = 'user' AND scope_id = $1) OR (scope_type = 'global' AND scope_id = '*')
         ORDER BY CASE WHEN scope_type = 'user' THEN 0 ELSE 1 END, updated_at DESC`,
        [user]
      );
      return {
        ...profile.rows[0],
        usage: usage.rows,
        payments: payments.rows[0],
        vouchers: vouchers.rows[0],
        groupsUsed: groups.rows[0].count,
        businessConnections: connections.rows,
        accessRequests: access.rows,
        notes: notes.rows,
        usagePolicies: policies.rows
      };
    });
  }

  return {
    ensureSecretaryAccess,
    requestSecretaryAccess,
    decideSecretaryAccess,
    activateSecretaryPayment,
    recordSecretaryRefund,
    listSecretaryAccessRequests,
    updateSecretarySettings,
    setSecretaryAccessStatus,
    getSecretaryContactSettings,
    listSecretaryContacts,
    updateSecretaryContactSettings,
    markSecretaryIntroductionSent,
    markSecretaryOnboardingSent,
    reserveFreeUsage,
    recordUsageReservation,
    finishUsageEvent,
    getUsageAllowance,
    setUsagePolicy,
    listUsagePolicies,
    createVoucher,
    redeemVoucher,
    listVouchers,
    revokeVoucher,
    isGroupUserVerified,
    verifyGroupUser,
    createCaptchaChallenge,
    answerCaptchaChallenge,
    createWebLoginRequest,
    consumeWebLoginRequest,
    createWebSession,
    getWebSession,
    revokeWebSession,
    getAdminAnalytics,
    getUserAnalytics
  };
}
