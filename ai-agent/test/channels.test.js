import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createStarPurchasePayload } from "../src/starPayments.js";
import { createSecretaryActivationPayload } from "../src/secretaryPayments.js";
import {
  configureTelegramBot,
  deliverDueSecretaryReminders,
  executeTelegramModerationAction,
  handleTelegramPreCheckout,
  handleTelegram,
  setTelegramStarLedgerForTests,
  splitTelegramText,
  telegramApi,
  telegramGroupPermissionState,
  telegramPublicStatus,
  telegramServiceReady,
  telegramUpdateRequiresSynchronousAck,
  validMetaSignature
} from "../src/channels.js";
import { setPlatformStoreForTests } from "../src/platformRuntime.js";

const originalFetch = global.fetch;
const ENV_NAMES = [
  "META_APP_SECRET",
  "NVIDIA_API_KEY",
  "NVIDIA_AUTO_TOOLS",
  "NVIDIA_BASE_URL",
  "NVIDIA_MODEL",
  "NVIDIA_MODELS",
  "PUBLIC_URL",
  "RENDER_EXTERNAL_URL",
  "DATABASE_URL",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_ADMIN_USER_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_STAR_SIGNING_SECRET",
  "TELEGRAM_STARS_REQUIRED",
  "TELEGRAM_PAYMENTS_ENABLED",
  "SESSION_SECRET",
  "TELEGRAM_WEBHOOK_SECRET"
];
const originalEnvironment = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function restoreEnvironment() {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  global.fetch = originalFetch;
  setTelegramStarLedgerForTests(null);
  setPlatformStoreForTests(null);
}

test.afterEach(restoreEnvironment);
// These doubles return the final response; routing has its own focused tests.
test.beforeEach(() => { process.env.NVIDIA_AUTO_TOOLS = "false"; });

function telegramSuccess(result = true) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function telegramUpdate({ text, userId = 123, chatId = 456, type = "private", messageId = 7, updateId = 9, threadId }) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: userId, first_name: "Ada" },
      chat: { id: chatId, type },
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      text
    }
  };
}

function starLedgerDouble(overrides = {}) {
  return {
    async init() {},
    async acceptTerms() {},
    async hasAcceptedTerms() { return true; },
    async creditPayment({ userId, amount }) { return { credited: true, userId: String(userId), amount, balance: String(amount) }; },
    async recordRefund() { return { changed: false, balance: null, deductedAmount: "0", payment: null }; },
    async getBalance(userId) { return { userId: String(userId), balance: "0" }; },
    async reservePrompt(userId, { reservationId, cost }) {
      return { reserved: false, changed: false, userId: String(userId), reservationId, cost, state: null, balance: "0" };
    },
    async completePrompt() {},
    async restorePrompt() {},
    async refundStaleReservations() { return { restoredCount: 0, refundedAmount: "0" }; },
    async getStats() { return { totalBalance: "0", paymentCount: "0", completedPrompts: "0" }; },
    async getModeSettings(defaultModes) { return { ...defaultModes }; },
    async setModeEnabled(mode, enabled) { return { mode, enabled, updatedAt: new Date() }; },
    async getUserControl(userId) { return { userId: String(userId), banned: false, banReason: null, unlimitedCredits: false, persona: null, selectedMode: "chat" }; },
    async setUserBan(userId, banned, reason) { return { userId: String(userId), banned, banReason: reason, unlimitedCredits: false, persona: null }; },
    async setUserPersona(userId, persona) { return { userId: String(userId), banned: false, banReason: null, unlimitedCredits: false, persona }; },
    async setUserMode(userId, selectedMode) { return { userId: String(userId), banned: false, unlimitedCredits: false, persona: null, selectedMode }; },
    ...overrides
  };
}

function groupStoreDouble(overrides = {}) {
  return {
    async upsertTelegramGroup({ chat }) {
      return { id: String(chat.id), chatType: chat.type, active: true, botIsAdministrator: true };
    },
    async getTelegramGroup(chatId) {
      return {
        group: { id: String(chatId), chatType: "supergroup", active: true, botIsAdministrator: true },
        settings: {
          enabled: true,
          activationPolicy: "mention_only",
          defaultMode: "chat",
          secretaryEnabled: false,
          botToBotEnabled: false,
          threadIsolationEnabled: true
        },
        permissions: null
      };
    },
    async syncUserProfile() {},
    ...overrides
  };
}

function enableStarTestEnvironment() {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_STARS_REQUIRED = "true";
  process.env.TELEGRAM_ADMIN_USER_ID = "6643462826";
  process.env.TELEGRAM_STAR_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
}

test("validates Meta webhook signatures", () => {
  process.env.META_APP_SECRET = "test-secret";
  const body = Buffer.from('{"ok":true}');
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  assert.equal(validMetaSignature(body, signature), true);
  assert.equal(validMetaSignature(body, "sha256=bad"), false);
});

test("splits Telegram text without breaking Unicode code points", () => {
  const text = "😀".repeat(4001);
  const chunks = splitTelegramText(text);
  assert.deepEqual(chunks.map((chunk) => Array.from(chunk).length), [4000, 1]);
  assert.equal(chunks.join(""), text);
  assert.equal(chunks.some((chunk) => chunk.includes("�")), false);
});

test("Telegram API helper retries a 429 once using retry_after", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 0 }
      }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return telegramSuccess({ id: 1, username: "nvidbot" });
  };

  const result = await telegramApi("getMe");
  assert.equal(requests, 2);
  assert.equal(result.username, "nvidbot");
});

test("Telegram API helper does not retry past a shared deadline", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 10 }
    }), { status: 429, headers: { "content-type": "application/json" } });
  };

  const startedAt = Date.now();
  await assert.rejects(
    telegramApi("answerPreCheckoutQuery", {}, { deadlineAt: Date.now() + 50 }),
    /429/
  );
  assert.equal(requests, 1);
  assert.ok(Date.now() - startedAt < 500);
});

