# Nvid AI Operating Services Milestone

Status: deployed to production on July 17, 2026.

## Completed

### Administrator user management

- Added authenticated user search, detail, role, ban/restriction, unlimited-credit, credit-adjustment, and internal-note APIs.
- Re-checks the acting administrator's current database role for every mutation.
- Reserves role, credit, unlimited-access, and administrator-target changes for the Super Admin.
- Prevents self-ban and protects the configured primary administrator from demotion or banning.
- Makes mutations transactional, request-idempotent, and audit logged.
- Added connected Mini App user-management screens with role-aware controls.

### Group entities and settings

- Persists Telegram groups, current bot state, group settings, and observed member state.
- Syncs group metadata from messages and Telegram membership updates.
- Added group list/detail/settings APIs and connected Mini App pages.
- Re-validates the requesting user's live Telegram administrator state before group writes.
- Supports rules, welcome/goodbye messages, warning policy, Guard state, and Secretary state.

### Moderation commands

Implemented Telegram commands and a connected Mini App action endpoint for:

`/ban`, `/unban`, `/kick`, `/mute`, `/unmute`, `/warn`, `/unwarn`, `/warnings`, `/purge`, `/pin`, `/unpin`, `/lock`, `/unlock`, `/rules`, `/setrules`, `/slowmode`, `/approve`, `/reject`, `/modlog`, `/admins`, and `/report`.

Every mutating action:

- Requires a supported group or supergroup.
- Checks the requesting user's current Telegram status and action-specific permission.
- Checks the bot's current Telegram permission.
- Protects creators, administrators, the bot, and invalid targets where applicable.
- Accepts safe reply targeting or an explicit numeric Telegram user ID.
- Creates a durable pending action before calling Telegram.
- Finalizes success, denial, or failure with actor, target, group, reason, duration, result, and timestamp.
- Uses a unique request ID so a replay cannot execute the Telegram action twice.

Warnings are persistent and can trigger the explicitly configured threshold consequence. Permanent severe actions are not enabled automatically by default.

### Persistent Guard queue

- Persists join requests, snapshots, status, and every decision.
- Supports queue, approve, reject, cancel, and verification-pending states.
- Verifies Guard mode, live requester authority, and the bot's `can_invite_users` permission before decisions.
- Prevents duplicate Telegram updates from creating duplicate queue decisions.
- Defaults Guard off. Automatic rejection occurs only when the group owner has explicitly enabled the relevant policy.
- Added connected Mini App queue controls and setup/permission states.

### Secretary jobs and reminders

- Persists reminders and scheduled task-digest jobs.
- Supports authenticated create, list, and cancel APIs and Mini App controls.
- Requires live group-admin verification for group destinations.
- Uses a durable global worker lease plus expiring row claims to prevent two Render instances from delivering the same work.
- Records delivery attempts, completion, failure codes, and retry state.
- Delivers reminders and task digests only to chats authorized at creation time.

### Managed bot provisioning architecture

- Persists managed bot profiles separately from encrypted credentials.
- Encrypts bot tokens with AES-256-GCM using profile-bound authenticated data.
- Stores a one-way token fingerprint and key version for safe rotation planning.
- Never returns stored tokens through APIs or the Mini App.
- Adds profile creation, listing, safe connectivity testing, health state, and deletion.
- Restricts management to authorized platform roles and a feature flag.
- Adds connected Mini App management controls and BotFather setup guidance.

This milestone does not provision new Telegram bots automatically: Telegram bot creation remains a BotFather action. It supplies the secure profile, credential, configuration, and connectivity foundation for later deployment integrations.

## Files

Created:

- `src/operatingStore.js`
- `src/managedBots.js`
- `test/managedBots.test.js`
- `OPERATING_SERVICES_MILESTONE.md`

Major modified files:

- `src/migrations.js`
- `src/platformStore.js`
- `src/channels.js`
- `src/server.js`
- `src/rbac.js`
- `public/miniapp.js`
- `public/miniapp.css`
- `.env.example`
- `../render.yaml`
- `test/channels.test.js`
- `test/server.test.js`
- `test/migrations.test.js`

The branch also contains the preceding stabilization milestone changes in `src/agent.js`, `src/starLedger.js`, `src/telegramWebAuth.js`, their tests, and supporting entitlement files.

## Database

Migration: `2026071701_operating_services`

Adds:

- `user_admin_notes`
- `telegram_groups`
- `telegram_group_settings`
- `telegram_group_members`
- `group_moderation_actions`
- `group_warnings`
- `moderation_appeals`
- `guard_join_requests`
- `guard_decisions`
- `secretary_reminders`
- `secretary_jobs`
- `managed_bot_profiles`
- `managed_bot_credentials`
- additive Telegram profile fields on `platform_users`
- supporting indexes, constraints, foreign keys, and default-off feature flags

