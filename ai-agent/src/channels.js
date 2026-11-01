import crypto from "node:crypto";
import { createLimitNotices } from "./freeAllowance.js";
import { createCommandInputs, keyboardCommand, keyboardLabel, telegramCommandKeyboard } from "./telegramKeyboard.js";
import { createGroupManager, Defer } from "./groupManager/manager.js";
import { prepareIntelligentRequest, appendLiveSources } from "./requestRouter.js";
import { generateNvidiaImage } from "./nvidiaImages.js";
import { resolveStarSigningSecret } from "./runtimeSecrets.js";
import {
  availableModels,
  defaultModel,
  reply,
  resetConversation,
  selectModel,
  streamReply
} from "./agent.js";
import { logger } from "./logger.js";
import { aiChatStarCost } from "./pricing.js";
import { aiEntitlement } from "./entitlements.js";
import { getPlatformStore } from "./platformRuntime.js";
import { platformPrincipal } from "./rbac.js";
import { createStarLedger } from "./starLedger.js";
import {
  ASSISTANT_MODE_DEFINITIONS,
  assistantModeList,
  assistantSystemPrompt,
  normalizeAssistantMode
} from "./assistantModes.js";
import {
  MAX_STAR_TOPUP,
  MIN_STAR_TOPUP,
  STAR_TERMS_VERSION,
  createStarPurchasePayload,
  parseStarTopupAmount,
  telegramStarTerms,
  validateStarPurchasePayload
} from "./starPayments.js";
import {
  activationPolicyLabel,
  parseTelegramCommand as parseTelegramUpdateCommand,
  resolveTelegramUpdateContext
} from "./telegramContext.js";
import {
  adaptiveSecretaryProfile,
  classifyAiFailure,
  detectMessageLanguage,
  safeAiFailureMessage,
  telegramMemoryScope
} from "./adaptiveSecretary.js";
import {
  SECRETARY_ACTIVATION_STARS,
  SECRETARY_PRODUCT_ID,
  createSecretaryActivationPayload,
  secretaryConnectionFingerprint,
  validateSecretaryActivationPayload
} from "./secretaryPayments.js";

const TELEGRAM_API_ROOT = "https://api.telegram.org";
let groupManager = null;
function getGroupManager() {
  return groupManager ||= createGroupManager({platform:getPlatformStore,api:telegramApi,
    ownerId:telegramAdminUserId,botId:()=>telegramStatus.id,botUsername:()=>telegramStatus.username});
}
export function startGroupManagerWorker() { getGroupManager().start(); }
export async function captureGroupManagerUpdate(update) { return getGroupManager().capture(update); }
async function privateKeyboard(message) {
  let eligible=false;
  try {eligible=await getGroupManager().eligible(message.from?.id);} catch { /* Fail closed for controls, not chat. */ }
  return telegramCommandKeyboard(telegramUserIsAdmin(message.from?.id),eligible);
}
const TELEGRAM_TEXT_LIMIT = 4000;
const DRAFT_INTERVAL_MS = 900;
const PRE_CHECKOUT_DEADLINE_MS = 8000;
const PRE_CHECKOUT_LEDGER_BUDGET_MS = 4000;
// Development-only compatibility fallback. Production preferences are stored
// in telegram_user_controls and never rely on this process-local cache.
const transientTelegramModelPreferences = new Map();
const telegramChatsInFlight = new Set();
let telegramStatus = Object.freeze({ enabled: false, configured: false });
let telegramStarLedger = null;
let telegramStarSweepTimer = null;
let telegramStarSweepInFlight = false;
let secretaryReminderTimer = null;
let secretaryReminderInFlight = false;
const limitNotices = createLimitNotices();
const commandInputs = createCommandInputs();
const TELEGRAM_BOT_SHORT_DESCRIPTION = "Fast AI assistant for chats, groups and work.";
function telegramBotDescription() {
  return "Nemotron is your AI assistant for chat, groups and daily work. Fast answers, smart moderation, simple buttons.";
}
const TELEGRAM_WELCOME_IMAGE_PATH = "/telegram/welcome-banner.png";
const MODE_DEFINITIONS = Object.freeze({
  chat: {
    label: "AI Chat Mode",
    defaultEnabled: true,
    billable: true,
    selectable: true,
    description: "Normal AI conversations. This is the only mode that consumes credits."
  },
  inline: {
    label: "Inline Mode",
    defaultEnabled: false,
    billable: true,
    description: "Runs explicitly addressed NVIDIA AI queries from Telegram inline mode when enabled in BotFather."
  },
  bot_management: {
    label: "Bot Management Mode",
    defaultEnabled: true,
    billable: false,
    description: "Admin-only commands for modes, bans, balances, and user management."
  },
  guest_chat: {
    label: "Guest Chat Mode",
    defaultEnabled: true,
    billable: false,
    description: "Lets non-admin users access free setup, help, top-up, model, and persona commands."
  },
  guard: {
    label: "Guard Mode",
    defaultEnabled: false,
    billable: false,
    description: "Handles group join requests and rejects banned users when the bot is a group admin."
  },
  secretary: {
    label: "Secretary Mode",
    defaultEnabled: true,
    billable: false,
    selectable: true,
    description: "Adapts AI Chat into an executive assistant for permitted messages, tasks, notes, and drafts."
  },
  bot_to_bot: {
    label: "Bot to Bot Communication Mode",
    defaultEnabled: false,
    billable: false,
    description: "Reserved for bot-to-bot or business integrations. It is disabled by default to avoid loops."
  },
  threaded: {
    label: "Threaded Mode",
    defaultEnabled: true,
    billable: false,
    description: "Keeps replies in Telegram forum topics and message threads."
  },
  coding: {
    label: "Coding Mode",
    defaultEnabled: true,
    billable: false,
    selectable: true,
    description: "Tunes AI Chat for implementation, debugging, review, and architecture."
  },
  research: {
    label: "Research Mode",
    defaultEnabled: true,
    billable: false,
    selectable: true,
    description: "Tunes AI Chat for structured analysis, comparisons, and uncertainty checks."
  },
  translation: {
    label: "Translation Mode",
    defaultEnabled: true,
    billable: false,
    selectable: true,
    description: "Tunes AI Chat for faithful translation and localization."
  },
  documents: {
    label: "Documents Mode",
    defaultEnabled: true,
    billable: false,
    selectable: true,
    description: "Tunes AI Chat to analyze, summarize, and draft text supplied in the chat."
  }
});
const DEFAULT_MODE_SETTINGS = Object.freeze(Object.fromEntries(
  Object.entries(MODE_DEFINITIONS).map(([mode, definition]) => [mode, definition.defaultEnabled])
));

const TELEGRAM_COMMANDS = [
  { command: "start", description: "Start Nemotron" },
  { command: "help", description: "Show available commands" },
  { command: "dashboard", description: "Open the Nemotron mini app" },
  { command: "modes", description: "Show enabled bot modes" },
  { command: "mode", description: "Admin: turn a bot mode on or off" },
  { command: "use", description: "Select your active AI assistant mode" },
  { command: "persona", description: "Customize how the AI answers you" },
  { command: "models", description: "List available NVIDIA models" },
  { command: "model", description: "View or change the active model" },
  { command: "reset", description: "Clear this chat's AI memory" },
  { command: "balance", description: "Show AI message credits" },
  { command: "topup", description: "Buy credits with Telegram Stars" },
  { command: "redeem", description: "Redeem a Nemotron credit voucher" },
  { command: "voucher", description: "Open voucher redemption help" },
  { command: "terms", description: "Read the Stars purchase terms" },
  { command: "paysupport", description: "Get help with a Stars payment" },
  { command: "ban", description: "Ban a group user or platform user" },
  { command: "unban", description: "Unban a group user or platform user" },
  { command: "kick", description: "Group admin: remove a user" },
  { command: "mute", description: "Group admin: restrict a user" },
  { command: "unmute", description: "Group admin: restore a user's permissions" },
  { command: "warn", description: "Group admin: warn a user" },
  { command: "unwarn", description: "Group admin: remove one warning" },
  { command: "warnings", description: "Show a user's group warnings" },
  { command: "purge", description: "Group admin: delete a recent message range" },
  { command: "pin", description: "Group admin: pin the replied-to message" },
  { command: "unpin", description: "Group admin: unpin a message" },
  { command: "lock", description: "Group admin: restrict message types" },
  { command: "unlock", description: "Group admin: restore message types" },
  { command: "rules", description: "Show group rules" },
  { command: "setrules", description: "Group admin: update group rules" },
  { command: "slowmode", description: "Group admin: set slow mode" },
  { command: "approve", description: "Group admin: approve a join request" },
  { command: "reject", description: "Group admin: reject a join request" },
  { command: "modlog", description: "Group admin: show moderation log" },
  { command: "admins", description: "Show current Telegram group admins" },
  { command: "report", description: "Report a replied-to group message" },
  { command: "starbalance", description: "Admin Stars and credit totals" },
  { command: "whoami", description: "Show your Telegram IDs" }
];

const TELEGRAM_GROUP_COMMANDS = Object.freeze([
  { command: "nvid", description: "Ask Nemotron in this group" },
  { command: "nvid_help", description: "Show Nemotron group help" },
  { command: "nvid_status", description: "Show the current group mode" },
  { command: "nvid_mode", description: "Show the active group assistant" },
  { command: "nvid_summary", description: "Summarize authorized recent messages" },
  { command: "nvid_reset", description: "Reset this thread's AI context" },
  { command: "nvid_report", description: "Report a replied-to message" },
  { command: "redeem", description: "Redeem a Nemotron voucher" },
  { command: "balance", description: "Show credits and free allowance" }
]);

const TELEGRAM_GROUP_ADMIN_COMMANDS = Object.freeze([
  ...TELEGRAM_GROUP_COMMANDS,
  { command: "nvid_enable", description: "Enable Nemotron in this group" },
  { command: "nvid_disable", description: "Disable Nemotron in this group" },
  { command: "nvid_register", description: "Refresh this group's installation" },
  { command: "nvid_setmode", description: "Set the group assistant" },
  { command: "nvid_model", description: "Set the group NVIDIA model" },
  { command: "nvid_secretary", description: "Configure Group Secretary" },
  { command: "nvid_guard", description: "Configure Guard Mode" },
  { command: "nvid_captcha", description: "Configure first-use CAPTCHA" },
  { command: "nvid_settings", description: "Show group configuration" },
  { command: "nvid_rules", description: "Show group rules" },
  { command: "nvid_setrules", description: "Update group rules" },
  { command: "nvid_welcome", description: "Configure the welcome message" },
  { command: "nvid_goodbye", description: "Configure the goodbye message" },
  { command: "nvid_moderation", description: "Configure moderation" },
  { command: "nvid_permissions", description: "Verify Telegram permissions" },
  { command: "nvid_usage", description: "Show group AI usage" },
  { command: "nvid_logs", description: "Show recent Nemotron group logs" },
  ...TELEGRAM_COMMANDS.filter(({ command }) => ["ban", "unban", "kick", "mute", "unmute", "warn", "unwarn", "warnings", "purge", "lock", "unlock", "slowmode", "approve", "reject", "modlog", "admins", "report"].includes(command))
]);

const TELEGRAM_ALLOWED_UPDATES = Object.freeze([
  "message", "edited_message", "channel_post", "edited_channel_post",
  "business_connection", "business_message", "edited_business_message", "deleted_business_messages",
  "guest_message", "pre_checkout_query", "callback_query", "inline_query", "chat_join_request",
  "my_chat_member", "chat_member", "managed_bot", "subscription"
]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function telegramStarsRequired() {
  return /^(1|true|yes|on)$/i.test(process.env.TELEGRAM_STARS_REQUIRED?.trim() || "");
}

function telegramPaymentsEnabled() {
  return telegramStarsRequired()
    || /^(1|true|yes|on)$/i.test(process.env.TELEGRAM_PAYMENTS_ENABLED?.trim() || "");
}

function telegramAdminUserId() {
  return process.env.TELEGRAM_ADMIN_USER_ID?.trim() || "";
}

function telegramUserIsAdmin(userId) {
  const adminId = telegramAdminUserId();
  return Boolean(adminId && String(userId ?? "") === adminId);
}

function defaultModeSettings() {
  return { ...DEFAULT_MODE_SETTINGS };
}

function modeExists(mode) {
  return Object.hasOwn(MODE_DEFINITIONS, mode);
}

function selectedAssistantMode(userControl, settings) {
  const requested = normalizeAssistantMode(userControl?.selectedMode || "chat", { fallback: "chat" });
  return settings[requested] === false ? "chat" : requested;
}

async function currentModeSettings() {
  if (!telegramStarLedger || typeof telegramStarLedger.getModeSettings !== "function") return defaultModeSettings();
  return telegramStarLedger.getModeSettings(defaultModeSettings());
}

async function modeEnabled(mode) {
  return (await currentModeSettings())[mode] !== false;
}

function assertTelegramAdmin(message) {
  if (!telegramUserIsAdmin(message.from?.id)) {
    return "This command is available only to the configured bot administrator.";
  }
  return null;
}

function parseModeToggle(argument) {
  const [rawMode, rawState] = String(argument || "").trim().split(/\s+/, 2);
  const mode = rawMode?.toLowerCase();
  const state = rawState?.toLowerCase();
  if (!mode || !modeExists(mode)) return null;
  if (!["on", "off", "enable", "disable", "enabled", "disabled"].includes(state)) return null;
  return { mode, enabled: ["on", "enable", "enabled"].includes(state) };
}

function modeListText(settings = defaultModeSettings(), { admin = false } = {}) {
  const lines = ["Nemotron modes:"];
  for (const [mode, definition] of Object.entries(MODE_DEFINITIONS)) {
    const enabled = settings[mode] !== false;
    lines.push(
      "",
      `${enabled ? "ON" : "OFF"} ${mode} - ${definition.label}`,
      `${definition.description}${definition.billable ? ` Credit cost: ${aiChatStarCost()} per accepted prompt.` : " Credit cost: free."}`
    );
  }
  if (admin) lines.push("", "Admin usage: /mode <mode> on|off");
  lines.push("", `Choose your assistant behavior with /use <${Object.keys(ASSISTANT_MODE_DEFINITIONS).join("|")}>.`);
  return lines.join("\n");
}

function requireStarLedger() {
  if (!telegramStarLedger) throw new Error("Telegram Stars ledger is not ready");
  return telegramStarLedger;
}

async function reconcileStaleTelegramCredits() {
  if (!telegramStarLedger || telegramStarSweepInFlight) return;
  telegramStarSweepInFlight = true;
  const store = getPlatformStore();
  const ownerId = crypto.randomUUID();
  let lease = null;
  try {
    if (store?.acquireLease) {
      lease = await store.acquireLease({ key: "job:billing-recovery", ownerId, ttlMs: 55_000 });
      if (!lease.acquired) return;
    }
    const recovered = await telegramStarLedger.recoverPendingCompletions?.({ limit: 100 });
    if (Number(recovered?.completedCount || 0) > 0) {
      logger.info("telegram.credit_completions_recovered", { completedCount: recovered.completedCount });
      await store?.writeAudit?.({
        action: "billing.completions.recovered",
        targetType: "billing_recovery",
        result: "success",
        metadata: { completedCount: recovered.completedCount }
      });
    }
    const restored = await telegramStarLedger.refundStaleReservations();
    if (Number(restored?.restoredCount || 0) > 0) {
      logger.info("telegram.credit_reservations_restored", { restoredCount: restored.restoredCount });
    }
  } finally {
    if (lease?.acquired) {
      await store?.releaseLease?.({ key: lease.key, ownerId }).catch((error) => {
        logger.error("telegram.credit_reconciliation_lease_release_failed", { error });
      });
    }
    telegramStarSweepInFlight = false;
  }
}

function assistantPreferences(userControl) {
  const parts = [userControl?.customInstructions || userControl?.persona || ""];
  if (userControl?.preferredLanguage && userControl.preferredLanguage !== "auto") {
    parts.push(`Respond in ${userControl.preferredLanguage}.`);
  }
  if (userControl?.responseLength && userControl.responseLength !== "balanced") {
    parts.push(`Use a ${userControl.responseLength} response length.`);
  }
  return parts.filter(Boolean).join("\n").slice(0, 5000) || null;
}

function responseTokenLimit(responseLength) {
  return responseLength === "concise" ? 512 : responseLength === "detailed" ? 2048 : 1024;
}

function startTelegramStarReconciliation() {
  if (telegramStarSweepTimer) return;
  telegramStarSweepTimer = setInterval(() => {
    reconcileStaleTelegramCredits().catch((error) => {
      logger.error("telegram.credit_reconciliation_failed", { error });
    });
  }, 60_000);
  telegramStarSweepTimer.unref?.();
}

async function initializeTelegramStars() {
  if (!telegramPaymentsEnabled() && !process.env.DATABASE_URL?.trim()) return false;
  if (!telegramPaymentsEnabled() && !telegramAdminUserId()) return false;
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required when Telegram Stars are enabled");
  if (!telegramAdminUserId()) throw new Error("TELEGRAM_ADMIN_USER_ID is required when Telegram Stars are enabled");
  resolveStarSigningSecret();

  if (!telegramStarLedger) telegramStarLedger = createStarLedger();
  await telegramStarLedger.init();
  await reconcileStaleTelegramCredits();
  startTelegramStarReconciliation();
  return true;
}

/** Test hook for an isolated in-memory ledger double. */
export function setTelegramStarLedgerForTests(ledger) {
  if (telegramStarSweepTimer) clearInterval(telegramStarSweepTimer);
  telegramStarSweepTimer = null;
  telegramStarSweepInFlight = false;
  telegramStarLedger = ledger || null;
}

function telegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

function telegramApiError(method, response, data) {
  const status = Number(response?.status || data?.error_code || 500);
  const description = typeof data?.description === "string" ? `: ${data.description.slice(0, 240)}` : "";
  const error = new Error(`Telegram ${method} failed (${status})${description}`);
  error.statusCode = status;
  if(status===429) error.retryAfter=Math.min(3600,Math.max(1,Number(data?.parameters?.retry_after)||1));
  return error;
}

/**
 * Call a Telegram Bot API method without ever placing the bot token in errors.
 * Telegram can return errors in either the HTTP status or an { ok: false }
 * response, so both layers are checked. A rate-limited call is retried once.
 */
export async function telegramApi(method, payload = {}, { deadlineAt, groupManagerBudgeted = false } = {}) {
  const token = telegramToken();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((!groupManagerBudgeted || attempt > 0) && await getGroupManager().enabled()) {
      const scopes=[{key:"gm:telegram:global",limit:29,window:1000}];
      if(["sendMessage","sendPhoto","sendDocument","sendVoice","sendVideo","editMessageText"].includes(method)
          && String(payload.chat_id).startsWith("-")) scopes.push({key:`gm:send:${payload.chat_id}`,limit:20,window:60000});
      const waitDeadline=deadlineAt??Date.now()+15000;
      let budget=await getGroupManager().store.rate(scopes);
      while(!budget.allowed) {
        if(Date.now()+budget.wait>=waitDeadline) {
          const error=new Error("Telegram outgoing budget unavailable");
          error.statusCode=429;error.retryAfter=Math.ceil(budget.wait/1000);throw error;
        }
        await wait(Math.max(1,budget.wait));
        budget=await getGroupManager().store.rate(scopes);
      }
    }
    const remaining = deadlineAt === undefined ? 15_000 : Math.floor(deadlineAt - Date.now());
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error(`Telegram ${method} request deadline expired`);
    }
    let response;
    try {
      response = await fetch(`${TELEGRAM_API_ROOT}/bot${token}/${method}`, {
        method: "POST",
        headers: payload instanceof FormData ? {} : { "content-type": "application/json" },
        body: payload instanceof FormData ? payload : JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, remaining)))
      });
    } catch (cause) {
      throw new Error(`Telegram ${method} request failed`, { cause });
    }

    let data;
    try {
      data = await response.json();
    } catch (cause) {
      const error = new Error(`Telegram ${method} returned invalid JSON`, { cause });
      error.statusCode = response.status;
      throw error;
    }

    const rateLimited = response.status === 429 || data?.error_code === 429;
    if (rateLimited && attempt === 0) {
      const retryAfter = Number(data?.parameters?.retry_after);
      const retryDelay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 1000;
      if (deadlineAt !== undefined && retryDelay >= deadlineAt - Date.now()) {
        throw telegramApiError(method, response, data);
      }
      await wait(retryDelay);
      continue;
    }

    if (!response.ok || data?.ok !== true) throw telegramApiError(method, response, data);
    return data.result;
  }

  throw new Error(`Telegram ${method} request failed`);
}

