# Nemotron Group Manager — implementation and verification

## Status and activation

The isolated Group Manager is implemented using the existing PostgreSQL database. Redis and BullMQ are not required, and no dependencies were added.

It is **disabled by default**, both globally and for each group. This work does not publish the application or enable moderation in existing groups.

1. In the owner's existing Mini App administration features screen, enable `group_manager`.
2. Make the bot a Telegram group administrator with delete-message and restrict/ban permissions. Administrator bots receive group messages; otherwise disable privacy mode through BotFather.
3. Start a private conversation with the bot. Verified group administrators and the owner can open **👥 My Groups**.
4. Choose a group, review its settings, and select **Enable group**. Enable a consenting test group first.
5. Leave the global flag off, or disable the individual group, to stop new moderation. Already scheduled message deletion and compensating unban jobs can still run.

The worker discovers previously tracked Telegram groups and refreshes their administrator registry. It does not enumerate groups that Telegram has never delivered to this application.

## Changed files

New module:

- `src/groupManager/migration.js`: two additive migrations; isolated `gm_*` tables and a disabled feature flag.
- `src/groupManager/policy.js`: validation, default settings, prefilters, warning escalation, encrypted queue payloads.
- `src/groupManager/store.js`: transactional warnings, durable jobs, leases, shared rate limits, metadata/audit records, expiry.
- `src/groupManager/ai.js`: bounded NVIDIA text classifier; validated category/confidence output and fail-open errors.
- `src/groupManager/manager.js`: capture, four background workers, role checks, enforcement, welcomes, cleanup and weekly reports.
- `src/groupManager/panel.js`: private group list, native inline settings, trusted-member review and pardon.

Integration:

- `src/channels.js`: module dispatch, decorated private keyboard, shared outgoing budgets when enabled, and Telegram `retry_after` propagation.
- `src/server.js`: durable Group Manager capture before webhook acknowledgement; worker startup; ingress allowance raised from 600 to 1,200 updates/minute.
- `src/telegramKeyboard.js`: icon-labelled native two-column keyboard, conditional My Groups row and owner-only full-width Admin Panel. Legacy undecorated labels still dispatch to the same handlers.
- `src/migrations.js`: appended migrations; no deletion or replacement of existing application/payment data.

Tests:

- `test/groupManager.test.js`
- `test/groupManagerPostgres.test.js`
- Existing keyboard and migration expectations updated in `test/nemotronRefresh.test.js` and `test/migrations.test.js`.

## Behavior

- Every delivered ordinary/edited group message is considered independently of mention/reply activation. Enabled-group text/captions enter an encrypted queue before Telegram receives HTTP success.
- Fast filters handle blocked links, invite links, hidden URL entities, configured keywords, restricted regex and repetition. Known benign greetings can be cleared locally. Unfamiliar content is not declared safe solely because it is short.
- Uncertain text is eligible for NVIDIA classification. Defaults: confidence 0.9, 30 AI calls/group/minute, 6/user/group/minute and 120 globally/minute. The group and global caps are editable.
- Moderation does not reserve, debit or refund AI-chat credits and does not consume the existing chat allowance. It can still consume NVIDIA provider tokens.
- Defaults within a rolling seven-day window: first violation deletes and warns; second deletes and mutes for 172,800 seconds; third deletes and kicks with immediate unban. Window, mute and rejoin delay are configurable.
- Duplicate delivery does not add another warning. Newer edits invalidate pending older versions. Per-group automatic moderation and approved trusted-review enforcement share the serialized queue.
- The configured owner, bot and current group administrators are protected. Administrator privileges are checked against Telegram on privileged taps and before sanctions; unknown role/API responses do not grant access.
- Trusted members receive no automatic sanction until an administrator approves their flagged case. Private alerts contain identifiers/category, not copied message content.
- Pardon clears warning metadata and removes a current mute or ban, while respecting group-default sending permissions.
- New-member batches receive one short rules/privacy notice, with deletion scheduled after 60 seconds.
- Health score and weekly risk reports use recent moderation metadata. The score is an internal heuristic, not an official Telegram compliance rating.
- Languages default to English/Swahili and accept up to eight two-letter language codes. Built-in keyword lists cover English/Swahili; other languages depend on configured keywords and model ability.
- New management is buttons-driven. Existing slash commands, Business/Secretary features, payment routes and authentication remain in place.

## Storage, safety and retry details