test("configures Telegram commands and a protected Render webhook", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_ADMIN_USER_ID = "123";
  process.env.TELEGRAM_WEBHOOK_SECRET = "valid_secret-123";
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com/";
  const calls = [];
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload });
    if (method === "getMe") return telegramSuccess({ id: 101, is_bot: true, first_name: "NvidBot", username: "NvidBotAI" });
    if (method === "getWebhookInfo") {
      return telegramSuccess({ url: "https://nvidbot.onrender.com/webhooks/telegram", pending_update_count: 0 });
    }
    return telegramSuccess(true);
  };

  const status = await configureTelegramBot();
  assert.deepEqual(calls.map(({ method }) => method), [
    "getMe",
    "setMyName",
    "setMyShortDescription",
    "setMyDescription",
    "setChatMenuButton",
    "deleteMyCommands",
    "deleteMyCommands",
    "deleteMyCommands",
    "setMyCommands",
    "setMyCommands",
    "setWebhook",
    "getWebhookInfo"
  ]);
  assert.equal(
    calls[2].payload.short_description,
    "Fast AI assistant for chats, groups and work."
  );
  assert.equal(calls[1].payload.name, "Nemotron");
  assert.equal(calls[3].payload.description, "Nemotron is your AI assistant for chat, groups and daily work. Fast answers, smart moderation, simple buttons.");
  assert.equal(calls[4].payload.menu_button.web_app.url, "https://nvidbot.onrender.com/miniapp.html");
  assert.deepEqual(calls.filter(({ method }) => method === "deleteMyCommands").map(({ payload }) => payload.scope.type),
    ["default", "all_private_chats", "all_group_chats"]);
  const adminMenu = calls.find(({ method, payload }) => method === "setMyCommands" && payload.scope.type === "chat");
  assert.deepEqual(adminMenu.payload.commands.map(({ command }) => command), [
    "start", "help", "dashboard", "modes", "mode", "use", "persona", "models", "model", "reset", "balance", "topup", "redeem", "voucher", "terms", "paysupport", "ban", "unban", "kick", "mute", "unmute", "warn", "unwarn", "warnings", "purge", "pin", "unpin", "lock", "unlock", "rules", "setrules", "slowmode", "approve", "reject", "modlog", "admins", "report", "starbalance", "whoami"
  ]);
  assert.equal(adminMenu.payload.scope.chat_id, "123");
  const groupMenu = calls.find(({ method, payload }) => method === "setMyCommands" && payload.scope.type === "all_chat_administrators");
  assert.ok(groupMenu.payload.commands.some(({ command }) => command === "nvid_secretary"));
  assert.equal(calls.filter(({ method }) => method === "setMyCommands").length, 2);
  assert.deepEqual(calls.find(({ method }) => method === "setWebhook").payload, {
    url: "https://nvidbot.onrender.com/webhooks/telegram",
    secret_token: "valid_secret-123",
    allowed_updates: [
      "message", "edited_message", "channel_post", "edited_channel_post", "business_connection",
      "business_message", "edited_business_message", "deleted_business_messages", "guest_message",
      "pre_checkout_query", "callback_query", "inline_query", "chat_join_request", "my_chat_member",
      "chat_member", "managed_bot", "subscription"
    ],
    max_connections: 10
  });
  assert.equal(status.configured, true);
  assert.equal(status.username, "NvidBotAI");
  assert.equal(status.link, "https://t.me/NvidBotAI");
  assert.deepEqual(telegramPublicStatus(), status);
});

test("Telegram setup deadlines reject long 429 waits instead of hanging startup", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "test_bot_token";
  global.fetch = async () => new Response(JSON.stringify({
    ok: false, error_code: 429, parameters: { retry_after: 120 }
  }), { status: 429 });
  const began = Date.now();
  await assert.rejects(telegramApi("getMe", {}, { deadlineAt: began + 500 }), error =>
    error.statusCode === 429 && error.retryAfter === 120);
  assert.ok(Date.now() - began < 1000);
});

test("rate-limited cosmetic updates do not block verified Telegram webhook setup", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test_webhook_secret";
  process.env.TELEGRAM_STAR_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.TELEGRAM_ADMIN_USER_ID = "123";
  process.env.TELEGRAM_PAYMENTS_ENABLED = "true";
  process.env.PUBLIC_URL = "https://fixture.example";
  setPlatformStoreForTests({ async isFeatureEnabled() { return false; } });
  for (const firstName of ["Legacy", "Nemotron"]) {
    setTelegramStarLedgerForTests({
      async init() {},
      async refundStaleReservations() { return { restoredCount: 0 }; }
    });
    const calls = [];
    global.fetch = async url => {
      const method = String(url).split("/").at(-1);
      calls.push(method);
      if (method === "getMe") return telegramSuccess({ id: 456, first_name: firstName, username: "fixture_bot" });
      if (["setMyName", "setMyShortDescription", "setMyDescription"].includes(method)) {
        return new Response(JSON.stringify({
          ok: false, error_code: 429, parameters: { retry_after: 44_000 }
        }), { status: 429 });
      }
      if (method === "getWebhookInfo") return telegramSuccess({ url: "https://fixture.example/webhooks/telegram" });
      return telegramSuccess();
    };
    const began = Date.now();
    const status = await configureTelegramBot();
    assert.equal(status.configured, true);
    assert.equal(status.starLedgerReady, true);
    assert.equal(telegramServiceReady(), true);
    assert.ok(calls.includes("setWebhook"));
    assert.equal(calls.includes("setMyName"), firstName !== "Nemotron");
    assert.ok(Date.now() - began < 1000);
  }
});
test("start sends the welcome image with setup guidance", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({
      method: new URL(url).pathname.split("/").at(-1),
      payload: JSON.parse(options.body)
    });
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "/start", chatId: 555, messageId: 44, updateId: 66 }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendPhoto");
  assert.equal(calls[0].payload.photo, "https://nvidbot.onrender.com/telegram/welcome-banner.png");
  assert.match(calls[0].payload.caption, /Nemotron/);
  assert.match(calls[0].payload.caption, /Quick start:/);
  assert.deepEqual(calls[0].payload.reply_parameters, { message_id: 44, allow_sending_without_reply: true });
});

test("rejects an invalid Telegram webhook secret before making API calls", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "not valid!";
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  let called = false;
  global.fetch = async () => {
    called = true;
    return telegramSuccess();
  };

  await assert.rejects(configureTelegramBot(), /1-256 letters/);
  assert.equal(called, false);
  assert.equal(telegramPublicStatus().configured, false);
});

test("lets a blocked user run whoami for allowlist discovery", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "999";
  const payloads = [];
  global.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "/whoami", userId: 123, chatId: 456 }));
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /User ID: 123/);
  assert.match(payloads[0].text, /Chat ID: 456/);
  assert.deepEqual(payloads[0].reply_parameters, { message_id: 7, allow_sending_without_reply: true });
});

test("blocks normal messages from users outside the optional allowlist", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "999";
  const payloads = [];
  global.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "hello", userId: 123, chatId: 457 }));
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /Access denied/);
  assert.match(payloads[0].text, /123/);
});

test("changes and reports the per-chat NVIDIA model by list number", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  const sent = [];
  global.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith("/sendMessage")) sent.push(JSON.parse(options.body));
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "/model 5", chatId: 700 }));
  await handleTelegram(telegramUpdate({ text: "/models", chatId: 700, messageId: 8, updateId: 10 }));

  assert.match(sent[0].text, /Llama 3\.1 8B/);
  assert.match(sent[0].text, /meta\/llama-3\.1-8b-instruct/);
  assert.match(sent[1].text, /meta\/llama-3\.1-8b-instruct  <- active/);
});