Existing data handling:

- The migration contains only additive `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, indexes, and non-destructive feature inserts.
- The checksummed migration runner takes a PostgreSQL advisory transaction lock.
- A migration failure rolls back the complete migration transaction.
- A changed checksum is rejected instead of silently altering applied production history.

Recovery procedure:

1. Take a Render PostgreSQL backup before release.
2. Run the application release once against a staging clone and confirm `2026071701_operating_services` appears in `app_schema_migrations`.
3. If the migration fails, keep the old application release active; PostgreSQL rolls back the failed transaction.
4. If the application must be rolled back after a successful migration, redeploy the prior application version and leave the additive tables in place. Do not drop them from production.
5. Correct forward with a new checksummed migration. Never edit an already applied migration.

No destructive down migration is supplied because removing the tables could destroy moderation, Guard, reminder, or managed-bot data.

## Tests

Final local run:

- Tests run: 114
- Passed: 114
- Failed: 0
- Skipped: 0
- Duration: approximately 2.9 seconds

Coverage includes:

- Existing NVIDIA, Telegram Stars, Mini App, conversation, billing, and security behavior.
- Current database authorization and privilege separation.
- Live Telegram group permission checks.
- Stored administrator removed by Telegram.
- Duplicate moderation request replay.
- Persistent Guard setup and callback authorization.
- Durable Secretary delivery claims.
- Managed-bot authenticated encryption and safe connectivity metadata.
- Checksummed additive migrations.
- Multi-instance AI, replay, ledger, and worker controls from the stabilization milestone.

Additional verification:

- Node syntax checks passed for the Mini App and all modified service entry points.
- `git diff --check` passed; only Windows line-ending notices were emitted.
- Local liveness and Mini App route smoke tests returned HTTP 200 with security headers.
- No NVIDIA- or Telegram-credential-shaped values were found in application files.

Browser-driven visual QA could not be completed because the local browser-control runtime failed with a Windows `EPERM` filesystem error. The connected Mini App code passed syntax, API, routing, and HTTP shell tests.

## Configuration

Required existing production variables remain documented in `.env.example` and Render configuration. Never place their values in source control.

New managed-bot variables:

- `BOT_CREDENTIAL_ENCRYPTION_KEY`: base64 encoding of exactly 32 random bytes.
- `BOT_CREDENTIAL_KEY_VERSION`: start with `v1`; change only as part of a planned re-encryption process.

Feature flags created default to disabled:

- `guard_mode`
- `secretary_automation`
- `managed_bots`

Enable each only after the migration, Telegram permissions, and staging checks pass.

## Telegram setup

- Promote Nvid AI in each managed group with only the rights required for enabled actions.
- Guard join-request handling requires the bot to be an administrator with invite-user permission.
- Moderation actions require the corresponding restrict, delete, pin, or group-management permission.
- Enable the required update types on the webhook; the application now registers membership and join-request updates.
- Bot creation and inline-mode activation remain BotFather operations.
- Telegram does not permit a normal bot to read arbitrary private user conversations.

## Deployment

Production deployment completed on Render from the clean `agent/nvid-ai-latest` release branch and `main`.

Verified after release:

- Render deployed commit `f6c7cc4702e7e983abdb3000f646b24a927e1e58` successfully.
- `/health/live` returned `ok: true`.
- `/health/ready` returned `ready: true`.
- PostgreSQL reported healthy and migration version `2026071701_operating_services`.
- Telegram integration reported healthy.
- NVIDIA reported healthy and AI generation available.
- `/home`, `/groups`, `/moderation`, `/guard`, `/secretary`, `/bots`, and `/admin/users` returned HTTP 200 with Content Security Policy headers.
- Render reported no warning or error logs during the release window.
- Managed-bot encryption variables were added to Render without exposing their values.

The three new service feature flags remain disabled by default and should be enabled selectively after their Telegram permissions are configured. Credentials previously posted in chat still require rotation.

## Intentional limitations

- Bot creation itself remains in BotFather; automatic third-party deployment provisioning is outside this milestone.
- Secretary provides durable reminders and task digests. AI-generated daily summaries and meeting-note automation should be added only after authorized message-retention policy and background inference billing are defined.
- Anti-spam, anti-link, blocked-word, domain, and anti-flood policies are persisted, but fully automated enforcement is not enabled merely by displaying a setting. Each enforcement path still needs dedicated classification/action tests before rollout.
- CAPTCHA and Mini App Guard verification state is modeled, but a production challenge provider and signed completion flow are not enabled yet.
- Browser visual QA remains pending due to the local Windows browser-control failure.
