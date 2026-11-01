# Nvid AI — Complete Platform Audit

**Audit date:** July 15, 2026
**Production URL:** https://nvidbot.onrender.com
**Audited revision:** `6da05e94fec6da37222f7b8a348dbb9d72b68f95`

## Executive summary

Nvid AI has a solid, working production core. Telegram messaging, NVIDIA streaming, Telegram Stars billing, Mini App authentication, role controls, administrator model management, and production health monitoring are operational.

The platform is not yet the complete premium Telegram SaaS described in the product specification. Several advanced modes appear in the interface but currently operate as prompt presets, basic setup screens, or limited foundations.

No production data, environment variables, deployment settings, or source files were changed during this audit other than the creation of this report.

## Current production status

- Render deployment: live
- Telegram webhook: healthy
- PostgreSQL database: healthy
- NVIDIA provider: healthy
- Homepage: HTTP 200 with Content Security Policy
- Automated tests: **90 passed, 0 failed**
- Tracked-secret scan: no Telegram or NVIDIA credentials detected
- Working tree during audit: clean except for the user's untracked attachment directory

## Technology stack

| Component | Implementation |
|---|---|
| Runtime | Node.js 22, native HTTP server |
| Database | PostgreSQL using `pg` |
| Telegram | Direct Telegram Bot API integration |
| NVIDIA | OpenAI-compatible NVIDIA API with streaming |
| Mini App | Vanilla HTML, CSS and JavaScript |
| Billing | Telegram Stars converted into internal credits |
| Hosting | Render web service |
| Deployment | Git-based Render automatic deployment |
| Tests | Native Node test runner |

## Important application files

- `src/server.js` — HTTP server, APIs, webhooks and static application
- `src/channels.js` — Telegram, WhatsApp, payments, commands and Guard logic
- `src/agent.js` — NVIDIA inference, streaming, model catalog and conversation context
- `src/starLedger.js` — credits, payments, reservations and user controls
- `src/starPayments.js` — invoice payload signing and payment terms
- `src/telegramWebAuth.js` — Telegram Mini App authentication
- `src/platformStore.js` — roles, feature flags, logs, models and pricing
- `src/rbac.js` — role and permission definitions
- `src/migrations.js` — platform database migrations
- `public/miniapp.js` — Mini App interface and navigation
- `render.yaml` — Render deployment configuration

## How Telegram AI chat works

1. Telegram sends an update to `/webhooks/telegram`.
2. Nvid AI verifies the Telegram webhook secret.
3. The request is rate-limited and size-limited before JSON processing.
4. Payment, callback, Guard and normal-message updates are routed separately.
5. Before AI inference, Nvid AI checks:
   - Whether the user is banned
   - Whether AI chat is enabled
   - The selected assistant mode
   - The selected NVIDIA model
   - The user's persona
   - Available credits or unlimited status
   - Whether another request is already running for the conversation
6. One credit is reserved.
7. NVIDIA generates a streamed response.
8. Telegram receives typing actions and progressively generated output where supported.
9. The final answer is sent.
10. The reserved credit is marked completed.
11. If NVIDIA fails before producing an answer, the reservation is restored.

Group context is separated using chat, topic/thread and user scope. This prevents cross-user and cross-topic context leakage.

## NVIDIA integration

Implemented:

- Streamed completions
- Dynamic model catalog loading
- Fifteen-minute model metadata cache
- Administrator model allowlist
- User model selection
- Model-unavailable fallback
- Bounded retries for rate limits and server failures
- Request deadlines
- Provider health monitoring
- Provider usage quotas
- Circuit-breaker behavior
- Server-sent event response parsing
- Safe provider error handling

The system contains fallback model definitions but normally retrieves models dynamically.

### NVIDIA limitations

- Telegram model preferences are stored in a process-local map and may disappear after a Render restart or deployment.
- Chat history is also process-local and cannot safely support multiple application instances.
- The WhatsApp integration does not use the same mature quota and billing controls as Telegram.

## Telegram Stars billing

Current pricing:

- One purchased Telegram Star produces one internal credit.
- One successful AI chat normally consumes one credit.
- The configured primary administrator has unlimited usage.

Implemented billing controls:

- Signed invoice payloads
- Payment terms acceptance
- Pre-checkout validation
- Payment transaction records
- Unique Telegram charge IDs
- AI request reservation IDs
- Duplicate callback handling
- Duplicate request protection
- Reserved, completed and restored states
- Refund processing
- Stale reservation recovery
- Provider usage budgeting

Relevant database tables:

- `telegram_star_accounts`
- `telegram_star_payments`
- `telegram_star_terms_acceptances`
- `telegram_star_prompt_reservations`
- `ai_provider_usage_buckets`

### Billing weaknesses

The final response is delivered before the database marks the reservation completed. If the response reaches Telegram or the browser but the final database update fails, the stale reservation may later be restored. A user could receive a successful answer without being charged.

This avoids overcharging but does not provide exactly-once charging. The platform needs a durable `response_produced` or `completion_pending` recovery state.