test("persists a selected assistant mode and applies its system instructions to NVIDIA", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  let selectedMode = "chat";
  const nvidiaRequests = [];
  setTelegramStarLedgerForTests(starLedgerDouble({
    async getUserControl(userId) {
      return { userId: String(userId), banned: false, unlimitedCredits: false, persona: "Use concise answers", selectedMode };
    },
    async setUserMode(userId, mode) {
      selectedMode = mode;
      return { userId: String(userId), banned: false, unlimitedCredits: false, persona: "Use concise answers", selectedMode };
    }
  }));
  global.fetch = async (url, options) => {
    if (new URL(url).hostname === "api.telegram.org") return telegramSuccess();
    nvidiaRequests.push(JSON.parse(options.body));
    return new Response('data: {"choices":[{"delta":{"content":"mode answer"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  await handleTelegram(telegramUpdate({ text: "/use coding", chatId: 710, messageId: 1, updateId: 1 }));
  await handleTelegram(telegramUpdate({ text: "Build an API", chatId: 710, messageId: 2, updateId: 2 }));

  assert.equal(selectedMode, "coding");
  assert.equal(nvidiaRequests.length, 1);
  assert.match(nvidiaRequests[0].messages[0].content, /Active mode: Code Studio/);
  assert.match(nvidiaRequests[0].messages[0].content, /senior software engineer/);
  assert.match(nvidiaRequests[0].messages[0].content, /Use concise answers/);
  assert.equal(nvidiaRequests[0].messages.at(-1).content, "Build an API");
});

test("streams stable Telegram drafts in a private chat and sends a final reply", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  const telegramCalls = [];
  global.fetch = async (url, options) => {
    if (new URL(url).hostname === "api.telegram.org") {
      telegramCalls.push({
        method: new URL(url).pathname.split("/").at(-1),
        payload: JSON.parse(options.body)
      });
      return telegramSuccess();
    }
    const stream = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      "",
      "data: [DONE]",
      ""
    ].join("\n");
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await handleTelegram(telegramUpdate({ text: "Say hello", chatId: 801, messageId: 21, updateId: 31 }));

  const drafts = telegramCalls.filter(({ method }) => method === "sendMessageDraft");
  assert.equal(telegramCalls[0].method, "sendChatAction");
  assert.ok(drafts.length >= 1);
  assert.ok(drafts.every(({ payload }) => payload.draft_id === drafts[0].payload.draft_id));
  assert.notEqual(drafts[0].payload.draft_id, 0);
  assert.equal(drafts.at(-1).payload.text, "world");
  const final = telegramCalls.findLast(({ method }) => method === "sendMessage");
  assert.equal(final.payload.text, "world");
  assert.deepEqual(final.payload.reply_parameters, { message_id: 21, allow_sending_without_reply: true });
});

test("uses typing and a final reply without drafts in a group", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  setPlatformStoreForTests(groupStoreDouble());
  const telegramMethods = [];
  global.fetch = async (url, options) => {
    if (new URL(url).hostname === "api.telegram.org") {
      const method = new URL(url).pathname.split("/").at(-1);
      telegramMethods.push(method);
      if (method === "sendMessage") return telegramSuccess({ message_id: 700, chat: { id: -900 }, text: JSON.parse(options.body).text });
      return telegramSuccess(true);
    }
    return new Response('data: {"choices":[{"delta":{"content":"Group answer"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  await handleTelegram(telegramUpdate({ text: "/nvid Question", chatId: -900, type: "supergroup", messageId: 22, updateId: 32 }));

  assert.equal(telegramMethods[0], "sendChatAction");
  assert.equal(telegramMethods[1], "sendMessage");
  assert.ok(telegramMethods.includes("editMessageText"));
  assert.equal(telegramMethods.filter((method) => method === "sendMessage").length, 1);
});

test("first-time group AI users receive a bound CAPTCHA before NVIDIA or billing", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  let nvidiaCalled = false;
  const telegramCalls = [];
  setPlatformStoreForTests(groupStoreDouble({
    async getTelegramGroup(chatId) {
      return {
        group: { id: String(chatId), chatType: "supergroup", active: true, botIsAdministrator: true },
        settings: { enabled: true, activationPolicy: "mention_only", defaultMode: "chat", captchaEnabled: true, captchaExemptAdministrators: true },
        permissions: null
      };
    },
    async isGroupUserVerified() { return false; },
    async consumeSharedRateLimit() { return { allowed: true }; },
    async createCaptchaChallenge() {
      return { challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", prompt: "Verification required: What is 4 + 3?", options: [{ index: 0, label: "6" }, { index: 1, label: "7" }, { index: 2, label: "8" }] };
    }
  }));
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "api.telegram.org") { nvidiaCalled = true; return new Response("", { status: 500 }); }
    const method = parsed.pathname.split("/").at(-1);
    telegramCalls.push({ method, payload: JSON.parse(options.body) });
    if (method === "getChatMember") return telegramSuccess({ status: "member" });
    return telegramSuccess(true);
  };

  await handleTelegram(telegramUpdate({ text: "/nvid verify me", userId: 901, chatId: -9010, type: "supergroup", messageId: 41 }));
  assert.equal(nvidiaCalled, false);
  const challenge = telegramCalls.find(({ method }) => method === "sendMessage");
  assert.match(challenge.payload.text, /4 \+ 3/);
  assert.deepEqual(challenge.payload.reply_markup.inline_keyboard[0].map((button) => button.callback_data), [
    "cap:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0",
    "cap:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1",
    "cap:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:2"
  ]);
  assert.doesNotMatch(JSON.stringify(challenge.payload.reply_markup), /answer|expected/i);
});

test("CAPTCHA callback is user-bound and another user cannot complete it", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  let answerInput = null;
  setPlatformStoreForTests(groupStoreDouble({
    async answerCaptchaChallenge(input) { answerInput = input; return { accepted: false, reason: "wrong_user" }; }
  }));
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split("/").at(-1), payload: JSON.parse(options.body) });
    return telegramSuccess(true);
  };
  await handleTelegram({ callback_query: { id: "callback-1", from: { id: 999 }, data: "cap:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1", message: { message_id: 51, chat: { id: -9010, type: "supergroup" } } } });
  assert.equal(answerInput.userId, 999);
  assert.equal(answerInput.groupId, -9010);
  assert.equal(calls[0].method, "answerCallbackQuery");
  assert.match(calls[0].payload.text, /another group member/i);
});

test("two successful requests use free allowance and the third consumes one credit", async () => {
  enableStarTestEnvironment();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  let freeReservations = 0;
  const finished = [];
  let creditsReserved = 0;
  let creditsCompleted = 0;
  setPlatformStoreForTests({
    async reserveFreeUsage() {
      freeReservations += 1;
      return freeReservations <= 2 ? { reserved: true, freeLimit: 2, used: freeReservations } : { reserved: false, exhausted: true, freeLimit: 2, used: 2 };
    },
    async recordUsageReservation() { return { recorded: true }; },
    async finishUsageEvent(id, state) { finished.push({ id, ...state }); }
  });
  setTelegramStarLedgerForTests(starLedgerDouble({
    async reservePrompt() { creditsReserved += 1; return { reserved: true, balance: "4" }; },
    async completePrompt() { creditsCompleted += 1; },
    async transitionPrompt() {},
    async reserveProviderCapacity() { return { reserved: true }; }
  }));
  global.fetch = async (url) => new URL(url).hostname === "api.telegram.org"
    ? telegramSuccess(true)
    : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  for (let index = 0; index < 3; index += 1) {
    await handleTelegram(telegramUpdate({ text: `request ${index}`, userId: 777, chatId: 777, messageId: 100 + index, updateId: 200 + index }));
  }
  assert.equal(creditsReserved, 1);
  assert.equal(creditsCompleted, 1);
  assert.equal(finished.filter((entry) => entry.success).length, 3);
});

