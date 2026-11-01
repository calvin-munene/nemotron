# Nemotron

Nemotron is a Telegram-native AI service with a Telegram bot, authenticated Mini App, Telegram Stars billing, a PostgreSQL platform foundation, and an optional WhatsApp Cloud API channel. NVIDIA remains the technical model provider.

## Run locally

1. Install Node.js 24.
2. Copy `.env.example` to `.env` and add your NVIDIA API key.
3. Run `npm start`.
4. Open `http://localhost:3000`.

Never put API keys in browser code or commit `.env`.

The HTTP service can start without provider credentials so its liveness endpoint and static Mini App remain available. AI responses require `NVIDIA_API_KEY`; `/health/live` reports process liveness, while `/health` and `/health/ready` report dependency readiness and provider availability.

## Browser model selector

The browser can switch between the server-approved NVIDIA models returned by `/api/models`. Set `NVIDIA_MODEL` for the preferred default and optionally set `NVIDIA_MODELS` to an authoritative comma-separated allowlist. If the preferred default is not in that allowlist, the first allowed model becomes the default. The NVIDIA API key remains server-side, and model IDs submitted by the browser are rejected unless they are allowed.

Browser answers stream token-by-token over a protected server-sent event connection. AI access requires a fresh Telegram Mini App launch followed by a short-lived signed session. The **STOP** control cancels the active NVIDIA request; failed generation restores any reserved AI credit.

## Secure platform foundation

Startup validates required environment configuration and runs additive, checksummed PostgreSQL migrations under an advisory lock. The platform foundation provides:

- Telegram-session authentication and replay-resistant Mini App launches.
- Platform roles and server-side permission checks.
- Database-backed feature flags.
- Transactional, idempotent administrative mutations.
- Durable audit logs and security events.
- Secret-redacted JSON logs.
- `/health/live` liveness and `/health` or `/health/ready` dependency readiness.

Administrator API routes are under `/api/admin/*`. They require a valid Telegram session, the appropriate platform permission, request rate limits, and same-origin checks for mutations. Configuration status endpoints return presence booleans only, never secret values.

## Mini App routes

The Telegram-authenticated Mini App is a mobile-first single-page application. Direct links restore the correct route and the Telegram Back Button is enabled only on supported client versions.

- User: `/home`, `/chat`, `/models`, `/assistants`, `/groups`, `/group/:id`, `/moderation`, `/bots`, `/guard`, `/secretary`, `/threads`, `/usage`, `/payments`, `/vouchers`, `/settings`, `/help`.
- Administrator: `/admin`, `/admin/users`, `/admin/user/:id`, `/admin/groups`, `/admin/access-requests`, `/admin/vouchers`, `/admin/analytics`, `/admin/models`, `/admin/features`, `/admin/pricing`, `/admin/payments`, `/admin/logs`, `/admin/system`.

Chat, assistant mode selection, model selection, payment history, usage history, feature flags, pricing, provider health, and audit logs use live backend APIs. Telegram capabilities that still require a group permission, BotFather setting, encryption key, or staged rollout are shown as unavailable with the specific requirement; the UI does not pretend they are active.

## Adaptive assistant modes

Each user has a durable assistant mode shared by Telegram and the Mini App. Available modes are Adaptive AI, Code Studio, Research Lab, Language Engine, Document Intelligence, and Executive Secretary. The selected mode changes the validated system instruction sent to NVIDIA while preserving user persona preferences and Telegram access boundaries. Administrators can disable a mode globally; disabled modes cannot be selected through either the API or interface. Switching modes is free, while an actual successful NVIDIA AI Chat response keeps the configured AI Chat credit price.

## NVIDIA reliability and billing

Nemotron discovers provider models from NVIDIA's OpenAI-compatible `/v1/models` endpoint with a bounded cache, while the database-backed administrator allowlist controls which models users can select. If a selected model is reported unavailable before a response starts, one approved fallback is attempted. Provider latency, failures, catalog state, and circuit status are exposed to authenticated administrators without credentials.

Telegram Stars transactions and prompt reservations remain in the original transactional ledger. User and administrator history endpoints read those tables directly. The default price remains one AI credit per successful non-admin message; failed requests restore the reservation, duplicate request IDs cannot charge again, administrators remain unlimited, and price changes are permission-checked, idempotent, and audited.

## VPS deployment