Assigning a user the platform `admin` role also does not automatically grant unlimited AI. Unlimited access currently depends on the configured primary administrator ID or a separate `unlimited_credits` flag.

## Telegram Mini App

Implemented:

- Telegram WebApp SDK integration
- Telegram `initData` signature verification
- `auth_date` expiration checks
- Replay prevention
- Signed one-hour backend sessions
- Telegram light and dark theme integration
- Mobile-responsive layout
- Safe-area support
- Session restoration
- Direct routes and navigation
- Streaming AI chat
- Stop generation
- Model selection
- Mode selection
- Usage history
- Payment history
- Administrator model controls
- Administrator feature controls
- Administrator pricing controls
- Administrator logs and system status
- Loading and error handling
- Content Security Policy

Routes with useful connected functionality:

- `/home`
- `/chat`
- `/models`
- `/assistants`
- `/usage`
- `/payments`
- `/settings`
- `/help`
- `/admin`
- `/admin/models`
- `/admin/features`
- `/admin/payments`
- `/admin/logs`
- `/admin/system`

### Incomplete Mini App routes

These currently behave as unavailable or setup experiences rather than completed services:

- `/groups`
- `/group/:id`
- `/moderation`
- `/bots`
- `/guard`
- `/secretary`
- `/threads`
- `/admin/users`
- `/admin/groups`

The `/history` route currently displays billing and usage records rather than AI conversation history.

## Assistant modes

Persistent user mode selection exists. Current assistant modes include:

- Adaptive AI chat
- Coding
- Research
- Translation
- Documents
- Secretary

A mode changes the NVIDIA system instructions and combines them with the user's persona.

The bot therefore adapts its writing and reasoning behavior, but most modes remain prompt-based:

- Secretary mode does not yet maintain tasks, reminders or daily summaries.
- Research mode does not have an external research and source-verification pipeline.
- Documents mode does not yet provide file ingestion and durable document storage.
- Coding mode does not have an isolated workspace or code-execution sandbox.

Operational mode flags also exist for Inline AI, Bot Management, Guest Chat, Guard, Bot-to-Bot and Threaded Mode. Not every corresponding backend service has been completed.

## Telegram commands

Implemented commands:

- `/start`
- `/help`
- `/dashboard`
- `/app`
- `/modes`
- `/mode`
- `/use`
- `/persona`
- `/models`
- `/model`
- `/reset`
- `/balance`
- `/topup`
- `/terms`
- `/paysupport`
- `/support`
- `/ban`
- `/unban`
- `/starbalance`
- `/whoami`

The current `/ban` and `/unban` commands control access to Nvid AI. They are not full Telegram group moderation commands.

Requested group-management commands that are not yet implemented include:

- `/kick`
- `/mute`
- `/unmute`
- `/warn`
- `/unwarn`
- `/warnings`
- `/purge`
- `/lock`
- `/unlock`
- `/rules`
- `/setrules`
- `/slowmode`
- `/modlog`
- `/admins`
- `/report`

## Advanced Telegram feature status

| Feature | Status |
|---|---|
| Normal private AI chat | Working |
| Group/topic context separation | Working |
| Selected assistant modes | Working |
| User persona | Working |
| Telegram Stars | Working |
| Guard permission verification | Working |
| Guard join-request callbacks | Basic implementation |
| Inline mode | Partial: launcher results, not full billed inline AI |
| Threaded AI | Partial: isolated context and reply threading |
| Secretary | Prompt mode only |
| Guest chat | Basic mode gating |
| Bot management | Not implemented |
| Bot-to-bot automation | Not fully implemented |
| Full group moderation | Not implemented |
| AI moderation | Not implemented |
| Persistent conversations | Not implemented |
| Reminders/background jobs | Not implemented |

Guard Mode currently supports basic join-request notification and configured-administrator approval or rejection. It verifies Guard state, the requester's current Telegram administrator status and the bot's required permissions.

It does not yet provide a durable join queue, CAPTCHA, rule acknowledgement, anti-raid analysis or Mini App verification workflow.

## Database audit

The platform migration system manages:

- `platform_users`
- `feature_flags`
- `audit_logs`
- `security_events`
- `ai_models`
- `billing_prices`
- `app_schema_migrations`

The Stars subsystem separately manages:

- Star accounts
- Payments
- Terms acceptance
- Prompt reservations
- Global modes
- Per-user controls
- Provider usage budgets

Missing durable entities include:

- Conversations
- Messages
- Structured assistants
- Groups
- Group members
- Group settings
- Warnings
- Moderation actions
- Moderation rules
- Appeals
- Join-request queue
- Guard decisions
- Bot profiles
- Encrypted bot credentials
- Notifications
- Background jobs

Conversation content is stored in an in-memory `Map` in `src/agent.js`. It is lost when Render restarts and cannot safely support multiple instances.

The Stars schema also performs some `CREATE TABLE` and `ALTER TABLE` operations outside the checksummed migration registry. The reported platform migration version therefore does not represent the complete deployed schema.

## Roles and authorization

Implemented platform roles:

- Super Admin
- Admin
- Moderator
- Support
- Premium User
- Standard User
- Restricted User
- Banned User