test("isolates Telegram AI history by group user and forum thread", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  setPlatformStoreForTests(groupStoreDouble());
  const nvidiaRequests = [];
  global.fetch = async (url, options) => {
    if (new URL(url).hostname === "api.telegram.org") return telegramSuccess();
    const request = JSON.parse(options.body);
    nvidiaRequests.push(request.messages.map(({ content }) => content).join("\n"));
    return new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  await handleTelegram(telegramUpdate({
    text: "/nvid user-one-secret-alpha",
    userId: 101,
    chatId: -9101,
    type: "supergroup",
    threadId: 11,
    messageId: 1,
    updateId: 1
  }));
  await handleTelegram(telegramUpdate({
    text: "/nvid user-two-question",
    userId: 202,
    chatId: -9101,
    type: "supergroup",
    threadId: 11,
    messageId: 2,
    updateId: 2
  }));
  await handleTelegram(telegramUpdate({
    text: "/nvid user-one-other-thread",
    userId: 101,
    chatId: -9101,
    type: "supergroup",
    threadId: 22,
    messageId: 3,
    updateId: 3
  }));

  assert.equal(nvidiaRequests.length, 3);
  assert.doesNotMatch(nvidiaRequests[1], /user-one-secret-alpha/);
  assert.doesNotMatch(nvidiaRequests[2], /user-one-secret-alpha/);
  assert.match(nvidiaRequests[1], /user-two-question/);
  assert.match(nvidiaRequests[2], /user-one-other-thread/);
});

test("ordinary group messages are observed safely but never billed or answered", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  let reservations = 0;
  let externalCalls = 0;
  setTelegramStarLedgerForTests(starLedgerDouble({
    async reservePrompt() { reservations += 1; return { reserved: true }; }
  }));
  setPlatformStoreForTests(groupStoreDouble());
  global.fetch = async () => { externalCalls += 1; return telegramSuccess(); };

  await handleTelegram(telegramUpdate({ text: "ordinary group conversation", chatId: -9102, type: "supergroup" }));

  assert.equal(reservations, 0);
  assert.equal(externalCalls, 0);
});

test("my_chat_member updates persist add, promotion, demotion, and removal states", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  const states = [];
  setPlatformStoreForTests(groupStoreDouble({
    async upsertTelegramGroup({ chat, botMember }) { states.push({ chatId: String(chat.id), status: botMember?.status }); }
  }));
  for (const [index, status] of ["member", "administrator", "restricted", "left"].entries()) {
    await handleTelegram({
      update_id: 100 + index,
      my_chat_member: {
        chat: { id: -9200, type: "supergroup", title: "Lifecycle" },
        from: { id: 7 },
        old_chat_member: { status: index ? states.at(-1)?.status || "member" : "left", user: { id: 999, is_bot: true } },
        new_chat_member: { status, user: { id: 999, is_bot: true }, can_manage_chat: status === "administrator" }
      }
    });
  }
  assert.deepEqual(states.map(({ status }) => status), ["member", "administrator", "restricted", "left"]);
});

test("Group Secretary stores authorized messages by thread without public replies", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  const observations = [];
  let apiCalls = 0;
  setPlatformStoreForTests(groupStoreDouble({
    async getTelegramGroup(chatId) {
      return {
        group: { id: String(chatId), active: true, botIsAdministrator: true },
        settings: {
          enabled: true,
          activationPolicy: "mention_only",
          defaultMode: "secretary",
          secretaryEnabled: true,
          secretaryObservationEnabled: true,
          messageStorageEnabled: true,
          retentionDays: 14,
          threadIsolationEnabled: true
        }
      };
    },
    async observeTelegramMessage(value) { observations.push(value); }
  }));
  global.fetch = async () => { apiCalls += 1; return telegramSuccess(); };

  await handleTelegram(telegramUpdate({ text: "decision in topic eleven", chatId: -9300, type: "supergroup", threadId: 11, messageId: 1 }));
  await handleTelegram(telegramUpdate({ text: "decision in topic twenty two", chatId: -9300, type: "supergroup", threadId: 22, messageId: 2 }));

  assert.deepEqual(observations.map(({ transportMode, threadId }) => [transportMode, threadId]), [["group_secretary", 11], ["group_secretary", 22]]);
  assert.equal(apiCalls, 0);
});

test("group configuration commands use live Telegram authority instead of stale local roles", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  const changes = [];
  let liveActorStatus = "creator";
  let botCanManage = true;
  setPlatformStoreForTests(groupStoreDouble({
    async getGroupMember() { return { status: "administrator" }; },
    async updateGroupSettings(change) { changes.push(change); return { settings: change.changes }; }
  }));
  const sent = [];
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(options.body);
    if (method === "getMe") return telegramSuccess({ id: 999, is_bot: true, username: "NvidBotAI" });
    if (method === "getChatMember") {
      return telegramSuccess(String(payload.user_id) === "123"
        ? { status: liveActorStatus, can_manage_chat: liveActorStatus !== "member", user: { id: 123 } }
        : { status: "administrator", can_manage_chat: botCanManage, user: { id: 999, is_bot: true } });
    }
    if (method === "sendMessage") sent.push(payload.text);
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "/nvid_secretary on", chatId: -9400, type: "supergroup" }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changes.messageStorageEnabled, true);
  assert.match(sent.at(-1), /Group Secretary is now active/);

  liveActorStatus = "member";
  await handleTelegram(telegramUpdate({ text: "/nvid_guard on", chatId: -9400, type: "supergroup", messageId: 8 }));
  assert.equal(changes.length, 1);
  assert.match(sent.at(-1), /current Telegram group administrator rights/);

  liveActorStatus = "administrator";
  botCanManage = false;
  await handleTelegram(telegramUpdate({ text: "/nvid_guard on", chatId: -9400, type: "supergroup", messageId: 9 }));
  assert.equal(changes.length, 1);
  assert.match(sent.at(-1), /must be a group administrator/);
});

test("Telegram Business messages use telegram_secretary delivery context", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  const persistedChannels = [];
  setPlatformStoreForTests(groupStoreDouble({
    async getBusinessConnection() {
      return { connectionId: "business-connection-1", ownerUserId: "123", enabled: true, canReply: true, accessActive: true, accessStatus: "active_paid", autoReplyEnabled: true, allowedChatConfiguration: {} };
    },
    async getOrCreateConversation(input) {
      persistedChannels.push(input.channel);
      return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    },
    async conversationContext() { return []; },
    async beginConversationTurn() { return { assistantMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }; },
    async finishConversationTurn() {}
  }));
  const telegramCalls = [];
  let nvidiaCalls = 0;
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.telegram.org") {
      telegramCalls.push({ method: parsed.pathname.split("/").at(-1), payload: JSON.parse(options.body) });
      return telegramSuccess();
    }
    nvidiaCalls += 1;
    return new Response('data: {"choices":[{"delta":{"content":"Business reply"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await handleTelegram({
    update_id: 501,
    business_message: {
      message_id: 17,
      business_connection_id: "business-connection-1",
      from: { id: 456, first_name: "Customer" },
      chat: { id: 456, type: "private" },
      text: "Can you help?"
    }
  });

  assert.equal(nvidiaCalls, 1);
  assert.deepEqual(persistedChannels, ["telegram_business"]);
  assert.equal(telegramCalls.find(({ method }) => method === "sendMessage").payload.business_connection_id, "business-connection-1");
});