function telegramAllowedUserIds() {
  return new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function telegramUserIsAllowed(message) {
  return telegramUserIdIsAllowed(message?.from?.id);
}

function telegramUserIdIsAllowed(userId) {
  const allowed = telegramAllowedUserIds();
  return allowed.size === 0 || allowed.has(String(userId ?? ""));
}

function parseTelegramCommand(messageOrText) {
  return parseTelegramUpdateCommand(messageOrText, { botUsername: telegramStatus.username });
}

function telegramConversationScope(message) {
  const chatId = String(message?.chat?.id ?? "unknown");
  const userId = String(message?.from?.id ?? "unknown");
  const threadId = message?.message_thread_id ?? null;
  if (message?.business_connection_id) return telegramMemoryScope({
    mode: "telegram_business_secretary",
    businessConnectionId: message.business_connection_id,
    chatId
  });
  if (message?.guest_query_id) return `guest:${message.guest_query_id}:chat:${chatId}:user:${userId}`;
  if (message?.chat?.type === "private") return telegramMemoryScope({ mode: "private_bot_chat", userId, chatId });
  if (threadId !== null) return telegramMemoryScope({ mode: "group_topic", groupId: chatId, threadId, userId });
  return telegramMemoryScope({ mode: message?.chat?.type === "supergroup" ? "supergroup" : "group", groupId: chatId, userId });
}

function conversationId(message) {
  return `telegram:${telegramConversationScope(message)}`;
}

function preferredTelegramModel(message, userControl = null) {
  const stored = userControl?.preferredModel || transientTelegramModelPreferences.get(telegramConversationScope(message));
  try {
    return selectModel(stored || defaultModel());
  } catch {
    return selectModel(defaultModel());
  }
}

export async function deliverDueSecretaryReminders() {
  const store = getPlatformStore();
  if (secretaryReminderInFlight || !store?.claimDueSecretaryReminders) return { delivered: 0 };
  if (!(await store.isFeatureEnabled?.("secretary_automation").catch(() => false))) return { delivered: 0 };
  secretaryReminderInFlight = true;
  const ownerId = crypto.randomUUID();
  let lease = null;
  let delivered = 0;
  try {
    lease = await store.acquireLease?.({ key: "job:secretary-reminders", ownerId, ttlMs: 55_000 });
    if (lease && !lease.acquired) return { delivered: 0 };
    const reminders = await store.claimDueSecretaryReminders({ ownerId, limit: 25, leaseMs: 60_000 });
    for (const reminder of reminders) {
      try {
        await telegramApi("sendMessage", {
          chat_id: reminder.chat_id || reminder.owner_user_id,
          ...(reminder.thread_id ? { message_thread_id: Number(reminder.thread_id) } : {}),
          text: `Nemotron reminder\n\n${reminder.title}\n${reminder.message}`,
          protect_content: true
        });
        await store.completeSecretaryReminder(reminder.reminder_id, { delivered: true });
        delivered += 1;
      } catch (error) {
        await store.completeSecretaryReminder(reminder.reminder_id, { delivered: false, errorCode: "telegram_delivery_failed" }).catch(() => undefined);
        logger.error("secretary.reminder_delivery_failed", { error, reminderId: reminder.reminder_id });
      }
    }
    const jobs = await store.claimDueSecretaryJobs?.({ limit: 10 }) || [];
    for (const job of jobs) {
      try {
        const items = await store.listSecretaryReminders(job.owner_user_id, { limit: 25 });
        const upcoming = items
          .filter((item) => item.status === "scheduled" && new Date(item.due_at).getTime() >= Date.now())
          .sort((a, b) => new Date(a.due_at) - new Date(b.due_at))
          .slice(0, 10);
        const digest = upcoming.length
          ? upcoming.map((item, index) => `${index + 1}. ${item.title} - ${new Date(item.due_at).toISOString()}`).join("\n")
          : "You have no scheduled reminders.";
        await telegramApi("sendMessage", {
          chat_id: job.chat_id || job.owner_user_id,
          ...(job.thread_id ? { message_thread_id: Number(job.thread_id) } : {}),
          text: `Nemotron daily task digest\n\n${digest}`,
          protect_content: true
        });
        await store.completeSecretaryJob(job.job_id, { delivered: true });
        delivered += 1;
      } catch (error) {
        await store.completeSecretaryJob(job.job_id, { delivered: false, errorCode: "digest_delivery_failed" }).catch(() => undefined);
        logger.error("secretary.job_delivery_failed", { error, jobId: job.job_id });
      }
    }
    return { delivered };
  } finally {
    if (lease?.acquired) await store.releaseLease?.({ key: lease.key, ownerId }).catch(() => undefined);
    secretaryReminderInFlight = false;
  }
}

export function startSecretaryReminderWorker() {
  if (secretaryReminderTimer) return;
  secretaryReminderTimer = setInterval(() => {
    deliverDueSecretaryReminders().catch((error) => logger.error("secretary.reminder_worker_failed", { error }));
  }, 30_000);
  secretaryReminderTimer.unref?.();
  deliverDueSecretaryReminders().catch((error) => logger.error("secretary.reminder_worker_failed", { error }));
}

export function stopSecretaryReminderWorkerForTests() {
  if (secretaryReminderTimer) clearInterval(secretaryReminderTimer);
  secretaryReminderTimer = null;
  secretaryReminderInFlight = false;
}

function normalizeModelSearch(value) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveTelegramModel(value) {
  const models = availableModels();
  const query = value.trim();
  if (!query) return { model: null, matches: [] };

  if (/^\d+$/.test(query)) {
    const model = models[Number(query) - 1];
    return { model: model || null, matches: model ? [model] : [] };
  }

  const lower = query.toLocaleLowerCase();
  const normalized = normalizeModelSearch(query);
  const exact = models.find((model) =>
    [model.id, model.label, model.tag].some((candidate) => candidate?.toLocaleLowerCase() === lower)
    || [model.id, model.label, model.tag].some((candidate) => normalizeModelSearch(candidate || "") === normalized)
  );
  if (exact) return { model: exact, matches: [exact] };

  const matches = models.filter((model) =>
    [model.id, model.label, model.tag]
      .map((candidate) => candidate?.toLocaleLowerCase() || "")
      .some((candidate) => candidate.includes(lower) || normalizeModelSearch(candidate).includes(normalized))
  );
  return { model: matches.length === 1 ? matches[0] : null, matches };
}

async function modelListText(message) {
  const control = telegramStarLedger?.getUserControl && message.from?.id
    ? await telegramStarLedger.getUserControl(String(message.from.id)).catch(() => null)
    : null;
  const current = preferredTelegramModel(message, control);
  const lines = availableModels().map((model, index) => {
    const selected = model.id === current ? "  <- active" : "";
    return `${index + 1}. ${model.label} [${model.tag}]\n   ${model.id}${selected}`;
  });
  return `Available NVIDIA models:\n\n${lines.join("\n\n")}\n\nChange model with /model <number or model name>.`;
}

function helpText() {
  const lines = [
    "Nemotron commands:",
    "",
    "/dashboard - open the Telegram mini app",
    "/modes - show active bot modes",
    "/use <mode> - tune the assistant for chat, coding, research, translation, documents, or secretary work",
    "/persona <instructions> - customize how the AI answers you",
    "/models - list available NVIDIA models",
    "/model <number or name> - change the model for this chat",
    "/reset - clear this chat's AI memory",
    "/balance - show your AI message credits",
    `/topup <${MIN_STAR_TOPUP}-${MAX_STAR_TOPUP}> - buy credits with Telegram Stars`,
    "/terms - read the Stars purchase terms",
    "/paysupport <message> - contact payment support",
    "/whoami - show your Telegram user and chat IDs",
    "/help - show this guide"
  ];
  lines.push(
    "",
    telegramStarsRequired()
      ? `Each non-command AI prompt costs ${aiChatStarCost()} message credit${aiChatStarCost() === 1 ? "" : "s"}. One Telegram Star buys one credit.`
      : "Send a message to chat with the active NVIDIA model."
  );
  return lines.join("\n");
}

function welcomeText() {
  const lines = [
    "Nemotron",
    "Fast AI assistant for chats, groups and work.",
    "",
    "Quick start:",
    "/dashboard - open your Nemotron control panel",
    "/use <mode> - choose how Nemotron should work for you",
    "/persona <instructions> - customize the bot's style for you",
    "/models - browse available NVIDIA models",
    "/model <number or name> - switch the active model",
    "/reset - clear this chat's memory",
    "/help - show all commands"
  ];
  lines.push(
    "",
    telegramStarsRequired()
      ? `Telegram pricing: each accepted non-command AI prompt costs ${aiChatStarCost()} credit${aiChatStarCost() === 1 ? "" : "s"}. Use /topup <amount> to buy credits with Telegram Stars.`
      : "Send any message to start chatting with the active NVIDIA model."
  );
  return lines.join("\n");
}

function miniAppUrl() {
  return `${telegramPublicBaseUrl()}/miniapp.html`;
}

function safeTelegramLaunchUrl() {
  if (telegramStatus.link) return telegramStatus.link;
  try {
    return miniAppUrl();
  } catch {
    return "https://t.me/";
  }
}

function whoAmIText(message) {
  return [
    "Telegram identity:",
    `User ID: ${message.from?.id ?? "unavailable"}`,
    `Chat ID: ${message.chat?.id ?? "unavailable"}`,
    `Chat type: ${message.chat?.type || "unknown"}`
  ].join("\n");
}

/** Split long Telegram messages at code-point boundaries, preferring whitespace. */
export function splitTelegramText(value, limit = TELEGRAM_TEXT_LIMIT) {
  const codePoints = Array.from(String(value || ""));
  if (!codePoints.length) return [];
  const chunks = [];

  while (codePoints.length > limit) {
    let boundary = limit;
    const preferredFloor = Math.floor(limit * 0.7);
    for (let index = limit; index >= preferredFloor; index -= 1) {
      if (/\s/u.test(codePoints[index - 1])) {
        boundary = index;
        break;
      }
    }
    const chunk = codePoints.splice(0, boundary).join("").trim();
    if (chunk) chunks.push(chunk);
    while (codePoints.length && /^\s$/u.test(codePoints[0])) codePoints.shift();
  }

  const remainder = codePoints.join("").trim();
  if (remainder) chunks.push(remainder);
  return chunks;
}

function messageThreadPayload(message) {
  return Number.isInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {};
}

function messageBusinessPayload(message) {
  return message?.business_connection_id ? { business_connection_id: message.business_connection_id } : {};
}

async function sendTelegramText(message, text) {
  const chunks = splitTelegramText(text);
  for (let index = 0; index < chunks.length; index += 1) {
    await telegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: chunks[index],
      ...(index === 0 && message.chat.type === "private" && !message.business_connection_id
        ? { reply_markup: await privateKeyboard(message) } : {}),
      ...messageBusinessPayload(message),
      ...messageThreadPayload(message),
      ...(index === 0 && message.message_id
        ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }
        : {})
    });
  }
}

async function deliverTelegramAiAnswer(context, message, text) {
  if (context?.telegramTransportMode === "guest") {
    const body = splitTelegramText(text, 4000)[0] || "I could not generate a response.";
    return telegramApi("answerGuestQuery", {
      guest_query_id: context.guestQueryId,
      result: {
        type: "article",
        id: crypto.createHash("sha256").update(String(context.guestQueryId)).digest("hex").slice(0, 32),
        title: "Nemotron response",
        input_message_content: { message_text: body }
      }
    });
  }
  return sendTelegramText(message, text);
}

function groupStreamEligible(context, message) {
  return ["group", "supergroup"].includes(message?.chat?.type)
    && context?.telegramTransportMode === "bot_api";
}

async function beginTelegramGroupStream(context, message) {
  if (!groupStreamEligible(context, message)) return null;
  const result = await telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: "Nemotron is thinking ...",
    ...messageThreadPayload(message),
    ...(message.message_id ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } } : {})
  });
  return result?.message_id ? { messageId: result.message_id, lastText: "", lastAt: 0, frame: 0, failed: false, queue: Promise.resolve() } : null;
}

function queueTelegramGroupStream(stream, message, content, { force = false } = {}) {
  if (!stream || !content) return stream?.queue || Promise.resolve();
  const now = Date.now();
  if (!force && now - stream.lastAt < DRAFT_INTERVAL_MS) return stream.queue;
  const body = Array.from(String(content)).slice(0, 3960).join("");
  const cursor = force ? "" : ["  |", "  /", "  -", "  \\ "][stream.frame++ % 4];
  const nextText = `${body}${cursor}`.trimEnd();
  if (!nextText || nextText === stream.lastText) return stream.queue;
  stream.lastAt = now;
  stream.lastText = nextText;
  stream.queue = stream.queue.then(() => telegramApi("editMessageText", {
    chat_id: message.chat.id,
    message_id: stream.messageId,
    text: nextText
  })).catch((error) => {
    stream.failed = true;
    logger.warn("telegram.group_stream_edit_failed", { error, chatId: message.chat.id });
  });
  return stream.queue;
}

async function finishTelegramGroupStream(stream, message, answer) {
  if (!stream) return false;
  const chunks = splitTelegramText(answer, TELEGRAM_TEXT_LIMIT);
  await queueTelegramGroupStream(stream, message, chunks[0] || "I could not generate a response.", { force: true });
  await stream.queue;
  if (stream.failed) return false;
  for (const chunk of chunks.slice(1)) {
    await telegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: chunk,
      ...messageThreadPayload(message)
    });
  }
  return true;
}

async function sendTelegramPhoto(message, photo, caption) {
  await telegramApi("sendPhoto", {
    chat_id: message.chat.id,
    photo,
    caption,
    ...(message.chat.type === "private" && !message.business_connection_id
      ? { reply_markup: await privateKeyboard(message) } : {}),
    ...messageBusinessPayload(message),
    ...messageThreadPayload(message),
    ...(message.message_id
      ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }
      : {})
  });
}