For a self-hosted Node.js 24 and PostgreSQL deployment, see the root repository's [`docs/VPS_DEPLOYMENT.md`](../docs/VPS_DEPLOYMENT.md). Store production environment variables in a root-owned environment file outside the checkout, use HTTPS, and back up PostgreSQL before updates.

## Telegram

1. Create a bot using `@BotFather`, then place its token in the Render `TELEGRAM_BOT_TOKEN` secret.
2. Set `PUBLIC_URL` to the deployed HTTPS origin and provide a random `TELEGRAM_WEBHOOK_SECRET`.
3. Set `TELEGRAM_ADMIN_USER_ID` to the numeric user ID authorized to view bot Stars totals and receive purchase/support notices.
4. To require prepaid messages, set `TELEGRAM_STARS_REQUIRED=true`, provide a random 32-byte-or-longer `TELEGRAM_STAR_SIGNING_SECRET`, and connect a durable PostgreSQL database with `DATABASE_URL`.
5. Optionally set `TELEGRAM_ALLOWED_USER_IDS` to a comma-separated list of Telegram user IDs. Leave it empty when any entitled Telegram user should be able to use the bot. Send `/whoami` to discover a numeric ID.
6. For external website login, configure the production origin and exact callback in BotFather, then set `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`, and `TELEGRAM_OIDC_REDIRECT_URI=https://YOUR_DOMAIN/auth/telegram/callback`. The backend uses Authorization Code Flow with PKCE and keeps tokens out of browser storage.

At startup the service validates the token, initializes the Stars ledger, restores stale prompt reservations, publishes member and administrator command scopes, registers the protected webhook, and verifies it with Telegram. Private and invoked group chats receive animated live edits while NVIDIA generates the answer; group replies remain in the originating topic. Ordinary uninvoked group messages are ignored and never billed.

With Stars charging enabled, `/topup N` presents the current terms and then opens a native Telegram invoice for exactly `N` XTR. A successful payment atomically adds `N` credits, and each accepted non-command prompt reserves one credit. Failed NVIDIA generation or final Telegram delivery restores the reservation. Payment charge IDs, terms acceptance, balances, prompt reservations, and refunds are stored transactionally and idempotently in PostgreSQL.

Telegram invoice revenue belongs to the bot's Stars balance. `TELEGRAM_ADMIN_USER_ID` controls Nemotron's admin command and notifications; it does not redirect Stars to an arbitrary Telegram user. The Telegram account that owns the bot in BotFather controls the bot balance.

Bot commands:

- `/start` and `/help` show usage.
- `/models` lists server-approved NVIDIA models.
- `/model 2` or `/model <model-id>` changes the model for that Telegram chat.
- `/use coding` (or `chat`, `research`, `translation`, `documents`, `secretary`) changes the user's durable assistant mode.
- `/reset` clears that private conversation context.
- `/balance` shows the user's credits and current free allowance.
- `/redeem CODE` redeems a secure Nemotron credit voucher.
- `/nvid <question>` invokes AI in a group; mentions and direct replies also activate it.
- `/nvid_register` lets a current group administrator register or refresh an existing group.
- `/topup 25` buys any whole number of credits from 1 to 10,000 with Telegram Stars.
- `/terms` shows the active purchase terms.
- `/paysupport <message>` sends a payment issue to the configured administrator.
- `/starbalance` shows the bot Stars balance and ledger totals to the configured administrator only.
- `/whoami` shows the user and chat IDs used by the optional allowlist.

## WhatsApp Cloud API

1. Create a Meta developer app, add WhatsApp, and obtain a permanent access token and phone-number ID.
2. Set the callback URL to `https://YOUR_DOMAIN/webhooks/whatsapp` and use the same value as `WHATSAPP_VERIFY_TOKEN`.
3. Subscribe the webhook to the `messages` field.
4. Set `META_APP_SECRET` to the app secret; incoming POST requests are verified with `X-Hub-Signature-256`.

During Meta's test phase, add recipient numbers in the developer dashboard. Production use requires the appropriate business setup, permissions, and message-template rules.

## Production checklist

- Rotate any credential that has appeared in a message, screenshot, file, or Git history.
- Keep `.env` untracked and set production secrets only in Render environment variables.
- Keep PostgreSQL backups and verify migrations against production-like data before deployment.
- Configure Telegram OIDC before enabling website login in production.
- Add a dedicated background worker queue and centralized monitoring before substantially increasing traffic.
- Keep the Mini App and webhook behind HTTPS.