test("guest responses use answerGuestQuery and never send typing actions", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  const telegramCalls = [];
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.telegram.org") {
      telegramCalls.push({ method: parsed.pathname.split("/").at(-1), payload: JSON.parse(options.body) });
      return telegramSuccess();
    }
    return new Response('data: {"choices":[{"delta":{"content":"Guest reply"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await handleTelegram({ update_id: 601, guest_message: { message_id: 1, guest_query_id: "guest-1", from: { id: 321 }, chat: { id: 321, type: "private" }, text: "Guest question" } });

  assert.deepEqual(telegramCalls.map(({ method }) => method), ["answerGuestQuery"]);
  assert.equal(telegramCalls[0].payload.guest_query_id, "guest-1");
});

test("inline AI returns an NVIDIA answer and completes one idempotent credit", async () => {
  enableStarTestEnvironment();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  const transitions = [];
  const completed = [];
  setTelegramStarLedgerForTests(starLedgerDouble({
    async getModeSettings(defaultModes) { return { ...defaultModes, inline: true }; },
    async getUserControl(userId) { return { userId: String(userId), banned: false, unlimitedCredits: false, selectedMode: "research" }; },
    async reservePrompt(userId, { reservationId, cost }) { return { reserved: true, userId, reservationId, cost, state: "reserved", balance: "4" }; },
    async reserveProviderCapacity() { return { reserved: true }; },
    async transitionPrompt(id, state) { transitions.push([id, state]); },
    async completePrompt(id) { completed.push(id); }
  }));
  const telegramCalls = [];
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.telegram.org") {
      telegramCalls.push({ method: parsed.pathname.split("/").at(-1), payload: JSON.parse(options.body) });
      return telegramSuccess();
    }
    return new Response('data: {"choices":[{"delta":{"content":"Inline NVIDIA answer"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await handleTelegram({ update_id: 650, inline_query: { id: "inline-query-1", from: { id: 123 }, query: "compare two architectures" } });

  assert.deepEqual(telegramCalls.map(({ method }) => method), ["answerInlineQuery"]);
  assert.match(telegramCalls[0].payload.results[0].input_message_content.message_text, /Inline NVIDIA answer/);
  assert.deepEqual(completed, ["inline:123:inline-query-1"]);
  assert.deepEqual(transitions.map(([, state]) => state), ["generation_started", "response_produced", "delivery_attempted", "delivered"]);
});

test("bot-to-bot duplicate updates are processed once with an allowlist", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  let accepted = true;
  let nvidiaCalls = 0;
  setPlatformStoreForTests(groupStoreDouble({
    async getTelegramGroup(chatId) {
      return {
        group: { id: String(chatId), active: true, botIsAdministrator: true },
        settings: { enabled: true, activationPolicy: "mention_only", defaultMode: "chat", botToBotEnabled: true, botToBotAllowlist: ["777"] }
      };
    },
    async recordBotInteraction() { const result = accepted; accepted = false; return { accepted: result }; }
  }));
  global.fetch = async (url) => {
    if (new URL(url).hostname === "api.telegram.org") return telegramSuccess();
    nvidiaCalls += 1;
    return new Response('data: {"choices":[{"delta":{"content":"Bot reply"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const update = { update_id: 701, message: { message_id: 5, from: { id: 777, is_bot: true, username: "AllowedBot" }, chat: { id: -9500, type: "supergroup" }, text: "/nvid coordinated task" } };
  await handleTelegram(update);
  await handleTelegram(update);
  assert.equal(nvidiaCalls, 1);
});

test("Guard callbacks verify mode, requester authority, and current bot permissions", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_ADMIN_USER_ID = "6643462826";
  setTelegramStarLedgerForTests(starLedgerDouble({
    async getModeSettings(defaultModes) { return { ...defaultModes, guard: true }; }
  }));
  setPlatformStoreForTests({
    async getTelegramGroup() { return { settings: { guardEnabled: true } }; },
    async isFeatureEnabled(key) { return key === "guard_mode"; },
    async decideGuardJoinRequest() {}
  });
  const calls = [];
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload });
    if (method === "getMe") return telegramSuccess({ id: 999, is_bot: true });
    if (method === "getChatMember") {
      return telegramSuccess({ status: "administrator", can_invite_users: true });
    }
    return telegramSuccess();
  };

  await handleTelegram({
    callback_query: {
      id: "guard-ok",
      from: { id: 6643462826 },
      data: "g1.approve.-100123.321"
    }
  });

  assert.equal(calls.filter(({ method }) => method === "getChatMember").length, 2);
  assert.deepEqual(calls.find(({ method }) => method === "approveChatJoinRequest").payload, {
    chat_id: "-100123",
    user_id: "321"
  });
  assert.equal(calls.at(-1).method, "answerCallbackQuery");
  assert.equal(calls.at(-1).payload.show_alert, false);
});

test("Guard callbacks fail closed when Telegram no longer grants authority", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_ADMIN_USER_ID = "6643462826";
  setTelegramStarLedgerForTests(starLedgerDouble({
    async getModeSettings(defaultModes) { return { ...defaultModes, guard: true }; }
  }));
  setPlatformStoreForTests({
    async getTelegramGroup() { return { settings: { guardEnabled: true } }; },
    async isFeatureEnabled(key) { return key === "guard_mode"; },
    async decideGuardJoinRequest() {}
  });
  const methods = [];
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    methods.push(method);
    if (method === "getMe") return telegramSuccess({ id: 999, is_bot: true });
    if (method === "getChatMember") {
      const payload = JSON.parse(options.body);
      return telegramSuccess(payload.user_id === 6643462826
        ? { status: "member" }
        : { status: "administrator", can_invite_users: true });
    }
    return telegramSuccess();
  };

  await handleTelegram({
    callback_query: {
      id: "guard-denied",
      from: { id: 6643462826 },
      data: "g1.deny.-100123.321"
    }
  });

  assert.equal(methods.includes("declineChatJoinRequest"), false);
  assert.equal(methods.at(-1), "answerCallbackQuery");
});