function telegramPublicAssetUrl(pathname) {
  return `${telegramPublicBaseUrl()}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

async function sendTelegramWelcome(message) {
  const caption = welcomeText();
  try {
    await sendTelegramPhoto(message, telegramPublicAssetUrl(TELEGRAM_WELCOME_IMAGE_PATH), caption);
  } catch (error) {
    logger.error("telegram.welcome_image_failed", { error });
    await sendTelegramText(message, caption);
  }
}

async function sendTelegramDashboard(message) {
  await telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: "Open the Nemotron control panel.",
    reply_markup: {
      inline_keyboard: [[{
        text: "Open Nemotron Dashboard",
        web_app: { url: miniAppUrl() }
      }]]
    },
    ...messageThreadPayload(message),
    ...(message.message_id
      ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }
      : {})
  });
}

function balanceValue(result) {
  return String(result?.balance ?? result ?? "0");
}

async function sendTopupOffer(message, amount) {
  if (!telegramPaymentsEnabled()) {
    await sendTelegramText(message, "Telegram Stars purchasing is not enabled for this bot.");
    return;
  }
  requireStarLedger();
  if (message.chat.type !== "private") {
    await sendTelegramText(message, "For payment security, open a private chat with me and run /topup there.");
    return;
  }

  const payload = createStarPurchasePayload({ userId: message.from?.id, amount });
  await telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: [
      `Buy ${amount} AI message credit${amount === 1 ? "" : "s"} for ${amount} Telegram Star${amount === 1 ? "" : "s"}.`,
      "",
      `One accepted AI prompt costs ${aiChatStarCost()} credit${aiChatStarCost() === 1 ? "" : "s"}. Commands are free. Read /terms for the full terms.`,
      "",
      "Tap the button below to confirm the terms and open Telegram's secure Stars checkout."
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [[{
        text: `I agree - Buy ${amount} Star${amount === 1 ? "" : "s"}`,
        callback_data: payload
      }]]
    },
    ...messageThreadPayload(message),
    ...(message.message_id
      ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }
      : {})
  });
}

async function handleStarPurchaseCallback(callback) {
  if (!String(callback?.data || "").startsWith("s1.")) return false;
  const message = callback.message;
  const validation = validateStarPurchasePayload(callback.data, { userId: callback.from?.id });
  if (!telegramPaymentsEnabled() || !telegramStarLedger) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Star payments are temporarily unavailable. Please try again later.",
      show_alert: true
    });
    return true;
  }
  if (!message || message.chat?.type !== "private" || !validation.valid) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: validation.error || "Open a private chat with the bot to purchase credits.",
      show_alert: true
    });
    return true;
  }

  const { purchase } = validation;
  await telegramStarLedger.acceptTerms(purchase.userId, STAR_TERMS_VERSION);
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "Terms accepted. Opening secure Stars checkout."
  });
  const startParameter = `topup_${crypto.createHash("sha256").update(purchase.payload).digest("hex").slice(0, 24)}`;
  await telegramApi("sendInvoice", {
    chat_id: message.chat.id,
    title: "Nemotron AI credits",
    description: `${purchase.amount} prepaid AI message credit${purchase.amount === 1 ? "" : "s"}. ${aiChatStarCost()} credit${aiChatStarCost() === 1 ? " is" : "s are"} used per accepted prompt.`,
    payload: purchase.payload,
    currency: "XTR",
    prices: [{
      label: `${purchase.amount} AI message credit${purchase.amount === 1 ? "" : "s"}`,
      amount: purchase.amount
    }],
    start_parameter: startParameter,
    protect_content: true
  });
  return true;
}

function memberCanManageJoinRequests(member) {
  if (member?.status === "creator") return true;
  return member?.status === "administrator" && member?.can_invite_users === true;
}

async function guardPermissionState(chatId, requesterId) {
  const bot = await telegramApi("getMe");
  const [requester, botMember] = await Promise.all([
    requesterId ? telegramApi("getChatMember", { chat_id: chatId, user_id: requesterId }) : null,
    telegramApi("getChatMember", { chat_id: chatId, user_id: bot.id })
  ]);
  return {
    requesterAllowed: requesterId ? memberCanManageJoinRequests(requester) : true,
    botAllowed: memberCanManageJoinRequests(botMember)
  };
}

const FULL_MEMBER_PERMISSIONS = Object.freeze({
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
  can_manage_topics: false
});

const MUTED_MEMBER_PERMISSIONS = Object.freeze(Object.fromEntries(
  Object.keys(FULL_MEMBER_PERMISSIONS).map((permission) => [permission, false])
));

function groupMemberHasPermission(member, permission) {
  if (member?.status === "creator") return true;
  return member?.status === "administrator" && member?.[permission] === true;
}

function groupActionPermission(action) {
  if (["ban", "unban", "kick", "mute", "unmute", "warn", "unwarn", "warnings", "lock", "unlock", "slowmode"].includes(action)) return "can_restrict_members";
  if (["delete", "purge"].includes(action)) return "can_delete_messages";
  if (["pin", "unpin"].includes(action)) return "can_pin_messages";
  if (["approve", "reject"].includes(action)) return "can_invite_users";
  if (action === "setrules") return "can_change_info";
  return "can_manage_chat";
}

export async function telegramGroupPermissionState({ chatId, actorUserId, action, targetUserId = null }) {
  const permission = groupActionPermission(action);
  const bot = await telegramApi("getMe");
  const [actor, botMember, target] = await Promise.all([
    telegramApi("getChatMember", { chat_id: chatId, user_id: actorUserId }),
    telegramApi("getChatMember", { chat_id: chatId, user_id: bot.id }),
    targetUserId ? telegramApi("getChatMember", { chat_id: chatId, user_id: targetUserId }).catch(() => null) : null
  ]);
  const targetProtected = Boolean(target && ["creator", "administrator"].includes(target.status))
    || String(targetUserId || "") === String(bot.id)
    || String(targetUserId || "") === String(actorUserId);
  return {
    permission,
    actor,
    botMember,
    target,
    actorAllowed: groupMemberHasPermission(actor, permission),
    botAllowed: groupMemberHasPermission(botMember, permission),
    targetProtected
  };
}

export async function resolveTelegramContext(update) {
  const initial = resolveTelegramUpdateContext(update, {
    botUsername: telegramStatus.username,
    botId: telegramStatus.id
  });
  const store = getPlatformStore();
  let groupState = null;
  let senderMember = null;
  if (["group", "supergroup", "channel"].includes(initial.chatType) && initial.chatId !== null && store?.getTelegramGroup) {
    groupState = await store.getTelegramGroup(initial.chatId).catch(() => null);
    if (initial.telegramUserId && store.getGroupMember) {
      senderMember = await store.getGroupMember(initial.chatId, initial.telegramUserId).catch(() => null);
    }
    if (groupState?.settings?.activationPolicy === "administrators_only"
        && initial.invoked && initial.telegramUserId) {
      const liveMember = await telegramApi("getChatMember", {
        chat_id: initial.chatId,
        user_id: initial.telegramUserId
      }).catch(() => null);
      senderMember = liveMember || { status: "unknown" };
      if (liveMember) {
        await store.syncGroupMember?.({ chatId: initial.chatId, member: liveMember }).catch(() => undefined);
      }
    }
  }
  const botMember = groupState?.botPermissionSnapshot ? {
    status: groupState.botPermissionSnapshot.status,
    ...groupState.botPermissionSnapshot.permissions
  } : null;
  const businessConnection = initial.businessConnectionId && store?.getBusinessConnection
    ? await store.getBusinessConnection(initial.businessConnectionId).catch(() => null)
    : null;
  const billingOwnerUserId = businessConnection?.ownerUserId || initial.telegramUserId || null;
  const platformUser = billingOwnerUserId && store?.getManagedUser
    ? await store.getManagedUser(billingOwnerUserId).catch(() => null)
    : null;
  const resolved = resolveTelegramUpdateContext(update, {
    botUsername: telegramStatus.username,
    botId: telegramStatus.id,
    groupState,
    senderMember,
    botMember,
    assistantMode: groupState?.settings?.defaultMode || "chat",
    platformUser,
    activeEntitlement: businessConnection ? {
      type: "telegram_secretary",
      status: businessConnection.accessStatus,
      active: businessConnection.accessActive === true
    } : null,
    billingOwnerUserId
  });
  return {
    ...resolved,
    businessConnection,
    platformUser
  };
}

async function secretaryConnectionFromFingerprint(ownerUserId, value) {
  const connections = await getPlatformStore()?.listBusinessConnections?.({ ownerUserId, limit: 250 }) || [];
  return connections.find((connection) => secretaryConnectionFingerprint(connection.connectionId) === value) || null;
}

export async function sendSecretaryActivationInvoice({ ownerUserId, connectionId, chatId = null } = {}) {
  const owner = String(ownerUserId || "");
  if (!/^[1-9]\d*$/.test(owner)) throw Object.assign(new Error("A valid Telegram account is required"), { statusCode: 400 });
  const connection = await getPlatformStore()?.getBusinessConnection?.(connectionId);
  if (!connection || connection.ownerUserId !== owner) throw Object.assign(new Error("Business connection was not found"), { statusCode: 404 });
  const payload = createSecretaryActivationPayload({ userId: owner, connectionId: connection.connectionId });
  await getPlatformStore()?.setSecretaryAccessStatus?.({ connectionId: connection.connectionId, ownerUserId: owner, status: "payment_pending" });
  await telegramApi("sendInvoice", {
    chat_id: chatId || connection.userChatId || owner,
    title: "Nemotron Secretary lifetime activation",
    description: "One-time access activation for this Telegram Business connection. AI replies continue to use your plan allowance or credits.",
    payload,
    currency: "XTR",
    prices: [{ label: "Secretary lifetime activation", amount: SECRETARY_ACTIVATION_STARS }],
    start_parameter: `secretary_${crypto.createHash("sha256").update(payload).digest("hex").slice(0, 20)}`,
    protect_content: true
  });
  return { sent: true, price: SECRETARY_ACTIVATION_STARS, currency: "XTR", connectionId: connection.connectionId };
}

async function handleSecretaryAccessCallback(callback) {
  const data = String(callback?.data || "");
  if (!/^(secrq|secpay|secdec):/.test(data)) return false;
  const store = getPlatformStore();
  const requesterId = String(callback?.from?.id || "");
  if (!store || !/^[1-9]\d*$/.test(requesterId)) return true;
  if (data.startsWith("secdec:")) {
    const match = data.match(/^secdec:(approve|deny):([0-9a-f-]{36})$/i);
    if (!match || !telegramUserIsAdmin(requesterId)) {
      await telegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: "Only the Nemotron administrator can decide this request.", show_alert: true });
      return true;
    }
    const result = await store.decideSecretaryAccess({ requestId: match[2], actorUserId: requesterId, decision: match[1] });
    await telegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: result.status === "active_admin_approved" ? "Secretary access approved." : "Secretary access denied." });
    await telegramApi("sendMessage", {
      chat_id: result.ownerUserId,
      text: result.status === "active_admin_approved"
        ? "Your Nemotron Secretary access was approved. Automatic replies can now be enabled in the Mini App."
        : "Your Nemotron Secretary access request was denied. You may request access again after the configured cooldown or activate with 500 Telegram Stars."
    }).catch(() => undefined);
    return true;
  }
  const match = data.match(/^(secrq|secpay):([A-Za-z0-9_-]{16})$/);
  const connection = match ? await secretaryConnectionFromFingerprint(requesterId, match[2]) : null;
  if (!connection) {
    await telegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: "This Secretary connection was not found for your account.", show_alert: true });
    return true;
  }
  if (match[1] === "secrq") {
    const request = await store.requestSecretaryAccess({ connectionId: connection.connectionId, ownerUserId: requesterId });
    await telegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: request.duplicate ? "Your request is already pending." : "Approval request sent." });
    if (!request.duplicate && telegramAdminUserId()) {
      await telegramApi("sendMessage", {
        chat_id: telegramAdminUserId(),
        text: `Nemotron Secretary access request\nRequester: ${requesterId}\nConnection: ${connection.connectionId.slice(0, 12)}…`,
        reply_markup: { inline_keyboard: [[
          { text: "Approve", callback_data: `secdec:approve:${request.requestId}` },
          { text: "Deny", callback_data: `secdec:deny:${request.requestId}` }
        ]] }
      });
    }
    return true;
  }
  await telegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: "Opening secure 500-Star checkout." });
  await sendSecretaryActivationInvoice({ ownerUserId: requesterId, connectionId: connection.connectionId, chatId: callback.message?.chat?.id });
  return true;
}

async function handleCaptchaCallback(callback) {
  const match = String(callback?.data || "").match(/^cap:([0-9a-f-]{36}):(\d)$/i);
  if (!match) return false;
  const message = callback?.message;
  const userId = callback?.from?.id;
  if (!message?.chat?.id || !userId) return true;
  const group = await getPlatformStore()?.getTelegramGroup?.(message.chat.id).catch(() => null);
  const result = await getPlatformStore()?.answerCaptchaChallenge?.({
    challengeId: match[1],
    groupId: message.chat.id,
    userId,
    optionIndex: Number(match[2]),
    verificationSeconds: group?.settings?.captchaVerificationSeconds || 2_592_000
  }).catch((error) => ({ accepted: false, reason: error.statusCode === 429 ? "rate_limited" : "failed" }));
  const text = result?.accepted ? "Verification complete. Run /nvid again to continue." : ({
    wrong_user: "This verification belongs to another group member.",
    expired: "This challenge expired. Run /nvid again for a new challenge.",
    attempts_exhausted: "Too many incorrect attempts. Wait before trying again.",
    incorrect: "That answer is not correct. Try again.",
    completed: "This challenge is already closed.",
    rate_limited: "Too many verification attempts. Please wait."
  })[result?.reason] || "This verification could not be completed.";
  await telegramApi("answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: !result?.accepted });
  if (result?.accepted) {
    await telegramApi("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `Verified: ${callback.from.first_name || callback.from.username || userId} can now use Nemotron in this group.`
    }).catch(() => undefined);
  }
  return true;
}

async function requireGroupVerification(message, context) {
  if (!groupMessage(message) || !message.from?.id || message.from.is_bot) return false;
  const settings = context.groupConfiguration || {};
  const store = getPlatformStore();
  if (settings.captchaEnabled === false || !store?.isGroupUserVerified || !store?.createCaptchaChallenge) return false;
  if (await store.isGroupUserVerified(message.chat.id, message.from.id)) return false;
  if (settings.captchaExemptAdministrators !== false) {
    const live = await telegramApi("getChatMember", { chat_id: message.chat.id, user_id: message.from.id }).catch(() => null);
    if (["creator", "administrator"].includes(live?.status)) {
      await store.verifyGroupUser?.({ groupId: message.chat.id, userId: message.from.id, verifiedBy: "exempt" });
      return false;
    }
  }
  const budget = await store.consumeSharedRateLimit?.({
    key: `captcha:create:${message.chat.id}:${message.from.id}`,
    limit: 5,
    windowMs: Math.max(60_000, Number(settings.captchaRetryCooldownSeconds || 300) * 1000)
  }).catch(() => ({ allowed: false }));
  if (budget && budget.allowed === false) {
    await sendTelegramText(message, "Verification is temporarily rate-limited. Please wait before trying again.");
    return true;
  }
  const challenge = await store.createCaptchaChallenge({
    groupId: message.chat.id,
    userId: message.from.id,
    maxAttempts: settings.captchaMaxAttempts || 3,
    ttlSeconds: 300,
    originalRequest: { messageId: message.message_id, threadId: message.message_thread_id ?? null }
  });
  await telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: `${challenge.prompt}\n\nThis protects group AI access. The challenge expires in 5 minutes.`,
    reply_markup: {
      inline_keyboard: [challenge.options.map((option) => ({
        text: option.label,
        callback_data: `cap:${challenge.challengeId}:${option.index}`
      }))]
    },
    ...messageThreadPayload(message),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true }
  });
  return true;
}

async function observeTelegramContext(message, context = null) {
  const store = getPlatformStore();
  if (!store) return;
  if (message?.from?.id && store.syncUserProfile) {
    const interactionSource = context?.telegramTransportMode === "telegram_secretary"
      ? "telegram_business_contact"
      : ["group", "supergroup"].includes(message?.chat?.type) ? "telegram_group" : "telegram_private";
    await store.syncUserProfile({ ...message.from, interactionSource }).catch((error) => logger.error("telegram.user_profile_sync_failed", { error, userId: message.from.id }));
  }
  if (["group", "supergroup", "channel"].includes(message?.chat?.type) && store.upsertTelegramGroup) {
    await store.upsertTelegramGroup({ chat: message.chat }).catch((error) => logger.error("telegram.group_sync_failed", { error, chatId: message.chat.id }));
  }
  if (!context || !["group", "supergroup"].includes(message?.chat?.type)) return;
  const settings = context.groupConfiguration || {};
  if (!settings.secretaryEnabled || !settings.secretaryObservationEnabled || !settings.messageStorageEnabled) return;
  if (message?.from?.is_bot || !message?.text || !store.observeTelegramMessage) return;
  await store.observeTelegramMessage({
    updateType: context.updateType,
    transportMode: "group_secretary",
    chatId: message.chat.id,
    threadId: message.message_thread_id ?? null,
    messageId: message.message_id,
    senderUserId: message.from?.id ?? null,
    content: message.text,
    status: context.updateType === "edited_message" ? "edited" : "active",
    retentionDays: settings.retentionDays || 7
  }).catch((error) => logger.error("telegram.secretary_observation_failed", { error, chatId: message.chat.id }));
}

async function handleBusinessConnectionUpdate(connection) {
  const store = getPlatformStore();
  if (!connection || !store?.upsertBusinessConnection) return false;
  await store.syncUserProfile?.({ ...connection.user, interactionSource: "telegram_business_connection" }).catch(() => undefined);
  const persisted = await store.upsertBusinessConnection(connection);
  const access = await store.ensureSecretaryAccess?.({
    connectionId: persisted.connectionId,
    ownerUserId: persisted.ownerUserId,
    primaryAdminId: telegramAdminUserId()
  }).catch((error) => {
    logger.error("telegram.secretary_access_resolution_failed", { error, connectionId: persisted.connectionId });
    return persisted;
  });
  await store.saveCapabilityVerification?.({
    capabilityKey: "telegram_secretary",
    status: connection.is_enabled ? "connected" : "not_connected",
    metadata: { canReply: connection.rights?.can_reply === true }
  }).catch(() => undefined);
  if (connection.is_enabled && access && !access.accessActive && !access.onboardingSentAt) {
    const shouldSend = await store.markSecretaryOnboardingSent?.(persisted.connectionId, persisted.ownerUserId).catch(() => false);
    if (shouldSend) {
      const targetChat = persisted.userChatId || persisted.ownerUserId;
      const fingerprint = secretaryConnectionFingerprint(persisted.connectionId);
      await telegramApi("sendMessage", {
        chat_id: targetChat,
        text: [
          "Nemotron Secretary connection received.",
          "Automatic replies are paused until access is activated.",
          "Choose administrator approval or a one-time 500 Telegram Star activation. AI usage still follows your plan, free allowance, and credit balance."
        ].join("\n\n"),
        reply_markup: { inline_keyboard: [
          [{ text: "Request Administrator Approval", callback_data: `secrq:${fingerprint}` }],
          [{ text: `Activate for ${SECRETARY_ACTIVATION_STARS} Stars`, callback_data: `secpay:${fingerprint}` }]
        ] }
      }).catch((error) => logger.error("telegram.secretary_onboarding_delivery_failed", { error, ownerUserId: persisted.ownerUserId }));
    }
  }
  return true;
}

async function businessConnectionForMessage(message) {
  const connectionId = message?.business_connection_id;
  const store = getPlatformStore();
  if (!connectionId || !store?.getBusinessConnection) return null;
  let connection = await store.getBusinessConnection(connectionId).catch(() => null);
  if (!connection) {
    const remote = await telegramApi("getBusinessConnection", { business_connection_id: connectionId }).catch(() => null);
    if (remote) connection = await store.upsertBusinessConnection(remote).catch(() => null);
  }
  return connection;
}

async function observeBusinessMessage(message, context, connection) {
  const store = getPlatformStore();
  if (!store?.observeTelegramMessage || !connection) return;
  const contact = await store.getSecretaryContactSettings?.(connection.connectionId, message.chat.id).catch(() => null);
  if (contact?.memoryEnabled === false) return;
  await store.syncUserProfile?.(message.from).catch(() => undefined);
  await store.observeTelegramMessage({
    updateType: context.updateType,
    transportMode: "telegram_secretary",
    chatId: message.chat.id,
    threadId: message.message_thread_id ?? null,
    messageId: message.message_id,
    senderUserId: message.from?.id ?? null,
    businessConnectionId: message.business_connection_id,
    content: message.text || null,
    status: context.updateType === "edited_business_message" ? "edited" : "active",
    retentionDays: Number(contact?.retentionDays || connection.retentionDays || 30)
  }).catch((error) => logger.error("telegram.business_observation_failed", { error, connectionId: message.business_connection_id }));
}

function telegramActionError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeActionReason(value, fallback) {
  const text = String(value || fallback).trim();
  return text.slice(0, 1000);
}

export async function executeTelegramModerationAction({
  actorUserId,
  chatId,
  action,
  targetUserId = null,
  reason = null,
  durationSeconds = null,
  telegramMessageId = null,
  telegramMessageIds = null,
  requestId = crypto.randomUUID(),
  lockType = "all"
}) {
  const store = getPlatformStore();
  if (!store?.getTelegramGroup || !store?.beginModerationAction || !store?.finishModerationAction) throw telegramActionError("Group management storage is unavailable", 503);
  if (!(await store.isFeatureEnabled?.("group_management"))) throw telegramActionError("Group Management is disabled by the platform administrator");
  const groupState = await store.getTelegramGroup(chatId);
  if (!groupState?.group?.active || groupState.settings?.enabled === false || groupState.settings?.moderationEnabled === false) {
    throw telegramActionError("Moderation is disabled for this group");
  }
  let permissionState;
  try {
    permissionState = await telegramGroupPermissionState({ chatId, actorUserId, action, targetUserId });
  } catch {
    throw telegramActionError("Telegram could not verify current group permissions", 503);
  }
  if (!permissionState.actorAllowed) throw telegramActionError(`You need Telegram's ${permissionState.permission} permission for this action`);
  if (!permissionState.botAllowed) throw telegramActionError(`Nemotron needs Telegram's ${permissionState.permission} permission for this action`);
  if (targetUserId && permissionState.targetProtected) throw telegramActionError("The selected user is protected from this moderation action");

  const safeReason = safeActionReason(reason, `${action} requested by group administrator`);
  const duration = durationSeconds === null || durationSeconds === undefined ? null : Number(durationSeconds);
  const untilDate = duration ? Math.floor(Date.now() / 1000) + duration : undefined;
  let pendingAction = null;
  if (!["warn", "unwarn"].includes(action)) {
    pendingAction = await store.beginModerationAction({
      requestId,
      chatId,
      actorUserId,
      targetUserId,
      action,
      reason: safeReason,
      durationSeconds: duration,
      telegramMessageId,
      reversible: ["ban", "mute", "lock", "pin", "approve"].includes(action),
      metadata: { lockType: ["lock", "unlock"].includes(action) ? lockType : undefined }
    });
    if (pendingAction.duplicate) {
      if (pendingAction.result === "success") return { ok: true, action, actionId: pendingAction.actionId, duplicate: true };
      throw telegramActionError(pendingAction.result === "pending" ? "This moderation action is already being processed" : "This moderation request already failed; submit a new request to retry", 409);
    }
  }
  let telegramResult;
  try {
    if (action === "ban") telegramResult = await telegramApi("banChatMember", { chat_id: chatId, user_id: targetUserId, ...(untilDate ? { until_date: untilDate } : {}) });
    else if (action === "unban") telegramResult = await telegramApi("unbanChatMember", { chat_id: chatId, user_id: targetUserId, only_if_banned: true });
    else if (action === "kick") {
      await telegramApi("banChatMember", { chat_id: chatId, user_id: targetUserId, until_date: Math.floor(Date.now() / 1000) + 45 });
      telegramResult = await telegramApi("unbanChatMember", { chat_id: chatId, user_id: targetUserId, only_if_banned: true });
    } else if (action === "mute") {
      telegramResult = await telegramApi("restrictChatMember", {
        chat_id: chatId,
        user_id: targetUserId,
        permissions: MUTED_MEMBER_PERMISSIONS,
        use_independent_chat_permissions: true,
        ...(untilDate ? { until_date: untilDate } : {})
      });
    } else if (action === "unmute") {
      telegramResult = await telegramApi("restrictChatMember", {
        chat_id: chatId,
        user_id: targetUserId,
        permissions: FULL_MEMBER_PERMISSIONS,
        use_independent_chat_permissions: true
      });
    } else if (action === "warn") {
      const warning = await store.issueWarning({ chatId, userId: targetUserId, actorUserId, reason: safeReason, requestId });
      const policy = warning.policy || {};
      if (!warning.duplicate && warning.count >= Number(policy.warning_threshold || 3)) {
        if (policy.warning_action === "mute") {
          const seconds = Number(policy.warning_mute_seconds || 3600);
          await telegramApi("restrictChatMember", {
            chat_id: chatId,
            user_id: targetUserId,
            permissions: MUTED_MEMBER_PERMISSIONS,
            use_independent_chat_permissions: true,
            until_date: Math.floor(Date.now() / 1000) + seconds
          });
        } else if (policy.warning_action === "kick") {
          await telegramApi("banChatMember", { chat_id: chatId, user_id: targetUserId, until_date: Math.floor(Date.now() / 1000) + 45 });
          await telegramApi("unbanChatMember", { chat_id: chatId, user_id: targetUserId, only_if_banned: true });
        } else if (policy.warning_action === "ban") {
          await telegramApi("banChatMember", { chat_id: chatId, user_id: targetUserId });
        }
      }
      return { ok: true, action, warningCount: warning.count, automaticAction: warning.count >= Number(policy.warning_threshold || 3) ? policy.warning_action : null };
    } else if (action === "unwarn") {
      const warning = await store.removeWarning({ chatId, userId: targetUserId, actorUserId, requestId });
      return { ok: true, action, warningCount: warning.count };
    } else if (action === "delete") telegramResult = await telegramApi("deleteMessage", { chat_id: chatId, message_id: telegramMessageId });
    else if (action === "purge") telegramResult = await telegramApi("deleteMessages", { chat_id: chatId, message_ids: telegramMessageIds });
    else if (action === "pin") telegramResult = await telegramApi("pinChatMessage", { chat_id: chatId, message_id: telegramMessageId, disable_notification: true });
    else if (action === "unpin") telegramResult = await telegramApi("unpinChatMessage", { chat_id: chatId, ...(telegramMessageId ? { message_id: telegramMessageId } : {}) });
    else if (["lock", "unlock"].includes(action)) {
      const locked = action === "lock";
      const permissions = { ...FULL_MEMBER_PERMISSIONS };
      if (lockType === "all") Object.assign(permissions, locked ? MUTED_MEMBER_PERMISSIONS : FULL_MEMBER_PERMISSIONS);
      else if (lockType === "media") for (const key of ["can_send_audios", "can_send_documents", "can_send_photos", "can_send_videos", "can_send_video_notes", "can_send_voice_notes"]) permissions[key] = !locked;
      else if (lockType === "stickers") permissions.can_send_other_messages = !locked;
      else if (lockType === "polls") permissions.can_send_polls = !locked;
      else if (lockType === "links") permissions.can_add_web_page_previews = !locked;
      else throw telegramActionError("Lock type must be all, media, stickers, polls, or links", 400);
      telegramResult = await telegramApi("setChatPermissions", { chat_id: chatId, permissions, use_independent_chat_permissions: true });
    } else if (action === "slowmode") {
      const delay = Number(durationSeconds);
      if (![0, 10, 30, 60, 300, 900, 3600].includes(delay)) throw telegramActionError("Slow mode must be 0, 10, 30, 60, 300, 900, or 3600 seconds", 400);
      telegramResult = await telegramApi("setChatSlowModeDelay", { chat_id: chatId, slow_mode_delay: delay });
    } else if (action === "approve") telegramResult = await telegramApi("approveChatJoinRequest", { chat_id: chatId, user_id: targetUserId });
    else if (action === "reject") telegramResult = await telegramApi("declineChatJoinRequest", { chat_id: chatId, user_id: targetUserId });
    else throw telegramActionError("Unsupported moderation action", 400);
  } catch (error) {
    if (pendingAction) await store.finishModerationAction(requestId, { result: "failed", metadata: { telegramStatus: error.statusCode || null } }).catch(() => undefined);
    if (error.statusCode) throw error;
    throw telegramActionError("Telegram rejected the moderation action", 502);
  }
  const record = await store.finishModerationAction(requestId, { result: "success" });
  if (["approve", "reject"].includes(action)) {
    await store.decideGuardJoinRequest({ chatId, userId: targetUserId, actorUserId, decision: action === "approve" ? "approved" : "rejected", reason: safeReason }).catch(() => undefined);
  }
  return { ok: telegramResult === true, action, actionId: record?.actionId || pendingAction?.actionId, duplicate: false };
}

