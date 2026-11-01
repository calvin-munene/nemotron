# Nvid AI Platform Stabilization

## Status

- Branch: `feature/nvid-platform-stabilization`
- Deployment: included in the July 17, 2026 production release
- Migration: `2026071505_stabilization_foundation`
- Full automated suite: 106 passed, 0 failed

## Implemented

- Current database-backed platform and Telegram authorization on every billable AI request
- Durable PostgreSQL conversations and messages with user/chat/thread isolation
- Conversation create, list, open, search, rename and soft-delete APIs
- Mini App conversation history and active-conversation restoration
- Persistent NVIDIA model preference and structured user AI settings
- Structured owned assistants with validation and ownership enforcement
- Central AI entitlement policy preserving unlimited access for the configured primary administrator and explicit grants
- Recoverable billing states from reservation through delivery and completion
- Idempotent completion-recovery worker protected by a durable lease
- PostgreSQL-backed conversation generation leases, replay claims and expensive-operation rate limits
- WhatsApp AI feature flag defaulting to disabled, with shared quota and concurrency protection when enabled
- Checksummed ownership of the complete database schema
- Separate liveness, readiness and NVIDIA degradation reporting
- Explicit Render trusted-proxy policy
- Accurate Mini App preview/setup labels for incomplete future modules

## New database structures

- `assistants`
- `conversations`
- `conversation_messages`
- `durable_leases`
- `telegram_webapp_replays`
- `shared_rate_limits`

The migration also adopts the existing Telegram Stars schema into the checksummed registry, adds durable AI user settings, and extends prompt reservations with recoverable generation and delivery states.

## Migration safety

The migration uses `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, additive indexes and data-compatible constraints. It does not drop tables, truncate data, reset balances or delete payments.

Before production release:

1. Take a PostgreSQL snapshot or provider backup.
2. Confirm the current production migration version is `2026071504_billing_pricing`.
3. Deploy one instance first so the advisory-locked migration runs once.
4. Wait for `/health/ready` to report the new version.
5. Verify existing account balances, recent payments and recent reservations.
6. Only then allow normal traffic or additional instances.

Rollback procedure:

1. Do not remove the additive tables or columns.
2. While the stabilization version is still running, allow the completion-recovery worker to clear `completion_pending`, `delivered`, `delivery_attempted` and `response_produced` records.
3. Restore the prior application revision if necessary. The additive schema can safely remain.
4. Investigate any remaining non-terminal reservation before changing balances manually.
5. Never reset or truncate the Stars tables during rollback.

## Configuration

No new secret is required.

- Render health path: `/health/ready`
- Render non-secret environment value: `TRUST_PROXY=render`
- WhatsApp AI remains disabled until the `whatsapp_ai` feature flag is deliberately enabled.

## Intentionally postponed

- Administrator user-management dashboard
- Group entities and group settings
- Full group moderation commands
- Persistent Guard verification queue
- Secretary background jobs and reminders
- Managed bot provisioning
- Redis or a separate cache service

Low-risk static-route/IP limits remain process-local. Billable AI, authentication replay, administrator mutations, payment idempotency, recovery ownership and conversation concurrency now have database-backed protection.