test("group moderation verifies live actor and bot permissions before a ban", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  const recorded = [];
  setPlatformStoreForTests({
    async isFeatureEnabled(key) { return key === "group_management"; },
    async getTelegramGroup() { return { group: { active: true }, settings: { enabled: true, moderationEnabled: true } }; },
    async beginModerationAction(action) { recorded.push({ ...action, result: "pending" }); return { actionId: crypto.randomUUID(), duplicate: false, result: "pending" }; },
    async finishModerationAction(requestId, update) { recorded.push({ requestId, ...update }); return { actionId: crypto.randomUUID(), result: update.result }; }
  });
  const calls = [];
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload });
    if (method === "getMe") return telegramSuccess({ id: 999, is_bot: true });
    if (method === "getChatMember") {
      if (String(payload.user_id) === "456") return telegramSuccess({ status: "member", user: { id: 456 } });
      return telegramSuccess({ status: "administrator", can_restrict_members: true, user: { id: payload.user_id } });
    }
    return telegramSuccess(true);
  };

  const result = await executeTelegramModerationAction({
    actorUserId: "123",
    chatId: "-10077",
    action: "ban",
    targetUserId: "456",
    reason: "Repeated spam",
    requestId: crypto.randomUUID()
  });
  assert.equal(result.ok, true);
  assert.ok(calls.some(({ method }) => method === "banChatMember"));
  assert.equal(recorded.at(-1).result, "success");
  assert.equal(recorded[0].targetUserId, "456");
});

test("group moderation fails closed when a stored administrator is no longer a Telegram admin", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  setPlatformStoreForTests({
    async isFeatureEnabled() { return true; },
    async getTelegramGroup() { return { group: { active: true }, settings: { enabled: true, moderationEnabled: true } }; },
    async beginModerationAction() { throw new Error("should not record an unattempted action"); },
    async finishModerationAction() { throw new Error("should not finish an unattempted action"); }
  });
  const methods = [];
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(options.body);
    methods.push(method);
    if (method === "getMe") return telegramSuccess({ id: 999, is_bot: true });
    if (method === "getChatMember") return telegramSuccess(String(payload.user_id) === "123"
      ? { status: "member", user: { id: 123 } }
      : String(payload.user_id) === "999"
        ? { status: "administrator", can_restrict_members: true, user: { id: 999 } }
        : { status: "member", user: { id: 456 } });
    return telegramSuccess(true);
  };
  const state = await telegramGroupPermissionState({ chatId: "-10077", actorUserId: "123", action: "ban", targetUserId: "456" });
  assert.equal(state.actorAllowed, false);
  await assert.rejects(
    executeTelegramModerationAction({ actorUserId: "123", chatId: "-10077", action: "ban", targetUserId: "456" }),
    /need Telegram's can_restrict_members/
  );
  assert.equal(methods.includes("banChatMember"), false);
});

test("duplicate moderation request IDs do not execute a Telegram action twice", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  const states = new Map();
  setPlatformStoreForTests({
    async isFeatureEnabled() { return true; },
    async getTelegramGroup() { return { group: { active: true }, settings: { enabled: true, moderationEnabled: true } }; },
    async beginModerationAction({ requestId }) {
      if (states.has(requestId)) return { duplicate: true, actionId: "saved", result: states.get(requestId) };
      states.set(requestId, "pending");
      return { duplicate: false, actionId: "saved", result: "pending" };
    },
    async finishModerationAction(requestId, { result }) { states.set(requestId, result); return { actionId: "saved", result }; }
  });
  let bans = 0;
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(options.body);
    if (method === "getMe") return telegramSuccess({ id: 999, is_bot: true });
    if (method === "getChatMember") return telegramSuccess(String(payload.user_id) === "456"
      ? { status: "member", user: { id: 456 } }
      : { status: "administrator", can_restrict_members: true, user: { id: payload.user_id } });
    if (method === "banChatMember") bans += 1;
    return telegramSuccess(true);
  };
  const id = crypto.randomUUID();
  await executeTelegramModerationAction({ actorUserId: "123", chatId: "-10077", action: "ban", targetUserId: "456", requestId: id });
  const duplicate = await executeTelegramModerationAction({ actorUserId: "123", chatId: "-10077", action: "ban", targetUserId: "456", requestId: id });
  assert.equal(duplicate.duplicate, true);
  assert.equal(bans, 1);
});

test("Secretary reminder delivery is leased, persistent, and marks successful Telegram delivery", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  const completed = [];
  setPlatformStoreForTests({
    async isFeatureEnabled(key) { return key === "secretary_automation"; },
    async acquireLease({ key, ownerId }) { return { acquired: true, key, ownerId }; },
    async releaseLease() {},
    async claimDueSecretaryReminders() {
      return [{ reminder_id: crypto.randomUUID(), owner_user_id: "123", chat_id: "123", thread_id: null, title: "Ship release", message: "Run the production checklist" }];
    },
    async completeSecretaryReminder(id, result) { completed.push({ id, result }); },
    async claimDueSecretaryJobs() { return []; }
  });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split("/").at(-1), payload: JSON.parse(options.body) });
    return telegramSuccess(true);
  };
  const result = await deliverDueSecretaryReminders();
  assert.equal(result.delivered, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.match(calls[0].payload.text, /production checklist/);
  assert.equal(completed[0].result.delivered, true);
});

test("admin AI chat does not consume Stars credits", async () => {
  enableStarTestEnvironment();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  let reserved = false;
  setTelegramStarLedgerForTests(starLedgerDouble({
    async reservePrompt() {
      reserved = true;
      return { reserved: false, balance: "0" };
    }
  }));
  const telegramCalls = [];
  global.fetch = async (url, options) => {
    if (new URL(url).hostname === "api.telegram.org") {
      telegramCalls.push(new URL(url).pathname.split("/").at(-1));
      return telegramSuccess();
    }
    return new Response('data: {"choices":[{"delta":{"content":"Admin answer"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  await handleTelegram(telegramUpdate({ text: "Admin prompt", userId: 6643462826, chatId: 6643462826 }));

  assert.equal(reserved, false);
  assert.ok(telegramCalls.includes("sendMessage"));
});

test("banned users are blocked before AI inference", async () => {
  enableStarTestEnvironment();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  let nvidiaCalled = false;
  setTelegramStarLedgerForTests(starLedgerDouble({
    async getUserControl(userId) {
      return { userId: String(userId), banned: true, banReason: "abuse", unlimitedCredits: false, persona: null };
    }
  }));
  const messages = [];
  global.fetch = async (url, options) => {
    if (new URL(url).hostname !== "api.telegram.org") nvidiaCalled = true;
    else messages.push(JSON.parse(options.body));
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "Blocked prompt", userId: 123, chatId: 123 }));

  assert.equal(nvidiaCalled, false);
  assert.match(messages[0].text, /banned from Nemotron/);
});

test("disabled chat mode stops paid AI inference without charging", async () => {
  enableStarTestEnvironment();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  let reserved = false;
  let nvidiaCalled = false;
  setTelegramStarLedgerForTests(starLedgerDouble({
    async getModeSettings(defaultModes) {
      return { ...defaultModes, chat: false };
    },
    async reservePrompt() {
      reserved = true;
      return { reserved: true, balance: "0" };
    }
  }));
  const messages = [];
  global.fetch = async (url, options) => {
    if (new URL(url).hostname !== "api.telegram.org") nvidiaCalled = true;
    else messages.push(JSON.parse(options.body));
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "Should not run", userId: 123, chatId: 123 }));

  assert.equal(reserved, false);
  assert.equal(nvidiaCalled, false);
  assert.match(messages[0].text, /AI Chat Mode is currently disabled/);
});