async function answerGuardCallback(callback, text, showAlert = true) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callback.id,
    text,
    show_alert: showAlert
  });
}

async function handleGuardCallback(callback) {
  const match = String(callback?.data || "").match(/^g1\.(approve|deny)\.(-?\d+)\.(\d+)$/);
  if (!match) return false;
  if (!(await modeEnabled("guard"))) {
    await answerGuardCallback(callback, "Guard Mode is disabled. No join-request action was taken.");
    return true;
  }
  const [, action, chatId, userId] = match;
  const store = getPlatformStore();
  const group = await store?.getTelegramGroup?.(chatId).catch(() => null);
  if (!group?.settings?.guardEnabled || !(await store?.isFeatureEnabled?.("guard_mode"))) {
    await answerGuardCallback(callback, "Guard is not enabled for this group. No action was taken.");
    return true;
  }
  let permissions;
  try {
    permissions = await guardPermissionState(chatId, callback.from.id);
  } catch {
    await answerGuardCallback(callback, "Telegram permissions could not be verified. No action was taken.");
    return true;
  }
  if (!permissions.requesterAllowed) {
    await answerGuardCallback(callback, "You must currently be a group administrator with invite-user permission.");
    return true;
  }
  if (!permissions.botAllowed) {
    await answerGuardCallback(callback, "Promote Nemotron and grant invite-user permission before managing join requests.");
    return true;
  }
  const method = action === "approve" ? "approveChatJoinRequest" : "declineChatJoinRequest";
  try {
    await telegramApi(method, { chat_id: chatId, user_id: userId });
  } catch {
    await answerGuardCallback(callback, "Telegram rejected the join-request action. Check current group permissions.");
    return true;
  }
  await store?.decideGuardJoinRequest?.({
    chatId,
    userId,
    actorUserId: callback.from.id,
    decision: action === "approve" ? "approved" : "rejected",
    reason: "Guard callback decision"
  }).catch((error) => logger.error("telegram.guard_decision_persistence_failed", { error, chatId, userId }));
  await answerGuardCallback(callback, action === "approve" ? "Join request approved." : "Join request denied.", false);
  return true;
}

async function handleTelegramInlineQuery(inlineQuery) {
  if (!inlineQuery?.id) return false;
  if (!(await modeEnabled("inline"))) {
    await telegramApi("answerInlineQuery", {
      inline_query_id: inlineQuery.id,
      results: [],
      cache_time: 1,
      is_personal: true,
      button: { text: "Inline Mode is disabled", start_parameter: "inline_disabled" }
    });
    return true;
  }
  const query = String(inlineQuery.query || "").trim();
  const answerResults = (results, options = {}) => telegramApi("answerInlineQuery", {
    inline_query_id: inlineQuery.id,
    cache_time: options.cacheTime ?? 0,
    is_personal: true,
    results,
    ...(options.button ? { button: options.button } : {})
  });
  const article = ({ id, title, description, text }) => ({
    type: "article",
    id: crypto.createHash("sha256").update(`${inlineQuery.id}:${id}`).digest("hex").slice(0, 32),
    title,
    description,
    input_message_content: { message_text: String(text).slice(0, 4096) },
    reply_markup: { inline_keyboard: [[{ text: "Open Nemotron", url: safeTelegramLaunchUrl() }]] }
  });

  if (!query) {
    await answerResults([
      article({ id: "explain", title: "Explain a topic", description: "Type a topic after the bot username.", text: "Type the bot's @username followed by the topic you want explained." }),
      article({ id: "plan", title: "Create a plan", description: "Ask Nemotron for a concise action plan.", text: "Type the bot's @username followed by the goal you want planned." }),
      article({ id: "draft", title: "Draft a message", description: "Describe the message and desired tone.", text: "Type the bot's @username followed by what you want drafted." })
    ], { cacheTime: 30 });
    return true;
  }

  const userId = String(inlineQuery.from?.id || "");
  const unavailable = async (message) => answerResults([
    article({ id: "unavailable", title: "Nemotron is unavailable for this query", description: message, text: `${message}\n\nOpen Nemotron to review access or credits.` })
  ], { cacheTime: 1 });
  if (!/^[1-9]\d*$/.test(userId) || !telegramUserIdIsAllowed(userId)) {
    await unavailable("This Telegram account is not authorized for inline AI.");
    return true;
  }
  const store = getPlatformStore();
  const principal = store?.getUserRole ? await platformPrincipal(userId, store) : null;
  const userControl = telegramStarLedger?.getUserControl
    ? await telegramStarLedger.getUserControl(userId).catch(() => null)
    : null;
  if (["banned_user", "restricted_user"].includes(principal?.role) || userControl?.banned) {
    await store?.writeSecurityEvent?.({
      eventType: "telegram_inline_authorization_denied",
      severity: "medium",
      userId,
      metadata: { reason: "current_access_restricted" }
    }).catch(() => undefined);
    await unavailable("Inline AI access is restricted for this account.");
    return true;
  }

  const reservationId = `inline:${userId}:${inlineQuery.id}`;
  let usage;
  try {
    usage = await reserveAiUsage({
      ownerUserId: userId,
      reservationId,
      channel: "telegram_inline",
      conversationKey: `inline:${userId}`,
      unlimited: aiEntitlement({ userId, userControl }).unlimited
    });
    usage.reservationId = reservationId;
  } catch (error) {
    logger.error("telegram.inline_usage_reservation_failed", { error, userId });
    await unavailable("Usage controls are temporarily unavailable. You were not charged.");
    return true;
  }
  if (!usage.allowed) {
    if (!usage.duplicate && !limitNotices.shouldNotify(`${userId}:telegram_inline`, usage.allowance?.resetAt)) {
      await answerResults([], { cacheTime: 0 });
      return true;
    }
    await unavailable(usage.duplicate
      ? "This inline query has already been processed."
      : `Your free requests are finished and you need ${usage.promptCost || aiChatStarCost()} AI credit. Open Nemotron to top up or redeem a voucher.`);
    return true;
  }
  const creditReserved = usage.creditReserved === true;

  let responseProduced = false;
  try {
    if (telegramStarLedger?.reserveProviderCapacity) {
      const budget = await telegramStarLedger.reserveProviderCapacity({ providerKey: "nvidia", limit: nvidiaHourlyRequestLimit(), cost: 1, windowSeconds: 3600 });
      if (!budget?.reserved) throw Object.assign(new Error("provider_budget"), { statusCode: 429 });
    }
    if (creditReserved) await telegramStarLedger?.transitionPrompt?.(reservationId, "generation_started");
    const settings = await currentModeSettings();
    const activeAssistantMode = selectedAssistantMode(userControl, settings);
    const answer = await streamReply({
      conversationId: `telegram:inline:${userId}:${inlineQuery.id}`,
      text: query.slice(0, 4000),
      model: selectModel(userControl?.preferredModel),
      temperature: userControl?.creativity,
      maxTokens: Math.min(1024, responseTokenLimit(userControl?.responseLength)),
      systemPrompt: assistantSystemPrompt({ mode: activeAssistantMode, persona: assistantPreferences(userControl) }),
      persistence: { userId, channel: "telegram_inline", requestId: reservationId, memoryEnabled: false }
    });
    if (creditReserved) await telegramStarLedger?.transitionPrompt?.(reservationId, "response_produced");
    responseProduced = true;
    if (creditReserved) await telegramStarLedger?.transitionPrompt?.(reservationId, "delivery_attempted");
    await answerResults([article({ id: "answer", title: `Nvid AI · ${query.slice(0, 54)}`, description: "NVIDIA-powered inline answer", text: answer })]);
    if (creditReserved) await telegramStarLedger?.transitionPrompt?.(reservationId, "delivered");
    if (creditReserved) {
      try {
        await telegramStarLedger.completePrompt(reservationId);
      } catch (error) {
        logger.error("telegram.inline_credit_completion_failed", { error, reservationId });
        await telegramStarLedger.transitionPrompt?.(reservationId, "completion_pending", { errorCode: "ledger_completion_failed" }).catch(() => undefined);
      }
    }
    await finishAiUsage(usage, { success: true, providerModel: selectModel(userControl?.preferredModel) }).catch(() => undefined);
  } catch (error) {
    if (creditReserved && responseProduced) {
      await telegramStarLedger.transitionPrompt?.(reservationId, "completion_pending", { errorCode: "inline_delivery_failed" }).catch(() => undefined);
    } else if (creditReserved) {
      await telegramStarLedger.restorePrompt?.(reservationId).catch(() => undefined);
    }
    await finishAiUsage(usage, {
      success: responseProduced,
      failureCategory: classifyAiFailure(error),
      providerModel: selectModel(userControl?.preferredModel)
    }).catch(() => undefined);
    logger.error("telegram.inline_ai_failed", { error, userId });
    await unavailable(responseProduced
      ? "The generated inline result could not be delivered. Billing finalization is being recovered safely."
      : error?.statusCode === 429 ? "Inline AI is at its current provider limit. Try again shortly." : "NVIDIA could not complete this inline query, so no credit was charged.");
  }
  return true;
}

async function handleTelegramJoinRequest(joinRequest) {
  if (!joinRequest?.chat?.id || !joinRequest?.from?.id) return false;
  if (!(await modeEnabled("guard"))) return true;
  const store = getPlatformStore();
  if (!store?.recordGuardJoinRequest || !(await store.isFeatureEnabled?.("guard_mode"))) return true;
  await store.upsertTelegramGroup?.({ chat: joinRequest.chat }).catch((error) => logger.error("telegram.guard_group_sync_failed", { error, chatId: joinRequest.chat.id }));
  await store.syncUserProfile?.(joinRequest.from).catch((error) => logger.error("telegram.guard_user_sync_failed", { error, userId: joinRequest.from.id }));
  await store.recordGuardJoinRequest({
    chatId: joinRequest.chat.id,
    user: joinRequest.from,
    requestedAt: new Date(Number(joinRequest.date || Math.floor(Date.now() / 1000)) * 1000),
    inviteLink: joinRequest.invite_link?.invite_link || null
  });
  const groupState = await store.getTelegramGroup(joinRequest.chat.id);
  if (!groupState?.settings?.guardEnabled) return true;
  const userControl = telegramStarLedger
    ? await telegramStarLedger.getUserControl(String(joinRequest.from.id)).catch(() => null)
    : null;
  if (userControl?.banned && groupState.settings.guardPolicy?.rejectBannedUsers === true) {
    let botAllowed = false;
    try {
      botAllowed = (await guardPermissionState(joinRequest.chat.id, null)).botAllowed;
    } catch {
      // Permission verification must fail closed for an automatic moderation action.
    }
    if (botAllowed) {
      await telegramApi("declineChatJoinRequest", {
        chat_id: joinRequest.chat.id,
        user_id: joinRequest.from.id
      });
    } else if (telegramAdminUserId()) {
      await telegramApi("sendMessage", {
        chat_id: telegramAdminUserId(),
        text: `Guard Mode did not decline banned user ${joinRequest.from.id} in ${joinRequest.chat.title || joinRequest.chat.id} because Nemotron's invite-user permission could not be verified.`
      }).catch(() => undefined);
    }
    return true;
  }
  const adminId = telegramAdminUserId();
  if (adminId) {
    await telegramApi("sendMessage", {
      chat_id: adminId,
      text: [
        "Nemotron Guard Mode join request",
        `Group: ${joinRequest.chat.title || joinRequest.chat.id}`,
        `User ID: ${joinRequest.from.id}`,
        `Name: ${[joinRequest.from.first_name, joinRequest.from.last_name].filter(Boolean).join(" ") || "unknown"}`,
        joinRequest.from.username ? `Username: @${joinRequest.from.username}` : "Username: not provided"
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: `g1.approve.${joinRequest.chat.id}.${joinRequest.from.id}` },
          { text: "Deny", callback_data: `g1.deny.${joinRequest.chat.id}.${joinRequest.from.id}` }
        ]]
      }
    });
  }
  return true;
}

async function sendPaymentSupport(message, detail) {
  if (message.chat?.type !== "private") {
    await sendTelegramText(message, "For payment privacy, contact me in a private chat. Do not post payment details in a group.");
    return;
  }
  const adminId = telegramAdminUserId();
  if (!adminId) {
    await sendTelegramText(message, "Payment support is not configured. Please try again later.");
    return;
  }
  if (!detail) {
    await sendTelegramText(
      message,
      `For payment help, run /paysupport followed by a short description and any payment ID.\n\nPayment administrator ID: ${adminId}. Telegram support cannot resolve purchases made from this bot.`
    );
    return;
  }

  const report = [
    "Nemotron payment support request",
    `From user: ${message.from?.id ?? "unknown"}`,
    `Username: ${message.from?.username ? `@${message.from.username}` : "not provided"}`,
    `Chat: ${message.chat?.id ?? "unknown"}`,
    "",
    detail.slice(0, 3000)
  ].join("\n");
  try {
    await telegramApi("sendMessage", { chat_id: adminId, text: report });
    await sendTelegramText(message, "Your payment support request was sent to the bot administrator.");
  } catch {
    await sendTelegramText(
      message,
      `I could not deliver the support request automatically. Contact the bot administrator (Telegram user ID ${adminId}) and include your payment ID.`
    );
  }
}

async function sendAdminStarBalance(message) {
  if (!telegramUserIsAdmin(message.from?.id)) {
    await sendTelegramText(message, "This command is available only to the configured bot administrator.");
    return;
  }
  const [botBalance, stats] = await Promise.all([
    telegramApi("getMyStarBalance"),
    requireStarLedger().getStats()
  ]);
  await sendTelegramText(message, [
    "Nemotron Stars admin status:",
    `Telegram bot balance: ${botBalance?.amount ?? 0} Stars`,
    `Outstanding user credits: ${stats?.outstandingCredits ?? stats?.totalBalance ?? "0"}`,
    `Credited payments: ${stats?.payments ?? stats?.paymentCount ?? "0"}`,
    `Completed paid prompts: ${stats?.completedPrompts ?? "0"}`
  ].join("\n"));
}

function telegramDraftId(update, message) {
  const seed = `${update.update_id ?? "update"}:${message.chat.id}:${message.message_id ?? "message"}`;
  return (crypto.createHash("sha256").update(seed).digest().readUInt32BE(0) & 0x7fffffff) || 1;
}

export async function handleTelegramPreCheckout(query, {
  deadlineMs = PRE_CHECKOUT_DEADLINE_MS,
  ledgerBudgetMs = PRE_CHECKOUT_LEDGER_BUDGET_MS
} = {}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || !Number.isFinite(ledgerBudgetMs) || ledgerBudgetMs <= 0) {
    throw new TypeError("Pre-checkout deadlines must be positive numbers");
  }
  const deadlineAt = Date.now() + Math.floor(deadlineMs);
  const secretaryPurchase = String(query?.invoice_payload || "").startsWith("sa1.");
  const validation = secretaryPurchase
    ? validateSecretaryActivationPayload(query?.invoice_payload, {
        userId: query?.from?.id,
        currency: query?.currency,
        totalAmount: query?.total_amount
      })
    : validateStarPurchasePayload(query?.invoice_payload, {
        userId: query?.from?.id,
        currency: query?.currency,
        totalAmount: query?.total_amount
      });
  let error = validation.valid ? null : validation.error;

  if (!telegramPaymentsEnabled() || !telegramStarLedger) {
    error = "Star payments are temporarily unavailable. Please try again later.";
  } else if (!error && secretaryPurchase) {
    try {
      const connection = await secretaryConnectionFromFingerprint(validation.purchase.userId, validation.purchase.connectionFingerprint);
      if (!connection || connection.ownerUserId !== validation.purchase.userId) error = "This Secretary invoice does not match an active business connection.";
    } catch {
      error = "Secretary access controls are temporarily unavailable. Please try again.";
    }
  } else if (!error) {
    try {
      const lookupBudget = Math.max(1, Math.min(
        Math.floor(ledgerBudgetMs),
        deadlineAt - Date.now() - 1000
      ));
      const accepted = await within(
        telegramStarLedger.hasAcceptedTerms(validation.purchase.userId, STAR_TERMS_VERSION),
        lookupBudget,
        "The payment ledger did not respond"
      );
      if (!accepted) error = "Please run /topup again and accept the current purchase terms.";
    } catch {
      error = "The payment ledger is temporarily unavailable. Please try again.";
    }
  }

  await telegramApi("answerPreCheckoutQuery", {
    pre_checkout_query_id: query.id,
    ok: !error,
    ...(error ? { error_message: error.slice(0, 200) } : {})
  }, { deadlineAt });
}

async function handleSuccessfulStarPayment(message) {
  const payment = message?.successful_payment;
  if (String(payment?.invoice_payload || "").startsWith("sa1.")) {
    const activation = validateSecretaryActivationPayload(payment.invoice_payload, {
      userId: message?.from?.id,
      currency: payment?.currency,
      totalAmount: payment?.total_amount,
      allowExpired: true
    });
    if (!activation.valid) throw new Error(`Rejected an invalid Secretary Stars payment: ${activation.error}`);
    const connection = await secretaryConnectionFromFingerprint(activation.purchase.userId, activation.purchase.connectionFingerprint);
    if (!connection) throw new Error("Rejected a Secretary payment for an unknown business connection");
    const result = await getPlatformStore().activateSecretaryPayment({
      connectionId: connection.connectionId,
      ownerUserId: activation.purchase.userId,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      metadata: { amount: SECRETARY_ACTIVATION_STARS, currency: "XTR", productId: SECRETARY_PRODUCT_ID }
    });
    if (result.activated) {
      await sendTelegramText(message, [
        "Nemotron Secretary access activated.",
        `Payment received: ${SECRETARY_ACTIVATION_STARS} Telegram Stars.`,
        "This activates Secretary access for the selected Business connection. Automatic AI replies still use your plan allowance or credits."
      ].join("\n\n"));
    }
    return;
  }
  const validation = validateStarPurchasePayload(payment?.invoice_payload, {
    userId: message?.from?.id,
    currency: payment?.currency,
    totalAmount: payment?.total_amount,
    // Telegram may redeliver a valid completed payment after the invoice TTL.
    // The signed identity, currency, amount, and charge ID remain enforced.
    allowExpired: true
  });
  if (!validation.valid) {
    throw new Error(`Rejected an invalid successful Telegram Stars payment: ${validation.error}`);
  }

  const { purchase } = validation;
  const result = await requireStarLedger().creditPayment({
    userId: purchase.userId,
    amount: purchase.amount,
    telegramPaymentChargeId: payment.telegram_payment_charge_id,
    providerPaymentChargeId: payment.provider_payment_charge_id,
    invoicePayload: payment.invoice_payload,
    currency: payment.currency
  });
  const changed = result?.credited ?? result?.changed ?? true;
  if (!changed) return;

  const currentBalance = balanceValue(result);
  await sendTelegramText(
    message,
    [
      `Payment received: ${purchase.amount} Star${purchase.amount === 1 ? "" : "s"}.`,
      `Credits added: ${purchase.amount}`,
      `Current balance: ${currentBalance}`,
      `Payment ID: ${payment.telegram_payment_charge_id}`,
      "",
      "Send any non-command message to use 1 credit."
    ].join("\n")
  ).catch((error) => logger.error("telegram.payment_confirmation_failed", { error }));

  const adminId = telegramAdminUserId();
  if (adminId) {
    telegramApi("sendMessage", {
      chat_id: adminId,
      text: [
        "Nemotron Stars purchase received",
        `Buyer ID: ${purchase.userId}`,
        `Amount: ${purchase.amount} Stars`,
        `Payment ID: ${payment.telegram_payment_charge_id}`
      ].join("\n")
    }).catch((error) => logger.error("telegram.admin_payment_notice_failed", { error }));
  }
}

