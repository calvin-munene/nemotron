import crypto from "node:crypto";
import { GROUP_MANAGER_MIGRATION, GROUP_MANAGER_QUEUE_MIGRATION } from "./groupManager/migration.js";

export const PLATFORM_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: "2026071501_platform_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS platform_users (
        user_id BIGINT PRIMARY KEY CHECK (user_id > 0),
        role TEXT NOT NULL DEFAULT 'standard_user'
          CHECK (role IN ('super_admin', 'admin', 'moderator', 'support', 'premium_user', 'standard_user', 'restricted_user', 'banned_user')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS feature_flags (
        feature_key TEXT PRIMARY KEY CHECK (feature_key ~ '^[a-z][a-z0-9_]{1,63}$'),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        description TEXT NOT NULL DEFAULT '',
        config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
        updated_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        audit_id BIGSERIAL PRIMARY KEY,
        request_id UUID UNIQUE,
        actor_user_id BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
        target_type TEXT CHECK (target_type IS NULL OR length(target_type) BETWEEN 1 AND 64),
        target_id TEXT CHECK (target_id IS NULL OR length(target_id) BETWEEN 1 AND 256),
        result TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'denied', 'failed', 'duplicate')),
        reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx
        ON audit_logs(actor_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_logs_action_created_idx
        ON audit_logs(action, created_at DESC);

      CREATE TABLE IF NOT EXISTS security_events (
        security_event_id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
        severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
        user_id BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        request_id UUID,
        source_hash TEXT CHECK (source_hash IS NULL OR length(source_hash) <= 128),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS security_events_type_created_idx
        ON security_events(event_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS security_events_severity_created_idx
        ON security_events(severity, created_at DESC);
    `
  }),
  Object.freeze({
    version: "2026071502_foundation_feature_flags",
    sql: `
      INSERT INTO feature_flags (feature_key, enabled, description)
      VALUES
        ('admin_api', TRUE, 'Authenticated administrator API foundation'),
        ('audit_logging', TRUE, 'Durable administrative audit logging'),
        ('security_events', TRUE, 'Durable security event recording'),
        ('group_management', FALSE, 'Telegram group management controls'),
        ('ai_moderation', FALSE, 'NVIDIA-assisted moderation classification'),
        ('bot_management', FALSE, 'Managed bot profiles and encrypted credentials')
      ON CONFLICT (feature_key) DO NOTHING;
    `
  }),
  Object.freeze({
    version: "2026071503_nvidia_model_controls",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_models (
        model_id TEXT PRIMARY KEY
          CHECK (model_id ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$'),
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        featured BOOLEAN NOT NULL DEFAULT FALSE,
        provider_available BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
        last_seen_at TIMESTAMPTZ,
        updated_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS ai_models_enabled_featured_idx
        ON ai_models(enabled, featured DESC, model_id);

      INSERT INTO ai_models (model_id, label, description, enabled, featured, metadata)
      VALUES
        ('meta/llama-3.3-70b-instruct', 'Llama 3.3 70B', 'Strong general reasoning and multilingual chat', TRUE, TRUE, '{"tag":"GENERAL"}'::jsonb),
        ('nvidia/llama-3.3-nemotron-super-49b-v1.5', 'Nemotron Super 49B', 'NVIDIA reasoning model for complex questions and planning', TRUE, TRUE, '{"tag":"REASONING"}'::jsonb),
        ('meta/llama-3.1-70b-instruct', 'Llama 3.1 70B', 'Reliable assistant for everyday work', TRUE, FALSE, '{"tag":"BALANCED"}'::jsonb),
        ('meta/llama-3.1-8b-instruct', 'Llama 3.1 8B', 'Lower-latency answers for simple tasks', TRUE, FALSE, '{"tag":"FAST"}'::jsonb)
      ON CONFLICT (model_id) DO NOTHING;
    `
  }),
  Object.freeze({
    version: "2026071504_billing_pricing",
    sql: `
      CREATE TABLE IF NOT EXISTS billing_prices (
        feature_key TEXT PRIMARY KEY CHECK (feature_key ~ '^[a-z][a-z0-9_]{1,63}$'),
        star_cost INTEGER NOT NULL CHECK (star_cost BETWEEN 1 AND 10000),
        updated_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO billing_prices (feature_key, star_cost)
      VALUES ('ai_chat', 1)
      ON CONFLICT (feature_key) DO NOTHING;
    `
  }),
  Object.freeze({
    version: "2026071505_stabilization_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS telegram_star_accounts (
        user_id BIGINT PRIMARY KEY,
        balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS telegram_star_payments (
        telegram_payment_charge_id TEXT PRIMARY KEY,
        provider_payment_charge_id TEXT,
        user_id BIGINT NOT NULL REFERENCES telegram_star_accounts(user_id),
        amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000),
        currency TEXT NOT NULL CHECK (currency = 'XTR'),
        invoice_payload TEXT,
        credited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        refunded_at TIMESTAMPTZ,
        refunded_amount INTEGER CHECK (refunded_amount BETWEEN 1 AND 10000)
      );
      CREATE INDEX IF NOT EXISTS telegram_star_payments_user_id_idx
        ON telegram_star_payments(user_id, credited_at DESC);

      CREATE TABLE IF NOT EXISTS telegram_star_terms_acceptances (
        user_id BIGINT NOT NULL REFERENCES telegram_star_accounts(user_id),
        terms_version TEXT NOT NULL,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, terms_version)
      );

      CREATE TABLE IF NOT EXISTS telegram_star_prompt_reservations (
        reservation_id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES telegram_star_accounts(user_id),
        cost INTEGER NOT NULL CHECK (cost BETWEEN 1 AND 10000),
        status TEXT NOT NULL DEFAULT 'reserved',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        restored_at TIMESTAMPTZ
      );
      ALTER TABLE telegram_star_prompt_reservations
        ADD COLUMN IF NOT EXISTS generation_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS response_produced_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS delivery_attempted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completion_pending_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_error_code TEXT;
      ALTER TABLE telegram_star_prompt_reservations
        DROP CONSTRAINT IF EXISTS telegram_star_prompt_reservations_status_check;
      ALTER TABLE telegram_star_prompt_reservations
        ADD CONSTRAINT telegram_star_prompt_reservations_status_check
        CHECK (status IN (
          'reserved', 'generation_started', 'response_produced', 'delivery_attempted',
          'delivered', 'completion_pending', 'completed', 'restored', 'failed'
        ));
      CREATE INDEX IF NOT EXISTS telegram_star_prompt_reservations_refundable_idx
        ON telegram_star_prompt_reservations(created_at)
        WHERE status IN ('reserved', 'generation_started', 'failed');
      CREATE INDEX IF NOT EXISTS telegram_star_prompt_reservations_recovery_idx
        ON telegram_star_prompt_reservations(updated_at, reservation_id)
        WHERE status IN ('response_produced', 'delivery_attempted', 'delivered', 'completion_pending');

      CREATE TABLE IF NOT EXISTS telegram_bot_modes (
        mode TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS telegram_user_controls (
        user_id BIGINT PRIMARY KEY REFERENCES telegram_star_accounts(user_id),
        banned BOOLEAN NOT NULL DEFAULT FALSE,
        ban_reason TEXT,
        unlimited_credits BOOLEAN NOT NULL DEFAULT FALSE,
        persona TEXT,
        selected_mode TEXT NOT NULL DEFAULT 'chat',
        preferred_model TEXT,
        preferred_language TEXT NOT NULL DEFAULT 'auto',
        response_length TEXT NOT NULL DEFAULT 'balanced',
        creativity NUMERIC(3,2) NOT NULL DEFAULT 0.40,
        memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        custom_instructions TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE telegram_user_controls
        ADD COLUMN IF NOT EXISTS selected_mode TEXT NOT NULL DEFAULT 'chat',
        ADD COLUMN IF NOT EXISTS preferred_model TEXT,
        ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'auto',
        ADD COLUMN IF NOT EXISTS response_length TEXT NOT NULL DEFAULT 'balanced',
        ADD COLUMN IF NOT EXISTS creativity NUMERIC(3,2) NOT NULL DEFAULT 0.40,
        ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS custom_instructions TEXT;

      CREATE TABLE IF NOT EXISTS ai_provider_usage_buckets (
        provider_key TEXT NOT NULL,
        bucket_start TIMESTAMPTZ NOT NULL,
        used INTEGER NOT NULL CHECK (used >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider_key, bucket_start)
      );

      CREATE TABLE IF NOT EXISTS assistants (
        assistant_id UUID PRIMARY KEY,
        owner_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
        system_instructions TEXT NOT NULL DEFAULT '' CHECK (length(system_instructions) <= 5000),
        tone TEXT NOT NULL DEFAULT 'adaptive' CHECK (length(tone) BETWEEN 1 AND 40),
        language TEXT NOT NULL DEFAULT 'auto' CHECK (length(language) BETWEEN 1 AND 32),
        technical_level TEXT NOT NULL DEFAULT 'adaptive' CHECK (technical_level IN ('simple', 'adaptive', 'technical', 'expert')),
        response_length TEXT NOT NULL DEFAULT 'balanced' CHECK (response_length IN ('concise', 'balanced', 'detailed')),
        selected_model TEXT,
        memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS assistants_owner_updated_idx
        ON assistants(owner_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id UUID PRIMARY KEY,
        scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 500),
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        telegram_chat_id BIGINT,
        telegram_thread_id BIGINT,
        channel TEXT NOT NULL CHECK (channel IN ('telegram', 'miniapp', 'whatsapp')),
        assistant_id UUID REFERENCES assistants(assistant_id) ON DELETE SET NULL,
        selected_model TEXT,
        title TEXT NOT NULL DEFAULT 'New conversation' CHECK (length(title) BETWEEN 1 AND 160),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CHECK ((channel = 'telegram' AND telegram_chat_id IS NOT NULL) OR channel <> 'telegram')
      );
      CREATE INDEX IF NOT EXISTS conversations_user_history_idx
        ON conversations(user_id, updated_at DESC) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_active_scope_uidx
        ON conversations(scope_key) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS conversations_active_idx
        ON conversations(user_id, status, updated_at DESC) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS conversations_telegram_scope_idx
        ON conversations(telegram_chat_id, telegram_thread_id, user_id) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS conversation_messages (
        message_id UUID PRIMARY KEY,
        conversation_id UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
        model TEXT,
        provider_request_id TEXT,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'generating', 'completed', 'failed')),
        usage_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage_metadata) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_order_idx
        ON conversation_messages(conversation_id, created_at, message_id);

      CREATE TABLE IF NOT EXISTS durable_leases (
        lease_key TEXT PRIMARY KEY CHECK (length(lease_key) BETWEEN 1 AND 500),
        owner_id UUID NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS durable_leases_expiry_idx ON durable_leases(expires_at);

      CREATE TABLE IF NOT EXISTS telegram_webapp_replays (
        fingerprint TEXT PRIMARY KEY CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS telegram_webapp_replays_expiry_idx ON telegram_webapp_replays(expires_at);

      CREATE TABLE IF NOT EXISTS shared_rate_limits (
        limit_key TEXT NOT NULL CHECK (length(limit_key) BETWEEN 1 AND 500),
        window_start TIMESTAMPTZ NOT NULL,
        used INTEGER NOT NULL CHECK (used >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (limit_key, window_start)
      );
      CREATE INDEX IF NOT EXISTS shared_rate_limits_expiry_idx ON shared_rate_limits(window_start);

      INSERT INTO feature_flags (feature_key, enabled, description)
      VALUES ('whatsapp_ai', FALSE, 'WhatsApp AI inference requires explicit entitlement rollout')
      ON CONFLICT (feature_key) DO NOTHING;
    `
  }),
  Object.freeze({
    version: "2026071701_operating_services",
    sql: `
      ALTER TABLE platform_users
        ADD COLUMN IF NOT EXISTS first_name TEXT CHECK (first_name IS NULL OR length(first_name) <= 128),
        ADD COLUMN IF NOT EXISTS last_name TEXT CHECK (last_name IS NULL OR length(last_name) <= 128),
        ADD COLUMN IF NOT EXISTS username TEXT CHECK (username IS NULL OR length(username) <= 64);
      CREATE INDEX IF NOT EXISTS platform_users_username_idx
        ON platform_users (lower(username)) WHERE username IS NOT NULL;

      CREATE TABLE IF NOT EXISTS user_admin_notes (
        note_id UUID PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        author_user_id BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS user_admin_notes_user_created_idx
        ON user_admin_notes(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS telegram_groups (
        chat_id BIGINT PRIMARY KEY CHECK (chat_id <> 0),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
        username TEXT CHECK (username IS NULL OR length(username) <= 64),
        chat_type TEXT NOT NULL CHECK (chat_type IN ('group', 'supergroup', 'channel')),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        bot_status TEXT NOT NULL DEFAULT 'member'
          CHECK (bot_status IN ('creator', 'administrator', 'member', 'restricted', 'left', 'kicked', 'unknown')),
        bot_permissions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(bot_permissions) = 'object'),
        member_count INTEGER CHECK (member_count IS NULL OR member_count >= 0),
        last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS telegram_groups_active_updated_idx
        ON telegram_groups(active, updated_at DESC);

      CREATE TABLE IF NOT EXISTS telegram_group_settings (
        chat_id BIGINT PRIMARY KEY REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        moderation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        guard_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        secretary_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        welcome_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        welcome_message TEXT CHECK (welcome_message IS NULL OR length(welcome_message) <= 2000),
        goodbye_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        goodbye_message TEXT CHECK (goodbye_message IS NULL OR length(goodbye_message) <= 2000),
        rules TEXT CHECK (rules IS NULL OR length(rules) <= 10000),
        warning_threshold INTEGER NOT NULL DEFAULT 3 CHECK (warning_threshold BETWEEN 1 AND 20),
        warning_action TEXT NOT NULL DEFAULT 'mute'
          CHECK (warning_action IN ('none', 'mute', 'kick', 'ban')),
        warning_mute_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (warning_mute_seconds BETWEEN 30 AND 31536000),
        anti_flood_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        anti_link_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        anti_caps_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        anti_spam_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        blocked_words JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocked_words) = 'array'),
        allowed_domains JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_domains) = 'array'),
        blocked_domains JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocked_domains) = 'array'),
        guard_policy JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(guard_policy) = 'object'),
        secretary_policy JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(secretary_policy) = 'object'),
        updated_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS telegram_group_members (
        chat_id BIGINT NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        telegram_status TEXT NOT NULL DEFAULT 'member'
          CHECK (telegram_status IN ('creator', 'administrator', 'member', 'restricted', 'left', 'kicked', 'unknown')),
        permissions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permissions) = 'object'),
        joined_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS telegram_group_members_user_idx
        ON telegram_group_members(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS group_moderation_actions (
        action_id UUID PRIMARY KEY,
        request_id UUID UNIQUE,
        chat_id BIGINT NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        actor_user_id BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        target_user_id BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK (action IN (
          'ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'unwarn', 'delete', 'purge',
          'pin', 'unpin', 'lock', 'unlock', 'slowmode', 'approve', 'reject', 'report', 'automatic_flag'
        )),
        reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
        duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 31536000),
        telegram_message_id BIGINT,
        result TEXT NOT NULL CHECK (result IN ('success', 'denied', 'failed', 'pending')),
        reversible BOOLEAN NOT NULL DEFAULT FALSE,
        reversed_at TIMESTAMPTZ,
        reversed_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS group_moderation_actions_chat_created_idx
        ON group_moderation_actions(chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS group_moderation_actions_target_created_idx
        ON group_moderation_actions(target_user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS group_warnings (
        warning_id UUID PRIMARY KEY,
        chat_id BIGINT NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        issued_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        removed_at TIMESTAMPTZ,
        removed_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS group_warnings_active_idx
        ON group_warnings(chat_id, user_id, created_at DESC) WHERE active = TRUE;

      CREATE TABLE IF NOT EXISTS moderation_appeals (
        appeal_id UUID PRIMARY KEY,
        action_id UUID NOT NULL REFERENCES group_moderation_actions(action_id) ON DELETE CASCADE,
        appellant_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn')),
        reviewed_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        review_note TEXT CHECK (review_note IS NULL OR length(review_note) <= 2000),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS moderation_appeals_status_idx
        ON moderation_appeals(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS guard_join_requests (
        join_request_id UUID PRIMARY KEY,
        chat_id BIGINT NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        requested_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'verification_pending', 'approved', 'rejected', 'cancelled', 'expired')),
        user_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(user_snapshot) = 'object'),
        invite_link_fingerprint TEXT,
        verification_token_hash TEXT,
        verification_expires_at TIMESTAMPTZ,
        decided_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 1000),
        decided_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (chat_id, user_id, requested_at)
      );
      CREATE INDEX IF NOT EXISTS guard_join_requests_queue_idx
        ON guard_join_requests(chat_id, requested_at) WHERE status IN ('queued', 'verification_pending');

      CREATE TABLE IF NOT EXISTS guard_decisions (
        decision_id UUID PRIMARY KEY,
        join_request_id UUID NOT NULL REFERENCES guard_join_requests(join_request_id) ON DELETE CASCADE,
        actor_user_id BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        decision TEXT NOT NULL CHECK (decision IN ('queue', 'request_verification', 'approve', 'reject', 'expire', 'cancel')),
        reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
        signals JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(signals) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS guard_decisions_request_created_idx
        ON guard_decisions(join_request_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS secretary_reminders (
        reminder_id UUID PRIMARY KEY,
        owner_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        chat_id BIGINT,
        thread_id BIGINT,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
        due_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled'
          CHECK (status IN ('scheduled', 'claimed', 'delivered', 'cancelled', 'failed')),
        delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 20),
        claimed_by UUID,
        claim_expires_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        last_error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS secretary_reminders_due_idx
        ON secretary_reminders(due_at, reminder_id) WHERE status IN ('scheduled', 'claimed');
      CREATE INDEX IF NOT EXISTS secretary_reminders_owner_idx
        ON secretary_reminders(owner_user_id, due_at DESC);

      CREATE TABLE IF NOT EXISTS secretary_jobs (
        job_id UUID PRIMARY KEY,
        owner_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        chat_id BIGINT REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        thread_id BIGINT,
        job_type TEXT NOT NULL CHECK (job_type IN ('daily_summary', 'topic_summary', 'meeting_notes', 'task_digest')),
        schedule TEXT NOT NULL CHECK (length(schedule) BETWEEN 1 AND 100),
        timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
        status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'paused', 'failed')),
        configuration JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration) = 'object'),
        next_run_at TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        last_error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS secretary_jobs_due_idx
        ON secretary_jobs(next_run_at, job_id) WHERE status = 'enabled';

      CREATE TABLE IF NOT EXISTS managed_bot_profiles (
        bot_profile_id UUID PRIMARY KEY,
        owner_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
        telegram_bot_id BIGINT,
        telegram_username TEXT CHECK (telegram_username IS NULL OR length(telegram_username) <= 64),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'configured', 'connected', 'error', 'disabled')),
        configuration JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration) = 'object'),
        last_health_at TIMESTAMPTZ,
        last_error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (telegram_bot_id)
      );
      CREATE INDEX IF NOT EXISTS managed_bot_profiles_owner_idx
        ON managed_bot_profiles(owner_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS managed_bot_credentials (
        bot_profile_id UUID PRIMARY KEY REFERENCES managed_bot_profiles(bot_profile_id) ON DELETE CASCADE,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        key_version TEXT NOT NULL CHECK (length(key_version) BETWEEN 1 AND 64),
        token_fingerprint TEXT NOT NULL CHECK (token_fingerprint ~ '^[a-f0-9]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO feature_flags (feature_key, enabled, description)
      VALUES
        ('guard_mode', FALSE, 'Persistent Telegram group join-request verification'),
        ('secretary_automation', FALSE, 'Scheduled reminders and authorized group productivity jobs'),
        ('managed_bots', FALSE, 'Encrypted managed bot profiles and connectivity operations')
      ON CONFLICT (feature_key) DO NOTHING;
    `
  }),
  Object.freeze({
    version: "2026071702_telegram_contexts",
    sql: `
      ALTER TABLE telegram_groups
        ADD COLUMN IF NOT EXISTS bot_is_administrator BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      UPDATE telegram_groups
      SET bot_is_administrator = bot_status IN ('creator', 'administrator'),
          last_seen_at = GREATEST(last_seen_at, last_event_at)
      WHERE bot_is_administrator IS DISTINCT FROM (bot_status IN ('creator', 'administrator'))
         OR last_seen_at < last_event_at;

      ALTER TABLE telegram_group_settings
        ADD COLUMN IF NOT EXISTS activation_policy TEXT NOT NULL DEFAULT 'mention_only',
        ADD COLUMN IF NOT EXISTS default_mode TEXT NOT NULL DEFAULT 'chat',
        ADD COLUMN IF NOT EXISTS response_visibility TEXT NOT NULL DEFAULT 'reply',
        ADD COLUMN IF NOT EXISTS secretary_observation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS message_storage_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 7,
        ADD COLUMN IF NOT EXISTS bot_to_bot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS bot_to_bot_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS always_on_confirmed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS thread_isolation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS delegation_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE telegram_group_settings
        DROP CONSTRAINT IF EXISTS telegram_group_settings_activation_policy_check,
        ADD CONSTRAINT telegram_group_settings_activation_policy_check
          CHECK (activation_policy IN ('mention_only', 'command_only', 'mention_command_or_reply', 'administrators_only', 'always_on')),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_response_visibility_check,
        ADD CONSTRAINT telegram_group_settings_response_visibility_check
          CHECK (response_visibility IN ('reply', 'public', 'silent')),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_retention_days_check,
        ADD CONSTRAINT telegram_group_settings_retention_days_check
          CHECK (retention_days BETWEEN 1 AND 90),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_bot_to_bot_allowlist_check,
        ADD CONSTRAINT telegram_group_settings_bot_to_bot_allowlist_check
          CHECK (jsonb_typeof(bot_to_bot_allowlist) = 'array'),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_delegation_policy_check,
        ADD CONSTRAINT telegram_group_settings_delegation_policy_check
          CHECK (jsonb_typeof(delegation_policy) = 'object'),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_always_on_confirmation_check,
        ADD CONSTRAINT telegram_group_settings_always_on_confirmation_check
          CHECK (activation_policy <> 'always_on' OR always_on_confirmed_at IS NOT NULL);

      CREATE TABLE IF NOT EXISTS telegram_group_bot_permissions (
        chat_id BIGINT PRIMARY KEY REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        member_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (member_status IN ('creator', 'administrator', 'member', 'restricted', 'left', 'kicked', 'unknown')),
        permission_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permission_snapshot) = 'object'),
        verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS telegram_business_connections (
        connection_id TEXT PRIMARY KEY CHECK (length(connection_id) BETWEEN 1 AND 256),
        owner_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        user_chat_id BIGINT,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        can_reply BOOLEAN NOT NULL DEFAULT FALSE,
        rights JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rights) = 'object'),
        allowed_chat_configuration JSONB NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(allowed_chat_configuration) = 'object'),
        connected_at TIMESTAMPTZ NOT NULL,
        last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS telegram_business_connections_owner_idx
        ON telegram_business_connections(owner_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS telegram_observed_messages (
        observation_id UUID PRIMARY KEY,
        update_type TEXT NOT NULL CHECK (length(update_type) BETWEEN 1 AND 64),
        transport_mode TEXT NOT NULL CHECK (transport_mode IN ('group_secretary', 'telegram_secretary')),
        chat_id BIGINT NOT NULL,
        thread_id BIGINT,
        message_id BIGINT NOT NULL,
        sender_user_id BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        business_connection_id TEXT REFERENCES telegram_business_connections(connection_id) ON DELETE CASCADE,
        content TEXT CHECK (content IS NULL OR length(content) <= 20000),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'edited', 'deleted', 'expired')),
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS telegram_observed_messages_identity_idx
        ON telegram_observed_messages(transport_mode, chat_id, COALESCE(thread_id, 0), message_id);
      CREATE INDEX IF NOT EXISTS telegram_observed_messages_context_idx
        ON telegram_observed_messages(chat_id, thread_id, observed_at DESC)
        WHERE status IN ('active', 'edited');
      CREATE INDEX IF NOT EXISTS telegram_observed_messages_expiry_idx
        ON telegram_observed_messages(expires_at) WHERE status <> 'expired';

      CREATE TABLE IF NOT EXISTS telegram_capability_verifications (
        capability_key TEXT PRIMARY KEY CHECK (length(capability_key) BETWEEN 1 AND 64),
        status TEXT NOT NULL CHECK (status IN (
          'active', 'disabled', 'setup_required', 'permission_required', 'connected',
          'not_connected', 'configured_unverified', 'unavailable'
        )),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
        verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS telegram_bot_interactions (
        correlation_id UUID PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        thread_id BIGINT,
        sender_bot_id BIGINT NOT NULL,
        message_id BIGINT NOT NULL,
        message_fingerprint TEXT NOT NULL CHECK (message_fingerprint ~ '^[a-f0-9]{64}$'),
        chain_depth INTEGER NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 3),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (chat_id, message_id, sender_bot_id)
      );
      CREATE INDEX IF NOT EXISTS telegram_bot_interactions_expiry_idx
        ON telegram_bot_interactions(expires_at);

      INSERT INTO feature_flags (feature_key, enabled, description)
      VALUES ('telegram_context_routing', TRUE, 'Deterministic Telegram transport and invocation routing')
      ON CONFLICT (feature_key) DO NOTHING;
    `
  }),
  Object.freeze({
    version: "2026071703_adaptive_access_billing",
    sql: `
      ALTER TABLE platform_users
        ADD COLUMN IF NOT EXISTS language_code TEXT CHECK (language_code IS NULL OR length(language_code) <= 16),
        ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'standard'
          CHECK (plan IN ('standard', 'premium', 'business', 'staff')),
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'restricted', 'banned', 'disabled')),
        ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS first_interaction_source TEXT
          CHECK (first_interaction_source IS NULL OR length(first_interaction_source) <= 64),
        ADD COLUMN IF NOT EXISTS last_interaction_source TEXT
          CHECK (last_interaction_source IS NULL OR length(last_interaction_source) <= 64);
      CREATE INDEX IF NOT EXISTS platform_users_plan_status_idx
        ON platform_users(plan, status, last_seen_at DESC);

      ALTER TABLE telegram_business_connections
        ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'pending_access',
        ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS business_style TEXT NOT NULL DEFAULT 'friendly',
        ADD COLUMN IF NOT EXISTS custom_style TEXT,
        ADD COLUMN IF NOT EXISTS default_language TEXT NOT NULL DEFAULT 'auto',
        ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 30,
        ADD COLUMN IF NOT EXISTS activation_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS onboarding_sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS access_decided_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS access_decided_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL;
      ALTER TABLE telegram_business_connections
        DROP CONSTRAINT IF EXISTS telegram_business_connections_access_status_check,
        ADD CONSTRAINT telegram_business_connections_access_status_check CHECK (access_status IN (
          'pending_access', 'approval_requested', 'payment_required', 'payment_pending',
          'active_admin_approved', 'active_paid', 'denied', 'suspended', 'revoked', 'connection_disabled'
        )),
        DROP CONSTRAINT IF EXISTS telegram_business_connections_business_style_check,
        ADD CONSTRAINT telegram_business_connections_business_style_check
          CHECK (business_style IN ('formal', 'friendly', 'concise', 'custom')),
        DROP CONSTRAINT IF EXISTS telegram_business_connections_retention_days_check,
        ADD CONSTRAINT telegram_business_connections_retention_days_check CHECK (retention_days BETWEEN 1 AND 365),
        DROP CONSTRAINT IF EXISTS telegram_business_connections_custom_style_check,
        ADD CONSTRAINT telegram_business_connections_custom_style_check
          CHECK (custom_style IS NULL OR length(custom_style) <= 1000);
      CREATE INDEX IF NOT EXISTS telegram_business_connections_access_idx
        ON telegram_business_connections(access_status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS secretary_access_requests (
        request_id UUID PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES telegram_business_connections(connection_id) ON DELETE CASCADE,
        owner_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
        reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
        decided_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        decided_at TIMESTAMPTZ,
        cooldown_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS secretary_access_requests_pending_uidx
        ON secretary_access_requests(connection_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS secretary_access_requests_admin_idx
        ON secretary_access_requests(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS secretary_entitlements (
        entitlement_id UUID PRIMARY KEY,
        owner_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES telegram_business_connections(connection_id) ON DELETE CASCADE,
        product_id TEXT NOT NULL CHECK (product_id = 'secretary_lifetime_activation'),
        entitlement_version INTEGER NOT NULL DEFAULT 1 CHECK (entitlement_version > 0),
        source TEXT NOT NULL CHECK (source IN ('primary_admin', 'admin_approved', 'telegram_stars')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked', 'refunded')),
        telegram_payment_charge_id TEXT UNIQUE,
        granted_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        suspended_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
        UNIQUE (connection_id, product_id, entitlement_version)
      );
      CREATE INDEX IF NOT EXISTS secretary_entitlements_owner_idx
        ON secretary_entitlements(owner_user_id, status, granted_at DESC);

      CREATE TABLE IF NOT EXISTS secretary_contact_settings (
        connection_id TEXT NOT NULL REFERENCES telegram_business_connections(connection_id) ON DELETE CASCADE,
        contact_chat_id BIGINT NOT NULL,
        language_override TEXT,
        tone_override TEXT CHECK (tone_override IS NULL OR tone_override IN ('adaptive', 'formal', 'friendly', 'concise')),
        auto_reply_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
        introduction_sent_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (connection_id, contact_chat_id)
      );

      CREATE TABLE IF NOT EXISTS ai_usage_policies (
        policy_id UUID PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'plan', 'role', 'user', 'group', 'business_connection')),
        scope_id TEXT NOT NULL DEFAULT '*',
        feature_key TEXT NOT NULL DEFAULT 'ai_chat' CHECK (length(feature_key) BETWEEN 1 AND 64),
        channel TEXT NOT NULL DEFAULT '*' CHECK (length(channel) BETWEEN 1 AND 64),
        free_successes INTEGER NOT NULL DEFAULT 2 CHECK (free_successes BETWEEN 0 AND 100000),
        window_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (window_seconds BETWEEN 60 AND 2592000),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        expires_at TIMESTAMPTZ,
        updated_by BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (scope_type, scope_id, feature_key, channel)
      );
      INSERT INTO ai_usage_policies (policy_id, scope_type, scope_id, feature_key, channel, free_successes, window_seconds)
      VALUES ('00000000-0000-4000-8000-000000000002', 'global', '*', 'ai_chat', '*', 2, 3600)
      ON CONFLICT (scope_type, scope_id, feature_key, channel) DO NOTHING;

      CREATE TABLE IF NOT EXISTS ai_usage_events (
        usage_id UUID PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 500),
        owner_user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        subject_user_id BIGINT REFERENCES platform_users(user_id) ON DELETE SET NULL,
        feature_key TEXT NOT NULL CHECK (length(feature_key) BETWEEN 1 AND 64),
        channel TEXT NOT NULL CHECK (length(channel) BETWEEN 1 AND 64),
        group_id BIGINT,
        business_connection_id TEXT REFERENCES telegram_business_connections(connection_id) ON DELETE SET NULL,
        conversation_key TEXT CHECK (conversation_key IS NULL OR length(conversation_key) <= 500),
        billing_source TEXT NOT NULL CHECK (billing_source IN ('free', 'credit', 'unlimited')),
        status TEXT NOT NULL DEFAULT 'reserved'
          CHECK (status IN ('reserved', 'completed', 'failed', 'restored')),
        credit_cost INTEGER NOT NULL DEFAULT 0 CHECK (credit_cost BETWEEN 0 AND 10000),
        failure_category TEXT CHECK (failure_category IS NULL OR length(failure_category) <= 64),
        provider_model TEXT,
        provider_latency_ms INTEGER CHECK (provider_latency_ms IS NULL OR provider_latency_ms >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ai_usage_events_allowance_idx
        ON ai_usage_events(owner_user_id, feature_key, channel, completed_at DESC)
        WHERE status = 'completed' AND billing_source = 'free';
      CREATE INDEX IF NOT EXISTS ai_usage_events_analytics_idx
        ON ai_usage_events(created_at DESC, channel, status);

      ALTER TABLE telegram_group_settings
        ADD COLUMN IF NOT EXISTS captcha_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS captcha_verification_seconds INTEGER NOT NULL DEFAULT 2592000,
        ADD COLUMN IF NOT EXISTS captcha_max_attempts INTEGER NOT NULL DEFAULT 3,
        ADD COLUMN IF NOT EXISTS captcha_retry_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
        ADD COLUMN IF NOT EXISTS captcha_exempt_administrators BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS group_model TEXT,
        ADD COLUMN IF NOT EXISTS group_tone TEXT NOT NULL DEFAULT 'adaptive',
        ADD COLUMN IF NOT EXISTS group_language TEXT NOT NULL DEFAULT 'auto',
        ADD COLUMN IF NOT EXISTS group_response_length TEXT NOT NULL DEFAULT 'balanced',
        ADD COLUMN IF NOT EXISTS group_creativity NUMERIC(3,2) NOT NULL DEFAULT 0.40,
        ADD COLUMN IF NOT EXISTS group_instructions TEXT,
        ADD COLUMN IF NOT EXISTS allowed_topics JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE telegram_group_settings
        DROP CONSTRAINT IF EXISTS telegram_group_settings_captcha_verification_seconds_check,
        ADD CONSTRAINT telegram_group_settings_captcha_verification_seconds_check
          CHECK (captcha_verification_seconds BETWEEN 300 AND 31536000),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_captcha_max_attempts_check,
        ADD CONSTRAINT telegram_group_settings_captcha_max_attempts_check CHECK (captcha_max_attempts BETWEEN 1 AND 10),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_group_tone_check,
        ADD CONSTRAINT telegram_group_settings_group_tone_check CHECK (group_tone IN ('adaptive', 'formal', 'casual', 'friendly', 'concise')),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_group_response_length_check,
        ADD CONSTRAINT telegram_group_settings_group_response_length_check CHECK (group_response_length IN ('concise', 'balanced', 'detailed')),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_group_creativity_check,
        ADD CONSTRAINT telegram_group_settings_group_creativity_check CHECK (group_creativity BETWEEN 0 AND 1),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_group_instructions_check,
        ADD CONSTRAINT telegram_group_settings_group_instructions_check CHECK (group_instructions IS NULL OR length(group_instructions) <= 5000),
        DROP CONSTRAINT IF EXISTS telegram_group_settings_allowed_topics_check,
        ADD CONSTRAINT telegram_group_settings_allowed_topics_check CHECK (jsonb_typeof(allowed_topics) = 'array');

      CREATE TABLE IF NOT EXISTS group_user_verifications (
        group_id BIGINT NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified', 'revoked')),
        verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        verified_by TEXT NOT NULL DEFAULT 'captcha' CHECK (verified_by IN ('captcha', 'administrator', 'exempt')),
        PRIMARY KEY (group_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS group_user_verifications_expiry_idx
        ON group_user_verifications(expires_at) WHERE expires_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS captcha_challenges (
        challenge_id UUID PRIMARY KEY,
        group_id BIGINT NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        answer_hash TEXT NOT NULL CHECK (answer_hash ~ '^[a-f0-9]{64}$'),
        prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 200),
        options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array'),
        original_request JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(original_request) = 'object'),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
        expires_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS captcha_challenges_active_uidx
        ON captcha_challenges(group_id, user_id) WHERE completed_at IS NULL;
      CREATE INDEX IF NOT EXISTS captcha_challenges_expiry_idx
        ON captcha_challenges(expires_at) WHERE completed_at IS NULL;

      CREATE TABLE IF NOT EXISTS credit_vouchers (
        voucher_id UUID PRIMARY KEY,
        creation_request_id UUID NOT NULL UNIQUE,
        code_hash TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
        display_prefix TEXT NOT NULL CHECK (length(display_prefix) BETWEEN 4 AND 16),
        credit_amount INTEGER NOT NULL CHECK (credit_amount BETWEEN 1 AND 1000000),
        maximum_redemptions INTEGER NOT NULL DEFAULT 1 CHECK (maximum_redemptions BETWEEN 1 AND 1000000),
        redemptions_used INTEGER NOT NULL DEFAULT 0 CHECK (redemptions_used >= 0 AND redemptions_used <= maximum_redemptions),
        per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit BETWEEN 1 AND 1000),
        eligible_plans JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(eligible_plans) = 'array'),
        eligible_roles JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(eligible_roles) = 'array'),
        assigned_user_id BIGINT REFERENCES platform_users(user_id) ON DELETE CASCADE,
        created_by BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE RESTRICT,
        valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        revoked_at TIMESTAMPTZ,
        internal_note TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 1000),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS credit_vouchers_admin_idx
        ON credit_vouchers(created_by, created_at DESC);
      CREATE TABLE IF NOT EXISTS voucher_redemptions (
        redemption_id UUID PRIMARY KEY,
        voucher_id UUID NOT NULL REFERENCES credit_vouchers(voucher_id) ON DELETE RESTRICT,
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        credits_added INTEGER NOT NULL CHECK (credits_added > 0),
        redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (voucher_id, user_id, redemption_id)
      );
      CREATE INDEX IF NOT EXISTS voucher_redemptions_user_idx
        ON voucher_redemptions(user_id, redeemed_at DESC);

      CREATE TABLE IF NOT EXISTS web_oidc_requests (
        state_hash TEXT PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
        nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 200),
        code_verifier_ciphertext TEXT NOT NULL,
        redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 8 AND 2000),
        return_to TEXT NOT NULL DEFAULT '/' CHECK (return_to ~ '^/'),
        source_hash TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS web_oidc_requests_expiry_idx ON web_oidc_requests(expires_at);
      CREATE TABLE IF NOT EXISTS web_sessions (
        session_id UUID PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        csrf_hash TEXT NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
        user_id BIGINT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
        idle_expires_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS web_sessions_user_active_idx
        ON web_sessions(user_id, expires_at DESC) WHERE revoked_at IS NULL;

      INSERT INTO feature_flags (feature_key, enabled, description)
      VALUES
        ('adaptive_secretary', TRUE, 'Adaptive Telegram Business Secretary routing and access control'),
        ('group_captcha', TRUE, 'First-use verification for group AI access'),
        ('credit_vouchers', TRUE, 'Administrator-issued internal AI credit vouchers'),
        ('telegram_web_login', TRUE, 'Telegram OIDC website login when configured')
      ON CONFLICT (feature_key) DO NOTHING;
    `
  }),
  Object.freeze({
    version: "2026071901_conversation_transport_channels",
    sql: `
      ALTER TABLE conversations
        DROP CONSTRAINT IF EXISTS conversations_channel_check;
      ALTER TABLE conversations
        ADD CONSTRAINT conversations_channel_check
        CHECK (channel IN (
          'telegram',
          'telegram_business',
          'telegram_guest',
          'telegram_inline',
          'miniapp',
          'web',
          'whatsapp',
          'managed_bot'
        ));
    `
  }),
  GROUP_MANAGER_MIGRATION,
  GROUP_MANAGER_QUEUE_MIGRATION
]);

function migrationChecksum(migration) {
  return crypto.createHash("sha256").update(`${migration.version}\n${migration.sql}`).digest("hex");
}

export async function runMigrations(pool, { migrations = PLATFORM_MIGRATIONS } = {}) {
  if (!pool?.connect) throw new TypeError("A PostgreSQL pool is required to run migrations");
  const client = await pool.connect();
  const applied = [];
  try {
    // Replit publishes the development schema. Never perform production DDL.
    if (process.env.NVID_SCHEMA_MODE === "verify") {
      const tables = [...new Set(migrations.flatMap((migration) =>
        [...migration.sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/g)]
          .map((match) => match[1])
      ))];
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
        [tables]
      );
      const present = new Set(result.rows.map((row) => row.table_name));
      const missing = tables.filter((table) => !present.has(table));
      if (missing.length) {
        throw new Error(`Published database schema is missing tables: ${missing.join(", ")}. Republish to apply the development schema.`);
      }
      return { applied: [], currentVersion: migrations.at(-1)?.version || null };
    }
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('nvid-ai-platform-migrations', 0))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const existing = await client.query("SELECT version, checksum FROM app_schema_migrations");
    const checksums = new Map(existing.rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration);
      const previousChecksum = checksums.get(migration.version);
      if (previousChecksum && previousChecksum !== checksum) {
        throw new Error(`Migration checksum mismatch for ${migration.version}`);
      }
      if (previousChecksum) continue;
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO app_schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, checksum]
      );
      applied.push(migration.version);
    }
    await client.query("COMMIT");
    return { applied, currentVersion: migrations.at(-1)?.version || null };
  } catch (error) {
    try {
      if (process.env.NVID_SCHEMA_MODE !== "verify") await client.query("ROLLBACK");
    } catch {
      // Keep the migration failure as the primary error.
    }
    throw error;
  } finally {
    client.release();
  }
}