test("top-up confirmation records terms acceptance and sends an XTR invoice", async () => {
  enableStarTestEnvironment();
  const accepted = [];
  setTelegramStarLedgerForTests(starLedgerDouble({
    async acceptTerms(userId, version) { accepted.push({ userId, version }); }
  }));
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({
      method: new URL(url).pathname.split("/").at(-1),
      payload: JSON.parse(options.body)
    });
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "/topup 7", userId: 123, chatId: 123 }));
  const offer = calls.find(({ method }) => method === "sendMessage");
  const callbackData = offer.payload.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(callbackData) <= 64);

  await handleTelegram({
    update_id: 10,
    callback_query: {
      id: "callback-1",
      from: { id: 123 },
      data: callbackData,
      message: { message_id: 8, chat: { id: 123, type: "private" } }
    }
  });

  assert.deepEqual(accepted, [{ userId: "123", version: "2026-07-14" }]);
  const invoice = calls.find(({ method }) => method === "sendInvoice").payload;
  assert.equal(invoice.currency, "XTR");
  assert.deepEqual(invoice.prices, [{ label: "7 AI message credits", amount: 7 }]);
  assert.equal("provider_token" in invoice, false);
  assert.match(invoice.start_parameter, /^topup_[a-f0-9]{24}$/);
});

test("validates pre-checkout data and only approves matching accepted purchases", async () => {
  enableStarTestEnvironment();
  setTelegramStarLedgerForTests(starLedgerDouble({ async hasAcceptedTerms() { return true; } }));
  const payload = createStarPurchasePayload({ userId: 123, amount: 5, nonce: "abcDEF12" });
  const answers = [];
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "answerPreCheckoutQuery") answers.push(JSON.parse(options.body));
    return telegramSuccess();
  };

  const validUpdate = {
    update_id: 11,
    pre_checkout_query: {
      id: "checkout-good",
      from: { id: 123 },
      currency: "XTR",
      total_amount: 5,
      invoice_payload: payload
    }
  };
  assert.equal(telegramUpdateRequiresSynchronousAck(validUpdate), true);
  await handleTelegram(validUpdate);
  await handleTelegram({
    pre_checkout_query: {
      ...validUpdate.pre_checkout_query,
      id: "checkout-bad",
      total_amount: 4
    }
  });

  assert.deepEqual(answers[0], { pre_checkout_query_id: "checkout-good", ok: true });
  assert.equal(answers[1].ok, false);
  assert.match(answers[1].error_message, /amount/i);
});

test("optional Stars purchases work without requiring payment for every AI request", async () => {
  enableStarTestEnvironment();
  process.env.TELEGRAM_STARS_REQUIRED = "false";
  process.env.TELEGRAM_PAYMENTS_ENABLED = "true";
  setTelegramStarLedgerForTests(starLedgerDouble());
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split("/").at(-1), payload: JSON.parse(options.body) });
    return telegramSuccess();
  };
  await handleTelegram(telegramUpdate({ text: "/topup 5", userId: 123, chatId: 123 }));
  const offer = calls.find(({ method }) => method === "sendMessage");
  assert.ok(offer.payload.reply_markup.inline_keyboard[0][0].callback_data);
  await handleTelegram({ callback_query: {
    id: "optional-payment", from: { id: 123 },
    data: offer.payload.reply_markup.inline_keyboard[0][0].callback_data,
    message: { message_id: 8, chat: { id: 123, type: "private" } }
  } });
  const invoice = calls.find(({ method }) => method === "sendInvoice").payload;
  assert.equal(invoice.currency, "XTR");
  await handleTelegram({ pre_checkout_query: {
    id: "optional-checkout", from: { id: 123 }, currency: "XTR",
    total_amount: 5, invoice_payload: invoice.payload
  } });
  assert.deepEqual(calls.find(({ method }) => method === "answerPreCheckoutQuery").payload,
    { pre_checkout_query_id: "optional-checkout", ok: true });
});

test("payment support routes to the configured owner while admin commands remain protected", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_ADMIN_USER_ID = "999";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split("/").at(-1), payload: JSON.parse(options.body) });
    return telegramSuccess();
  };
  await handleTelegram(telegramUpdate({ text: "/paysupport Payment help", userId: 123, chatId: 123 }));
  assert.ok(calls.some(({ payload }) => String(payload.chat_id) === "999" && /Payment help/.test(payload.text)));
  assert.ok(calls.some(({ payload }) => String(payload.chat_id) === "123" && /sent to the bot administrator/.test(payload.text)));
  calls.length = 0;
  await handleTelegram(telegramUpdate({ text: "/mode chat off", userId: 123, chatId: 123 }));
  assert.ok(calls.some(({ payload }) => /only to the configured bot administrator/.test(payload.text)));
});

test("restricted users can reach payment support without accessing AI or exposing details in groups", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_ADMIN_USER_ID = "999";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "999";
  setTelegramStarLedgerForTests(starLedgerDouble({
    async getUserControl() { return { banned: true, banReason: "test restriction" }; }
  }));
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split("/").at(-1), payload: JSON.parse(options.body) });
    return telegramSuccess();
  };
  await handleTelegram(telegramUpdate({ text: "/paysupport Test purchase", userId: 123, chatId: 123 }));
  assert.ok(calls.some(({ payload }) => String(payload.chat_id) === "999" && /Test purchase/.test(payload.text)));
  calls.length = 0;
  await handleTelegram(telegramUpdate({ text: "/paysupport@NvidBotAI Do not forward", userId: 123, chatId: -10077, type: "supergroup" }));
  assert.equal(calls.some(({ payload }) => String(payload.chat_id) === "999"), false);
  assert.equal(calls.length, 0, "an unregistered group must not process or forward payment details");
});

test("rejects pre-checkout within the shared deadline when the ledger stalls", async () => {
  enableStarTestEnvironment();
  setTelegramStarLedgerForTests(starLedgerDouble({
    async hasAcceptedTerms() { return new Promise(() => {}); }
  }));
  const payload = createStarPurchasePayload({ userId: 123, amount: 5, nonce: "abcDEF12" });
  const answers = [];
  global.fetch = async (_url, options) => {
    answers.push(JSON.parse(options.body));
    return telegramSuccess();
  };

  const startedAt = Date.now();
  await handleTelegramPreCheckout({
    id: "checkout-stalled",
    from: { id: 123 },
    currency: "XTR",
    total_amount: 5,
    invoice_payload: payload
  }, { deadlineMs: 100, ledgerBudgetMs: 20 });

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].ok, false);
  assert.match(answers[0].error_message, /ledger/i);
});