async function handleRefundedStarPayment(message) {
  const refund = message?.refunded_payment;
  if (String(refund?.invoice_payload || "").startsWith("sa1.")) {
    const activation = validateSecretaryActivationPayload(refund.invoice_payload, {
      userId: message?.from?.id,
      currency: refund?.currency,
      totalAmount: refund?.total_amount,
      allowExpired: true
    });
    if (!activation.valid) throw new Error(`Rejected an invalid Secretary Stars refund: ${activation.error}`);
    await getPlatformStore()?.recordSecretaryRefund?.({
      telegramPaymentChargeId: refund.telegram_payment_charge_id,
      ownerUserId: activation.purchase.userId
    });
    await sendTelegramText(message, "The Secretary activation refund was recorded and automatic replies were suspended.").catch(() => undefined);
    return;
  }
  const validation = validateStarPurchasePayload(refund?.invoice_payload, {
    currency: refund?.currency,
    totalAmount: refund?.total_amount,
    allowExpired: true
  });
  if (!validation.valid) {
    throw new Error(`Rejected an invalid Telegram Stars refund: ${validation.error}`);
  }

  const { purchase } = validation;
  const result = await requireStarLedger().recordRefund({
    telegramPaymentChargeId: refund.telegram_payment_charge_id,
    userId: purchase.userId,
    amount: purchase.amount
  });
  if (!result?.payment || !result.changed) return;

  await sendTelegramText(message, [
    `Telegram refunded payment ${refund.telegram_payment_charge_id}.`,
    `Credits removed: ${result.deductedAmount}`,
    `Current balance: ${result.balance}`
  ].join("\n")).catch((error) => logger.error("telegram.refund_confirmation_failed", { error }));

  const adminId = telegramAdminUserId();
  if (adminId) {
    telegramApi("sendMessage", {
      chat_id: adminId,
      text: [
        "Nemotron Stars refund recorded",
        `Buyer ID: ${purchase.userId}`,
        `Amount: ${purchase.amount} Stars`,
        `Credits removed: ${result.deductedAmount}`,
        `Payment ID: ${refund.telegram_payment_charge_id}`
      ].join("\n")
    }).catch((error) => logger.error("telegram.admin_refund_notice_failed", { error }));
  }
}

export function telegramUpdateRequiresSynchronousAck(update) {
  return Boolean(
    update?.pre_checkout_query
    || update?.message?.successful_payment
    || update?.message?.refunded_payment
    || String(update?.callback_query?.data || "").startsWith("s1.")
    || String(update?.callback_query?.data || "").startsWith("g1.")
    || /^(secrq|secpay|secdec|cap):/.test(String(update?.callback_query?.data || ""))
  );
}

const GROUP_MODERATION_COMMANDS = new Set([
  "ban", "unban", "kick", "mute", "unmute", "warn", "unwarn", "warnings", "purge",
  "pin", "unpin", "lock", "unlock", "rules", "setrules", "slowmode", "approve", "reject",
  "modlog", "admins", "report"
]);

function groupMessage(message) {
  return ["group", "supergroup"].includes(message?.chat?.type);
}

function commandTarget(command, message) {
  const replyTarget = message?.reply_to_message?.from?.id;
  const parts = String(command.argument || "").split(/\s+/).filter(Boolean);
  if (replyTarget) return { targetUserId: String(replyTarget), rest: parts };
  if (/^[1-9]\d*$/.test(parts[0] || "")) return { targetUserId: parts.shift(), rest: parts };
  return { targetUserId: null, rest: parts };
}

function parseDuration(value, fallback = null) {
  if (!value) return fallback;
  if (/^(forever|permanent|perm)$/i.test(value)) return null;
  const match = String(value).match(/^(\d{1,6})(s|m|h|d|w)$/i);
  if (!match) return undefined;
  const factor = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2].toLowerCase()];
  const seconds = Number(match[1]) * factor;
  return seconds >= 30 && seconds <= 31_536_000 ? seconds : undefined;
}

async function groupCommandPermission(message, action, targetUserId = null) {
  try {
    return await telegramGroupPermissionState({ chatId: message.chat.id, actorUserId: message.from.id, action, targetUserId });
  } catch {
    return null;
  }
}

async function handleTelegramGroupCommand(command, message) {
  if (!GROUP_MODERATION_COMMANDS.has(command.name) || !groupMessage(message)) return false;
  const store = getPlatformStore();
  if (!store?.getTelegramGroup) {
    await sendTelegramText(message, "Group management storage is temporarily unavailable.");
    return true;
  }
  const group = await store.getTelegramGroup(message.chat.id);
  if (!group) {
    await sendTelegramText(message, "This group has not finished registering with Nemotron. Try again in a moment.");
    return true;
  }
  if (command.name === "rules") {
    await sendTelegramText(message, group.settings?.rules || "No group rules have been configured yet.");
    return true;
  }
  if (command.name === "admins") {
    try {
      const admins = await telegramApi("getChatAdministrators", { chat_id: message.chat.id });
      const lines = admins.map((entry) => {
        const name = [entry.user?.first_name, entry.user?.last_name].filter(Boolean).join(" ") || entry.user?.id;
        return `${entry.status === "creator" ? "OWNER" : "ADMIN"} ${name}${entry.user?.username ? ` (@${entry.user.username})` : ""}`;
      });
      await sendTelegramText(message, `Current Telegram administrators:\n\n${lines.join("\n")}`);
    } catch {
      await sendTelegramText(message, "Telegram would not provide the current administrator list.");
    }
    return true;
  }
  if (command.name === "report") {
    const reported = message.reply_to_message;
    if (!reported?.from?.id) {
      await sendTelegramText(message, "Reply to the message you want to report, then run /report [reason].");
      return true;
    }
    await store.recordModerationAction({
      requestId: crypto.randomUUID(),
      chatId: message.chat.id,
      actorUserId: message.from.id,
      targetUserId: reported.from.id,
      action: "report",
      reason: command.argument || "Reported by a group member",
      telegramMessageId: reported.message_id,
      result: "pending",
      metadata: { reporterMessageId: message.message_id }
    });
    await sendTelegramText(message, "Report recorded for the group administrators.");
    return true;
  }
  if (command.name === "setrules") {
    const permission = await groupCommandPermission(message, "setrules");
    if (!permission?.actorAllowed) {
      await sendTelegramText(message, "You need the current Telegram change-info permission to update rules.");
      return true;
    }
    if (!command.argument) {
      await sendTelegramText(message, "Usage: /setrules <group rules>");
      return true;
    }
    await store.updateGroupSettings({
      actorUserId: message.from.id,
      chatId: message.chat.id,
      requestId: crypto.randomUUID(),
      changes: { rules: command.argument }
    });
    await sendTelegramText(message, "Group rules updated and saved.");
    return true;
  }
  if (command.name === "modlog") {
    const permission = await groupCommandPermission(message, "modlog");
    if (!permission?.actorAllowed) {
      await sendTelegramText(message, "Only a current Telegram group administrator can view the moderation log.");
      return true;
    }
    const actions = await store.listModerationActions(message.chat.id, { limit: 12 });
    const lines = actions.map((entry) => `${String(entry.action).toUpperCase()} user ${entry.target_user_id || "n/a"} - ${entry.result}${entry.reason ? ` - ${entry.reason}` : ""}`);
    await sendTelegramText(message, lines.length ? `Recent moderation actions:\n\n${lines.join("\n")}` : "No moderation actions have been recorded.");
    return true;
  }

  const { targetUserId, rest } = commandTarget(command, message);
  if (command.name === "warnings") {
    const target = targetUserId || String(message.from.id);
    if (target !== String(message.from.id)) {
      const permission = await groupCommandPermission(message, "warnings", target);
      if (!permission?.actorAllowed) {
        await sendTelegramText(message, "Only a current group administrator can view another user's warnings.");
        return true;
      }
    }
    const warnings = await store.listWarnings(message.chat.id, target);
    const active = warnings.filter((warning) => warning.active);
    await sendTelegramText(message, active.length ? `Active warnings for ${target}:\n${active.map((warning, index) => `${index + 1}. ${warning.reason}`).join("\n")}` : `User ${target} has no active warnings.`);
    return true;
  }

  let action = command.name;
  let durationSeconds = null;
  let reason = rest.join(" ");
  let telegramMessageId = null;
  let telegramMessageIds = null;
  let lockType = "all";

  if (["ban", "unban", "kick", "mute", "unmute", "warn", "unwarn", "approve", "reject"].includes(action) && !targetUserId) {
    await sendTelegramText(message, `Reply to a user's message or use /${action} <telegram-user-id>${action === "mute" ? " [10m|1h|1d|permanent]" : ""} [reason].`);
    return true;
  }
  if (action === "mute") {
    const parsed = parseDuration(rest[0], 3600);
    if (parsed === undefined) {
      await sendTelegramText(message, "Mute duration must look like 30s, 10m, 1h, 1d, 1w, or permanent.");
      return true;
    }
    durationSeconds = parsed;
    reason = rest.slice(rest[0] && parseDuration(rest[0], 3600) !== 3600 ? 1 : 0).join(" ");
  }
  if (action === "ban") {
    const parsed = parseDuration(rest[0]);
    if (parsed !== undefined && rest[0]) {
      durationSeconds = parsed;
      reason = rest.slice(1).join(" ");
    }
  }
  if (action === "purge") {
    const start = message.reply_to_message?.message_id;
    if (!start || start > message.message_id) {
      await sendTelegramText(message, "Reply to the first recent message to delete, then run /purge. Telegram only permits eligible recent messages.");
      return true;
    }
    telegramMessageIds = Array.from({ length: Math.min(100, message.message_id - start + 1) }, (_, index) => start + index);
  }
  if (["pin", "unpin"].includes(action)) {
    telegramMessageId = message.reply_to_message?.message_id || null;
    if (action === "pin" && !telegramMessageId) {
      await sendTelegramText(message, "Reply to the message you want to pin, then run /pin.");
      return true;
    }
  }
  if (["lock", "unlock"].includes(action)) lockType = rest[0]?.toLowerCase() || "all";
  if (action === "slowmode") {
    durationSeconds = Number(rest[0]);
    if (![0, 10, 30, 60, 300, 900, 3600].includes(durationSeconds)) {
      await sendTelegramText(message, "Usage: /slowmode <0|10|30|60|300|900|3600>");
      return true;
    }
  }

  try {
    const result = await executeTelegramModerationAction({
      actorUserId: message.from.id,
      chatId: message.chat.id,
      action,
      targetUserId,
      reason: reason || null,
      durationSeconds,
      telegramMessageId,
      telegramMessageIds,
      lockType,
      requestId: crypto.randomUUID()
    });
    const detail = result.warningCount === undefined ? "" : ` Active warnings: ${result.warningCount}.`;
    await sendTelegramText(message, `${action.toUpperCase()} completed.${detail}`);
  } catch (error) {
    await sendTelegramText(message, error.message || "The moderation action could not be completed.");
  }
  return true;
}

const NVID_GROUP_ADMIN_COMMANDS = new Set([
  "nvid_enable", "nvid_disable", "nvid_register", "nvid_setmode", "nvid_model", "nvid_secretary", "nvid_guard", "nvid_captcha",
  "nvid_settings", "nvid_setrules", "nvid_welcome", "nvid_goodbye", "nvid_moderation", "nvid_permissions", "nvid_usage", "nvid_logs"
]);

function groupHelpText() {
  return [
    "Nemotron group commands",
    "",
    "/nvid <question> - ask Nemotron",
    "/nvid_help - show this help",
    "/nvid_status - show live group mode",
    "/nvid_mode - show the active assistant",
    "/nvid_summary - summarize stored messages in this thread",
    "/nvid_reset - reset this thread's AI context",
    "/nvid_report - report the replied-to message",
    "",
    "Group administrators can use /nvid_settings for configuration commands."
  ].join("\n");
}

async function liveBotMember(chatId) {
  const me = await telegramApi("getMe");
  return telegramApi("getChatMember", { chat_id: chatId, user_id: me.id });
}

function safeGroupStatusText(context, botMember) {
  const settings = context.groupConfiguration || {};
  const chatLabel = context.isSupergroup ? "Supergroup" : context.isGroup ? "Group" : "Unknown";
  const secretaryObservation = settings.secretaryEnabled && settings.secretaryObservationEnabled
    ? settings.messageStorageEnabled ? "Active" : "Active, storage disabled"
    : "Off";
  return [
    "Nemotron Status",
    `Chat: ${chatLabel}${context.isThread ? " topic" : ""}`,
    `Activation: ${activationPolicyLabel(settings.activationPolicy)}`,
    `Assistant: ${ASSISTANT_MODE_DEFINITIONS[settings.defaultMode]?.label || settings.defaultMode || "AI Chat"}`,
    `Secretary observation: ${secretaryObservation}`,
    `Thread isolation: ${settings.threadIsolationEnabled === false ? "Off" : "Active"}`,
    `Bot administrator: ${["creator", "administrator"].includes(botMember?.status) ? "Yes" : "No"}`,
    `AI replies: ${settings.enabled === false ? "Disabled" : "Enabled"}`
  ].join("\n");
}

async function requireLiveGroupConfigurationAuthority(message, commandName) {
  const permission = await groupCommandPermission(message, "group_settings");
  if (!permission?.actorAllowed) {
    await sendTelegramText(message, "This command requires your current Telegram group administrator rights.");
    return null;
  }
  if (!permission?.botAllowed) {
    await sendTelegramText(message, "Nemotron must be a group administrator with manage-chat permission before this setting can be changed.");
    return null;
  }
  const store = getPlatformStore();
  await store?.recordModerationAction?.({
    requestId: crypto.randomUUID(),
    chatId: message.chat.id,
    actorUserId: message.from.id,
    action: "automatic_flag",
    reason: `Group configuration command /${commandName}`,
    result: "success",
    metadata: { command: commandName }
  }).catch(() => undefined);
  return permission;
}

async function handleNvidGroupCommand(command, message, context) {
  if (!groupMessage(message) || !command?.name?.startsWith("nvid")) return { handled: false, prompt: null };
  const store = getPlatformStore();
  const groupState = await store?.getTelegramGroup?.(message.chat.id).catch(() => null);
  if (!groupState) {
    await sendTelegramText(message, "This group is still registering with Nemotron. Try again in a moment.");
    return { handled: true, prompt: null };
  }

  if (command.name === "nvid") {
    if (!command.argument) {
      await sendTelegramText(message, groupHelpText());
      return { handled: true, prompt: null };
    }
    return { handled: false, prompt: command.argument };
  }
  if (command.name === "nvid_help") {
    await sendTelegramText(message, groupHelpText());
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_status" || command.name === "nvid_settings") {
    if (command.name === "nvid_settings" && !(await requireLiveGroupConfigurationAuthority(message, command.name))) return { handled: true, prompt: null };
    const botMember = await liveBotMember(message.chat.id).catch(() => null);
    await sendTelegramText(message, safeGroupStatusText({ ...context, groupConfiguration: groupState.settings }, botMember));
    if (command.name === "nvid_settings") {
      await sendTelegramText(message, "Admin controls: /nvid_register, /nvid_enable, /nvid_disable, /nvid_setmode, /nvid_model, /nvid_secretary, /nvid_captcha, /nvid_guard, /nvid_moderation, /nvid_setrules, /nvid_welcome, /nvid_goodbye, /nvid_permissions, /nvid_usage, /nvid_logs");
    }
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_mode") {
    const mode = groupState.settings?.defaultMode || "chat";
    await sendTelegramText(message, `Active group assistant: ${ASSISTANT_MODE_DEFINITIONS[mode]?.label || mode}.\nChange it with /nvid_setmode <mode> as a group administrator.`);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_reset") {
    await resetConversation(conversationId(message), { userId: String(message.from?.id) });
    await sendTelegramText(message, "This group thread's Nemotron context was reset.");
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_report") {
    await handleTelegramGroupCommand({ ...command, name: "report" }, message);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_summary") {
    if (!groupState.settings?.secretaryEnabled || !groupState.settings?.messageStorageEnabled) {
      await sendTelegramText(message, "Group Secretary message storage is disabled. A group administrator can enable it with /nvid_secretary on.");
      return { handled: true, prompt: null };
    }
    const observations = await store.listObservedMessages?.({
      chatId: message.chat.id,
      threadId: message.message_thread_id ?? null,
      transportMode: "group_secretary",
      limit: 120
    }) || [];
    if (!observations.length) {
      await sendTelegramText(message, "There are no authorized stored messages in this thread to summarize yet.");
      return { handled: true, prompt: null };
    }
    const transcript = observations.map((entry) => `[${entry.sender_user_id || "member"}] ${entry.content || ""}`).join("\n").slice(-18_000);
    return { handled: false, prompt: `Summarize the following authorized Telegram group thread. Identify decisions, tasks, dates, and unanswered questions.\n\n${transcript}` };
  }
  if (command.name === "nvid_rules") {
    await sendTelegramText(message, groupState.settings?.rules || "No group rules have been configured.");
    return { handled: true, prompt: null };
  }

  if (!NVID_GROUP_ADMIN_COMMANDS.has(command.name)) {
    await sendTelegramText(message, `Unknown Nemotron group command /${command.name}.\n\n${groupHelpText()}`);
    return { handled: true, prompt: null };
  }
  const permission = await requireLiveGroupConfigurationAuthority(message, command.name);
  if (!permission) return { handled: true, prompt: null };
  const actorIsCreator = permission.actor?.status === "creator";
  const update = (changes) => store.updateGroupSettings({
    actorUserId: message.from.id,
    chatId: message.chat.id,
    requestId: crypto.randomUUID(),
    changes
  });

  if (command.name === "nvid_enable" || command.name === "nvid_disable") {
    const enabled = command.name === "nvid_enable";
    await update({ enabled });
    await sendTelegramText(message, `Nemotron group replies are now ${enabled ? "enabled" : "disabled"}.`);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_register") {
    const [chat, bot] = await Promise.all([
      telegramApi("getChat", { chat_id: message.chat.id }),
      liveBotMember(message.chat.id)
    ]);
    await store.upsertTelegramGroup({ chat, botMember: bot });
    await sendTelegramText(message, `Group registration refreshed. Bot status: ${bot.status}.`);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_setmode") {
    let mode = null;
    try {
      mode = normalizeAssistantMode(command.argument);
    } catch {
      mode = null;
    }
    if (!mode || !ASSISTANT_MODE_DEFINITIONS[mode]) {
      await sendTelegramText(message, `Usage: /nvid_setmode <${Object.keys(ASSISTANT_MODE_DEFINITIONS).join("|")}>`);
      return { handled: true, prompt: null };
    }
    await update({ defaultMode: mode });
    await sendTelegramText(message, `${ASSISTANT_MODE_DEFINITIONS[mode].label} is now the group assistant.`);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_model") {
    const { model } = resolveTelegramModel(command.argument);
    if (!model) {
      await sendTelegramText(message, "Usage: /nvid_model <model number or approved model name>. See /models in a private chat.");
      return { handled: true, prompt: null };
    }
    await update({ groupModel: selectModel(model.id) });
    await sendTelegramText(message, `${model.label} is now the group model. Personal model settings were not changed.`);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_secretary") {
    const state = command.argument.toLowerCase();
    if (!["on", "off", "storage_on", "storage_off"].includes(state)) {
      await sendTelegramText(message, "Usage: /nvid_secretary <on|off|storage_on|storage_off>");
      return { handled: true, prompt: null };
    }
    const wasEnabled = groupState.settings?.secretaryEnabled === true;
    const changes = state === "on"
      ? { secretaryEnabled: true, secretaryObservationEnabled: true, messageStorageEnabled: true }
      : state === "off"
        ? { secretaryEnabled: false, secretaryObservationEnabled: false }
        : { messageStorageEnabled: state === "storage_on" };
    await update(changes);
    if (state === "on" && !wasEnabled) {
      await sendTelegramText(message, "Nemotron Group Secretary is now active. I will observe authorized messages for summaries, but I will respond publicly only when called with /nvid, mentioned or scheduled.");
    } else {
      await sendTelegramText(message, `Group Secretary ${state.replace("_", " ")} saved.`);
    }
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_guard" || command.name === "nvid_moderation") {
    const enabled = /^(on|enable|enabled)$/i.test(command.argument);
    if (!/^(on|off|enable|disable|enabled|disabled)$/i.test(command.argument)) {
      await sendTelegramText(message, `Usage: /${command.name} <on|off>`);
      return { handled: true, prompt: null };
    }
    await update(command.name === "nvid_guard" ? { guardEnabled: enabled } : { moderationEnabled: enabled });
    await sendTelegramText(message, `${command.name === "nvid_guard" ? "Guard" : "Moderation"} is now ${enabled ? "enabled" : "disabled"}.`);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_captcha") {
    const enabled = /^(on|enable|enabled)$/i.test(command.argument);
    if (!/^(on|off|enable|disable|enabled|disabled)$/i.test(command.argument)) {
      await sendTelegramText(message, "Usage: /nvid_captcha <on|off>");
      return { handled: true, prompt: null };
    }
    await update({ captchaEnabled: enabled });
    await sendTelegramText(message, `First-use CAPTCHA verification is now ${enabled ? "enabled" : "disabled"}.`);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_setrules") {
    if (!command.argument) {
      await sendTelegramText(message, "Usage: /nvid_setrules <group rules>");
      return { handled: true, prompt: null };
    }
    await update({ rules: command.argument });
    await sendTelegramText(message, "Group rules updated.");
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_welcome") {
    const disabled = /^off$/i.test(command.argument);
    await update(disabled ? { welcomeEnabled: false } : { welcomeEnabled: true, welcomeMessage: command.argument || "Welcome {name} to the group." });
    await sendTelegramText(message, disabled ? "Welcome messages disabled." : "Welcome message saved and enabled.");
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_goodbye") {
    const disabled = /^off$/i.test(command.argument);
    await update(disabled ? { goodbyeEnabled: false } : { goodbyeEnabled: true, goodbyeMessage: command.argument || "Goodbye {name}." });
    await sendTelegramText(message, disabled ? "Goodbye messages disabled." : "Goodbye message saved and enabled.");
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_usage") {
    const allowance = await store.getUsageAllowance?.(message.from.id, { channel: "telegram_group" });
    await sendTelegramText(message, allowance
      ? `Your group AI allowance: ${allowance.remaining}/${allowance.freeLimit} free successful requests remaining. Group-wide analytics are available in the Mini App.`
      : "Group usage controls are temporarily unavailable.");
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_permissions") {
    const bot = permission.botMember;
    const rights = Object.entries(bot || {}).filter(([key, value]) => key.startsWith("can_") && value === true).map(([key]) => key.replace(/^can_/, "").replaceAll("_", " "));
    await sendTelegramText(message, `Bot status: ${bot?.status || "unknown"}\nVerified rights: ${rights.length ? rights.join(", ") : "none"}`);
    return { handled: true, prompt: null };
  }
  if (command.name === "nvid_logs") {
    const actions = await store.listModerationActions(message.chat.id, { limit: 12 });
    await sendTelegramText(message, actions.length ? actions.map((entry) => `${entry.action}: ${entry.result}${entry.reason ? ` - ${entry.reason}` : ""}`).join("\n") : "No Nemotron group actions have been logged yet.");
    return { handled: true, prompt: null };
  }
  return { handled: true, prompt: null };
}

