# Nemotron refresh: delivery and verification

## Before and after

- Nvid/NvidBot product copy, hooded imagery and command-center wording → Nemotron, a geometric mark and “Your AI workspace.”
- Existing interface → navy/gold tokens, locally hosted Sora/Inter, line icons, skeletons, reduced-motion support and safe-area-aware layout. No replacement framework or design system.
- Uneven navigation/card placement → five equal-width standard-user tabs, six for authorized admins, and a complete four-card grid. Hidden controls now remain visually hidden under component display rules.
- Raw personal Telegram ID → last four digits only. Greeting uses a first name only after the signed Telegram launch succeeds and its user ID matches; saved sessions use “Welcome.”
- Free allowance and credits → distinct allowance ring and AI-credit value. AI credits are not labelled as Stars revenue; vouchers also grant credits. Unknown capacity remains explicitly unavailable, never an invented maximum.
- Long history → last 12 bounded messages plus bounded older, untrusted excerpts. Ordinary replies still stream after the opening is checked; one repetitive opening can be corrected without another user turn or charge.
- Seeded global free allowance of 2/hour → 2 requests in a sliding 60-second window. Explicit non-default/user/role/plan policies remain intact.
- Slash-only interaction → the exact additive persistent keyboard, with existing handlers and owner-only Admin Panel.
- Three branded PNGs: 5,450,700 bytes → 180,697 bytes, a 97% reduction. Local font assets are additional, separately licensed assets.

## Verification by implementation step

| Step | Result |
| --- | --- |
| Existing contracts | Compared Mini App API-call expressions, slash-command tokens and callback data with the starting Git version: unchanged. No database schema, authentication, payment pricing, ledger or moderation/Guard behavior changes. |
| Branding and profile | Updated product copy/assets and artifact metadata. Live `setMyName`, `setMyDescription`, `setMyShortDescription` all succeeded; `getMyName`, `getMyDescription`, `getMyShortDescription` matched the exact requested values. |
| Theme and typography | Self-hosted Inter/Sora loaded with HTTP 200 and passed browser font checks. Existing CSP was not weakened. Outside Telegram defaults dark; supplied Telegram theme and safe-area behavior remain. |
| Dashboard/navigation | Signed-in standard-user dashboard checked at 390, 768 and 1280 pixels; owner dashboard checked separately. Hero, masked ID, balanced cards and five/six equal-width tabs rendered without horizontal overflow. Non-admin controls have computed `display:none`. |
| Loading/animation | Content remained visible with reduced motion. Removed opacity-based entry hiding and fixed native hidden styling. Unknown allowance presentation is explicit; credit animation skips unlimited/non-numeric values. |
| Performance | Immediate typing starts before slow work; independent Secretary reads are parallel. Native fetch pooling remains. Generation is capped at 2048 tokens, with the existing 90-second deadline and one shared network retry. No unsafe preference/access cache was added. |
| Reply style | Tests cover the exact tone, split greetings, only the last three openings, one correction maximum, usable-answer fallback, a single persisted turn, and retry bounds. |
| Quota | Tests cover creation-time sliding boundaries, reset, failure release, duplicate reservation, non-AI commands, fresh paid rechecks, quiet repeated denial and existing paid/unlimited paths. Development database read-only check and authenticated allowance endpoint HTTP 200 confirm 2 remaining / limit 2 / 60 seconds. Fixed the display query’s TEXT/BIGINT parameter inference without a schema change. |
| Keyboard | Tests verify every label dispatch, unchanged slash handlers, exact rows, owner visibility/stale ownership denial and bounded user/chat/thread input state. |
| Complete regression | `NVIDIA_AUTO_TOOLS=false node --test`: **196 passed, 0 failed**. Dedicated routing tests explicitly enable automatic routing. Syntax checks passed; the managed web workflow restarted cleanly; development readiness returned HTTP 200. |

The browser check initially found hidden controls overridden by CSS and blocked external fonts. Both were repaired and the same tester confirmed the repaired dashboard. It also exposed the allowance query’s type mismatch; the corrected query was confirmed directly against development PostgreSQL and through regression tests. No real Telegram messages or Stars purchases were made.