- Moderation text/captions are AES-256-GCM encrypted with a key derived from the existing session secret; no separate Redis/encryption credential is needed.
- Content jobs expire after five minutes. Completed/failed payloads are cleared; an active worker purges expired content on its periodic maintenance pass.
- Scheduled cleanup jobs contain only action identifiers and can remain until due plus a recovery period. Warning/audit/job metadata is cleaned after 30 days. Cleanup requires the worker to be running.
- AI-cache keys are keyed hashes, not raw messages; cached verdicts expire after ten minutes.
- SQL uses parameters and transactions. Regex syntax deliberately excludes constructs that can cause catastrophic backtracking.
- Jobs use `FOR UPDATE SKIP LOCKED`, lease ownership tokens and heartbeat renewal. A partial unique index serializes running moderation per group.
- Shared sliding budgets coordinate enabled-module and legacy outgoing Telegram calls: 29 requests/second globally and 20 message operations/minute for a group. Longer waits defer work. Telegram 429 responses preserve `retry_after`.
- AI timeouts, invalid results, exhausted AI budgets and unsupported media fail open. No sanction is justified by an unknown verdict.
- A compensating unban is queued before a kick. Ambiguous kick attempts are not automatically repeated as new bans.
- Queue failure records contain bounded failure codes, not raw messages, provider credentials or API payloads.

## Automated verification

Commands, from `ai-agent/`:

```sh
NVIDIA_AUTO_TOOLS=false node --test
GM_DATABASE_TEST=1 node --test test/groupManagerPostgres.test.js
```

The normal suite skips the opt-in PostgreSQL benchmark. The integration test creates an isolated temporary schema, uses synthetic IDs, and removes that schema afterward. It does not call Telegram/NVIDIA or alter existing group, payment or credit records.

Final results: **214 regression tests passed, zero failures**, with the opt-in integration test skipped in that run. The PostgreSQL integration/benchmark passed separately. Startup completed successfully, both additive migrations are present in development, and the global `group_manager` flag remains **false**. The Mini App's unauthenticated Telegram-required screen was visually checked; this does not validate native Telegram keyboards or signed-in management.

Verified coverage includes decorated/legacy keyboard dispatch, hidden administrator controls, stale/forged callbacks, protected accounts, link whitelist/entities, English/Swahili filtering, bounded configuration, encryption, fail-open classification, warning escalation/idempotency, trusted review, welcome cleanup scheduling, real SQL warning windows, pardon-window resets, sliding budgets, job deduplication, lease recovery, wrong-token completion rejection and content cleanup.

**Queue load result:** 1,000 synthetic jobs enqueued and completed by four workers in **10.15 seconds**, approximately **5,914 jobs/minute**, with no duplicate claims and cleared completed payloads.

This measures **PostgreSQL queue operations only**, not end-to-end moderation. Real model latency, role checks, Telegram quotas, group concentration and classification budgets can reduce throughput substantially. It does not establish 1,000 live moderated messages/minute.

## Live acceptance and failure test plan

Before enabling production groups:

1. Use a consenting test group and owner, group-admin, normal-member and trusted-member accounts.
2. Check keyboard visibility on Telegram mobile and desktop; normal users must have no administrative rows. The native client controls button sizing and appearance.
3. Promote/demote an administrator while keeping an old panel open; stale taps must deny access. Attempt another group's callback identifiers.
4. Submit three distinct blocked links from a normal member; verify delete/warn, 48-hour mute and ban/unban. Re-deliver the same update and verify no extra warning.
5. Check exact whitelist domains, non-whitelisted subdomains, invite links, caption URLs and hidden clickable links.
6. Turn each setting off/on, configure languages/window/durations, and confirm a subsequent panel shows saved values.
7. Flag a trusted member; verify no automatic deletion, then approve/dismiss once. Test pardon against actual group-default permissions.
8. Join with several members at once; verify one welcome and deletion around 60 seconds.
9. Remove bot delete/restrict rights; verify a setup notice and no unauthorized sanction.
10. Simulate NVIDIA timeout, malformed/low-confidence output, AI-cap exhaustion and Telegram 429. Verify fail-open behavior, deferred retries and unchanged chat credits.
11. Stop/restart a worker between a kick and unban; verify compensating cleanup. Test ambiguous network completion separately.
12. Deliver a newer clean edit before an older moderation job executes; it must not delete the newer message using the stale verdict.
13. Run a sustained ingress test across multiple groups with fake external services, then a lower-rate live test within Telegram/provider quotas. Inspect queue depth, age, lease recovery, failures and database growth.

## Limitations

- **No visual/audio/document-content moderation.** Image-only, video-only, audio, stickers and document bodies are not classified. Captions/text are supported. This is not a complete multimedia compliance guard.
- Telegram must actually deliver messages. Privacy mode, missing membership, unavailable webhook delivery and administrator permissions limit visibility/actions.
- Provider confidence and heuristics are imperfect. Neither this module nor its score guarantees Telegram Terms-of-Service or legal compliance.
- Budget exhaustion/expired work intentionally leaves content untouched instead of taking an unsupported action. Trusted-review enforcement also has a five-minute freshness limit.
- Telegram HTTP does not offer exactly-once execution. Notifications prefer avoiding duplicates; an ambiguous network failure can omit a notice. Worker downtime can delay the 60-second welcome deletion and unban cleanup.
- Group listing is bounded to 1,000 tracked groups. Initial discovery and live role checks take time under rate limits.
- Live Telegram role/action checks and end-to-end load testing remain acceptance steps; automated Telegram/NVIDIA calls were mocked.
- No new optional Business assistant was added; existing Business/Secretary behavior is preserved.