async function handleTelegramCommand(command, message) {
  if (await handleTelegramGroupCommand(command, message)) return true;
  const chatId = message.chat.id;
  switch (command.name) {
    case "start":
      await sendTelegramWelcome(message);
      return true;
    case "help":
      await sendTelegramText(message, helpText());
      return true;
    case "dashboard":
    case "app":
      await sendTelegramDashboard(message);
      return true;
    case "modes": {
      await sendTelegramText(message, modeListText(await currentModeSettings(), { admin: telegramUserIsAdmin(message.from?.id) }));
      return true;
    }
    case "mode": {
      const adminError = assertTelegramAdmin(message);
      if (adminError) {
        await sendTelegramText(message, adminError);
        return true;
      }
      const toggle = parseModeToggle(command.argument);
      if (!toggle) {
        await sendTelegramText(
          message,
          `Usage: /mode <mode> on|off\n\nAvailable modes: ${Object.keys(MODE_DEFINITIONS).join(", ")}`
        );
        return true;
      }
      const result = await requireStarLedger().setModeEnabled(toggle.mode, toggle.enabled);
      await sendTelegramText(
        message,
        `${MODE_DEFINITIONS[result.mode].label} is now ${result.enabled ? "ON" : "OFF"}.\n\n${modeListText(await currentModeSettings(), { admin: true })}`
      );
      return true;
    }
    case "use": {
      if (!telegramStarLedger || typeof telegramStarLedger.setUserMode !== "function") {
        await sendTelegramText(message, "Assistant mode selection is temporarily unavailable.");
        return true;
      }
      const settings = await currentModeSettings();
      if (!command.argument) {
        const control = await telegramStarLedger.getUserControl(String(message.from?.id));
        const active = selectedAssistantMode(control, settings);
        const choices = assistantModeList(settings)
          .map((mode) => `${mode.enabled ? "ON" : "OFF"} ${mode.id} - ${mode.label}${mode.id === active ? " <- active" : ""}`)
          .join("\n");
        await sendTelegramText(message, `Your active assistant mode is ${active}.\n\n${choices}\n\nUse /use <mode> to switch.`);
        return true;
      }
      let requested;
      try {
        requested = normalizeAssistantMode(command.argument);
      } catch {
        await sendTelegramText(message, `Unknown assistant mode. Choose: ${Object.keys(ASSISTANT_MODE_DEFINITIONS).join(", ")}.`);
        return true;
      }
      if (settings[requested] === false) {
        await sendTelegramText(message, `${ASSISTANT_MODE_DEFINITIONS[requested].label} is disabled by the administrator.`);
        return true;
      }
      await telegramStarLedger.setUserMode(String(message.from?.id), requested);
      await sendTelegramText(message, `${ASSISTANT_MODE_DEFINITIONS[requested].label} is now active. Future AI Chat answers will use this mode.`);
      return true;
    }
    case "persona": {
      if (!(await modeEnabled("secretary"))) {
        await sendTelegramText(message, "Secretary Mode is currently disabled.");
        return true;
      }
      if (!telegramStarLedger) {
        await sendTelegramText(message, "Persona customization is temporarily unavailable.");
        return true;
      }
      if (!command.argument) {
        const control = await telegramStarLedger.getUserControl(String(message.from?.id));
        await sendTelegramText(
          message,
          control.persona
            ? `Your current AI customization:\n${control.persona}\n\nUpdate it with /persona <instructions>, or clear it with /persona clear.`
            : "No AI customization is set. Use /persona <instructions> to choose the tone, role, or response style you want."
        );
        return true;
      }
      const nextPersona = /^clear$/i.test(command.argument) ? null : command.argument;
      await telegramStarLedger.setUserPersona(String(message.from?.id), nextPersona);
      await sendTelegramText(
        message,
        nextPersona
          ? "Your AI customization was saved. Future chat answers will follow it when possible."
          : "Your AI customization was cleared."
      );
      return true;
    }
    case "models":
      await sendTelegramText(message, await modelListText(message));
      return true;
    case "model": {
      const control = telegramStarLedger?.getUserControl && message.from?.id
        ? await telegramStarLedger.getUserControl(String(message.from.id)).catch(() => null)
        : null;
      if (!command.argument) {
        const preferred = preferredTelegramModel(message, control);
        const current = availableModels().find((model) => model.id === preferred);
        await sendTelegramText(
          message,
          `Active model: ${current?.label || preferred}\n\nUse /model <number or model name>. See /models for choices.`
        );
        return true;
      }
      const { model, matches } = resolveTelegramModel(command.argument);
      if (!model) {
        const detail = matches.length > 1
          ? `That name matches multiple models: ${matches.map(({ label }) => label).join(", ")}.`
          : "I could not find that model.";
        await sendTelegramText(message, `${detail}\n\nUse /models to see the available choices.`);
        return true;
      }
      const selected = selectModel(model.id);
      if (!telegramStarLedger?.setUserModel) {
        transientTelegramModelPreferences.set(telegramConversationScope(message), selected);
      } else {
        await telegramStarLedger.setUserModel(String(message.from?.id), selected);
      }
      await sendTelegramText(message, `Model changed to ${model.label} [${model.tag}].\n${model.id}`);
      return true;
    }
    case "reset":
      await resetConversation(conversationId(message), { userId: String(message.from?.id) });
      await sendTelegramText(message, "Conversation memory cleared. Your selected model is unchanged.");
      return true;
    case "balance": {
      const balance = telegramStarLedger ? await telegramStarLedger.getBalance(String(message.from?.id)) : { balance: "0" };
      const allowance = await getPlatformStore()?.getUsageAllowance?.(String(message.from?.id), {
        channel: groupMessage(message) ? "telegram_group" : "telegram_private"
      }).catch(() => null);
      await sendTelegramText(
        message,
        [
          `Your Nemotron balance is ${balanceValue(balance)} AI message credit${balanceValue(balance) === "1" ? "" : "s"}.`,
          allowance ? `Free allowance: ${allowance.remaining} of ${allowance.freeLimit} request${allowance.freeLimit === 1 ? "" : "s"} remaining per ${allowance.windowSeconds === 60 ? "minute" : `${allowance.windowSeconds} seconds`} (sliding window).` : null,
          `After the free allowance, each successful AI prompt costs ${aiChatStarCost()} credit${aiChatStarCost() === 1 ? "" : "s"}. Use /topup or /redeem.`
        ].filter(Boolean).join("\n\n")
      );
      return true;
    }
    case "voucher":
      await sendTelegramText(message, "Redeem a voucher with /redeem CODE. Voucher credits are added atomically to your Nemotron balance.");
      return true;
    case "redeem": {
      if (!command.argument) {
        await sendTelegramText(message, "Usage: /redeem NVID-XXXX-XXXX-XXXX-XXXX");
        return true;
      }
      try {
        const result = await getPlatformStore()?.redeemVoucher?.({ userId: message.from?.id, code: command.argument });
        if (!result) throw new Error("Voucher redemption is temporarily unavailable");
        await sendTelegramText(message, `Voucher redeemed: ${result.creditsAdded} credits added.\nCurrent balance: ${result.balance}`);
      } catch (error) {
        await sendTelegramText(message, String(error?.message || "Voucher redemption failed.").slice(0, 300));
      }
      return true;
    }
    case "topup": {
      const amount = parseStarTopupAmount(command.argument);
      if (!amount) {
        await sendTelegramText(
          message,
          `Usage: /topup <amount>\nChoose any whole amount from ${MIN_STAR_TOPUP} to ${MAX_STAR_TOPUP}. Example: /topup 25`
        );
        return true;
      }
      await sendTopupOffer(message, amount);
      return true;
    }
    case "terms":
      await sendTelegramText(message, telegramStarTerms(undefined, aiChatStarCost()));
      return true;
    case "paysupport":
    case "support":
      await sendPaymentSupport(message, command.argument);
      return true;
    case "ban": {
      const adminError = assertTelegramAdmin(message);
      if (adminError) {
        await sendTelegramText(message, adminError);
        return true;
      }
      const [targetUserId, ...reasonParts] = command.argument.split(/\s+/).filter(Boolean);
      if (!targetUserId) {
        await sendTelegramText(message, "Usage: /ban <telegram-user-id> [reason]");
        return true;
      }
      const reason = reasonParts.join(" ") || "Banned by administrator";
      const result = await requireStarLedger().setUserBan(targetUserId, true, reason);
      await sendTelegramText(message, `User ${result.userId} is banned from Nemotron.\nReason: ${result.banReason}`);
      return true;
    }
    case "unban": {
      const adminError = assertTelegramAdmin(message);
      if (adminError) {
        await sendTelegramText(message, adminError);
        return true;
      }
      const targetUserId = command.argument.split(/\s+/).filter(Boolean)[0];
      if (!targetUserId) {
        await sendTelegramText(message, "Usage: /unban <telegram-user-id>");
        return true;
      }
      const result = await requireStarLedger().setUserBan(targetUserId, false, null);
      await sendTelegramText(message, `User ${result.userId} can use Nemotron again.`);
      return true;
    }
    case "starbalance":
      await sendAdminStarBalance(message);
      return true;
    case "whoami":
      await sendTelegramText(message, whoAmIText(message));
      return true;
    default:
      await sendTelegramText(message, `Unknown command /${command.name}.\n\n${helpText()}`);
      return true;
  }
}