## Exact Telegram profile outcome

- Name: **Nemotron**
- Description: **Nemotron is your AI assistant for chat, groups and daily work. Fast answers, smart moderation, simple buttons.**
- Short description: **Fast AI assistant for chats, groups and work.**

All three values were applied and read back successfully. The local profile-picture PNG was replaced; the bot’s actual Telegram avatar was not changed by these name/description calls.

## Deferred items and limits

- User-setting/persona caching is deferred: existing writes span multiple paths, and reliable invalidation cannot be guaranteed under the unchanged-call restriction. No roles, permissions, quotas, balances or payments are cached.
- Greeted metadata, keyboard pending input and limit-notice suppression are bounded process memory. Restarting the service clears them. Available persisted conversation history still informs later replies.
- Older-history “summary” is bounded extractive context, not a separately generated or durable summary. Excerpts are treated as untrusted historical content.
- Paid credits continue after the free window; unlimited access is unchanged. The quiet-ignore behavior is only for requests denied by both fresh free-quota and paid-access checks. No debit/refund/idempotency semantics were replaced.
- No real-provider latency benchmark, load test, complete accessibility audit or real Telegram login/device test was performed. Browser testing used development-only signed sessions. It covered the changed dashboard, not every unchanged admin page.
- Existing NVIDIA-only generation, free-only search and existing image generation/editing limitations remain. Provider latency and model availability are not guaranteed by catalog/readiness checks.
- Existing Telegram usernames/links, deployment origins, command tokens, `NVID` voucher prefixes, environment/storage identifiers and canonical NVIDIA model/provider strings remain intentionally unchanged.
- Fonts use **SIL Open Font License 1.1**, with both full notices included. No new npm runtime dependency, Redis or paid service was added.
- The refresh has **not been published**.

## Actual changed and added files

### Documentation and artifact metadata
- `ai-agent/README.md`
- `ai-agent/NEMOTRON_REFRESH.md`
- `artifacts/nvid-ai/README.md`
- `artifacts/nvid-ai/.replit-artifact/artifact.toml`

### Interface
- `ai-agent/public/app.js`
- `ai-agent/public/index.html`
- `ai-agent/public/styles.css`
- `ai-agent/public/miniapp.html`
- `ai-agent/public/miniapp.css`
- `ai-agent/public/miniapp.js`

### Brand and font assets
- `ai-agent/public/og.png`
- `ai-agent/public/telegram/profile-picture.png`
- `ai-agent/public/telegram/welcome-banner.png`
- `ai-agent/public/telegram/mark.svg`
- `ai-agent/public/fonts/fonts.css`
- `ai-agent/public/fonts/inter-latin.woff2`
- `ai-agent/public/fonts/inter-latin-ext.woff2`
- `ai-agent/public/fonts/sora-latin.woff2`
- `ai-agent/public/fonts/sora-latin-ext.woff2`
- `ai-agent/public/fonts/Inter-OFL.txt`
- `ai-agent/public/fonts/Sora-OFL.txt`

### Backend
- `ai-agent/src/adaptiveSecretary.js`
- `ai-agent/src/agent.js`
- `ai-agent/src/assistantModes.js`
- `ai-agent/src/channels.js`
- `ai-agent/src/milestoneStore.js`
- `ai-agent/src/requestRouter.js`
- `ai-agent/src/server.js`
- `ai-agent/src/starPayments.js`
- `ai-agent/src/freeAllowance.js`
- `ai-agent/src/responseStyle.js`
- `ai-agent/src/telegramKeyboard.js`

### Tests
- `ai-agent/test/adaptiveSecretary.test.js`
- `ai-agent/test/agent.test.js`
- `ai-agent/test/channels.test.js`
- `ai-agent/test/milestoneStore.test.js`
- `ai-agent/test/miniappTelegramModes.test.js`
- `ai-agent/test/server.test.js`
- `ai-agent/test/nemotronRefresh.test.js`

### Agent working notes
- `.agents/memory/MEMORY.md`
- `.agents/memory/partial-patch-failures.md`