test("credits each successful Telegram payment once before acknowledging it", async () => {
  enableStarTestEnvironment();
  const credited = [];
  setTelegramStarLedgerForTests(starLedgerDouble({
    async creditPayment(payment) {
      credited.push(payment);
      return { credited: true, balance: "12" };
    }
  }));
  const payload = createStarPurchasePayload({ userId: 123, amount: 12, nonce: "abcDEF12" });
  const telegramMessages = [];
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "sendMessage") telegramMessages.push(JSON.parse(options.body));
    return telegramSuccess();
  };
  const update = {
    update_id: 12,
    message: {
      message_id: 20,
      from: { id: 123, username: "ada" },
      chat: { id: 123, type: "private" },
      successful_payment: {
        currency: "XTR",
        total_amount: 12,
        invoice_payload: payload,
        telegram_payment_charge_id: "charge-123",
        provider_payment_charge_id: ""
      }
    }
  };

  assert.equal(telegramUpdateRequiresSynchronousAck(update), true);
  await handleTelegram(update);
  assert.equal(credited.length, 1);
  assert.equal(credited[0].telegramPaymentChargeId, "charge-123");
  assert.match(telegramMessages[0].text, /Current balance: 12/);
  assert.equal(telegramMessages[1].chat_id, "6643462826");
});

test("credits an authentic successful payment even after its invoice payload expires", async () => {
  enableStarTestEnvironment();
  const credited = [];
  setTelegramStarLedgerForTests(starLedgerDouble({
    async creditPayment(payment) {
      credited.push(payment);
      return { credited: true, balance: "3" };
    }
  }));
  const expiredPayload = createStarPurchasePayload({
    userId: 123,
    amount: 3,
    nonce: "abcDEF12",
    now: Date.now() - 8 * 24 * 60 * 60 * 1000
  });
  global.fetch = async () => telegramSuccess();

  await handleTelegram({
    update_id: 120,
    message: {
      message_id: 200,
      from: { id: 123 },
      chat: { id: 123, type: "private" },
      successful_payment: {
        currency: "XTR",
        total_amount: 3,
        invoice_payload: expiredPayload,
        telegram_payment_charge_id: "charge-expired-delivery",
        provider_payment_charge_id: ""
      }
    }
  });

  assert.equal(credited.length, 1);
  assert.equal(credited[0].telegramPaymentChargeId, "charge-expired-delivery");
});

test("500-Star Secretary activation is bound to its owner and idempotent", async () => {
  enableStarTestEnvironment();
  const connectionId = "business-connection-payment-test";
  const payload = createSecretaryActivationPayload({ userId: "123", connectionId });
  let activations = 0;
  setPlatformStoreForTests(groupStoreDouble({
    async listBusinessConnections() {
      return [{ connectionId, ownerUserId: "123", enabled: true, canReply: true, accessStatus: "payment_pending" }];
    },
    async activateSecretaryPayment(input) {
      activations += 1;
      return { activated: activations === 1, duplicate: activations > 1, status: "active_paid", ...input };
    }
  }));
  const messages = [];
  global.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith("/sendMessage")) messages.push(JSON.parse(options.body));
    return telegramSuccess(true);
  };
  const update = {
    update_id: 700,
    message: {
      message_id: 701,
      from: { id: 123, first_name: "Owner" },
      chat: { id: 123, type: "private" },
      successful_payment: {
        currency: "XTR",
        total_amount: 500,
        invoice_payload: payload,
        telegram_payment_charge_id: "secretary-charge-1"
      }
    }
  };
  await handleTelegram(update);
  await handleTelegram({ ...update, update_id: 701 });
  assert.equal(activations, 2);
  assert.equal(messages.filter((message) => /Secretary access activated/.test(message.text)).length, 1);
  await assert.rejects(handleTelegram({
    ...update,
    update_id: 702,
    message: { ...update.message, from: { id: 124, first_name: "Wrong owner" } }
  }), /invalid Secretary Stars payment/i);
});

test("paid Telegram mode is not ready until its ledger and webhook are configured", async () => {
  enableStarTestEnvironment();
  process.env.TELEGRAM_WEBHOOK_SECRET = "valid_secret-123";
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  delete process.env.DATABASE_URL;
  await assert.rejects(configureTelegramBot(), /DATABASE_URL/);
  assert.equal(telegramServiceReady(), false);
  assert.equal(telegramPublicStatus().starsRequired, true);
  assert.equal(telegramPublicStatus().starLedgerReady, false);
});

test("reconciles Telegram refund updates against unused credits", async () => {
  enableStarTestEnvironment();
  const refunds = [];
  setTelegramStarLedgerForTests(starLedgerDouble({
    async recordRefund(refund) {
      refunds.push(refund);
      return {
        changed: true,
        balance: "2",
        deductedAmount: "3",
        payment: { telegramPaymentChargeId: refund.telegramPaymentChargeId }
      };
    }
  }));
  const payload = createStarPurchasePayload({ userId: 123, amount: 5, nonce: "abcDEF12" });
  global.fetch = async () => telegramSuccess();
  const update = {
    update_id: 13,
    message: {
      message_id: 21,
      from: { id: 123 },
      chat: { id: 123, type: "private" },
      refunded_payment: {
        currency: "XTR",
        total_amount: 5,
        invoice_payload: payload,
        telegram_payment_charge_id: "charge-refunded"
      }
    }
  };

  await handleTelegram(update);
  assert.deepEqual(refunds, [{
    telegramPaymentChargeId: "charge-refunded",
    userId: "123",
    amount: 5
  }]);
});

test("does not call NVIDIA when a paying user has no message credit", async () => {
  enableStarTestEnvironment();
  setTelegramStarLedgerForTests(starLedgerDouble());
  let nvidiaCalled = false;
  const sent = [];
  global.fetch = async (url, options) => {
    if (new URL(url).hostname !== "api.telegram.org") nvidiaCalled = true;
    else if (new URL(url).pathname.endsWith("/sendMessage")) sent.push(JSON.parse(options.body));
    return telegramSuccess();
  };

  await handleTelegram(telegramUpdate({ text: "Use a paid prompt", userId: 123, chatId: 123 }));
  assert.equal(nvidiaCalled, false);
  assert.match(sent[0].text, /Free limit reached/i);
  assert.match(sent[0].text, /\/topup/);
});

test("restores a reserved credit when NVIDIA generation fails", async () => {
  enableStarTestEnvironment();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  const restored = [];
  let completed = false;
  setTelegramStarLedgerForTests(starLedgerDouble({
    async reservePrompt(userId, { reservationId, cost }) {
      return { reserved: true, changed: true, userId: String(userId), reservationId, cost, state: "reserved", balance: "2" };
    },
    async completePrompt() { completed = true; },
    async restorePrompt(reservationId) { restored.push(reservationId); }
  }));
  global.fetch = async (url) => {
    if (new URL(url).hostname === "api.telegram.org") return telegramSuccess();
    return new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  };

  await handleTelegram(telegramUpdate({ text: "This will fail", userId: 123, chatId: 123, messageId: 99 }));
  assert.equal(completed, false);
  assert.deepEqual(restored, ["telegram:123:99"]);
});