export async function handleTelegram(update) {
  try {if(await getGroupManager().handle(update)) return;}
  catch(error) {
    if(update?.callback_query?.data?.startsWith("gm:")) {
      await telegramApi("answerCallbackQuery",{callback_query_id:update.callback_query.id,text:error instanceof Defer?"Busy; try again shortly.":"Action unavailable; no access granted."}).catch(()=>undefined);
      return;
    }
    if(update?.message?.chat?.type==="private" && ["My Groups","👥 My Groups"].includes(update.message.text)) return;
    // Fail open for ordinary content; the isolated queue never replaces credits.
    logger.warn("group_manager.ingress_unavailable",{reason:"processing_failed"});
  }
  let context = await resolveTelegramContext(update);
  const store = getPlatformStore();
  if (update?.my_chat_member?.chat && getPlatformStore()?.upsertTelegramGroup) {
    const member = update.my_chat_member.new_chat_member;
    await getPlatformStore().upsertTelegramGroup({ chat: update.my_chat_member.chat, botMember: member }).catch((error) => {
      logger.error("telegram.bot_group_membership_sync_failed", { error, chatId: update.my_chat_member.chat.id });
    });
    return;
  }
  if (update?.chat_member?.chat && getPlatformStore()?.syncGroupMember) {
    await getPlatformStore().upsertTelegramGroup?.({ chat: update.chat_member.chat }).catch(() => undefined);
    await getPlatformStore().syncGroupMember({ chatId: update.chat_member.chat.id, member: update.chat_member.new_chat_member }).catch((error) => {
      logger.error("telegram.group_member_sync_failed", { error, chatId: update.chat_member.chat.id });
    });
    return;
  }
  if (update?.business_connection) {
    await handleBusinessConnectionUpdate(update.business_connection);
    return;
  }
  if (update?.deleted_business_messages) {
    const deleted = update.deleted_business_messages;
    await store?.markBusinessMessagesDeleted?.({
      connectionId: deleted.business_connection_id,
      chatId: deleted.chat.id,
      messageIds: deleted.message_ids
    }).catch((error) => logger.error("telegram.business_messages_delete_sync_failed", { error }));
    return;
  }
  if (update?.pre_checkout_query) {
    await handleTelegramPreCheckout(update.pre_checkout_query);
    return;
  }
  if (await handleSecretaryAccessCallback(update?.callback_query)) return;
  if (await handleCaptchaCallback(update?.callback_query)) return;
  if (await handleStarPurchaseCallback(update?.callback_query)) return;
  if (await handleGuardCallback(update?.callback_query)) return;
  if (await handleTelegramInlineQuery(update?.inline_query)) return;
  if (await handleTelegramJoinRequest(update?.chat_join_request)) return;
  if (update?.managed_bot) {
    await store?.syncUserProfile?.(update.managed_bot.user).catch(() => undefined);
    await store?.saveCapabilityVerification?.({
      capabilityKey: "bot_management",
      status: "active",
      metadata: { managedBotObserved: true }
    }).catch(() => undefined);
    logger.info("telegram.managed_bot_observed", { ownerUserId: update.managed_bot.user?.id, managedBotId: update.managed_bot.bot?.id });
    return;
  }

  const message = context.message;
  if (!message) return;
  let businessConnection = null;
  if (["business_message", "edited_business_message"].includes(context.updateType)) {
    businessConnection = await businessConnectionForMessage(message);
    if (businessConnection && store?.ensureSecretaryAccess) {
      businessConnection = await store.ensureSecretaryAccess({
        connectionId: businessConnection.connectionId,
        ownerUserId: businessConnection.ownerUserId,
        primaryAdminId: telegramAdminUserId()
      }).catch(() => businessConnection);
    }
    context = { ...context, businessConnection, effectiveBillingOwnerUserId: businessConnection?.ownerUserId || context.effectiveBillingOwnerUserId };
    await observeBusinessMessage(message, context, businessConnection);
    if (context.updateType === "edited_business_message") return;
    const contactSettings = businessConnection
      ? await store?.getSecretaryContactSettings?.(businessConnection.connectionId, message.chat.id).catch(() => null)
      : null;
    if (!businessConnection?.enabled || !businessConnection.canReply || !businessConnection.accessActive || !businessConnection.autoReplyEnabled || contactSettings?.autoReplyEnabled === false) {
      logger.info("telegram.business_message_ignored", {
        connectionId: message.business_connection_id,
        reason: !businessConnection?.enabled ? "connection_disabled"
          : !businessConnection?.canReply ? "missing_business_reply_right"
            : !businessConnection?.accessActive ? "secretary_access_inactive"
              : contactSettings?.autoReplyEnabled === false ? "secretary_contact_auto_reply_disabled" : "secretary_auto_reply_disabled"
      });
      return;
    }
  }
  await observeTelegramContext(message, context);
  if (["edited_message", "channel_post", "edited_channel_post"].includes(context.updateType)) return;
  if (message?.successful_payment) {
    await handleSuccessfulStarPayment(message);
    return;
  }
  if (message?.refunded_payment) {
    await handleRefundedStarPayment(message);
    return;
  }
  if (message?.new_chat_members?.length || message?.left_chat_member) {
    const state = await getPlatformStore()?.getTelegramGroup?.(message.chat.id).catch(() => null);
    if (message.new_chat_members?.length && state?.settings?.welcomeEnabled && state.settings.welcomeMessage) {
      for (const member of message.new_chat_members) {
        await getPlatformStore()?.syncUserProfile?.(member).catch(() => undefined);
        const name = member.first_name || member.username || String(member.id);
        await sendTelegramText(message, state.settings.welcomeMessage.replaceAll("{name}", name).replaceAll("{user_id}", String(member.id)));
      }
    }
    if (message.left_chat_member && state?.settings?.goodbyeEnabled && state.settings.goodbyeMessage) {
      const member = message.left_chat_member;
      const name = member.first_name || member.username || String(member.id);
      await sendTelegramText(message, state.settings.goodbyeMessage.replaceAll("{name}", name).replaceAll("{user_id}", String(member.id)));
    }
  }
  let text = context.promptText?.trim();
  if (!text || message?.chat?.id === undefined || message?.chat?.id === null) return;

  let command = context.command;
  if (command && !command.addressedToThisBot) return;
  const groupControlCommand = groupMessage(message)
    && (command?.name?.startsWith("nvid") || ["redeem", "voucher", "balance"].includes(command?.name) || GROUP_MODERATION_COMMANDS.has(command?.name));
  if (groupMessage(message) && !context.invoked && !groupControlCommand) return;

  if (context.senderIsBot) {
    const settings = context.groupConfiguration || {};
    const allowlist = new Set((settings.botToBotAllowlist || []).map((value) => String(value).toLocaleLowerCase()));
    const senderAllowed = allowlist.has(String(message.from?.id)) || allowlist.has(String(message.from?.username || "").toLocaleLowerCase());
    if (!settings.botToBotEnabled || !senderAllowed) return;
    const interaction = await store?.recordBotInteraction?.({
      chatId: message.chat.id,
      threadId: message.message_thread_id ?? null,
      senderBotId: message.from.id,
      messageId: message.message_id,
      content: message.text,
      chainDepth: 0
    }).catch(() => ({ accepted: false }));
    if (!interaction?.accepted) return;
  }

  const accessUserId = businessConnection?.ownerUserId || message.from?.id;
  const isAdminUser = telegramUserIsAdmin(accessUserId);
  // Payment support must remain reachable even when AI access is restricted.
  // This routes only the support request, never a privileged or AI operation.
  if (["paysupport", "support"].includes(command?.name)) {
    await sendPaymentSupport(message, command.argument);
    return;
  }
  const userControl = telegramStarLedger && typeof telegramStarLedger.getUserControl === "function" && accessUserId
    ? await telegramStarLedger.getUserControl(String(accessUserId)).catch((error) => {
        logger.error("telegram.user_control_lookup_failed", { error, userId: accessUserId });
        return null;
      })
    : null;

  if (userControl?.banned && !isAdminUser) {
    await sendTelegramText(
      message,
      `Access denied. This account is banned from Nemotron.${userControl.banReason ? `\nReason: ${userControl.banReason}` : ""}\n\nUse /paysupport if you believe this is a mistake.`
    );
    return;
  }

  // /whoami deliberately remains available so an owner can discover the ID to
  // place in TELEGRAM_ALLOWED_USER_IDS without first opening access to the bot.
  if (!telegramUserIdIsAllowed(accessUserId) && command?.name !== "whoami") {
    await sendTelegramText(
      message,
      `Access denied. Telegram user ${accessUserId} is not in the configured access list.`
    );
    return;
  }

  // Button labels are data, not privileged routes. Reuse the existing command
  // handlers after fresh access checks. Pending input is bounded and isolated.
  if (message.chat.type === "private" && context.telegramTransportMode === "bot_api") {
    const inputKey = JSON.stringify([String(accessUserId), String(message.chat.id), message.message_thread_id ?? null]);
    const buttonCommand = keyboardCommand(text);
    if (command || buttonCommand) commandInputs.clear(inputKey);
    if (buttonCommand) {
      if (keyboardLabel(text) === "Admin Panel" && !telegramUserIsAdmin(accessUserId)) {
        await sendTelegramText(message, "This command is available only to the configured bot administrator.");
        return;
      }
      const principal = store?.getUserRole ? await platformPrincipal(String(accessUserId), store) : null;
      if (["banned_user", "restricted_user"].includes(principal?.role) && !isAdminUser && keyboardLabel(text) !== "Help") {
        await sendTelegramText(message, "This platform account is not permitted to use this control.");
        return;
      }
      command = buttonCommand;
      commandInputs.remember(inputKey, text);
    } else if (!command) {
      command = commandInputs.take(inputKey, text);
    }
  }

  if (command) {
    if (groupMessage(message) && command.name.startsWith("nvid")) {
      const groupResult = await handleNvidGroupCommand(command, message, context);
      if (groupResult.handled) return;
      text = groupResult.prompt || text;
      command = null;
    }
  }

  if (command) {
    if (!isAdminUser && !(await modeEnabled("guest_chat")) && !["start", "help", "dashboard", "app", "terms", "paysupport", "support", "whoami", "balance", "redeem", "voucher"].includes(command.name)) {
      await sendTelegramText(message, "Guest Chat Mode is currently disabled. Only basic help and payment support commands are available.");
      return;
    }
    await handleTelegramCommand(command, message);
    return;
  }

  if (await requireGroupVerification(message, context)) return;

  if (groupMessage(message) && context.groupConfiguration?.enabled === false) {
    await sendTelegramText(message, "Nemotron replies are disabled in this group. A current group administrator can use /nvid_enable.");
    return;
  }

  if (!(await modeEnabled("chat"))) {
    await sendTelegramText(message, "AI Chat Mode is currently disabled by the bot administrator. Commands remain available.");
    return;
  }

  const livePlatformStore = getPlatformStore();
  if (livePlatformStore?.getUserRole && accessUserId) {
    const principal = await platformPrincipal(String(accessUserId), livePlatformStore);
    if (["banned_user", "restricted_user"].includes(principal?.role) && !isAdminUser) {
      await livePlatformStore.writeSecurityEvent?.({
        eventType: "telegram_ai_authorization_denied",
        severity: "high",
        userId: String(accessUserId),
        metadata: { role: principal.role, runtimeMode: context.effectiveRuntimeMode }
      });
      await sendTelegramText(message, "This platform account is not permitted to use AI chat.");
      return;
    }
  }

  const chatKey = telegramConversationScope(message);
  if (telegramChatsInFlight.has(chatKey)) {
    await sendTelegramText(message, "I am still generating the previous answer. Please wait for it to finish.");
    return;
  }

  const platformStore = getPlatformStore();
  const leaseOwnerId = crypto.randomUUID();
  const leaseKey = `ai:telegram:${chatKey}`;
  let durableLease = null;
  if (platformStore?.acquireLease) {
    durableLease = await platformStore.acquireLease({ key: leaseKey, ownerId: leaseOwnerId, ttlMs: 300_000 });
    if (!durableLease.acquired) {
      await sendTelegramText(message, "I am still generating the previous answer. Please wait for it to finish.");
      return;
    }
  }
  const releaseDurableLease = () => durableLease?.acquired && platformStore?.releaseLease
    ? platformStore.releaseLease({ key: leaseKey, ownerId: leaseOwnerId }).catch((error) => {
      logger.error("telegram.conversation_lease_release_failed", { error });
    })
    : Promise.resolve();

  telegramChatsInFlight.add(chatKey);
  const reservationPrefix = context.telegramTransportMode === "bot_api" ? "telegram" : context.telegramTransportMode;
  const reservationId = `${reservationPrefix}:${message.business_connection_id || message.guest_query_id || message.chat.id}:${message.message_id ?? update.update_id ?? "unknown"}`;
  const unlimitedCredits = aiEntitlement({ userId: accessUserId, userControl }).unlimited;
  let usage;
  try {
    usage = await reserveAiUsage({
      ownerUserId: String(accessUserId),
      subjectUserId: context.telegramTransportMode === "telegram_secretary" ? String(message.from?.id || accessUserId) : null,
      reservationId,
      channel: aiUsageChannel(context, message),
      groupId: groupMessage(message) ? String(message.chat.id) : null,
      businessConnectionId: message.business_connection_id || null,
      conversationKey: chatKey,
      unlimited: unlimitedCredits
    });
    usage.reservationId = reservationId;
    if (!usage.allowed) {
      telegramChatsInFlight.delete(chatKey);
      await releaseDurableLease();
      if (usage.duplicate) return;
      if (!limitNotices.shouldNotify(`${accessUserId}:${aiUsageChannel(context, message)}`, usage.allowance?.resetAt)) return;
      await deliverTelegramAiAnswer(
        context, message,
        "Free limit reached. Try again when the window resets, or use /topup or /redeem."
      );
      return;
    }
  } catch (error) {
    telegramChatsInFlight.delete(chatKey);
    await releaseDurableLease();
    logger.error("telegram.usage_reservation_failed", { error, reservationId });
    await deliverTelegramAiAnswer(context, message, "Usage controls are temporarily unavailable. You were not charged; please try again later.");
    return;
  }

  const creditReserved = usage.creditReserved === true;

  // Start feedback before independent settings/history reads and routing.
  if (context.telegramTransportMode !== "guest") {
    void telegramApi("sendChatAction", {
      chat_id: message.chat.id, action: "typing",
      ...messageBusinessPayload(message), ...messageThreadPayload(message)
    }).catch(() => undefined);
  }

  const isPrivateChat = message.chat.type === "private";
  const groupConfiguration = context.groupConfiguration || null;
  let model = preferredTelegramModel(message, userControl);
  if (groupMessage(message) && groupConfiguration?.groupModel) {
    try { model = selectModel(groupConfiguration.groupModel); } catch { /* retain the working user/default model */ }
  }
  const settings = await currentModeSettings();
  let activeAssistantMode = selectedAssistantMode(userControl, settings);
  const groupMode = context.groupConfiguration?.defaultMode;
  if (groupMode && ASSISTANT_MODE_DEFINITIONS[groupMode] && settings[groupMode] !== false) activeAssistantMode = groupMode;
  let systemPrompt = assistantSystemPrompt({ mode: activeAssistantMode, persona: assistantPreferences(userControl) });
  let secretaryProfile = null;
  let secretaryContactSettings = null;
  if (context.telegramTransportMode === "telegram_secretary" && context.businessConnection) {
    const store = getPlatformStore();
    const [contactSettings, recentContactMessages] = await Promise.all([
      store?.getSecretaryContactSettings?.(message.business_connection_id, message.chat.id).catch(() => null),
      store?.listObservedMessages?.({
        chatId: message.chat.id, transportMode: "telegram_secretary",
        businessConnectionId: message.business_connection_id, limit: 12
      }).catch(() => [])
    ]);
    secretaryContactSettings = contactSettings;
    secretaryProfile = adaptiveSecretaryProfile({
      message: text,
      recentLanguages: (recentContactMessages || []).slice(0, -1).reverse().map((item) => detectMessageLanguage(item.content || "", { telegramLanguageCode: message.from?.language_code })),
      telegramLanguageCode: message.from?.language_code,
      defaultLanguage: context.businessConnection.defaultLanguage,
      languageOverride: secretaryContactSettings?.languageOverride,
      ownerStyle: context.businessConnection.businessStyle,
      customStyle: context.businessConnection.customStyle,
      accountName: context.platformUser?.displayName || context.platformUser?.username || "the connected account",
      introductionRequired: secretaryContactSettings?.introductionSent !== true
    });
    systemPrompt = `${secretaryProfile.systemPrompt}\n\n${systemPrompt}`;
  } else if (groupMessage(message)) {
    systemPrompt = [
      systemPrompt,
      groupConfiguration?.groupLanguage && groupConfiguration.groupLanguage !== "auto" ? `Reply primarily in ${groupConfiguration.groupLanguage}.` : "Adapt to the invoking message language.",
      groupConfiguration?.groupTone ? `Use a ${groupConfiguration.groupTone} group tone.` : "",
      groupConfiguration?.groupInstructions || "",
      Array.isArray(groupConfiguration?.allowedTopics) && groupConfiguration.allowedTopics.length ? `Stay within these configured group topics: ${groupConfiguration.allowedTopics.join(", ")}.` : ""
    ].filter(Boolean).join("\n");
  }
  const draftId = telegramDraftId(update, message);
  let streamedText = "";
  let lastDraftAt = 0;
  let lastDraftText = "";
  let draftAvailable = isPrivateChat && context.telegramTransportMode !== "guest";
  let draftQueue = Promise.resolve();
  let groupStream = null;
  let responseProduced = false;
  let imageDelivered = false;
  const generationStartedAt = Date.now();

  const sendTyping = () => telegramApi("sendChatAction", {
    chat_id: message.chat.id,
    action: "typing",
    ...messageBusinessPayload(message),
    ...messageThreadPayload(message)
  }).catch(() => undefined);

  groupStream = await beginTelegramGroupStream(context, message).catch((error) => {
    logger.warn("telegram.group_stream_start_failed", { error, chatId: message.chat.id });
    return null;
  });
  const typingTimer = context.telegramTransportMode === "guest" ? null : setInterval(() => void sendTyping(), 4000);
  typingTimer?.unref?.();

  const queueDraft = (force = false) => {
    if (!draftAvailable || !streamedText) return draftQueue;
    const now = Date.now();
    if (!force && now - lastDraftAt < DRAFT_INTERVAL_MS) return draftQueue;
    const draftText = Array.from(streamedText).slice(0, 4096).join("");
    if (!draftText || draftText === lastDraftText) return draftQueue;
    lastDraftAt = now;
    lastDraftText = draftText;
    draftQueue = draftQueue.then(async () => {
      try {
        await telegramApi("sendMessageDraft", {
          chat_id: message.chat.id,
          draft_id: draftId,
          text: draftText,
          ...messageBusinessPayload(message),
          ...messageThreadPayload(message)
        });
      } catch {
        // Older clients, bots without private topic mode, or transient Telegram
        // errors must not prevent delivery of the completed normal message.
        draftAvailable = false;
      }
    });
    return draftQueue;
  };

  try {
    if (creditReserved && requireStarLedger().transitionPrompt) {
      await requireStarLedger().transitionPrompt(reservationId, "generation_started");
    }
    const quoted = message.reply_to_message?.text || message.reply_to_message?.caption;
    const routedText = quoted && !message.reply_to_message?.from?.is_bot
      ? `${text}\n\nReferenced message (untrusted quoted content):\n${quoted.slice(0, 1600)}` : text;
    const prepared = await prepareIntelligentRequest({
      text: routedText, systemPrompt,
      hasImage: Boolean(message.photo?.length || message.reply_to_message?.photo?.length
        || /^image\//.test(message.document?.mime_type || "")
        || /^image\//.test(message.reply_to_message?.document?.mime_type || "")),
      allowImages: context.telegramTransportMode !== "guest"
    });
    let answer;
    if (prepared.task === "image_generate") {
      if (creditReserved) {
        const error = new Error("Paid image generation is not enabled");
        error.publicMessage = "NVIDIA image generation is available only as a free preview within your free allowance. I will not spend your Stars credits on a trial-model image request. Your reserved credits will be restored.";
        throw error;
      }
      const image = await generateNvidiaImage(text).catch((error) => {
        error.publicMessage ||= "NVIDIA's image service could not complete this request. No image was delivered and this request was not charged. No paid provider was used.";
        throw error;
      });
      const payload = new FormData();
      payload.set("chat_id", String(message.chat.id));
      payload.set("photo", new Blob([image.bytes], { type: image.mimeType }),
        image.mimeType === "image/png" ? "nvid-image.png" : "nvid-image.jpg");
      payload.set("caption", "Generated with NVIDIA FLUX.1");
      if (message.message_thread_id !== undefined) payload.set("message_thread_id", String(message.message_thread_id));
      if (message.business_connection_id) payload.set("business_connection_id", message.business_connection_id);
      if (message.message_id) payload.set("reply_parameters", JSON.stringify({ message_id: message.message_id, allow_sending_without_reply: true }));
      await telegramApi("sendPhoto", payload);
      imageDelivered = true;
      model = image.model;
      answer = "Your generated image is attached above.";
    } else {
    answer = await streamReply({
      conversationId: conversationId(message),
      text: routedText,
      model,
      temperature: groupMessage(message) ? groupConfiguration?.groupCreativity : userControl?.creativity,
      maxTokens: responseTokenLimit(groupMessage(message) ? groupConfiguration?.groupResponseLength : userControl?.responseLength),
      systemPrompt: prepared.systemPrompt,
      answerSuffix: appendLiveSources("", prepared),
      persistence: {
        userId: String(accessUserId),
        channel: context.telegramTransportMode === "telegram_secretary"
          ? "telegram_business"
          : context.telegramTransportMode === "guest" ? "telegram_guest" : "telegram",
        telegramChatId: String(message.chat.id),
        telegramThreadId: message.message_thread_id === undefined ? null : String(message.message_thread_id),
        requestId: reservationId,
        memoryEnabled: context.telegramTransportMode === "telegram_secretary"
          ? secretaryContactSettings?.memoryEnabled !== false
          : userControl?.memoryEnabled !== false
      },
      onDelta(delta) {
        streamedText += String(delta || "");
        void queueDraft(false);
        void queueTelegramGroupStream(groupStream, message, streamedText);
      }
    });
    }
    responseProduced = true;
    if (creditReserved && requireStarLedger().transitionPrompt) {
      await requireStarLedger().transitionPrompt(reservationId, "response_produced");
    }
    await queueDraft(true);
    await draftQueue;
    if (creditReserved && requireStarLedger().transitionPrompt) {
      await requireStarLedger().transitionPrompt(reservationId, "delivery_attempted");
    }
    const completedAnswer = answer || streamedText || "I could not generate a response.";
    if (!(await finishTelegramGroupStream(groupStream, message, completedAnswer)) && !imageDelivered) {
      await deliverTelegramAiAnswer(context, message, completedAnswer);
    }
    if (creditReserved && requireStarLedger().transitionPrompt) {
      await requireStarLedger().transitionPrompt(reservationId, "delivered");
    }
    if (creditReserved) {
      try {
        await requireStarLedger().completePrompt(reservationId);
      } catch (error) {
        logger.error("telegram.credit_completion_failed", { error, reservationId });
        await requireStarLedger().transitionPrompt?.(reservationId, "completion_pending", { errorCode: "ledger_completion_failed" })
          .catch((transitionError) => logger.error("telegram.credit_completion_pending_failed", { error: transitionError, reservationId }));
      }
    }
    await finishAiUsage(usage, {
      success: true,
      providerModel: model,
      providerLatencyMs: Date.now() - generationStartedAt
    }).catch((error) => logger.error("telegram.usage_completion_failed", { error, reservationId }));
    if (secretaryProfile?.introductionRequired) {
      await getPlatformStore()?.markSecretaryIntroductionSent?.(message.business_connection_id, message.chat.id).catch(() => undefined);
    }
  } catch (generationError) {
    const failureCategory = classifyAiFailure(generationError);
    if (creditReserved && responseProduced) {
      await requireStarLedger().transitionPrompt?.(reservationId, "completion_pending", { errorCode: "delivery_failed_after_response" }).catch(() => undefined);
    } else if (creditReserved) {
      try {
        await requireStarLedger().transitionPrompt?.(reservationId, "failed", { errorCode: failureCategory });
        await requireStarLedger().restorePrompt(reservationId);
      } catch (error) {
        logger.error("telegram.credit_restoration_failed", { error, reservationId });
      }
    }
    await finishAiUsage(usage, {
      success: responseProduced,
      failureCategory,
      providerModel: model,
      providerLatencyMs: Date.now() - generationStartedAt
    }).catch(() => undefined);
    logger.error("telegram.ai_generation_failed", { error: generationError, reservationId, category: failureCategory, responseProduced });
    if (groupStream) {
      await finishTelegramGroupStream(groupStream, message, generationError.publicMessage || safeAiFailureMessage(failureCategory, { secretary: context.telegramTransportMode === "telegram_secretary" })).catch(() => undefined);
    } else {
      await deliverTelegramAiAnswer(context, message, generationError.publicMessage || safeAiFailureMessage(failureCategory, { secretary: context.telegramTransportMode === "telegram_secretary" })).catch(() => undefined);
    }
  } finally {
    if (typingTimer) clearInterval(typingTimer);
    telegramChatsInFlight.delete(chatKey);
    await releaseDurableLease();
  }
}

function validateTelegramWebhookSecret(secret) {
  if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 1-256 letters, numbers, underscores, or hyphens");
  }
  return secret;
}