Strong controls:

- Server-side permission enforcement
- Live platform-role lookup
- Administrator endpoint protection
- Same-origin validation for mutations
- Audit logging
- Security-event logging
- Configured primary administrator becomes Super Admin

Missing administration functions:

- Connected `/admin/users` dashboard
- User search and detailed profiles
- Role-management interface
- Credit-adjustment interface
- Internal administrator notes
- User audit-history interface

### Session authorization gap

The Mini App verifies platform restrictions when issuing a session, and most user endpoints re-check authorization.

`/api/chat` does not run the same platform authorization middleware for every request. A user changed to restricted or banned may continue using an already-issued chat session until it expires unless they are also banned in the Telegram user-control ledger.

Sessions last up to one hour. Current platform status should be checked for every paid AI request.

## WhatsApp integration

WhatsApp webhook signature verification and basic AI replies exist.

The WhatsApp channel currently bypasses several Telegram protections:

- No Stars billing
- No account entitlement
- No persistent user mode
- No platform role enforcement
- No per-user durable quota
- No complete concurrency control
- No equivalent assistant settings

A valid WhatsApp user who can contact the business number may consume NVIDIA quota without credits. Meta's webhook signature prevents forged webhooks but does not control provider spending by legitimate senders.

This integration should remain limited or disabled until durable entitlement, quota and role controls are implemented.

## Security assessment

Strong security controls:

- Secrets loaded through environment variables
- No tracked NVIDIA or Telegram secrets detected
- Telegram webhook-secret verification
- WhatsApp signature verification
- Mini App HMAC validation
- Expired-launch rejection
- Replay prevention
- Signed backend sessions
- Request size limits before parsing
- Content-type validation
- CSP, referrer and permissions headers
- Parameterized database queries
- Transactional billing operations
- Role-based access control
- Audit and security-event logs
- Rate limiting
- Secret-redacted structured logging
- Provider retry limits and circuit breaker
- Guard permission verification

Priority weaknesses:

1. Existing Mini App chat sessions do not immediately honor platform bans.
2. WhatsApp can consume NVIDIA quota without entitlement.
3. Conversation and model state is process-local.
4. Successful responses can become free after ledger-completion failure.
5. Rate limits, replay tracking and concurrency locks are process-local.
6. Client IP handling trusts the first forwarded IP without an explicit trusted-proxy policy.
7. Readiness can return healthy while NVIDIA is unavailable.
8. Advanced feature navigation exceeds actual backend completeness.
9. Database migration tracking does not cover the complete schema.
10. Credentials previously shared through chat should be considered exposed.

The dedicated Codex Security scanner could not run its required preflight because Python was unavailable in the audit environment. This report is a comprehensive direct code, test and production-health audit, but not a formal exhaustive scanner artifact.

## Credential warning

Telegram bot tokens and an NVIDIA API key were previously shared through chat. Even though they were not found in tracked repository files, they should be treated as exposed.

Recommended rotation procedure:

1. Generate a new NVIDIA API key.
2. Revoke the previously shared NVIDIA key.
3. Revoke or regenerate affected Telegram bot tokens through BotFather.
4. Update the corresponding Render environment variables.
5. Redeploy the service.
6. Confirm webhook, database and NVIDIA health.
7. Never paste replacement credentials into chat or repository files.

## Render deployment audit

Current Render configuration:

- Node.js 22.22.2
- `npm ci` build command
- `npm start` start command
- `/health` health-check path
- Environment-managed secrets
- Git automatic deployment
- PostgreSQL configuration
- Public Mini App URL

Deployment risks:

- Free instances may sleep or cold-start.
- In-memory context, rate limits and replay caches reset during restart.
- Multiple instances would have inconsistent conversation context, replay protection and request locks.
- Database migrations run during application startup instead of a dedicated release phase.

## Final verdict

Nvid AI's production core is healthy and all current automated tests pass. Telegram AI chat, NVIDIA streaming, Stars billing, secure Mini App login and basic administration are real working features.

The largest gaps are persistence and operational depth. The platform currently behaves like a capable paid AI bot with an expanding SaaS dashboard, but it is not yet a complete Telegram AI operating system.

## Recommended implementation order

1. Persist conversations, messages, model preferences and assistants.
2. Enforce current platform authorization inside every AI chat request.
3. Make billing completion recoverable after response delivery.
4. Add durable distributed rate limits, replay protection and locks.
5. Complete administrator user management.
6. Build group and moderation data models and commands.
7. Upgrade Guard with a persistent queue and verification workflows.
8. Implement Secretary jobs, summaries, tasks and reminders.
9. Complete billed inline AI.
10. Secure or temporarily disable unmetered WhatsApp inference.
11. Move every schema change into checksummed migrations.
12. Rotate previously exposed credentials.

## Test report

- Test runner: Node native test runner
- Tests executed: 90
- Passed: 90
- Failed: 0
- Live health endpoint: passed
- Live homepage check: passed
- Database connectivity: passed
- Telegram configuration health: passed
- NVIDIA provider health: passed
- Tracked credential-pattern scan: clear
