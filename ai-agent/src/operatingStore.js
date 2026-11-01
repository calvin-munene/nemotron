import crypto from "node:crypto";
import { normalizePlatformRole } from "./rbac.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INT64 = 9_223_372_036_854_775_807n;

function userId(value, field = "userId") {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > MAX_INT64) throw new TypeError(`${field} is invalid`);
  return BigInt(text).toString();
}

function chatId(value) {
  const text = String(value ?? "");
  if (!/^-?[1-9]\d*$/.test(text) || BigInt(text) > MAX_INT64 || BigInt(text) < -MAX_INT64) throw new TypeError("chatId is invalid");
  return BigInt(text).toString();
}

function requestId(value) {
  const text = String(value || "").toLowerCase();
  if (!UUID_V4.test(text)) throw new TypeError("requestId must be a UUID v4");
  return text;
}

function uuid(value, field = "id") {
  const text = String(value || "").toLowerCase();
  if (!UUID.test(text)) throw new TypeError(`${field} must be a UUID`);
  return text;
}

function bounded(value, field, maximum, { optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return null;
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum) throw new TypeError(`${field} must contain 1-${maximum} characters`);
  return text;
}

function boolean(value, field) {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function limit(value, fallback = 50, maximum = 250) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : fallback;
}

function jsonObject(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function stringArray(value, field, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${field} must be an array with at most ${maximum} values`);
  return [...new Set(value.map((entry) => bounded(entry, field, 255).toLowerCase()))];
}

function managedUserRow(row) {
  return {
    userId: String(row.user_id),
    role: row.role,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    username: row.username || null,
    languageCode: row.language_code || null,
    plan: row.plan || "standard",
    status: row.status || "active",
    verified: row.verified === true,
    firstInteractionSource: row.first_interaction_source || null,
    lastInteractionSource: row.last_interaction_source || null,
    banned: row.banned === true,
    banReason: row.ban_reason || null,
    unlimitedCredits: row.unlimited_credits === true,
    balance: String(row.balance ?? "0"),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at
  };
}

function groupRow(row) {
  return {
    chatId: String(row.chat_id),
    title: row.title,
    username: row.username || null,
    chatType: row.chat_type,
    active: row.active === true,
    botStatus: row.bot_status,
    botIsAdministrator: row.bot_is_administrator === true || ["creator", "administrator"].includes(row.bot_status),
    botPermissions: row.bot_permissions || {},
    memberCount: row.member_count === null ? null : Number(row.member_count),
    lastEventAt: row.last_event_at,
    lastSeenAt: row.last_seen_at || row.last_event_at,
    updatedAt: row.updated_at,
    settings: row.settings_snapshot ? groupSettingsRow(row.settings_snapshot) : undefined
  };
}

function groupSettingsRow(row) {
  if (!row) return null;
  return {
    chatId: String(row.chat_id),
    enabled: row.enabled === true,
    moderationEnabled: row.moderation_enabled === true,
    guardEnabled: row.guard_enabled === true,
    secretaryEnabled: row.secretary_enabled === true,
    secretaryObservationEnabled: row.secretary_observation_enabled === true,
    messageStorageEnabled: row.message_storage_enabled === true,
    retentionDays: Number(row.retention_days || 7),
    activationPolicy: row.activation_policy || "mention_only",
    defaultMode: row.default_mode || "chat",
    responseVisibility: row.response_visibility || "reply",
    botToBotEnabled: row.bot_to_bot_enabled === true,
    botToBotAllowlist: row.bot_to_bot_allowlist || [],
    alwaysOnConfirmed: Boolean(row.always_on_confirmed_at),
    alwaysOnConfirmedAt: row.always_on_confirmed_at || null,
    threadIsolationEnabled: row.thread_isolation_enabled !== false,
    delegationPolicy: row.delegation_policy || {},
    welcomeEnabled: row.welcome_enabled === true,
    welcomeMessage: row.welcome_message || null,
    goodbyeEnabled: row.goodbye_enabled === true,
    goodbyeMessage: row.goodbye_message || null,
    rules: row.rules || null,
    warningThreshold: Number(row.warning_threshold),
    warningAction: row.warning_action,
    warningMuteSeconds: Number(row.warning_mute_seconds),
    antiFloodEnabled: row.anti_flood_enabled === true,
    antiLinkEnabled: row.anti_link_enabled === true,
    antiCapsEnabled: row.anti_caps_enabled === true,
    antiSpamEnabled: row.anti_spam_enabled === true,
    blockedWords: row.blocked_words || [],
    allowedDomains: row.allowed_domains || [],
    blockedDomains: row.blocked_domains || [],
    guardPolicy: row.guard_policy || {},
    secretaryPolicy: row.secretary_policy || {},
    captchaEnabled: row.captcha_enabled !== false,
    captchaVerificationSeconds: Number(row.captcha_verification_seconds || 2592000),
    captchaMaxAttempts: Number(row.captcha_max_attempts || 3),
    captchaRetryCooldownSeconds: Number(row.captcha_retry_cooldown_seconds || 300),
    captchaExemptAdministrators: row.captcha_exempt_administrators !== false,
    groupModel: row.group_model || null,
    groupTone: row.group_tone || "adaptive",
    groupLanguage: row.group_language || "auto",
    groupResponseLength: row.group_response_length || "balanced",
    groupCreativity: Number(row.group_creativity ?? 0.4),
    groupInstructions: row.group_instructions || null,
    allowedTopics: row.allowed_topics || [],
    updatedAt: row.updated_at
  };
}

function businessConnectionRow(row) {
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    ownerUserId: String(row.owner_user_id),
    userChatId: row.user_chat_id === null ? null : String(row.user_chat_id),
    enabled: row.enabled === true,
    canReply: row.can_reply === true,
    rights: row.rights || {},
    allowedChatConfiguration: row.allowed_chat_configuration || {},
    accessStatus: row.access_status || "pending_access",
    accessActive: ["active_admin_approved", "active_paid"].includes(row.access_status),
    autoReplyEnabled: row.auto_reply_enabled === true,
    businessStyle: row.business_style || "friendly",
    customStyle: row.custom_style || null,
    defaultLanguage: row.default_language || "auto",
    retentionDays: Number(row.retention_days || 30),
    activationVersion: Number(row.activation_version || 1),
    onboardingSentAt: row.onboarding_sent_at || null,
    connectedAt: row.connected_at,
    lastVerifiedAt: row.last_verified_at,
    updatedAt: row.updated_at
  };
}

function botProfileRow(row) {
  return {
    id: row.bot_profile_id,
    ownerUserId: String(row.owner_user_id),
    displayName: row.display_name,
    telegramBotId: row.telegram_bot_id === null ? null : String(row.telegram_bot_id),
    telegramUsername: row.telegram_username || null,
    status: row.status,
    configuration: row.configuration || {},
    hasCredential: row.has_credential === true,
    lastHealthAt: row.last_health_at || null,
    lastErrorCode: row.last_error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createOperatingStore({ transaction, ensureUserWithClient }) {
  if (typeof transaction !== "function" || typeof ensureUserWithClient !== "function") {
    throw new TypeError("Operating store requires transaction helpers");
  }

  async function syncUserProfile(profile) {
    const id = userId(profile?.id);
    const firstName = profile?.first_name ? bounded(profile.first_name, "firstName", 128) : null;
    const lastName = profile?.last_name ? bounded(profile.last_name, "lastName", 128) : null;
    const username = profile?.username ? bounded(profile.username, "username", 64) : null;
    const languageCode = profile?.language_code ? bounded(profile.language_code, "languageCode", 16) : null;
    const source = profile?.interactionSource ? bounded(profile.interactionSource, "interactionSource", 64) : null;
    return transaction(async (client) => {
      await ensureUserWithClient(client, id);
      const result = await client.query(
        `UPDATE platform_users SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
           username = COALESCE($4, username), language_code = COALESCE($5, language_code),
           first_interaction_source = COALESCE(first_interaction_source, $6),
           last_interaction_source = COALESCE($6, last_interaction_source), last_seen_at = NOW(), updated_at = NOW()
         WHERE user_id = $1
         RETURNING user_id::text, role, first_name, last_name, username, language_code, plan, status,
           verified, first_interaction_source, last_interaction_source, created_at, last_seen_at, updated_at`,
        [id, firstName, lastName, username, languageCode, source]
      );
      return result.rows[0];
    });
  }

  async function listManagedUsers({ search = "", limit: rawLimit = 50 } = {}) {
    const query = String(search || "").trim().slice(0, 100);
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT users.user_id::text, users.role, users.first_name, users.last_name, users.username,
                users.created_at, users.last_seen_at, users.updated_at,
                COALESCE(controls.banned, FALSE) AS banned, controls.ban_reason,
                COALESCE(controls.unlimited_credits, FALSE) AS unlimited_credits,
                COALESCE(accounts.balance, 0)::text AS balance
         FROM platform_users AS users
         LEFT JOIN telegram_user_controls AS controls ON controls.user_id = users.user_id
         LEFT JOIN telegram_star_accounts AS accounts ON accounts.user_id = users.user_id
         WHERE ($1 = '' OR users.user_id::text = $1 OR users.username ILIKE '%' || $1 || '%'
           OR concat_ws(' ', users.first_name, users.last_name) ILIKE '%' || $1 || '%')
         ORDER BY users.last_seen_at DESC, users.user_id DESC LIMIT $2`,
        [query, limit(rawLimit)]
      );
      return result.rows.map(managedUserRow);
    });
  }

  async function getManagedUser(rawUserId) {
    const id = userId(rawUserId);
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT users.user_id::text, users.role, users.first_name, users.last_name, users.username,
                users.created_at, users.last_seen_at, users.updated_at,
                COALESCE(controls.banned, FALSE) AS banned, controls.ban_reason,
                COALESCE(controls.unlimited_credits, FALSE) AS unlimited_credits,
                COALESCE(accounts.balance, 0)::text AS balance
         FROM platform_users AS users
         LEFT JOIN telegram_user_controls AS controls ON controls.user_id = users.user_id
         LEFT JOIN telegram_star_accounts AS accounts ON accounts.user_id = users.user_id
         WHERE users.user_id = $1`,
        [id]
      );
      if (!result.rowCount) return null;
      const notes = await client.query(
        `SELECT note_id, author_user_id::text, note, created_at FROM user_admin_notes
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id]
      );
      return { ...managedUserRow(result.rows[0]), notes: notes.rows };
    });
  }

  async function manageUser({ actorUserId, userId: rawUserId, requestId: rawRequestId, role, banned, banReason, unlimitedCredits, creditDelta, note, allowPrivilegedChanges = false }) {
    const actor = userId(actorUserId, "actorUserId");
    const target = userId(rawUserId);
    const operationId = requestId(rawRequestId);
    const nextRole = role === undefined ? undefined : normalizePlatformRole(role);
    if (banned !== undefined) boolean(banned, "banned");
    if (unlimitedCredits !== undefined) boolean(unlimitedCredits, "unlimitedCredits");
    const reason = banReason === undefined || banReason === null || banReason === "" ? null : bounded(banReason, "banReason", 1000);
    const adminNote = note === undefined || note === null || note === "" ? null : bounded(note, "note", 2000);
    const delta = creditDelta === undefined ? 0 : Number(creditDelta);
    if (!Number.isSafeInteger(delta) || delta < -1_000_000 || delta > 1_000_000) throw new TypeError("creditDelta is invalid");
    if ([nextRole, banned, unlimitedCredits, adminNote].every((value) => value === undefined || value === null) && delta === 0) {
      throw new TypeError("At least one user change is required");
    }
    const requested = { role: nextRole, banned, banReason: reason, unlimitedCredits, creditDelta: delta, note: adminNote };
    return transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationId]);
      const duplicate = await client.query("SELECT action, target_id, metadata FROM audit_logs WHERE request_id = $1", [operationId]);
      if (duplicate.rowCount) {
        if (duplicate.rows[0].action !== "platform_user.managed" || duplicate.rows[0].target_id !== target) {
          const error = new Error("requestId was already used for a different operation");
          error.statusCode = 409;
          throw error;
        }
        return { duplicate: true, user: await readManagedUser(client, target) };
      }
      await ensureUserWithClient(client, actor);
      await ensureUserWithClient(client, target);
      const targetRole = await client.query("SELECT role FROM platform_users WHERE user_id = $1 FOR UPDATE", [target]);
      if (!allowPrivilegedChanges && (["admin", "super_admin"].includes(targetRole.rows[0]?.role)
        || nextRole !== undefined || unlimitedCredits !== undefined || delta !== 0)) {
        const error = new Error("Only the Super Admin can perform this user-management change");
        error.statusCode = 403;
        throw error;
      }
      await client.query(
        `INSERT INTO telegram_star_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [target]
      );
      await client.query(
        `INSERT INTO telegram_user_controls (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [target]
      );
      if (nextRole !== undefined) await client.query("UPDATE platform_users SET role = $2, updated_at = NOW() WHERE user_id = $1", [target, nextRole]);
      if (banned !== undefined || unlimitedCredits !== undefined) {
        await client.query(
          `UPDATE telegram_user_controls SET banned = COALESCE($2, banned),
             ban_reason = CASE WHEN $2 = FALSE THEN NULL WHEN $2 = TRUE THEN $3 ELSE ban_reason END,
             unlimited_credits = COALESCE($4, unlimited_credits), updated_at = NOW()
           WHERE user_id = $1`,
          [target, banned, reason, unlimitedCredits]
        );
      }
      if (delta !== 0) {
        const balance = await client.query(
          `UPDATE telegram_star_accounts SET balance = balance + $2, updated_at = NOW()
           WHERE user_id = $1 AND balance + $2 >= 0 RETURNING balance::text`,
          [target, delta]
        );
        if (!balance.rowCount) {
          const error = new Error("Credit adjustment would make the balance negative");
          error.statusCode = 409;
          throw error;
        }
      }
      if (adminNote) {
        await client.query(
          `INSERT INTO user_admin_notes (note_id, user_id, author_user_id, note) VALUES ($1, $2, $3, $4)`,
          [crypto.randomUUID(), target, actor, adminNote]
        );
      }
      await client.query(
        `INSERT INTO audit_logs (request_id, actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'platform_user.managed', 'user', $3, $4::jsonb)`,
        [operationId, actor, target, JSON.stringify({ ...requested, note: adminNote ? "[recorded]" : null })]
      );
      return { duplicate: false, user: await readManagedUser(client, target) };
    });
  }

  async function readManagedUser(client, id) {
    const result = await client.query(
      `SELECT users.user_id::text, users.role, users.first_name, users.last_name, users.username,
              users.created_at, users.last_seen_at, users.updated_at,
              COALESCE(controls.banned, FALSE) AS banned, controls.ban_reason,
              COALESCE(controls.unlimited_credits, FALSE) AS unlimited_credits,
              COALESCE(accounts.balance, 0)::text AS balance
       FROM platform_users AS users
       LEFT JOIN telegram_user_controls AS controls ON controls.user_id = users.user_id
       LEFT JOIN telegram_star_accounts AS accounts ON accounts.user_id = users.user_id
       WHERE users.user_id = $1`,
      [id]
    );
    return result.rowCount ? managedUserRow(result.rows[0]) : null;
  }

  async function upsertTelegramGroup({ chat, botMember = null, memberCount = null }) {
    const id = chatId(chat?.id);
    const type = String(chat?.type || "");
    if (!["group", "supergroup", "channel"].includes(type)) throw new TypeError("Unsupported Telegram group type");
    const title = bounded(chat?.title || chat?.username || `Telegram ${id}`, "title", 255);
    const username = chat?.username ? bounded(chat.username, "username", 64) : null;
    const status = ["creator", "administrator", "member", "restricted", "left", "kicked"].includes(botMember?.status) ? botMember.status : "unknown";
    const active = !["left", "kicked"].includes(status);
    const botIsAdministrator = ["creator", "administrator"].includes(status);
    const permissions = botMember && typeof botMember === "object" ? Object.fromEntries(
      Object.entries(botMember).filter(([key, value]) => key.startsWith("can_") && typeof value === "boolean")
    ) : {};
    const count = memberCount === null || memberCount === undefined ? null : Number(memberCount);
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new TypeError("memberCount is invalid");
    return transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO telegram_groups
          (chat_id, title, username, chat_type, active, bot_status, bot_is_administrator, bot_permissions, member_count, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW())
         ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, username = EXCLUDED.username,
           chat_type = EXCLUDED.chat_type,
           active = CASE WHEN EXCLUDED.bot_status = 'unknown' THEN telegram_groups.active ELSE EXCLUDED.active END,
           bot_status = CASE WHEN EXCLUDED.bot_status = 'unknown' THEN telegram_groups.bot_status ELSE EXCLUDED.bot_status END,
           bot_is_administrator = CASE WHEN EXCLUDED.bot_status = 'unknown' THEN telegram_groups.bot_is_administrator ELSE EXCLUDED.bot_is_administrator END,
           bot_permissions = CASE WHEN EXCLUDED.bot_status = 'unknown' THEN telegram_groups.bot_permissions ELSE EXCLUDED.bot_permissions END,
           member_count = COALESCE(EXCLUDED.member_count, telegram_groups.member_count),
           last_event_at = NOW(), last_seen_at = NOW(), updated_at = NOW()
         RETURNING *`,
        [id, title, username, type, active, status, botIsAdministrator, JSON.stringify(permissions), count]
      );
      await client.query("INSERT INTO telegram_group_settings (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING", [id]);
      if (botMember) {
        await client.query(
          `INSERT INTO telegram_group_bot_permissions (chat_id, member_status, permission_snapshot, verified_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (chat_id) DO UPDATE SET member_status = EXCLUDED.member_status,
             permission_snapshot = EXCLUDED.permission_snapshot, verified_at = NOW()`,
          [id, status, JSON.stringify(permissions)]
        );
      }
      return groupRow(result.rows[0]);
    });
  }

  async function syncGroupMember({ chatId: rawChatId, member }) {
    const groupId = chatId(rawChatId);
    const id = userId(member?.user?.id);
    const status = ["creator", "administrator", "member", "restricted", "left", "kicked"].includes(member?.status) ? member.status : "unknown";
    const permissions = Object.fromEntries(Object.entries(member || {}).filter(([key, value]) => key.startsWith("can_") && typeof value === "boolean"));
    return transaction(async (client) => {
      await ensureUserWithClient(client, id);
      await client.query(
        `UPDATE platform_users SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
          username = COALESCE($4, username), last_seen_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
        [id, member?.user?.first_name || null, member?.user?.last_name || null, member?.user?.username || null]
      );
      await client.query(
        `INSERT INTO telegram_group_members (chat_id, user_id, telegram_status, permissions)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (chat_id, user_id) DO UPDATE SET telegram_status = EXCLUDED.telegram_status,
           permissions = EXCLUDED.permissions, last_seen_at = NOW(), updated_at = NOW()`,
        [groupId, id, status, JSON.stringify(permissions)]
      );
      return { chatId: groupId, userId: id, status, permissions };
    });
  }

  async function listTelegramGroups({ userId: rawUserId = null, search = "", limit: rawLimit = 50 } = {}) {
    const owner = rawUserId === null || rawUserId === undefined ? null : userId(rawUserId);
    const query = String(search || "").trim().slice(0, 100);
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT groups.*, to_jsonb(settings) AS settings_snapshot
         FROM telegram_groups AS groups
         LEFT JOIN telegram_group_settings AS settings USING (chat_id)
         WHERE ($1::bigint IS NULL OR EXISTS (
             SELECT 1 FROM telegram_group_members AS members WHERE members.chat_id = groups.chat_id
               AND members.user_id = $1 AND members.telegram_status IN ('creator', 'administrator')
           ))
           AND ($2 = '' OR groups.chat_id::text = $2 OR groups.title ILIKE '%' || $2 || '%' OR groups.username ILIKE '%' || $2 || '%')
         ORDER BY groups.updated_at DESC LIMIT $3`,
        [owner, query, limit(rawLimit)]
      );
      return result.rows.map(groupRow);
    });
  }

  async function getTelegramGroup(rawChatId) {
    const id = chatId(rawChatId);
    return transaction(async (client) => {
      const group = await client.query("SELECT * FROM telegram_groups WHERE chat_id = $1", [id]);
      if (!group.rowCount) return null;
      const [settings, permissions, actions, warnings, guard] = await Promise.all([
        client.query("SELECT * FROM telegram_group_settings WHERE chat_id = $1", [id]),
        client.query("SELECT member_status, permission_snapshot, verified_at FROM telegram_group_bot_permissions WHERE chat_id = $1", [id]),
        client.query("SELECT * FROM group_moderation_actions WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 100", [id]),
        client.query("SELECT warning_id, user_id::text, issued_by::text, reason, active, removed_at, created_at FROM group_warnings WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 100", [id]),
        client.query("SELECT join_request_id, user_id::text, requested_at, status, user_snapshot, decision_reason, decided_at FROM guard_join_requests WHERE chat_id = $1 ORDER BY requested_at DESC LIMIT 100", [id])
      ]);
      return {
        group: groupRow(group.rows[0]),
        settings: groupSettingsRow(settings.rows[0]),
        botPermissionSnapshot: permissions.rows[0] ? {
          status: permissions.rows[0].member_status,
          permissions: permissions.rows[0].permission_snapshot || {},
          verifiedAt: permissions.rows[0].verified_at
        } : null,
        actions: actions.rows,
        warnings: warnings.rows,
        guardRequests: guard.rows
      };
    });
  }

  async function getGroupMember(rawChatId, rawUserId) {
    const groupId = chatId(rawChatId);
    const id = userId(rawUserId);
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT user_id::text, telegram_status, permissions, joined_at, last_seen_at, updated_at
         FROM telegram_group_members WHERE chat_id = $1 AND user_id = $2`,
        [groupId, id]
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return { userId: row.user_id, status: row.telegram_status, permissions: row.permissions || {}, joinedAt: row.joined_at, lastSeenAt: row.last_seen_at, updatedAt: row.updated_at };
    });
  }

  async function updateGroupSettings({ actorUserId, chatId: rawChatId, requestId: rawRequestId, changes }) {
    const actor = userId(actorUserId, "actorUserId");
    const id = chatId(rawChatId);
    const operationId = requestId(rawRequestId);
    const input = jsonObject(changes, "changes");
    const normalized = {};
    for (const key of [
      "enabled", "moderationEnabled", "guardEnabled", "secretaryEnabled", "secretaryObservationEnabled",
      "messageStorageEnabled", "botToBotEnabled", "alwaysOnConfirmed", "threadIsolationEnabled",
      "welcomeEnabled", "goodbyeEnabled", "antiFloodEnabled", "antiLinkEnabled", "antiCapsEnabled", "antiSpamEnabled",
      "captchaEnabled", "captchaExemptAdministrators"
    ]) {
      if (input[key] !== undefined) normalized[key] = boolean(input[key], key);
    }
    for (const [key, maximum] of [["welcomeMessage", 2000], ["goodbyeMessage", 2000], ["rules", 10000], ["groupInstructions", 5000]]) {
      if (input[key] !== undefined) normalized[key] = input[key] === null || input[key] === "" ? null : bounded(input[key], key, maximum);
    }
    if (input.warningThreshold !== undefined) {
      normalized.warningThreshold = Number(input.warningThreshold);
      if (!Number.isSafeInteger(normalized.warningThreshold) || normalized.warningThreshold < 1 || normalized.warningThreshold > 20) throw new TypeError("warningThreshold is invalid");
    }
    if (input.warningAction !== undefined) {
      normalized.warningAction = String(input.warningAction);
      if (!["none", "mute", "kick", "ban"].includes(normalized.warningAction)) throw new TypeError("warningAction is invalid");
    }
    if (input.warningMuteSeconds !== undefined) {
      normalized.warningMuteSeconds = Number(input.warningMuteSeconds);
      if (!Number.isSafeInteger(normalized.warningMuteSeconds) || normalized.warningMuteSeconds < 30 || normalized.warningMuteSeconds > 31_536_000) throw new TypeError("warningMuteSeconds is invalid");
    }
    if (input.activationPolicy !== undefined) {
      normalized.activationPolicy = String(input.activationPolicy);
      if (!["mention_only", "command_only", "mention_command_or_reply", "administrators_only", "always_on"].includes(normalized.activationPolicy)) throw new TypeError("activationPolicy is invalid");
      if (normalized.activationPolicy === "always_on" && input.alwaysOnConfirmed !== true) throw new TypeError("always_on requires explicit owner confirmation");
    }
    if (input.defaultMode !== undefined) {
      normalized.defaultMode = bounded(input.defaultMode, "defaultMode", 64).toLowerCase();
      if (!/^[a-z0-9_]+$/.test(normalized.defaultMode)) throw new TypeError("defaultMode is invalid");
    }
    if (input.responseVisibility !== undefined) {
      normalized.responseVisibility = String(input.responseVisibility);
      if (!["reply", "public", "silent"].includes(normalized.responseVisibility)) throw new TypeError("responseVisibility is invalid");
    }
    if (input.retentionDays !== undefined) {
      normalized.retentionDays = Number(input.retentionDays);
      if (!Number.isSafeInteger(normalized.retentionDays) || normalized.retentionDays < 1 || normalized.retentionDays > 90) throw new TypeError("retentionDays is invalid");
    }
    for (const [key, minimum, maximum] of [
      ["captchaVerificationSeconds", 300, 31_536_000],
      ["captchaMaxAttempts", 1, 10],
      ["captchaRetryCooldownSeconds", 30, 86_400]
    ]) {
      if (input[key] !== undefined) {
        normalized[key] = Number(input[key]);
        if (!Number.isSafeInteger(normalized[key]) || normalized[key] < minimum || normalized[key] > maximum) throw new TypeError(`${key} is invalid`);
      }
    }
    if (input.groupModel !== undefined) normalized.groupModel = input.groupModel === null || input.groupModel === "" ? null : bounded(input.groupModel, "groupModel", 200);
    if (input.groupTone !== undefined) {
      normalized.groupTone = String(input.groupTone);
      if (!["adaptive", "formal", "casual", "friendly", "concise"].includes(normalized.groupTone)) throw new TypeError("groupTone is invalid");
    }
    if (input.groupLanguage !== undefined) normalized.groupLanguage = bounded(input.groupLanguage, "groupLanguage", 32).toLowerCase();
    if (input.groupResponseLength !== undefined) {
      normalized.groupResponseLength = String(input.groupResponseLength);
      if (!["concise", "balanced", "detailed"].includes(normalized.groupResponseLength)) throw new TypeError("groupResponseLength is invalid");
    }
    if (input.groupCreativity !== undefined) {
      normalized.groupCreativity = Number(input.groupCreativity);
      if (!Number.isFinite(normalized.groupCreativity) || normalized.groupCreativity < 0 || normalized.groupCreativity > 1) throw new TypeError("groupCreativity is invalid");
    }
    for (const key of ["blockedWords", "allowedDomains", "blockedDomains", "botToBotAllowlist"]) if (input[key] !== undefined) normalized[key] = stringArray(input[key], key);
    if (input.allowedTopics !== undefined) normalized.allowedTopics = stringArray(input.allowedTopics, "allowedTopics", 100);
    for (const key of ["guardPolicy", "secretaryPolicy", "delegationPolicy"]) if (input[key] !== undefined) normalized[key] = jsonObject(input[key], key);
    if (!Object.keys(normalized).length) throw new TypeError("At least one group setting is required");
    return transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationId]);
      const duplicate = await client.query("SELECT action, target_id FROM audit_logs WHERE request_id = $1", [operationId]);
      if (duplicate.rowCount) {
        if (duplicate.rows[0].action !== "telegram_group.settings.updated" || duplicate.rows[0].target_id !== id) {
          const error = new Error("requestId was already used for a different operation");
          error.statusCode = 409;
          throw error;
        }
        const current = await client.query("SELECT * FROM telegram_group_settings WHERE chat_id = $1", [id]);
        return { duplicate: true, settings: groupSettingsRow(current.rows[0]) };
      }
      await ensureUserWithClient(client, actor);
      const result = await client.query(
        `UPDATE telegram_group_settings SET
          enabled = COALESCE($2, enabled), moderation_enabled = COALESCE($3, moderation_enabled),
          guard_enabled = COALESCE($4, guard_enabled), secretary_enabled = COALESCE($5, secretary_enabled),
          welcome_enabled = COALESCE($6, welcome_enabled), welcome_message = CASE WHEN $7::boolean THEN $8 ELSE welcome_message END,
          goodbye_enabled = COALESCE($9, goodbye_enabled), goodbye_message = CASE WHEN $10::boolean THEN $11 ELSE goodbye_message END,
          rules = CASE WHEN $12::boolean THEN $13 ELSE rules END,
          warning_threshold = COALESCE($14, warning_threshold), warning_action = COALESCE($15, warning_action),
          warning_mute_seconds = COALESCE($16, warning_mute_seconds), anti_flood_enabled = COALESCE($17, anti_flood_enabled),
          anti_link_enabled = COALESCE($18, anti_link_enabled), anti_caps_enabled = COALESCE($19, anti_caps_enabled),
          anti_spam_enabled = COALESCE($20, anti_spam_enabled),
          blocked_words = COALESCE($21::jsonb, blocked_words), allowed_domains = COALESCE($22::jsonb, allowed_domains),
          blocked_domains = COALESCE($23::jsonb, blocked_domains), guard_policy = COALESCE($24::jsonb, guard_policy),
          secretary_policy = COALESCE($25::jsonb, secretary_policy),
          activation_policy = COALESCE($26, activation_policy), default_mode = COALESCE($27, default_mode),
          response_visibility = COALESCE($28, response_visibility),
          secretary_observation_enabled = COALESCE($29, secretary_observation_enabled),
          message_storage_enabled = COALESCE($30, message_storage_enabled), retention_days = COALESCE($31, retention_days),
          bot_to_bot_enabled = COALESCE($32, bot_to_bot_enabled),
          bot_to_bot_allowlist = COALESCE($33::jsonb, bot_to_bot_allowlist),
          always_on_confirmed_at = CASE WHEN $34::boolean THEN CASE WHEN $35::boolean THEN NOW() ELSE NULL END ELSE always_on_confirmed_at END,
          thread_isolation_enabled = COALESCE($36, thread_isolation_enabled),
          delegation_policy = COALESCE($37::jsonb, delegation_policy), updated_by = $38,
          captcha_enabled = COALESCE($39, captcha_enabled),
          captcha_verification_seconds = COALESCE($40, captcha_verification_seconds),
          captcha_max_attempts = COALESCE($41, captcha_max_attempts),
          captcha_retry_cooldown_seconds = COALESCE($42, captcha_retry_cooldown_seconds),
          captcha_exempt_administrators = COALESCE($43, captcha_exempt_administrators),
          group_model = CASE WHEN $44::boolean THEN $45 ELSE group_model END,
          group_tone = COALESCE($46, group_tone), group_language = COALESCE($47, group_language),
          group_response_length = COALESCE($48, group_response_length), group_creativity = COALESCE($49, group_creativity),
          group_instructions = CASE WHEN $50::boolean THEN $51 ELSE group_instructions END,
          allowed_topics = COALESCE($52::jsonb, allowed_topics), updated_at = NOW()
         WHERE chat_id = $1 RETURNING *`,
        [id, normalized.enabled, normalized.moderationEnabled, normalized.guardEnabled, normalized.secretaryEnabled,
          normalized.welcomeEnabled, Object.hasOwn(normalized, "welcomeMessage"), normalized.welcomeMessage,
          normalized.goodbyeEnabled, Object.hasOwn(normalized, "goodbyeMessage"), normalized.goodbyeMessage,
          Object.hasOwn(normalized, "rules"), normalized.rules, normalized.warningThreshold, normalized.warningAction,
          normalized.warningMuteSeconds, normalized.antiFloodEnabled, normalized.antiLinkEnabled, normalized.antiCapsEnabled,
          normalized.antiSpamEnabled, normalized.blockedWords ? JSON.stringify(normalized.blockedWords) : null,
          normalized.allowedDomains ? JSON.stringify(normalized.allowedDomains) : null,
          normalized.blockedDomains ? JSON.stringify(normalized.blockedDomains) : null,
          normalized.guardPolicy ? JSON.stringify(normalized.guardPolicy) : null,
          normalized.secretaryPolicy ? JSON.stringify(normalized.secretaryPolicy) : null,
          normalized.activationPolicy, normalized.defaultMode, normalized.responseVisibility,
          normalized.secretaryObservationEnabled, normalized.messageStorageEnabled, normalized.retentionDays,
          normalized.botToBotEnabled, normalized.botToBotAllowlist ? JSON.stringify(normalized.botToBotAllowlist) : null,
          Object.hasOwn(normalized, "alwaysOnConfirmed"), normalized.alwaysOnConfirmed,
          normalized.threadIsolationEnabled, normalized.delegationPolicy ? JSON.stringify(normalized.delegationPolicy) : null,
          actor, normalized.captchaEnabled, normalized.captchaVerificationSeconds, normalized.captchaMaxAttempts,
          normalized.captchaRetryCooldownSeconds, normalized.captchaExemptAdministrators,
          Object.hasOwn(normalized, "groupModel"), normalized.groupModel, normalized.groupTone, normalized.groupLanguage,
          normalized.groupResponseLength, normalized.groupCreativity, Object.hasOwn(normalized, "groupInstructions"),
          normalized.groupInstructions, normalized.allowedTopics ? JSON.stringify(normalized.allowedTopics) : null]
      );
      if (!result.rowCount) {
        const error = new Error("Telegram group was not found");
        error.statusCode = 404;
        throw error;
      }
      await client.query(
        `INSERT INTO audit_logs (request_id, actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'telegram_group.settings.updated', 'telegram_group', $3, $4::jsonb)`,
        [operationId, actor, id, JSON.stringify(normalized)]
      );
      return { duplicate: false, settings: groupSettingsRow(result.rows[0]) };
    });
  }

  async function recordModerationAction(input) {
    const actionId = input.actionId ? uuid(input.actionId, "actionId") : crypto.randomUUID();
    const operationId = input.requestId ? requestId(input.requestId) : null;
    const groupId = chatId(input.chatId);
    const actor = input.actorUserId === null || input.actorUserId === undefined ? null : userId(input.actorUserId, "actorUserId");
    const target = input.targetUserId === null || input.targetUserId === undefined ? null : userId(input.targetUserId, "targetUserId");
    const action = String(input.action || "");
    if (!["ban", "unban", "kick", "mute", "unmute", "warn", "unwarn", "delete", "purge", "pin", "unpin", "lock", "unlock", "slowmode", "approve", "reject", "report", "automatic_flag"].includes(action)) throw new TypeError("moderation action is invalid");
    const result = String(input.result || "success");
    if (!["success", "denied", "failed", "pending"].includes(result)) throw new TypeError("moderation result is invalid");
    const reason = input.reason ? bounded(input.reason, "reason", 1000) : null;
    const duration = input.durationSeconds === undefined || input.durationSeconds === null ? null : Number(input.durationSeconds);
    if (duration !== null && (!Number.isSafeInteger(duration) || duration < 1 || duration > 31_536_000)) throw new TypeError("durationSeconds is invalid");
    return transaction(async (client) => {
      if (actor) await ensureUserWithClient(client, actor);
      if (target) await ensureUserWithClient(client, target);
      const inserted = await client.query(
        `INSERT INTO group_moderation_actions
          (action_id, request_id, chat_id, actor_user_id, target_user_id, action, reason, duration_seconds,
           telegram_message_id, result, reversible, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (request_id) DO NOTHING RETURNING action_id, created_at`,
        [actionId, operationId, groupId, actor, target, action, reason, duration,
          input.telegramMessageId ?? null, result, input.reversible === true, JSON.stringify(jsonObject(input.metadata, "metadata"))]
      );
      return { actionId: inserted.rows[0]?.action_id || actionId, duplicate: inserted.rowCount === 0, result };
    });
  }

  async function beginModerationAction(input) {
    const actionId = crypto.randomUUID();
    const operationId = requestId(input.requestId);
    const groupId = chatId(input.chatId);
    const actor = userId(input.actorUserId, "actorUserId");
    const target = input.targetUserId === null || input.targetUserId === undefined ? null : userId(input.targetUserId, "targetUserId");
    const action = String(input.action || "");
    if (!["ban", "unban", "kick", "mute", "unmute", "delete", "purge", "pin", "unpin", "lock", "unlock", "approve", "reject", "slowmode"].includes(action)) throw new TypeError("moderation action is invalid");
    const reason = input.reason ? bounded(input.reason, "reason", 1000) : null;
    return transaction(async (client) => {
      await ensureUserWithClient(client, actor);
      if (target) await ensureUserWithClient(client, target);
      const inserted = await client.query(
        `INSERT INTO group_moderation_actions
          (action_id, request_id, chat_id, actor_user_id, target_user_id, action, reason, duration_seconds,
           telegram_message_id, result, reversible, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11::jsonb)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING action_id, result, created_at`,
        [actionId, operationId, groupId, actor, target, action, reason, input.durationSeconds ?? null,
          input.telegramMessageId ?? null, input.reversible === true, JSON.stringify(jsonObject(input.metadata, "metadata"))]
      );
      if (inserted.rowCount) return { duplicate: false, actionId, result: "pending" };
      const existing = await client.query(
        `SELECT action_id, chat_id::text, actor_user_id::text, target_user_id::text, action, result
         FROM group_moderation_actions WHERE request_id = $1`,
        [operationId]
      );
      const row = existing.rows[0];
      if (!row || row.chat_id !== groupId || row.actor_user_id !== actor || row.action !== action || String(row.target_user_id || "") !== String(target || "")) {
        const error = new Error("requestId was already used for a different moderation action");
        error.statusCode = 409;
        throw error;
      }
      return { duplicate: true, actionId: row.action_id, result: row.result };
    });
  }

  async function finishModerationAction(rawRequestId, { result, metadata = {} } = {}) {
    const operationId = requestId(rawRequestId);
    if (!["success", "denied", "failed"].includes(result)) throw new TypeError("moderation result is invalid");
    const safeMetadata = jsonObject(metadata, "metadata");
    return transaction(async (client) => {
      const changed = await client.query(
        `UPDATE group_moderation_actions SET result = $2, metadata = metadata || $3::jsonb
         WHERE request_id = $1 AND result = 'pending' RETURNING action_id, result`,
        [operationId, result, JSON.stringify(safeMetadata)]
      );
      if (changed.rowCount) return { changed: true, actionId: changed.rows[0].action_id, result: changed.rows[0].result };
      const current = await client.query("SELECT action_id, result FROM group_moderation_actions WHERE request_id = $1", [operationId]);
      return current.rowCount ? { changed: false, actionId: current.rows[0].action_id, result: current.rows[0].result } : null;
    });
  }

  async function issueWarning({ chatId: rawChatId, userId: rawUserId, actorUserId, reason, requestId: rawRequestId }) {
    const groupId = chatId(rawChatId);
    const target = userId(rawUserId);
    const actor = userId(actorUserId, "actorUserId");
    const operationId = requestId(rawRequestId);
    const warningReason = bounded(reason || "Warning issued by group administrator", "reason", 1000);
    return transaction(async (client) => {
      await ensureUserWithClient(client, actor);
      await ensureUserWithClient(client, target);
      const duplicate = await client.query("SELECT action_id FROM group_moderation_actions WHERE request_id = $1", [operationId]);
      if (!duplicate.rowCount) {
        const warningId = crypto.randomUUID();
        await client.query(
          `INSERT INTO group_warnings (warning_id, chat_id, user_id, issued_by, reason) VALUES ($1, $2, $3, $4, $5)`,
          [warningId, groupId, target, actor, warningReason]
        );
        await client.query(
          `INSERT INTO group_moderation_actions
            (action_id, request_id, chat_id, actor_user_id, target_user_id, action, reason, result, reversible)
           VALUES ($1, $2, $3, $4, $5, 'warn', $6, 'success', TRUE)`,
          [crypto.randomUUID(), operationId, groupId, actor, target, warningReason]
        );
      }
      const countResult = await client.query("SELECT COUNT(*)::int AS count FROM group_warnings WHERE chat_id = $1 AND user_id = $2 AND active = TRUE", [groupId, target]);
      const settings = await client.query("SELECT warning_threshold, warning_action, warning_mute_seconds FROM telegram_group_settings WHERE chat_id = $1", [groupId]);
      return { duplicate: duplicate.rowCount > 0, count: Number(countResult.rows[0]?.count || 0), policy: settings.rows[0] || null };
    });
  }

  async function removeWarning({ chatId: rawChatId, userId: rawUserId, actorUserId, requestId: rawRequestId }) {
    const groupId = chatId(rawChatId);
    const target = userId(rawUserId);
    const actor = userId(actorUserId, "actorUserId");
    const operationId = requestId(rawRequestId);
    return transaction(async (client) => {
      await ensureUserWithClient(client, actor);
      await ensureUserWithClient(client, target);
      const duplicate = await client.query("SELECT action_id FROM group_moderation_actions WHERE request_id = $1", [operationId]);
      if (!duplicate.rowCount) {
        const removed = await client.query(
          `UPDATE group_warnings SET active = FALSE, removed_at = NOW(), removed_by = $3
           WHERE warning_id = (SELECT warning_id FROM group_warnings WHERE chat_id = $1 AND user_id = $2 AND active = TRUE ORDER BY created_at DESC LIMIT 1)
           RETURNING warning_id`,
          [groupId, target, actor]
        );
        await client.query(
          `INSERT INTO group_moderation_actions
            (action_id, request_id, chat_id, actor_user_id, target_user_id, action, result, reversible, metadata)
           VALUES ($1, $2, $3, $4, $5, 'unwarn', 'success', FALSE, $6::jsonb)`,
          [crypto.randomUUID(), operationId, groupId, actor, target, JSON.stringify({ removed: removed.rowCount > 0 })]
        );
      }
      const countResult = await client.query("SELECT COUNT(*)::int AS count FROM group_warnings WHERE chat_id = $1 AND user_id = $2 AND active = TRUE", [groupId, target]);
      return { duplicate: duplicate.rowCount > 0, count: Number(countResult.rows[0]?.count || 0) };
    });
  }

  async function listWarnings(rawChatId, rawUserId = null) {
    const groupId = chatId(rawChatId);
    const target = rawUserId === null || rawUserId === undefined ? null : userId(rawUserId);
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT warning_id, user_id::text, issued_by::text, reason, active, removed_at, removed_by::text, created_at
         FROM group_warnings WHERE chat_id = $1 AND ($2::bigint IS NULL OR user_id = $2)
         ORDER BY created_at DESC LIMIT 250`,
        [groupId, target]
      );
      return result.rows;
    });
  }

  async function listModerationActions(rawChatId, { limit: rawLimit = 100 } = {}) {
    const groupId = chatId(rawChatId);
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT action_id, request_id, actor_user_id::text, target_user_id::text, action, reason, duration_seconds,
                telegram_message_id::text, result, reversible, reversed_at, metadata, created_at
         FROM group_moderation_actions WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [groupId, limit(rawLimit)]
      );
      return result.rows;
    });
  }

  async function recordGuardJoinRequest({ chatId: rawChatId, user, requestedAt, inviteLink = null, status = "queued" }) {
    const groupId = chatId(rawChatId);
    const target = userId(user?.id);
    const requestTime = new Date(requestedAt);
    if (Number.isNaN(requestTime.getTime())) throw new TypeError("requestedAt is invalid");
    if (!["queued", "verification_pending"].includes(status)) throw new TypeError("guard request status is invalid");
    const snapshot = {
      firstName: String(user?.first_name || "").slice(0, 128),
      lastName: String(user?.last_name || "").slice(0, 128),
      username: String(user?.username || "").slice(0, 64),
      isBot: user?.is_bot === true,
      isPremium: user?.is_premium === true
    };
    const inviteFingerprint = inviteLink ? crypto.createHash("sha256").update(String(inviteLink)).digest("hex") : null;
    return transaction(async (client) => {
      await ensureUserWithClient(client, target);
      const id = crypto.randomUUID();
      const inserted = await client.query(
        `INSERT INTO guard_join_requests
          (join_request_id, chat_id, user_id, requested_at, status, user_snapshot, invite_link_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (chat_id, user_id, requested_at) DO UPDATE SET updated_at = NOW()
         RETURNING join_request_id, status, requested_at, (xmax = 0) AS inserted`,
        [id, groupId, target, requestTime, status, JSON.stringify(snapshot), inviteFingerprint]
      );
      if (inserted.rows[0].inserted === true) {
        await client.query(
          `INSERT INTO guard_decisions (decision_id, join_request_id, decision, reason, signals)
           VALUES ($1, $2, 'queue', 'Telegram join request received', $3::jsonb)`,
          [crypto.randomUUID(), inserted.rows[0].join_request_id, JSON.stringify(snapshot)]
        );
      }
      return { id: inserted.rows[0].join_request_id, chatId: groupId, userId: target, status: inserted.rows[0].status, requestedAt: inserted.rows[0].requested_at };
    });
  }

  async function decideGuardJoinRequest({ chatId: rawChatId, userId: rawUserId, actorUserId, decision, reason = null }) {
    const groupId = chatId(rawChatId);
    const target = userId(rawUserId);
    const actor = userId(actorUserId, "actorUserId");
    const next = String(decision || "");
    if (!["approved", "rejected", "verification_pending", "cancelled", "expired"].includes(next)) throw new TypeError("guard decision is invalid");
    const decisionReason = reason ? bounded(reason, "reason", 1000) : null;
    return transaction(async (client) => {
      await ensureUserWithClient(client, actor);
      const current = await client.query(
        `SELECT join_request_id FROM guard_join_requests WHERE chat_id = $1 AND user_id = $2
         AND status IN ('queued', 'verification_pending') ORDER BY requested_at DESC LIMIT 1 FOR UPDATE`,
        [groupId, target]
      );
      if (!current.rowCount) {
        const error = new Error("No pending Guard request was found");
        error.statusCode = 404;
        throw error;
      }
      const joinRequestId = current.rows[0].join_request_id;
      await client.query(
        `UPDATE guard_join_requests SET status = $2, decided_by = $3, decision_reason = $4,
           decided_at = CASE WHEN $2 = 'verification_pending' THEN NULL ELSE NOW() END, updated_at = NOW()
         WHERE join_request_id = $1`,
        [joinRequestId, next, actor, decisionReason]
      );
      const decisionName = next === "approved" ? "approve"
        : next === "rejected" ? "reject"
          : next === "verification_pending" ? "request_verification"
            : next === "cancelled" ? "cancel" : "expire";
      await client.query(
        `INSERT INTO guard_decisions (decision_id, join_request_id, actor_user_id, decision, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), joinRequestId, actor, decisionName, decisionReason]
      );
      return { id: joinRequestId, chatId: groupId, userId: target, status: next };
    });
  }

  async function listGuardJoinRequests(rawChatId, { status = null, limit: rawLimit = 100 } = {}) {
    const groupId = chatId(rawChatId);
    const normalizedStatus = status === null ? null : String(status);
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT join_request_id, user_id::text, requested_at, status, user_snapshot, decision_reason, decided_by::text, decided_at, created_at, updated_at
         FROM guard_join_requests WHERE chat_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY requested_at DESC LIMIT $3`,
        [groupId, normalizedStatus, limit(rawLimit)]
      );
      return result.rows;
    });
  }

  async function createSecretaryReminder({ ownerUserId, chatId: rawChatId = null, threadId = null, title, message, dueAt }) {
    const owner = userId(ownerUserId, "ownerUserId");
    const targetChat = rawChatId === null || rawChatId === undefined ? null : chatId(rawChatId);
    const targetThread = threadId === null || threadId === undefined ? null : Number(threadId);
    if (targetThread !== null && (!Number.isSafeInteger(targetThread) || targetThread < 1)) throw new TypeError("threadId is invalid");
    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime()) || due.getTime() < Date.now() + 5_000 || due.getTime() > Date.now() + 366 * 24 * 60 * 60_000) throw new TypeError("dueAt must be between 5 seconds and 366 days in the future");
    const reminderTitle = bounded(title, "title", 200);
    const reminderMessage = bounded(message, "message", 2000);
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      const id = crypto.randomUUID();
      const result = await client.query(
        `INSERT INTO secretary_reminders (reminder_id, owner_user_id, chat_id, thread_id, title, message, due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING reminder_id, owner_user_id::text, chat_id::text, thread_id::text, title, message, due_at, status, created_at`,
        [id, owner, targetChat, targetThread, reminderTitle, reminderMessage, due]
      );
      return result.rows[0];
    });
  }

  async function listSecretaryReminders(rawOwnerUserId, { limit: rawLimit = 100 } = {}) {
    const owner = userId(rawOwnerUserId, "ownerUserId");
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT reminder_id, owner_user_id::text, chat_id::text, thread_id::text, title, message, due_at,
                status, delivery_attempts, delivered_at, last_error_code, created_at, updated_at
         FROM secretary_reminders WHERE owner_user_id = $1 ORDER BY due_at DESC LIMIT $2`,
        [owner, limit(rawLimit)]
      );
      return result.rows;
    });
  }

  async function cancelSecretaryReminder(rawOwnerUserId, rawReminderId) {
    const owner = userId(rawOwnerUserId, "ownerUserId");
    const reminderId = uuid(rawReminderId, "reminderId");
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE secretary_reminders SET status = 'cancelled', updated_at = NOW()
         WHERE reminder_id = $1 AND owner_user_id = $2 AND status IN ('scheduled', 'claimed')
         RETURNING reminder_id, status`,
        [reminderId, owner]
      );
      return result.rowCount ? result.rows[0] : null;
    });
  }

  async function claimDueSecretaryReminders({ ownerId = crypto.randomUUID(), limit: rawLimit = 25, leaseMs = 60_000 } = {}) {
    const worker = uuid(ownerId, "ownerId");
    const maximum = limit(rawLimit, 25, 100);
    const lease = Number(leaseMs);
    if (!Number.isSafeInteger(lease) || lease < 10_000 || lease > 600_000) throw new TypeError("leaseMs is invalid");
    return transaction(async (client) => {
      const result = await client.query(
        `WITH due AS (
           SELECT reminder_id FROM secretary_reminders
           WHERE (status = 'scheduled' AND due_at <= NOW()) OR (status = 'claimed' AND claim_expires_at < NOW())
           ORDER BY due_at, reminder_id LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE secretary_reminders AS reminders SET status = 'claimed', claimed_by = $2,
           claim_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
           delivery_attempts = delivery_attempts + 1, updated_at = NOW()
         FROM due WHERE reminders.reminder_id = due.reminder_id
         RETURNING reminders.reminder_id, reminders.owner_user_id::text, reminders.chat_id::text,
           reminders.thread_id::text, reminders.title, reminders.message, reminders.due_at, reminders.delivery_attempts`,
        [maximum, worker, lease]
      );
      return result.rows;
    });
  }

  async function completeSecretaryReminder(rawReminderId, { delivered, errorCode = null } = {}) {
    const reminderId = uuid(rawReminderId, "reminderId");
    if (typeof delivered !== "boolean") throw new TypeError("delivered must be a boolean");
    const safeError = errorCode ? bounded(errorCode, "errorCode", 128) : null;
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE secretary_reminders SET status = $2,
           delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END,
           last_error_code = $3, claimed_by = NULL, claim_expires_at = NULL, updated_at = NOW()
         WHERE reminder_id = $1 AND status = 'claimed' RETURNING reminder_id, status`,
        [reminderId, delivered ? "delivered" : "failed", safeError]
      );
      return result.rowCount ? result.rows[0] : null;
    });
  }

  async function createSecretaryJob({ ownerUserId, chatId: rawChatId = null, threadId = null, jobType = "task_digest", schedule, timezone = "UTC" }) {
    const owner = userId(ownerUserId, "ownerUserId");
    const targetChat = rawChatId === null || rawChatId === undefined ? null : chatId(rawChatId);
    const targetThread = threadId === null || threadId === undefined ? null : Number(threadId);
    if (jobType !== "task_digest") throw new TypeError("Only task_digest jobs are currently supported");
    const normalizedSchedule = bounded(schedule, "schedule", 100);
    const match = normalizedSchedule.match(/^daily@(\d{2}):(\d{2})$/);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new TypeError("schedule must use daily@HH:MM");
    const normalizedTimezone = bounded(timezone, "timezone", 64);
    if (normalizedTimezone !== "UTC") throw new TypeError("Only UTC scheduling is currently supported");
    const next = new Date();
    next.setUTCSeconds(0, 0);
    next.setUTCHours(Number(match[1]), Number(match[2]));
    if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      const id = crypto.randomUUID();
      const result = await client.query(
        `INSERT INTO secretary_jobs (job_id, owner_user_id, chat_id, thread_id, job_type, schedule, timezone, next_run_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING job_id, owner_user_id::text, chat_id::text, thread_id::text, job_type, schedule, timezone, status, next_run_at, created_at`,
        [id, owner, targetChat, targetThread, jobType, normalizedSchedule, normalizedTimezone, next]
      );
      return result.rows[0];
    });
  }

  async function listSecretaryJobs(rawOwnerUserId) {
    const owner = userId(rawOwnerUserId, "ownerUserId");
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT job_id, owner_user_id::text, chat_id::text, thread_id::text, job_type, schedule, timezone,
                status, next_run_at, last_run_at, last_error_code, created_at, updated_at
         FROM secretary_jobs WHERE owner_user_id = $1 ORDER BY created_at DESC`,
        [owner]
      );
      return result.rows;
    });
  }

  async function cancelSecretaryJob(rawOwnerUserId, rawJobId) {
    const owner = userId(rawOwnerUserId, "ownerUserId");
    const jobId = uuid(rawJobId, "jobId");
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE secretary_jobs SET status = 'paused', updated_at = NOW()
         WHERE job_id = $1 AND owner_user_id = $2 AND status = 'enabled' RETURNING job_id, status`,
        [jobId, owner]
      );
      return result.rowCount ? result.rows[0] : null;
    });
  }

  async function claimDueSecretaryJobs({ limit: rawLimit = 10 } = {}) {
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT job_id, owner_user_id::text, chat_id::text, thread_id::text, job_type, schedule, timezone
         FROM secretary_jobs WHERE status = 'enabled' AND next_run_at <= NOW()
         ORDER BY next_run_at, job_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit(rawLimit, 10, 50)]
      );
      if (result.rowCount) {
        await client.query("UPDATE secretary_jobs SET next_run_at = NOW() + INTERVAL '10 minutes', updated_at = NOW() WHERE job_id = ANY($1::uuid[])", [result.rows.map((row) => row.job_id)]);
      }
      return result.rows;
    });
  }

  async function completeSecretaryJob(rawJobId, { delivered, errorCode = null } = {}) {
    const jobId = uuid(rawJobId, "jobId");
    if (typeof delivered !== "boolean") throw new TypeError("delivered must be a boolean");
    const safeError = errorCode ? bounded(errorCode, "errorCode", 128) : null;
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE secretary_jobs SET status = CASE WHEN $2 THEN 'enabled' ELSE 'failed' END,
           next_run_at = CASE WHEN $2 THEN NOW() + INTERVAL '1 day' ELSE next_run_at END,
           last_run_at = NOW(), last_error_code = $3, updated_at = NOW()
         WHERE job_id = $1 RETURNING job_id, status, next_run_at`,
        [jobId, delivered, safeError]
      );
      return result.rows[0] || null;
    });
  }

  async function createManagedBotProfile({ profileId: rawProfileId = null, ownerUserId, displayName, credential = null, configuration = {} }) {
    const owner = userId(ownerUserId, "ownerUserId");
    const name = bounded(displayName, "displayName", 100);
    const config = jsonObject(configuration, "configuration");
    if (credential && typeof credential !== "object") throw new TypeError("credential is invalid");
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      const id = rawProfileId ? uuid(rawProfileId, "botProfileId") : crypto.randomUUID();
      const result = await client.query(
        `INSERT INTO managed_bot_profiles (bot_profile_id, owner_user_id, display_name, status, configuration)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
        [id, owner, name, credential ? "configured" : "draft", JSON.stringify(config)]
      );
      if (credential) {
        await client.query(
          `INSERT INTO managed_bot_credentials (bot_profile_id, ciphertext, iv, auth_tag, key_version, token_fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, credential.ciphertext, credential.iv, credential.authTag, credential.keyVersion, credential.tokenFingerprint]
        );
      }
      return botProfileRow({ ...result.rows[0], has_credential: Boolean(credential) });
    });
  }

  async function listManagedBotProfiles(rawOwnerUserId) {
    const owner = userId(rawOwnerUserId, "ownerUserId");
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT profiles.*, credentials.bot_profile_id IS NOT NULL AS has_credential
         FROM managed_bot_profiles AS profiles
         LEFT JOIN managed_bot_credentials AS credentials USING (bot_profile_id)
         WHERE profiles.owner_user_id = $1 ORDER BY profiles.updated_at DESC`,
        [owner]
      );
      return result.rows.map(botProfileRow);
    });
  }

  async function getManagedBotProfile(rawOwnerUserId, rawProfileId, { includeCredential = false } = {}) {
    const owner = userId(rawOwnerUserId, "ownerUserId");
    const profileId = uuid(rawProfileId, "botProfileId");
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT profiles.*, credentials.bot_profile_id IS NOT NULL AS has_credential,
                credentials.ciphertext, credentials.iv, credentials.auth_tag, credentials.key_version,
                credentials.token_fingerprint
         FROM managed_bot_profiles AS profiles LEFT JOIN managed_bot_credentials AS credentials USING (bot_profile_id)
         WHERE profiles.bot_profile_id = $1 AND profiles.owner_user_id = $2`,
        [profileId, owner]
      );
      if (!result.rowCount) return null;
      const profile = botProfileRow(result.rows[0]);
      return includeCredential ? {
        profile,
        credential: result.rows[0].has_credential ? {
          ciphertext: result.rows[0].ciphertext,
          iv: result.rows[0].iv,
          authTag: result.rows[0].auth_tag,
          keyVersion: result.rows[0].key_version,
          tokenFingerprint: result.rows[0].token_fingerprint
        } : null
      } : profile;
    });
  }

  async function updateManagedBotHealth(rawOwnerUserId, rawProfileId, { connected, telegramBotId = null, telegramUsername = null, errorCode = null }) {
    const owner = userId(rawOwnerUserId, "ownerUserId");
    const profileId = uuid(rawProfileId, "botProfileId");
    if (typeof connected !== "boolean") throw new TypeError("connected must be a boolean");
    const botId = telegramBotId === null ? null : userId(telegramBotId, "telegramBotId");
    const username = telegramUsername ? bounded(telegramUsername, "telegramUsername", 64) : null;
    const safeError = errorCode ? bounded(errorCode, "errorCode", 128) : null;
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE managed_bot_profiles SET status = $3, telegram_bot_id = COALESCE($4, telegram_bot_id),
           telegram_username = COALESCE($5, telegram_username), last_health_at = NOW(), last_error_code = $6, updated_at = NOW()
         WHERE bot_profile_id = $1 AND owner_user_id = $2 RETURNING *`,
        [profileId, owner, connected ? "connected" : "error", botId, username, safeError]
      );
      return result.rowCount ? botProfileRow({ ...result.rows[0], has_credential: true }) : null;
    });
  }

  async function deleteManagedBotProfile(rawOwnerUserId, rawProfileId) {
    const owner = userId(rawOwnerUserId, "ownerUserId");
    const profileId = uuid(rawProfileId, "botProfileId");
    return transaction(async (client) => {
      const result = await client.query(
        "DELETE FROM managed_bot_profiles WHERE bot_profile_id = $1 AND owner_user_id = $2 RETURNING bot_profile_id",
        [profileId, owner]
      );
      return result.rowCount > 0;
    });
  }

  async function upsertBusinessConnection(connection) {
    const connectionId = bounded(connection?.id || connection?.connectionId, "connectionId", 256);
    const owner = userId(connection?.user?.id || connection?.ownerUserId, "ownerUserId");
    const userChat = connection?.user_chat_id === undefined && connection?.userChatId === undefined
      ? null
      : chatId(connection?.user_chat_id ?? connection?.userChatId);
    const rights = jsonObject(connection?.rights, "rights");
    const enabled = connection?.is_enabled === true || connection?.enabled === true;
    const connectedAt = new Date(Number(connection?.date || 0) * 1000);
    if (!Number.isFinite(connectedAt.getTime()) || connectedAt.getTime() <= 0) throw new TypeError("connection date is invalid");
    const allowed = jsonObject(connection?.allowedChatConfiguration, "allowedChatConfiguration");
    return transaction(async (client) => {
      await ensureUserWithClient(client, owner);
      const result = await client.query(
        `INSERT INTO telegram_business_connections
          (connection_id, owner_user_id, user_chat_id, enabled, can_reply, rights,
           allowed_chat_configuration, connected_at, last_verified_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, NOW())
         ON CONFLICT (connection_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id,
           user_chat_id = EXCLUDED.user_chat_id, enabled = EXCLUDED.enabled, can_reply = EXCLUDED.can_reply,
           rights = EXCLUDED.rights, allowed_chat_configuration = EXCLUDED.allowed_chat_configuration,
           access_status = CASE
             WHEN EXCLUDED.enabled = FALSE THEN 'connection_disabled'
             WHEN telegram_business_connections.access_status = 'connection_disabled' THEN COALESCE((
               SELECT CASE WHEN entitlements.source = 'telegram_stars' THEN 'active_paid' ELSE 'active_admin_approved' END
               FROM secretary_entitlements AS entitlements
               WHERE entitlements.connection_id = EXCLUDED.connection_id AND entitlements.status = 'active'
               ORDER BY entitlements.granted_at DESC LIMIT 1
             ), 'pending_access')
             ELSE telegram_business_connections.access_status
           END,
           auto_reply_enabled = CASE WHEN EXCLUDED.enabled AND EXCLUDED.can_reply THEN telegram_business_connections.auto_reply_enabled ELSE FALSE END,
           connected_at = EXCLUDED.connected_at, last_verified_at = NOW(), updated_at = NOW()
         RETURNING *`,
        [connectionId, owner, userChat, enabled, rights.can_reply === true, JSON.stringify(rights), JSON.stringify(allowed), connectedAt]
      );
      return businessConnectionRow(result.rows[0]);
    });
  }

  async function getBusinessConnection(rawConnectionId) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    return transaction(async (client) => {
      const result = await client.query("SELECT * FROM telegram_business_connections WHERE connection_id = $1", [connectionId]);
      return businessConnectionRow(result.rows[0]);
    });
  }

  async function listBusinessConnections({ ownerUserId = null, limit: rawLimit = 50 } = {}) {
    const owner = ownerUserId === null ? null : userId(ownerUserId, "ownerUserId");
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT * FROM telegram_business_connections
         WHERE ($1::bigint IS NULL OR owner_user_id = $1)
         ORDER BY updated_at DESC LIMIT $2`,
        [owner, limit(rawLimit)]
      );
      return result.rows.map(businessConnectionRow);
    });
  }

  async function observeTelegramMessage({ updateType, transportMode, chatId: rawChatId, threadId = null, messageId, senderUserId = null, businessConnectionId = null, content = null, status = "active", retentionDays = 7 }) {
    const groupId = chatId(rawChatId);
    const thread = threadId === null || threadId === undefined ? null : chatId(threadId);
    const message = chatId(messageId);
    const sender = senderUserId === null || senderUserId === undefined ? null : userId(senderUserId, "senderUserId");
    const type = bounded(updateType, "updateType", 64);
    if (!["group_secretary", "telegram_secretary"].includes(transportMode)) throw new TypeError("transportMode is invalid");
    if (!["active", "edited", "deleted"].includes(status)) throw new TypeError("status is invalid");
    const days = Number(retentionDays);
    if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new TypeError("retentionDays is invalid");
    const connectionId = businessConnectionId ? bounded(businessConnectionId, "businessConnectionId", 256) : null;
    const body = content === null || content === undefined ? null : String(content).slice(0, 20_000);
    return transaction(async (client) => {
      if (sender) await ensureUserWithClient(client, sender);
      const result = await client.query(
        `INSERT INTO telegram_observed_messages
          (observation_id, update_type, transport_mode, chat_id, thread_id, message_id,
           sender_user_id, business_connection_id, content, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + ($11::text || ' days')::interval)
         ON CONFLICT (transport_mode, chat_id, (COALESCE(thread_id, 0)), message_id)
         DO UPDATE SET update_type = EXCLUDED.update_type, sender_user_id = EXCLUDED.sender_user_id,
           business_connection_id = EXCLUDED.business_connection_id, content = EXCLUDED.content,
           status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, updated_at = NOW()
         RETURNING observation_id, status, observed_at, expires_at`,
        [crypto.randomUUID(), type, transportMode, groupId, thread, message, sender, connectionId, body, status, String(days)]
      );
      return result.rows[0];
    });
  }

  async function listObservedMessages({ chatId: rawChatId, threadId = null, transportMode = "group_secretary", businessConnectionId = null, limit: rawLimit = 100 } = {}) {
    const groupId = chatId(rawChatId);
    const thread = threadId === null || threadId === undefined ? null : chatId(threadId);
    if (!["group_secretary", "telegram_secretary"].includes(transportMode)) throw new TypeError("transportMode is invalid");
    const connectionId = businessConnectionId ? bounded(businessConnectionId, "businessConnectionId", 256) : null;
    return transaction(async (client) => {
      const result = await client.query(
        `SELECT observation_id, update_type, transport_mode, chat_id::text, thread_id::text,
                message_id::text, sender_user_id::text, content, status, observed_at, expires_at
         FROM telegram_observed_messages
         WHERE chat_id = $1 AND COALESCE(thread_id, 0) = COALESCE($2::bigint, 0)
           AND transport_mode = $3 AND ($4::text IS NULL OR business_connection_id = $4)
           AND status IN ('active', 'edited') AND expires_at > NOW()
         ORDER BY observed_at DESC LIMIT $5`,
        [groupId, thread, transportMode, connectionId, limit(rawLimit, 100, 500)]
      );
      return result.rows.reverse();
    });
  }

  async function markBusinessMessagesDeleted({ connectionId: rawConnectionId, chatId: rawChatId, messageIds }) {
    const connectionId = bounded(rawConnectionId, "connectionId", 256);
    const groupId = chatId(rawChatId);
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 100) throw new TypeError("messageIds is invalid");
    const ids = messageIds.map((value) => chatId(value));
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE telegram_observed_messages SET status = 'deleted', content = NULL, updated_at = NOW()
         WHERE business_connection_id = $1 AND chat_id = $2 AND message_id = ANY($3::bigint[])
         RETURNING observation_id`,
        [connectionId, groupId, ids]
      );
      return { deleted: result.rowCount };
    });
  }

  async function saveCapabilityVerification({ capabilityKey, status, metadata = {} }) {
    const key = bounded(capabilityKey, "capabilityKey", 64).toLowerCase();
    const state = String(status || "");
    if (!["active", "disabled", "setup_required", "permission_required", "connected", "not_connected", "configured_unverified", "unavailable"].includes(state)) throw new TypeError("capability status is invalid");
    const safeMetadata = jsonObject(metadata, "metadata");
    return transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO telegram_capability_verifications (capability_key, status, metadata, verified_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (capability_key) DO UPDATE SET status = EXCLUDED.status,
           metadata = EXCLUDED.metadata, verified_at = NOW()
         RETURNING capability_key, status, metadata, verified_at`,
        [key, state, JSON.stringify(safeMetadata)]
      );
      return result.rows[0];
    });
  }

  async function listCapabilityVerifications() {
    return transaction(async (client) => {
      const result = await client.query("SELECT capability_key, status, metadata, verified_at FROM telegram_capability_verifications ORDER BY capability_key");
      return result.rows.map((row) => ({
        capabilityKey: row.capability_key,
        status: row.status,
        metadata: row.metadata || {},
        verifiedAt: row.verified_at
      }));
    });
  }

  async function recordBotInteraction({ chatId: rawChatId, threadId = null, senderBotId, messageId, content, chainDepth = 0 }) {
    const groupId = chatId(rawChatId);
    const thread = threadId === null || threadId === undefined ? null : chatId(threadId);
    const sender = userId(senderBotId, "senderBotId");
    const message = chatId(messageId);
    const depth = Number(chainDepth);
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 3) return { accepted: false, reason: "chain_depth" };
    const fingerprint = crypto.createHash("sha256").update(String(content || "")).digest("hex");
    return transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO telegram_bot_interactions
          (correlation_id, chat_id, thread_id, sender_bot_id, message_id, message_fingerprint, chain_depth, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '5 minutes')
         ON CONFLICT (chat_id, message_id, sender_bot_id) DO NOTHING
         RETURNING correlation_id`,
        [crypto.randomUUID(), groupId, thread, sender, message, fingerprint, depth]
      );
      return { accepted: result.rowCount > 0, correlationId: result.rows[0]?.correlation_id || null, reason: result.rowCount ? null : "duplicate" };
    });
  }

  return {
    syncUserProfile,
    listManagedUsers,
    getManagedUser,
    manageUser,
    upsertTelegramGroup,
    syncGroupMember,
    getGroupMember,
    listTelegramGroups,
    getTelegramGroup,
    updateGroupSettings,
    recordModerationAction,
    beginModerationAction,
    finishModerationAction,
    issueWarning,
    removeWarning,
    listWarnings,
    listModerationActions,
    recordGuardJoinRequest,
    decideGuardJoinRequest,
    listGuardJoinRequests,
    createSecretaryReminder,
    listSecretaryReminders,
    cancelSecretaryReminder,
    claimDueSecretaryReminders,
    completeSecretaryReminder,
    createSecretaryJob,
    listSecretaryJobs,
    cancelSecretaryJob,
    claimDueSecretaryJobs,
    completeSecretaryJob,
    createManagedBotProfile,
    listManagedBotProfiles,
    getManagedBotProfile,
    updateManagedBotHealth,
    deleteManagedBotProfile,
    upsertBusinessConnection,
    getBusinessConnection,
    listBusinessConnections,
    observeTelegramMessage,
    listObservedMessages,
    markBusinessMessagesDeleted,
    saveCapabilityVerification,
    listCapabilityVerifications,
    recordBotInteraction
  };
}