function telegramPublicBaseUrl() {
  const raw = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
  if (!raw) throw new Error("PUBLIC_URL or RENDER_EXTERNAL_URL is required for the Telegram webhook");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The Telegram public URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("The Telegram public URL must be a public HTTPS URL without credentials");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function telegramPublicStatus() {
  return {
    enabled: telegramStatus.enabled === true,
    configured: telegramStatus.configured === true,
    username: telegramStatus.username || null,
    displayName: telegramStatus.displayName || null,
    link: telegramStatus.link || null,
    webhookReady: telegramStatus.webhookReady === true,
    starsRequired: telegramStatus.starsRequired === true,
    starLedgerReady: telegramStatus.starLedgerReady === true,
    canJoinGroups: telegramStatus.canJoinGroups === true,
    canReadAllGroupMessages: telegramStatus.canReadAllGroupMessages === true,
    supportsInlineQueries: telegramStatus.supportsInlineQueries === true,
    supportsGuestQueries: telegramStatus.supportsGuestQueries === true,
    canConnectToBusiness: telegramStatus.canConnectToBusiness === true,
    hasMainWebApp: telegramStatus.hasMainWebApp === true,
    hasTopicsEnabled: telegramStatus.hasTopicsEnabled === true,
    canManageBots: telegramStatus.canManageBots === true,
    supportsJoinRequestQueries: telegramStatus.supportsJoinRequestQueries === true,
    lastVerifiedAt: telegramStatus.lastVerifiedAt || null
  };
}

function telegramCapabilityCard({
  id, name, description, status, nvidEnabled, requiredPermissions = [],
  connectionStatus = status, setupInstructions = null, lastVerifiedAt = null, details = {}
}) {
  return {
    id,
    name,
    description,
    telegramStatus: status,
    nvidEnabled: nvidEnabled === true,
    requiredPermissions,
    connectionStatus,
    setupInstructions,
    lastVerifiedAt,
    details
  };
}

export async function telegramCapabilities({ refresh = false } = {}) {
  if (refresh && telegramStatus.enabled) {
    const me = await telegramApi("getMe");
    telegramStatus = Object.freeze({
      ...telegramStatus,
      id: me?.id ?? telegramStatus.id ?? null,
      username: me?.username || telegramStatus.username || null,
      displayName: me?.first_name || telegramStatus.displayName || null,
      canJoinGroups: me?.can_join_groups === true,
      canReadAllGroupMessages: me?.can_read_all_group_messages === true,
      supportsInlineQueries: me?.supports_inline_queries === true,
      supportsGuestQueries: me?.supports_guest_queries === true,
      canConnectToBusiness: me?.can_connect_to_business === true,
      hasMainWebApp: me?.has_main_web_app === true,
      hasTopicsEnabled: me?.has_topics_enabled === true,
      canManageBots: me?.can_manage_bots === true,
      supportsJoinRequestQueries: me?.supports_join_request_queries === true,
      lastVerifiedAt: new Date().toISOString()
    });
  }

  const safeStatus = telegramPublicStatus();
  const modes = await currentModeSettings();
  const store = getPlatformStore();
  let groups = [];
  let businessConnections = [];
  let verifications = [];
  if (store) {
    [groups, businessConnections, verifications] = await Promise.all([
      store.listTelegramGroups?.({ limit: 250 }).catch(() => []) ?? [],
      store.listBusinessConnections?.({ limit: 250 }).catch(() => []) ?? [],
      store.listCapabilityVerifications?.().catch(() => []) ?? []
    ]);
  }
  const lastVerification = new Map(verifications.map((item) => [item.capabilityKey, item]));
  const activeGroups = groups.filter((group) => group.active);
  const administratorGroups = activeGroups.filter((group) => group.botIsAdministrator);
  const connectedBusiness = businessConnections.filter((connection) => connection.enabled);
  const verifiedAt = safeStatus.lastVerifiedAt;
  const setup = (command) => `Open @BotFather, choose this bot, run ${command}, then return here and select Verify again.`;
  const booleanCapability = (supported, enabled = true) => supported
    ? (enabled ? "active" : "disabled")
    : "setup_required";

  return {
    verifiedAt,
    bot: {
      username: safeStatus.username,
      displayName: safeStatus.displayName,
      configured: safeStatus.configured,
      webhookReady: safeStatus.webhookReady
    },
    capabilities: [
      telegramCapabilityCard({
        id: "group_access", name: "Group access", description: "Install Nemotron in groups and supergroups.",
        status: safeStatus.canJoinGroups ? "active" : "setup_required", nvidEnabled: safeStatus.canJoinGroups,
        requiredPermissions: ["BotFather group access"],
        setupInstructions: safeStatus.canJoinGroups ? null : setup("/setjoingroups"), lastVerifiedAt: verifiedAt,
        details: { knownGroups: groups.length, activeGroups: activeGroups.length }
      }),
      telegramCapabilityCard({
        id: "group_privacy", name: "Group Privacy", description: safeStatus.canReadAllGroupMessages
          ? "Telegram delivers all permitted group messages; Nemotron still enforces invocation-only replies."
          : "Telegram Privacy Mode is enabled, so the bot receives addressed commands, mentions, replies, and service updates.",
        status: safeStatus.lastVerifiedAt ? "active" : "configured_unverified",
        nvidEnabled: true, requiredPermissions: ["BotFather privacy setting"],
        connectionStatus: safeStatus.lastVerifiedAt ? "active" : "configured_unverified",
        setupInstructions: safeStatus.lastVerifiedAt ? null : setup("/setprivacy"), lastVerifiedAt: verifiedAt,
        details: { privacyModeEnabled: !safeStatus.canReadAllGroupMessages, invocationOnlyEnforcedByNvid: true }
      }),
      telegramCapabilityCard({
        id: "inline", name: "Inline Mode", description: "Use @bot_username query in supported chats.",
        status: booleanCapability(safeStatus.supportsInlineQueries, modes.inline !== false), nvidEnabled: modes.inline !== false,
        requiredPermissions: ["BotFather Inline Mode"], setupInstructions: safeStatus.supportsInlineQueries ? null : setup("/setinline"), lastVerifiedAt: verifiedAt
      }),
      telegramCapabilityCard({
        id: "guest", name: "Guest Mode", description: "Answer explicit Telegram guest queries when Telegram delivers them.",
        status: booleanCapability(safeStatus.supportsGuestQueries, modes.guest_chat !== false), nvidEnabled: modes.guest_chat !== false,
        requiredPermissions: ["BotFather Guest Mode"], setupInstructions: safeStatus.supportsGuestQueries ? null : setup("/setguestmode"), lastVerifiedAt: verifiedAt
      }),
      telegramCapabilityCard({
        id: "telegram_secretary", name: "Telegram Secretary Mode", description: "Operate through connected Telegram Business accounts. This is separate from Group Secretary.",
        status: !safeStatus.canConnectToBusiness ? "setup_required" : connectedBusiness.length ? "connected" : "not_connected",
        nvidEnabled: modes.secretary !== false, requiredPermissions: ["Telegram Business connection", "Reply permission"],
        connectionStatus: connectedBusiness.length ? "connected" : "not_connected",
        setupInstructions: safeStatus.canConnectToBusiness ? "Connect Nemotron from Telegram Business chatbot settings." : setup("/business"),
        lastVerifiedAt: connectedBusiness[0]?.lastVerifiedAt || verifiedAt,
        details: { connectedAccounts: connectedBusiness.length, groupSecretaryConfiguredSeparately: true }
      }),
      telegramCapabilityCard({
        id: "bot_management", name: "Bot Management", description: "Manage explicitly connected bot profiles with encrypted credentials.",
        status: safeStatus.canManageBots ? "active" : (lastVerification.get("bot_management") ? "configured_unverified" : "setup_required"),
        nvidEnabled: modes.bot_management !== false, requiredPermissions: ["BotFather or Telegram managed-bot capability"],
        setupInstructions: safeStatus.canManageBots ? null : "Enable bot management for this bot in BotFather where available, then verify again.", lastVerifiedAt: lastVerification.get("bot_management")?.verifiedAt || verifiedAt,
        details: { managedBots: null }
      }),
      telegramCapabilityCard({
        id: "bot_to_bot", name: "Bot-to-Bot Mode", description: "Controlled interaction with allowlists, duplicate detection and chain limits.",
        status: modes.bot_to_bot === false ? "disabled" : "configured_unverified", nvidEnabled: modes.bot_to_bot !== false,
        requiredPermissions: ["Per-group enablement", "Bot allowlist"], lastVerifiedAt: lastVerification.get("bot_to_bot")?.verifiedAt || null
      }),
      telegramCapabilityCard({
        id: "guard", name: "Guard Mode", description: "Review Telegram group join requests when Nemotron has the required group rights.",
        status: safeStatus.supportsJoinRequestQueries ? (administratorGroups.length ? "active" : "permission_required") : "configured_unverified",
        nvidEnabled: modes.guard !== false, requiredPermissions: ["Group administrator", "Invite users"],
        connectionStatus: administratorGroups.length ? "active" : "permission_required", lastVerifiedAt: verifiedAt,
        details: { administratorGroups: administratorGroups.length }
      }),
      telegramCapabilityCard({
        id: "threads", name: "Thread and Topic Mode", description: "Keep AI and Secretary context isolated by Telegram topic.",
        status: safeStatus.hasTopicsEnabled || groups.some((group) => group.chatType === "supergroup") ? "active" : "configured_unverified",
        nvidEnabled: modes.threaded !== false, requiredPermissions: ["Forum topics where used"], lastVerifiedAt: verifiedAt,
        details: { threadIsolation: true }
      }),
      telegramCapabilityCard({
        id: "mini_app", name: "Mini App", description: "Authenticated Telegram-native user and administration interface.",
        status: safeStatus.hasMainWebApp ? "active" : "configured_unverified", nvidEnabled: true,
        requiredPermissions: ["BotFather Main App or Menu Button"],
        setupInstructions: safeStatus.hasMainWebApp ? null : setup("/newapp"), lastVerifiedAt: verifiedAt
      }),
      telegramCapabilityCard({
        id: "payments", name: "Telegram Stars", description: "One-credit billing and Telegram Stars top-ups.",
        status: safeStatus.starLedgerReady ? "active" : "unavailable", nvidEnabled: safeStatus.starsRequired,
        requiredPermissions: ["Telegram Stars payments"], lastVerifiedAt: verifiedAt
      })
    ]
  };
}

export async function telegramDashboardState({ userId } = {}) {
  const resolvedUserId = userId === undefined || userId === null || userId === "" ? null : String(userId);
  const isAdmin = telegramUserIsAdmin(resolvedUserId);
  const modes = await currentModeSettings();
  let balance = null;
  let userControl = null;
  let stats = null;

  if (telegramStarLedger && resolvedUserId) {
    userControl = await telegramStarLedger.getUserControl(resolvedUserId);
    balance = await telegramStarLedger.getBalance(resolvedUserId);
  }
  if (isAdmin && telegramStarLedger) {
    stats = await telegramStarLedger.getStats();
  }

  return {
    userId: resolvedUserId,
    isAdmin,
    unlimitedCredits: aiEntitlement({ userId: resolvedUserId, userControl }).unlimited,
    balance: balance?.balance ?? null,
    banned: userControl?.banned === true,
    banReason: userControl?.banReason ?? null,
    persona: userControl?.persona ?? null,
    preferredModel: userControl?.preferredModel ?? null,
    preferredLanguage: userControl?.preferredLanguage || "auto",
    responseLength: userControl?.responseLength || "balanced",
    creativity: userControl?.creativity ?? 0.4,
    memoryEnabled: userControl?.memoryEnabled !== false,
    customInstructions: userControl?.customInstructions ?? null,
    selectedMode: selectedAssistantMode(userControl, modes),
    assistantModes: assistantModeList(modes),
    modes: Object.fromEntries(Object.entries(MODE_DEFINITIONS).map(([mode, definition]) => [
      mode,
      {
        label: definition.label,
        enabled: modes[mode] !== false,
        billable: definition.billable,
        description: definition.description
      }
    ])),
    stats,
    telegram: telegramPublicStatus()
  };
}

export async function telegramBillingHistory({ userId = null, limit = 50 } = {}) {
  if (!telegramStarLedger
      || typeof telegramStarLedger.listPayments !== "function"
      || typeof telegramStarLedger.listUsage !== "function") {
    const error = new Error("Telegram billing history is temporarily unavailable");
    error.statusCode = 503;
    throw error;
  }
  const options = { userId, limit };
  const [payments, usage] = await Promise.all([
    telegramStarLedger.listPayments(options),
    telegramStarLedger.listUsage(options)
  ]);
  return { payments, usage };
}

function nvidiaHourlyRequestLimit() {
  const parsed = Number(process.env.NVIDIA_GLOBAL_REQUESTS_PER_HOUR || 300);
  return Number.isSafeInteger(parsed) && parsed >= 10 && parsed <= 1_000_000 ? parsed : 300;
}

function aiUsageChannel(context, message) {
  if (context?.telegramTransportMode === "telegram_secretary") return "telegram_secretary";
  if (context?.telegramTransportMode === "inline") return "telegram_inline";
  if (context?.telegramTransportMode === "guest") return "telegram_guest";
  if (["group", "supergroup"].includes(message?.chat?.type)) return "telegram_group";
  return "telegram_private";
}

async function reserveAiUsage({ ownerUserId, subjectUserId = null, reservationId, channel, groupId = null, businessConnectionId = null, conversationKey = null, unlimited = false } = {}) {
  const store = getPlatformStore();
  let exhaustedAllowance = null;
  if (unlimited) {
    const recorded = await store?.recordUsageReservation?.({
      idempotencyKey: reservationId,
      ownerUserId,
      subjectUserId,
      channel,
      billingSource: "unlimited",
      creditCost: 0,
      groupId,
      businessConnectionId,
      conversationKey
    });
    if (recorded && recorded.recorded === false) return { allowed: false, duplicate: true, billingSource: "unlimited" };
    return { allowed: true, billingSource: "unlimited", creditReserved: false };
  }

  if (store?.reserveFreeUsage) {
    const free = await store.reserveFreeUsage({
      idempotencyKey: reservationId,
      ownerUserId,
      subjectUserId,
      channel,
      groupId,
      businessConnectionId,
      conversationKey
    });
    if (free?.duplicate) return { allowed: false, duplicate: true, status: free.status, billingSource: free.billing_source };
    if (free?.reserved) return { allowed: true, billingSource: "free", creditReserved: false, allowance: free };
    if (free?.exhausted) exhaustedAllowance = free;
  }

  if (!telegramStarsRequired()) {
    const recorded = await store?.recordUsageReservation?.({
      idempotencyKey: reservationId,
      ownerUserId,
      subjectUserId,
      channel,
      billingSource: "unlimited",
      creditCost: 0,
      groupId,
      businessConnectionId,
      conversationKey
    });
    if (recorded && recorded.recorded === false) return { allowed: false, duplicate: true, billingSource: "unlimited" };
    return { allowed: true, billingSource: "unlimited", creditReserved: false };
  }

  const ledger = requireStarLedger();
  const promptCost = aiChatStarCost();
  const reservation = await ledger.reservePrompt(String(ownerUserId), { reservationId, cost: promptCost });
  if (!reservation?.reserved) {
    const duplicate = ["reserved", "generation_started", "response_produced", "delivery_attempted", "delivered", "completion_pending", "completed", "restored", "failed"].includes(reservation?.state);
    return { allowed: false, duplicate, promptCost, reservation, allowance: exhaustedAllowance };
  }
  try {
    await store?.recordUsageReservation?.({
      idempotencyKey: reservationId,
      ownerUserId,
      subjectUserId,
      channel,
      billingSource: "credit",
      creditCost: promptCost,
      groupId,
      businessConnectionId,
      conversationKey
    });
  } catch (error) {
    await ledger.restorePrompt(reservationId).catch(() => undefined);
    throw error;
  }
  return { allowed: true, billingSource: "credit", creditReserved: true, promptCost };
}

async function finishAiUsage(usage, { success, failureCategory = null, providerModel = null, providerLatencyMs = null } = {}) {
  if (!usage?.reservationId) return;
  await getPlatformStore()?.finishUsageEvent?.(usage.reservationId, {
    success,
    failureCategory,
    providerModel,
    providerLatencyMs
  });
}

export async function reserveTelegramWebAiUsage({ userId, requestId, model } = {}) {
  const resolvedUserId = String(userId ?? "");
  if (!/^[1-9]\d*$/.test(resolvedUserId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(requestId || ""))) {
    return { allowed: false, status: 400, error: "A valid authenticated request ID is required" };
  }
  if (!(await modeEnabled("chat"))) {
    return { allowed: false, status: 403, error: "AI Chat Mode is currently disabled" };
  }
  if (!telegramStarLedger
      || typeof telegramStarLedger.getUserControl !== "function"
      || typeof telegramStarLedger.reserveProviderCapacity !== "function") {
    return { allowed: false, status: 503, error: "AI usage controls are temporarily unavailable" };
  }

  const userControl = await telegramStarLedger.getUserControl(resolvedUserId);
  const modeSettings = await currentModeSettings();
  const activeAssistantMode = selectedAssistantMode(userControl, modeSettings);
  const isAdmin = telegramUserIsAdmin(resolvedUserId);
  if (userControl?.banned && !isAdmin) {
    return { allowed: false, status: 403, error: "This account is not permitted to use Nemotron" };
  }

  const reservationId = `web:${resolvedUserId}:${requestId}`;
  const entitlement = aiEntitlement({ userId: resolvedUserId, userControl });
  const unlimitedCredits = entitlement.unlimited;
  const usage = await reserveAiUsage({
    ownerUserId: resolvedUserId,
    reservationId,
    channel: "web",
    conversationKey: `web:${resolvedUserId}`,
    unlimited: unlimitedCredits
  });
  usage.reservationId = reservationId;
  if (!usage.allowed) {
    return {
      allowed: false,
      status: usage.duplicate ? 409 : 402,
      error: usage.duplicate
        ? "This AI request has already been processed"
        : `Your free allowance is finished. You need ${usage.promptCost || aiChatStarCost()} AI credit. Current balance: ${balanceValue(usage.reservation)}`
    };
  }
  const creditReserved = usage.creditReserved === true;

  try {
    const providerBudget = await telegramStarLedger.reserveProviderCapacity({
      providerKey: "nvidia",
      limit: nvidiaHourlyRequestLimit(),
      cost: model === "nvidia/llama-3.3-nemotron-super-49b-v1.5" ? 2 : 1,
      windowSeconds: 3600
    });
    if (!providerBudget?.reserved) {
      if (creditReserved) await telegramStarLedger.restorePrompt(reservationId);
      await finishAiUsage(usage, { success: false, failureCategory: "provider_quota_exhausted", providerModel: model });
      return { allowed: false, status: 429, error: "The NVIDIA hourly safety limit has been reached. Try again later." };
    }
  } catch (error) {
    if (creditReserved) await telegramStarLedger.restorePrompt(reservationId).catch(() => undefined);
    await finishAiUsage(usage, { success: false, failureCategory: classifyAiFailure(error), providerModel: model }).catch(() => undefined);
    throw error;
  }

  return {
    allowed: true,
    userId: resolvedUserId,
    reservationId,
    creditReserved,
    billingSource: usage.billingSource,
    model: selectModel(model),
    unlimitedCredits,
    persona: userControl?.persona ?? null,
    selectedMode: activeAssistantMode,
    memoryEnabled: userControl?.memoryEnabled !== false,
    creativity: userControl?.creativity ?? 0.4,
    maxTokens: responseTokenLimit(userControl?.responseLength),
    entitlement,
    systemPrompt: assistantSystemPrompt({ mode: activeAssistantMode, persona: assistantPreferences(userControl) })
  };
}

export async function setTelegramAssistantMode({ userId, mode } = {}) {
  const resolvedUserId = String(userId ?? "");
  if (!/^[1-9]\d*$/.test(resolvedUserId)) throw new TypeError("userId must be a Telegram user ID");
  const selectedMode = normalizeAssistantMode(mode);
  const settings = await currentModeSettings();
  if (settings[selectedMode] === false) {
    const error = new Error("That assistant mode is disabled by the administrator");
    error.statusCode = 403;
    throw error;
  }
  if (!telegramStarLedger || typeof telegramStarLedger.setUserMode !== "function") {
    const error = new Error("Assistant mode selection is temporarily unavailable");
    error.statusCode = 503;
    throw error;
  }
  return telegramStarLedger.setUserMode(resolvedUserId, selectedMode);
}

export async function completeTelegramWebAiUsage(usage) {
  if (usage?.creditReserved) await requireStarLedger().completePrompt(usage.reservationId);
  await finishAiUsage(usage, { success: true, providerModel: usage?.model }).catch(() => undefined);
}

export async function setTelegramUserAiSettings({ userId, settings } = {}) {
  const resolvedUserId = String(userId ?? "");
  if (!telegramStarLedger?.setUserAiSettings) {
    const error = new Error("User AI settings are temporarily unavailable");
    error.statusCode = 503;
    throw error;
  }
  return telegramStarLedger.setUserAiSettings(resolvedUserId, settings);
}

export async function setTelegramUserPreferredModel({ userId, model } = {}) {
  const resolvedUserId = String(userId ?? "");
  if (!telegramStarLedger?.setUserModel) return null;
  return telegramStarLedger.setUserModel(resolvedUserId, selectModel(model));
}

export async function transitionTelegramWebAiUsage(usage, state, options) {
  if (usage?.creditReserved && requireStarLedger().transitionPrompt) {
    return requireStarLedger().transitionPrompt(usage.reservationId, state, options);
  }
  return { changed: false, state: usage?.creditReserved ? "reserved" : "unlimited" };
}

export async function restoreTelegramWebAiUsage(usage) {
  if (usage?.creditReserved) await requireStarLedger().restorePrompt(usage.reservationId);
  await finishAiUsage(usage, { success: false, failureCategory: "generation_failed", providerModel: usage?.model }).catch(() => undefined);
}

export function telegramServiceReady() {
  if (!telegramPaymentsEnabled()) return true;
  const status = telegramPublicStatus();
  return status.configured && status.starLedgerReady;
}

// Startup checks local payment storage; operational readiness also checks Telegram.
// Remote profile/webhook calls must not hold the deployment startup probe hostage.
export function telegramStartupReady() {
  if (!telegramPaymentsEnabled()) return true;
  const status = telegramPublicStatus();
  return status.enabled && status.starLedgerReady;
}

export async function configureTelegramBot() {
  const starsRequired = telegramStarsRequired();
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    telegramStatus = Object.freeze({
      enabled: false,
      configured: false,
      starsRequired,
      starLedgerReady: false
    });
    return telegramPublicStatus();
  }

  let starLedgerReady = false;
  telegramStatus = Object.freeze({
    enabled: true,
    configured: false,
    state: "configuring",
    starsRequired,
    starLedgerReady
  });
  try {
    telegramToken();
    const secret = validateTelegramWebhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET?.trim());
    starLedgerReady = await initializeTelegramStars();
    telegramStatus = Object.freeze({ ...telegramStatus, starLedgerReady });
    logger.info("telegram.local_initialization.ready", { starLedgerReady });
    const deadlineAt = Date.now() + 60_000;
    const setupApi = (method, payload) => telegramApi(method, payload, { deadlineAt });
    const updateProfile = async (method, payload) => {
      try {
        await telegramApi(method, payload, { deadlineAt: Math.min(deadlineAt, Date.now() + 5_000) });
      } catch (error) {
        // Cosmetic changes can hit long per-bot limits. Never block webhook setup.
        logger.warn("telegram.profile_update_skipped", { method, statusCode: error.statusCode, retryAfter: error.retryAfter });
      }
    };
    const webhookUrl = `${telegramPublicBaseUrl()}/webhooks/telegram`;
    const me = await setupApi("getMe");
    if (me?.first_name !== "Nemotron") await updateProfile("setMyName", { name: "Nemotron" });
    await updateProfile("setMyShortDescription", {
      short_description: TELEGRAM_BOT_SHORT_DESCRIPTION
    });
    await updateProfile("setMyDescription", {
      description: telegramBotDescription()
    });
    await setupApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Nemotron",
        web_app: { url: miniAppUrl() }
      }
    });
    for (const type of ["default", "all_private_chats", "all_group_chats"]) {
      await setupApi("deleteMyCommands", { scope: { type } });
    }
    await setupApi("setMyCommands", {
      commands: TELEGRAM_GROUP_ADMIN_COMMANDS,
      scope: { type: "all_chat_administrators" }
    });
    if (telegramAdminUserId()) {
      await setupApi("setMyCommands", {
        commands: TELEGRAM_COMMANDS,
        scope: { type: "chat", chat_id: telegramAdminUserId() }
      });
    }
    await setupApi("setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
      max_connections: 10
    });
    const webhook = await setupApi("getWebhookInfo");
    const webhookMatches = webhook?.url === webhookUrl;

    telegramStatus = Object.freeze({
      enabled: true,
      configured: webhookMatches,
      id: me?.id ?? null,
      username: me?.username || null,
      displayName: me?.first_name || null,
      link: me?.username ? `https://t.me/${me.username}` : null,
      webhookReady: webhookMatches,
      starsRequired,
      starLedgerReady,
      pendingUpdates: Number(webhook?.pending_update_count || 0),
      lastWebhookError: webhook?.last_error_message || null,
      canJoinGroups: me?.can_join_groups === true,
      canReadAllGroupMessages: me?.can_read_all_group_messages === true,
      supportsInlineQueries: me?.supports_inline_queries === true,
      supportsGuestQueries: me?.supports_guest_queries === true,
      canConnectToBusiness: me?.can_connect_to_business === true,
      hasMainWebApp: me?.has_main_web_app === true,
      hasTopicsEnabled: me?.has_topics_enabled === true,
      canManageBots: me?.can_manage_bots === true,
      supportsJoinRequestQueries: me?.supports_join_request_queries === true,
      lastVerifiedAt: new Date().toISOString()
    });
    return telegramPublicStatus();
  } catch (error) {
    telegramStatus = Object.freeze({
      enabled: true,
      configured: false,
      starsRequired,
      starLedgerReady,
      error: error instanceof Error ? error.message : "Telegram setup failed"
    });
    throw error;
  }
}

export function validMetaSignature(rawBody, signature) {
  if (!process.env.META_APP_SECRET || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(rawBody).digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function handleWhatsApp(payload) {
  const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const text = message?.text?.body?.trim();
  if (!text || !message?.from) return;

  const answer = await reply({ conversationId: `whatsapp:${message.from}`, text });
  const version = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: message.from,
      type: "text",
      text: { body: answer.slice(0, 4096) }
    })
  });
  if (!response.ok) throw new Error(`WhatsApp returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
}
