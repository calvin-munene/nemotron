import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createAppServer, resolveClientIp } from "../src/server.js";
import { configureTelegramBot, setTelegramStarLedgerForTests } from "../src/channels.js";
import { createStarPurchasePayload } from "../src/starPayments.js";
import { resetTelegramWebAuthForTests } from "../src/telegramWebAuth.js";
import { setPlatformStoreForTests } from "../src/platformRuntime.js";
import { resetNvidiaModelCatalogForTests } from "../src/agent.js";
import { aiChatStarCost, resetPricingForTests } from "../src/pricing.js";
import { recordNvidiaRequest, resetProviderHealthForTests } from "../src/providerHealth.js";

const originalFetch = global.fetch;
const ENV_NAMES = [
  "TELEGRAM_ADMIN_USER_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_STAR_SIGNING_SECRET",
  "TELEGRAM_STARS_REQUIRED",
  "TELEGRAM_PAYMENTS_ENABLED",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_WEBAPP_MAX_AGE_SECONDS",
  "TELEGRAM_WEBAPP_SESSION_TTL_SECONDS",
  "TELEGRAM_OIDC_CLIENT_ID",
  "TELEGRAM_OIDC_CLIENT_SECRET",
  "TELEGRAM_OIDC_REDIRECT_URI",
  "WEB_SESSION_IDLE_SECONDS",
  "WEB_SESSION_ABSOLUTE_SECONDS",
  "NVIDIA_API_KEY",
  "NVIDIA_AUTO_TOOLS",
  "NVIDIA_GLOBAL_REQUESTS_PER_HOUR",
  "NVIDIA_MAX_CONCURRENT_REQUESTS",
  "PUBLIC_URL",
  "META_APP_SECRET",
  "TRUST_PROXY",
  "RENDER"
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
  resetNvidiaModelCatalogForTests();
  resetPricingForTests();
  resetProviderHealthForTests();
  resetTelegramWebAuthForTests();
}

test.afterEach(restoreEnvironment);
test.beforeEach(() => {
  process.env.TELEGRAM_PAYMENTS_ENABLED = "false";
  process.env.NVIDIA_AUTO_TOOLS = "false";
});

function enableTelegramPayments() {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test_webhook_secret";
  process.env.TELEGRAM_STAR_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.TELEGRAM_ADMIN_USER_ID = "6643462826";
  process.env.TELEGRAM_STARS_REQUIRED = "true";
  global.fetch = async () => new Response(JSON.stringify({ ok: true, result: true }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function postTelegram(port, update) {
  const body = JSON.stringify(update);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/webhooks/telegram",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-telegram-bot-api-secret-token": process.env.TELEGRAM_WEBHOOK_SECRET
      }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function requestJson(port, path, value, headers = {}) {
  const requestBody = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.end(requestBody);
  });
}

function requestJsonMethod(port, path, method, value = null, headers = {}) {
  const requestBody = value === null ? "" : JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(value === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(requestBody) }),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.end(requestBody);
  });
}

function requestRaw(port, path, requestBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(requestBody);
  });
}

function requestGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function signedInitData({ authDate = Math.floor(Date.now() / 1000), userId = 123 } = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: `query-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "Ada" })
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.TELEGRAM_BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

function webLedgerDouble(overrides = {}) {
  return {
    async getModeSettings(defaultModes) { return { ...defaultModes }; },
    async getUserControl(userId) {
      return { userId: String(userId), banned: false, unlimitedCredits: false, persona: null, selectedMode: "chat" };
    },
    async getBalance(userId) { return { userId: String(userId), balance: "2" }; },
    async reservePrompt(userId, { reservationId, cost }) {
      return { reserved: true, userId: String(userId), reservationId, cost, state: "reserved", balance: "1" };
    },
    async reserveProviderCapacity() { return { reserved: true, used: 1 }; },
    async completePrompt() {},
    async restorePrompt() {},
    async listPayments() { return []; },
    async listUsage() { return []; },
    async getStats() { return { accounts: "1", credits: "2", payments: "0", prompts: "0" }; },
    async setUserMode(userId, selectedMode) { return { userId: String(userId), selectedMode }; },
    ...overrides
  };
}

function platformStoreDouble(overrides = {}) {
  const features = [{ key: "admin_api", enabled: true, description: "Admin API", config: {}, updatedBy: null }];
  return {
    async ensureUser() {},
    async getUserRole() { return "standard_user"; },
    async writeSecurityEvent() { return { written: true }; },
    async getOverview() { return { totalUsers: "1", activeUsers: "1", newUsers: "1", auditEvents: "0", recentSecurityEvents: "0" }; },
    async listFeatureFlags() { return features; },
    async setFeatureFlag({ featureKey, enabled }) {
      return { duplicate: false, feature: { key: featureKey, enabled, description: "", config: {}, updatedBy: "6643462826" } };
    },
    async listAuditLogs() { return []; },
    async listSecurityEvents() { return []; },
    async listAiModels() { return [{ id: "meta/model-a", enabled: true, featured: false, providerAvailable: true }]; },
    async enabledAiModelIds() { return ["meta/model-a"]; },
    async setAiModelControl({ modelId, enabled, featured }) {
      return { duplicate: false, model: { id: modelId, enabled: enabled ?? true, featured: featured ?? false } };
    },
    async getBillingPrices() { return [{ featureKey: "ai_chat", starCost: 1, updatedBy: null }]; },
    async getBillingPrice() { return { featureKey: "ai_chat", starCost: 1, updatedBy: null }; },
    async setBillingPrice({ featureKey, starCost }) {
      return { duplicate: false, price: { featureKey, starCost, updatedBy: "6643462826" } };
    },
    ...overrides
  };
}

async function launchWebSession(port, userId = 123) {
  const response = await requestJson(port, "/api/miniapp/state", { initData: signedInitData({ userId }) });
  assert.equal(response.status, 200, response.text);
  return JSON.parse(response.text).sessionToken;
}

function paymentUpdate(kind, payload, id = 1) {
  const payment = {
    currency: "XTR",
    total_amount: 5,
    invoice_payload: payload,
    telegram_payment_charge_id: `charge-${kind}-${id}`,
    provider_payment_charge_id: ""
  };
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 123 },
      chat: { id: 123, type: "private" },
      [kind]: payment
    }
  };
}

test("payment webhooks wait for a durable ledger result before returning 200", async () => {
  enableTelegramPayments();
  const payload = createStarPurchasePayload({ userId: 123, amount: 5, nonce: "abcDEF12" });

  for (const kind of ["successful_payment", "refunded_payment"]) {
    const commit = deferred();
    setTelegramStarLedgerForTests({
      async creditPayment() { return commit.promise; },
      async recordRefund() { return commit.promise; }
    });
    const server = createAppServer();
    const port = await listen(server);
    try {
      let settled = false;
      const responsePromise = postTelegram(port, paymentUpdate(kind, payload)).then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false, `${kind} was acknowledged before its ledger write`);

      commit.resolve(kind === "successful_payment"
        ? { credited: false, balance: "5" }
        : { changed: false, balance: "0", deductedAmount: "0", payment: {} });
      assert.equal((await responsePromise).status, 200);
    } finally {
      await close(server);
    }
  }
});

test("payment webhooks return non-2xx when their ledger write fails", async () => {
  enableTelegramPayments();
  const payload = createStarPurchasePayload({ userId: 123, amount: 5, nonce: "abcDEF12" });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const kind of ["successful_payment", "refunded_payment"]) {
      setTelegramStarLedgerForTests({
        async creditPayment() { throw new Error("database unavailable"); },
        async recordRefund() { throw new Error("database unavailable"); }
      });
      const server = createAppServer();
      const port = await listen(server);
      try {
        const response = await postTelegram(port, paymentUpdate(kind, payload, 2));
        assert.notEqual(response.status, 200);
      } finally {
        await close(server);
      }
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test("ordinary Telegram messages are acknowledged without waiting for NVIDIA or the ledger", async () => {
  enableTelegramPayments();
  setTelegramStarLedgerForTests({
    async reservePrompt() { return new Promise(() => {}); }
  });
  const server = createAppServer();
  const port = await listen(server);
  try {
    const response = await postTelegram(port, {
      update_id: 3,
      message: {
        message_id: 3,
        from: { id: 123 },
        chat: { id: 999, type: "private" },
        text: "hello"
      }
    });
    assert.equal(response.status, 200);
  } finally {
    await close(server);
  }
});

test("Mini App launch credentials require freshness and cannot be replayed", async () => {
  enableTelegramPayments();
  setTelegramStarLedgerForTests(webLedgerDouble());
  const server = createAppServer();
  const port = await listen(server);
  try {
    const launch = signedInitData();
    assert.equal((await requestJson(port, "/api/miniapp/state", { initData: launch })).status, 200);
    const replay = await requestJson(port, "/api/miniapp/state", { initData: launch });
    assert.equal(replay.status, 401);
    assert.match(replay.text, /already used/i);

    const stale = signedInitData({ authDate: Math.floor(Date.now() / 1000) - 301, userId: 124 });
    assert.equal((await requestJson(port, "/api/miniapp/state", { initData: stale })).status, 401);
  } finally {
    await close(server);
  }
});

test("public chat authenticates before JSON parsing and large public bodies are rejected early", async () => {
  enableTelegramPayments();
  setTelegramStarLedgerForTests(webLedgerDouble());
  const server = createAppServer();
  const port = await listen(server);
  try {
    assert.equal((await requestRaw(port, "/api/chat", "{broken")).status, 401);
    const oversized = JSON.stringify({ initData: "x".repeat(65_000) });
    assert.equal((await requestRaw(port, "/api/miniapp/state", oversized)).status, 413);
  } finally {
    await close(server);
  }
});

test("Mini App assistant modes are authenticated, durable, and origin protected", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  let selectedMode = "chat";
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getUserControl(userId) {
      return { userId: String(userId), banned: false, unlimitedCredits: false, persona: null, selectedMode };
    },
    async setUserMode(userId, mode) {
      selectedMode = mode;
      return { userId: String(userId), selectedMode };
    }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    assert.equal((await requestGet(port, "/api/modes")).status, 401);
    const session = await launchWebSession(port, 123);
    const headers = { authorization: `Bearer ${session}` };
    const catalog = await requestGet(port, "/api/modes", headers);
    assert.equal(catalog.status, 200, catalog.text);
    assert.ok(JSON.parse(catalog.text).modes.some((mode) => mode.id === "coding" && mode.enabled));

    const forged = await requestJson(port, "/api/modes/selection", { mode: "coding" }, {
      ...headers,
      origin: "https://attacker.example"
    });
    assert.equal(forged.status, 403);
    assert.equal(selectedMode, "chat");

    const changed = await requestJson(port, "/api/modes/selection", { mode: "coding" }, {
      ...headers,
      origin: process.env.PUBLIC_URL
    });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(selectedMode, "coding");
  } finally {
    await close(server);
  }
});

test("authenticated web AI uses durable credit and provider budgets exactly once", async () => {
  enableTelegramPayments();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  const reservations = [];
  const providerBudgets = [];
  const completions = [];
  setTelegramStarLedgerForTests(webLedgerDouble({
    async reservePrompt(userId, options) {
      reservations.push({ userId, ...options });
      return { reserved: true, state: "reserved", balance: "1" };
    },
    async reserveProviderCapacity(options) {
      providerBudgets.push(options);
      return { reserved: true, used: 1 };
    },
    async completePrompt(reservationId) { completions.push(reservationId); }
  }));
  global.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"Secure answer"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port);
    const requestId = crypto.randomUUID();
    const response = await requestJson(port, "/api/chat", {
      requestId,
      message: "hello",
      model: "meta/llama-3.1-8b-instruct"
    }, { authorization: `Bearer ${session}` });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /event: done/);
    assert.deepEqual(reservations, [{ userId: "123", reservationId: `web:123:${requestId}`, cost: 1 }]);
    assert.equal(providerBudgets.length, 1);
    assert.deepEqual(completions, [`web:123:${requestId}`]);
  } finally {
    await close(server);
  }
});

test("web AI does not call NVIDIA without credit and restores credit after provider failure", async () => {
  enableTelegramPayments();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  let nvidiaCalls = 0;
  setTelegramStarLedgerForTests(webLedgerDouble({
    async reservePrompt() { return { reserved: false, state: null, balance: "0" }; }
  }));
  global.fetch = async () => {
    nvidiaCalls += 1;
    return new Response("provider should not be called", { status: 500 });
  };
  let server = createAppServer();
  let port = await listen(server);
  let session;
  try {
    session = await launchWebSession(port);
    const noCredit = await requestJson(port, "/api/chat", {
      requestId: crypto.randomUUID(),
      message: "no credit"
    }, { authorization: `Bearer ${session}` });
    assert.equal(noCredit.status, 402);
    assert.equal(nvidiaCalls, 0);
  } finally {
    await close(server);
  }

  resetTelegramWebAuthForTests();
  const restored = [];
  setTelegramStarLedgerForTests(webLedgerDouble({
    async restorePrompt(reservationId) { restored.push(reservationId); }
  }));
  global.fetch = async () => {
    nvidiaCalls += 1;
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  };
  server = createAppServer();
  port = await listen(server);
  try {
    session = await launchWebSession(port);
    const requestId = crypto.randomUUID();
    const failed = await requestJson(port, "/api/chat", {
      requestId,
      message: "provider fails"
    }, { authorization: `Bearer ${session}` });
    assert.equal(failed.status, 200);
    assert.match(failed.text, /event: error/);
    assert.deepEqual(restored, [`web:123:${requestId}`]);
    assert.ok(nvidiaCalls >= 1);
  } finally {
    await close(server);
  }
});

test("admin APIs require a Telegram session and a live platform permission", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble());
  const securityEvents = [];
  setPlatformStoreForTests(platformStoreDouble({
    async writeSecurityEvent(event) { securityEvents.push(event); return { written: true }; }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    assert.equal((await requestGet(port, "/api/admin/overview")).status, 401);
    const session = await launchWebSession(port, 123);
    const forbidden = await requestGet(port, "/api/admin/overview", { authorization: `Bearer ${session}` });
    assert.equal(forbidden.status, 403, forbidden.text);
    assert.ok(securityEvents.some((event) => event.eventType === "admin_access_denied"));
  } finally {
    await close(server);
  }
});

test("configured super admin can read and idempotently mutate feature controls", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getStats() { return { accounts: "1", credits: "0", payments: "0", prompts: "0" }; }
  }));
  const mutations = [];
  setPlatformStoreForTests(platformStoreDouble({
    async setFeatureFlag(change) {
      mutations.push(change);
      return { duplicate: mutations.length > 1, feature: { key: change.featureKey, enabled: change.enabled } };
    }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 6643462826);
    const auth = { authorization: `Bearer ${session}` };
    const features = await requestGet(port, "/api/admin/features", auth);
    assert.equal(features.status, 200, features.text);
    assert.equal(JSON.parse(features.text).features[0].key, "admin_api");

    const requestId = crypto.randomUUID();
    const first = await requestJson(port, "/api/admin/features", {
      requestId,
      featureKey: "group_management",
      enabled: true
    }, { ...auth, origin: process.env.PUBLIC_URL });
    assert.equal(first.status, 200, first.text);
    assert.equal(mutations[0].actorUserId, "6643462826");

    const replay = await requestJson(port, "/api/admin/features", {
      requestId,
      featureKey: "group_management",
      enabled: true
    }, { ...auth, origin: process.env.PUBLIC_URL });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(JSON.parse(replay.text).duplicate, true);

    const forgedOrigin = await requestJson(port, "/api/admin/features", {
      requestId: crypto.randomUUID(),
      featureKey: "group_management",
      enabled: false
    }, { ...auth, origin: "https://attacker.example" });
    assert.equal(forgedOrigin.status, 403, forgedOrigin.text);
  } finally {
    await close(server);
  }
});

test("banned users cannot establish a Mini App session", async () => {
  enableTelegramPayments();
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getUserControl(userId) {
      return { userId: String(userId), banned: true, unlimitedCredits: false, persona: null };
    }
  }));
  setPlatformStoreForTests(platformStoreDouble());
  const server = createAppServer();
  const port = await listen(server);
  try {
    const response = await requestJson(port, "/api/miniapp/state", { initData: signedInitData({ userId: 123 }) });
    assert.equal(response.status, 403, response.text);
    assert.match(response.text, /not permitted/i);
  } finally {
    await close(server);
  }
});

test("Mini App direct routes serve the protected SPA shell with security headers", async () => {
  const server = createAppServer();
  const port = await listen(server);
  try {
    for (const path of ["/home", "/chat", "/groups", "/group/123", "/vouchers", "/admin/system", "/admin/analytics", "/admin/limits", "/admin/bots"]) {
      const response = await requestGet(port, path);
      assert.equal(response.status, 200, `${path}: ${response.text}`);
    assert.match(response.text, /Nemotron/);
      assert.match(response.headers["content-security-policy"], /telegram\.org/);
    }
  } finally {
    await close(server);
  }
});

test("model administration is authenticated, audited by the store, and updates the runtime allowlist", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getStats() { return { accounts: "1", credits: "0", payments: "0", prompts: "0" }; }
  }));
  const changes = [];
  setPlatformStoreForTests(platformStoreDouble({
    async setAiModelControl(change) {
      changes.push(change);
      return { duplicate: false, model: { id: change.modelId, enabled: true, featured: true } };
    }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 6643462826);
    const headers = { authorization: `Bearer ${session}` };
    assert.equal((await requestGet(port, "/api/admin/models", headers)).status, 200);
    const response = await requestJson(port, "/api/admin/models", {
      requestId: crypto.randomUUID(),
      modelId: "meta/model-a",
      featured: true
    }, { ...headers, origin: process.env.PUBLIC_URL });
    assert.equal(response.status, 200, response.text);
    assert.equal(changes[0].actorUserId, "6643462826");
  } finally {
    await close(server);
  }
});

test("billing history is scoped to the authenticated user while admins can query the ledger", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  const paymentQueries = [];
  const usageQueries = [];
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getStats() { return { accounts: "1", credits: "0", payments: "1", prompts: "1" }; },
    async listPayments(options) { paymentQueries.push(options); return [{ chargeId: "charge-1", userId: options.userId || "123" }]; },
    async listUsage(options) { usageQueries.push(options); return [{ reservationId: "prompt-1", userId: options.userId || "123" }]; }
  }));
  setPlatformStoreForTests(platformStoreDouble());
  const server = createAppServer();
  const port = await listen(server);
  try {
    const userSession = await launchWebSession(port, 123);
    const self = await requestGet(port, "/api/billing/history?limit=10", { authorization: `Bearer ${userSession}` });
    assert.equal(self.status, 200, self.text);
    assert.equal(paymentQueries[0].userId, "123");
    assert.equal(usageQueries[0].userId, "123");

    resetTelegramWebAuthForTests();
    const adminSession = await launchWebSession(port, 6643462826);
    const admin = await requestGet(port, "/api/admin/payments?userId=123&limit=20", { authorization: `Bearer ${adminSession}` });
    assert.equal(admin.status, 200, admin.text);
    assert.equal(paymentQueries.at(-1).userId, "123");
  } finally {
    await close(server);
  }
});

test("pricing changes require billing authority and immediately update the success-charge cost", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getStats() { return { accounts: "1", credits: "0", payments: "0", prompts: "0" }; }
  }));
  const changes = [];
  setPlatformStoreForTests(platformStoreDouble({
    async setBillingPrice(change) {
      changes.push(change);
      return { duplicate: false, price: { featureKey: change.featureKey, starCost: change.starCost } };
    }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 6643462826);
    const headers = { authorization: `Bearer ${session}` };
    assert.equal((await requestGet(port, "/api/admin/pricing", headers)).status, 200);
    const response = await requestJson(port, "/api/admin/pricing", {
      requestId: crypto.randomUUID(),
      featureKey: "ai_chat",
      starCost: 2
    }, { ...headers, origin: process.env.PUBLIC_URL });
    assert.equal(response.status, 200, response.text);
    assert.equal(changes[0].actorUserId, "6643462826");
    assert.equal(aiChatStarCost(), 2);
  } finally {
    await close(server);
  }
});

test("user administration rechecks privilege and reserves role and credit changes for the Super Admin", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getStats() { return { accounts: "1", credits: "4", payments: "0", prompts: "0" }; }
  }));
  const changes = [];
  const users = [{
    userId: "123",
    role: "standard_user",
    firstName: "Ada",
    lastName: null,
    username: "ada",
    banned: false,
    unlimitedCredits: false,
    balance: "4"
  }];
  setPlatformStoreForTests(platformStoreDouble({
    async listManagedUsers() { return users; },
    async getManagedUser() { return users[0]; },
    async manageUser(change) { changes.push(change); return { duplicate: false, user: { ...users[0], role: change.role || users[0].role } }; }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 6643462826);
    const headers = { authorization: `Bearer ${session}`, origin: process.env.PUBLIC_URL };
    const listed = await requestGet(port, "/api/admin/users?search=ada", headers);
    assert.equal(listed.status, 200, listed.text);
    const changed = await requestJsonMethod(port, "/api/admin/users/123", "PATCH", {
      requestId: crypto.randomUUID(),
      role: "premium_user",
      creditDelta: 5,
      unlimitedCredits: true,
      note: "Verified subscription"
    }, headers);
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changes[0].actorUserId, "6643462826");
    assert.equal(changes[0].creditDelta, 5);
  } finally {
    await close(server);
  }

  setTelegramStarLedgerForTests(webLedgerDouble({
    async getStats() { return { accounts: "1", credits: "4", payments: "0", prompts: "0" }; }
  }));
  let called = false;
  setPlatformStoreForTests(platformStoreDouble({
    async getUserRole(id) { return String(id) === "777" ? "admin" : "standard_user"; },
    async getManagedUser() { return users[0]; },
    async manageUser() { called = true; }
  }));
  const second = createAppServer();
  const secondPort = await listen(second);
  try {
    const adminSession = await launchWebSession(secondPort, 777);
    const denied = await requestJsonMethod(secondPort, "/api/admin/users/123", "PATCH", {
      requestId: crypto.randomUUID(),
      creditDelta: 1
    }, { authorization: `Bearer ${adminSession}`, origin: process.env.PUBLIC_URL });
    assert.equal(denied.status, 403, denied.text);
    assert.equal(called, false);
  } finally {
    await close(second);
  }
});

test("group Mini App APIs require current Telegram administrator status", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble());
  const group = { chatId: "-10077", title: "Nvid Test Group", chatType: "supergroup", active: true, botStatus: "administrator", botPermissions: {} };
  setPlatformStoreForTests(platformStoreDouble({
    async listTelegramGroups() { return [group]; },
    async getTelegramGroup() { return { group, settings: { enabled: true, moderationEnabled: true, guardEnabled: false }, actions: [], warnings: [], guardRequests: [] }; },
    async syncGroupMember() {}
  }));
  let actorIsAdmin = true;
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(options.body);
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 999, is_bot: true } }), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "getChatMember") {
      const result = String(payload.user_id) === "123"
        ? { status: actorIsAdmin ? "administrator" : "member", can_manage_chat: actorIsAdmin, user: { id: 123 } }
        : { status: "administrator", can_manage_chat: true, user: { id: 999 } };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 123);
    const headers = { authorization: `Bearer ${session}` };
    assert.equal((await requestGet(port, "/api/groups", headers)).status, 200);
    assert.equal((await requestGet(port, "/api/groups/-10077", headers)).status, 200);
    actorIsAdmin = false;
    const denied = await requestGet(port, "/api/groups/-10077", headers);
    assert.equal(denied.status, 403, denied.text);
  } finally {
    await close(server);
  }
});

test("Telegram capability API is authenticated and returns safe runtime state", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble());
  setPlatformStoreForTests(platformStoreDouble({
    async listTelegramGroups() { return [{ chatId: "-1001", active: true, botIsAdministrator: true, chatType: "supergroup" }]; },
    async listBusinessConnections() { return []; },
    async listCapabilityVerifications() { return []; }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    assert.equal((await requestGet(port, "/api/telegram/capabilities")).status, 401);
    const session = await launchWebSession(port, 123);
    const response = await requestGet(port, "/api/telegram/capabilities", { authorization: `Bearer ${session}` });
    assert.equal(response.status, 200, response.text);
    const data = JSON.parse(response.text);
    assert.ok(data.capabilities.some((entry) => entry.id === "group_access"));
    assert.ok(data.capabilities.some((entry) => entry.id === "telegram_secretary"));
    assert.ok(data.capabilities.some((entry) => entry.id === "payments"));
    assert.equal(response.text.includes("test-token"), false);
    assert.equal(response.text.includes("TELEGRAM_BOT_TOKEN"), false);
  } finally {
    await close(server);
  }
});

test("Always On group activation requires live creator confirmation", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble());
  let actorStatus = "administrator";
  const updates = [];
  setPlatformStoreForTests(platformStoreDouble({
    async syncGroupMember() {},
    async updateGroupSettings(input) { updates.push(input); return { duplicate: false, settings: input.changes }; }
  }));
  global.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(options.body);
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 999, is_bot: true } }), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "getChatMember") {
      const result = String(payload.user_id) === "123"
        ? { status: actorStatus, can_manage_chat: true, user: { id: 123 } }
        : { status: "administrator", can_manage_chat: true, user: { id: 999 } };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 123);
    const headers = { authorization: `Bearer ${session}`, origin: process.env.PUBLIC_URL };
    const denied = await requestJsonMethod(port, "/api/groups/-10077/settings", "PATCH", {
      requestId: crypto.randomUUID(),
      changes: { activationPolicy: "always_on", alwaysOnConfirmed: true }
    }, headers);
    assert.equal(denied.status, 403, denied.text);
    assert.equal(updates.length, 0);

    actorStatus = "creator";
    const allowed = await requestJsonMethod(port, "/api/groups/-10077/settings", "PATCH", {
      requestId: crypto.randomUUID(),
      changes: { activationPolicy: "always_on", alwaysOnConfirmed: true }
    }, headers);
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].changes.activationPolicy, "always_on");
  } finally {
    await close(server);
  }
});

test("durable conversation lease blocks a duplicate generation across simulated instances", async () => {
  enableTelegramPayments();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  setTelegramStarLedgerForTests(webLedgerDouble());
  const leases = new Map();
  setPlatformStoreForTests(platformStoreDouble({
    async acquireLease({ key, ownerId }) {
      if (leases.has(key)) return { acquired: false };
      leases.set(key, ownerId);
      return { acquired: true, key, ownerId };
    },
    async releaseLease({ key, ownerId }) {
      if (leases.get(key) !== ownerId) return false;
      leases.delete(key);
      return true;
    }
  }));
  const provider = deferred();
  global.fetch = async () => provider.promise;
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 123);
    const conversationId = crypto.randomUUID();
    const first = requestJson(port, "/api/chat", {
      requestId: crypto.randomUUID(),
      conversationId,
      message: "first"
    }, { authorization: `Bearer ${session}` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const duplicate = await requestJson(port, "/api/chat", {
      requestId: crypto.randomUUID(),
      conversationId,
      message: "duplicate"
    }, { authorization: `Bearer ${session}` });
    assert.equal(duplicate.status, 409, duplicate.text);
    provider.resolve(new Response(
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));
    assert.equal((await first).status, 200);
    assert.equal(leases.size, 0);
  } finally {
    await close(server);
  }
});

test("browser response completion failure becomes recoverable and is never restored", async () => {
  enableTelegramPayments();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  const transitions = [];
  const restored = [];
  setTelegramStarLedgerForTests(webLedgerDouble({
    async transitionPrompt(_reservationId, state) { transitions.push(state); return { changed: true, state }; },
    async completePrompt() { throw new Error("database temporarily unavailable"); },
    async restorePrompt(reservationId) { restored.push(reservationId); }
  }));
  global.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"produced answer"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  const originalConsoleError = console.error;
  console.error = () => {};
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 123);
    const response = await requestJson(port, "/api/chat", {
      requestId: crypto.randomUUID(),
      message: "produce then recover"
    }, { authorization: `Bearer ${session}` });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /event: done/);
    assert.deepEqual(transitions, ["generation_started", "response_produced", "delivery_attempted", "delivered", "completion_pending"]);
    assert.deepEqual(restored, []);
  } finally {
    console.error = originalConsoleError;
    await close(server);
  }
});

test("Mini App replay claims remain effective across simulated instances", async () => {
  enableTelegramPayments();
  setTelegramStarLedgerForTests(webLedgerDouble());
  const fingerprints = new Set();
  setPlatformStoreForTests(platformStoreDouble({
    async claimReplay({ fingerprint }) {
      if (fingerprints.has(fingerprint)) return false;
      fingerprints.add(fingerprint);
      return true;
    }
  }));
  const launch = signedInitData({ userId: 321 });
  let server = createAppServer();
  let port = await listen(server);
  try {
    assert.equal((await requestJson(port, "/api/miniapp/state", { initData: launch })).status, 200);
  } finally {
    await close(server);
  }
  resetTelegramWebAuthForTests();
  server = createAppServer();
  port = await listen(server);
  try {
    assert.equal((await requestJson(port, "/api/miniapp/state", { initData: launch })).status, 401);
  } finally {
    await close(server);
  }
});

test("billable chat rechecks a platform restriction after session issuance", async () => {
  enableTelegramPayments();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getStats() { return { accounts: "1", credits: "0", payments: "0", prompts: "0" }; }
  }));
  let role = "standard_user";
  const securityEvents = [];
  setPlatformStoreForTests(platformStoreDouble({
    async getUserRole() { return role; },
    async writeSecurityEvent(event) { securityEvents.push(event); return { written: true }; }
  }));
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 123);
    role = "restricted_user";
    const denied = await requestJson(port, "/api/chat", {
      requestId: crypto.randomUUID(),
      message: "must not run"
    }, { authorization: `Bearer ${session}` });
    assert.equal(denied.status, 403, denied.text);
    assert.equal(providerCalls, 0);
    assert.ok(securityEvents.some((event) => event.eventType === "current_user_authorization_denied"));
  } finally {
    await close(server);
  }
});

test("billable chat and direct APIs recheck a Telegram ban after session issuance", async () => {
  enableTelegramPayments();
  let banned = false;
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getUserControl(userId) {
      return { userId: String(userId), banned, unlimitedCredits: false, selectedMode: "chat" };
    }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 123);
    banned = true;
    const headers = { authorization: `Bearer ${session}` };
    assert.equal((await requestGet(port, "/api/modes", headers)).status, 403);
    assert.equal((await requestJson(port, "/api/chat", {
      requestId: crypto.randomUUID(),
      message: "blocked"
    }, headers)).status, 403);
  } finally {
    await close(server);
  }
});

test("configured administrator remains authorized with a current valid session", async () => {
  enableTelegramPayments();
  process.env.NVIDIA_API_KEY = "nvapi-test";
  setTelegramStarLedgerForTests(webLedgerDouble({
    async getStats() { return { accounts: "1", credits: "0", payments: "0", prompts: "0" }; }
  }));
  setPlatformStoreForTests(platformStoreDouble({ async getUserRole() { return "admin"; } }));
  global.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"admin answer"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 6643462826);
    const response = await requestJson(port, "/api/chat", {
      requestId: crypto.randomUUID(),
      message: "admin request"
    }, { authorization: `Bearer ${session}` });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /event: done/);
  } finally {
    await close(server);
  }
});

test("trusted proxy resolution ignores forged leftmost forwarding entries", () => {
  const request = {
    headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.12" },
    socket: { remoteAddress: "10.0.0.4" }
  };
  assert.equal(resolveClientIp(request, {}), "10.0.0.4");
  assert.equal(resolveClientIp(request, { RENDER: "true" }), "198.51.100.12");
  assert.equal(resolveClientIp({ headers: { "x-forwarded-for": "forged" }, socket: { remoteAddress: "127.0.0.1" } }, { TRUST_PROXY: "render" }), "127.0.0.1");
});

test("readiness keeps core interfaces available while NVIDIA is degraded", async () => {
  process.env.TELEGRAM_STARS_REQUIRED = "false";
  setPlatformStoreForTests(platformStoreDouble({
    async health() { return { ok: true, latencyMs: 1, migrationVersion: "test" }; }
  }));
  recordNvidiaRequest({ ok: false, statusCode: 503, latencyMs: 10 });
  recordNvidiaRequest({ ok: false, statusCode: 503, latencyMs: 10 });
  recordNvidiaRequest({ ok: false, statusCode: 503, latencyMs: 10 });
  const server = createAppServer();
  const port = await listen(server);
  try {
    const response = await requestGet(port, "/health/ready");
    const health = JSON.parse(response.text);
    assert.equal(response.status, 200);
    assert.equal(health.ready, true);
    assert.equal(health.status, "degraded");
    assert.equal(health.aiGenerationAvailable, false);
    assert.equal(health.services.nvidia.requiredForReadiness, false);
  } finally {
    await close(server);
  }
});

test("startup accepts initialized local services while Telegram setup is pending; readiness stays strict", async () => {
  enableTelegramPayments();
  process.env.TELEGRAM_PAYMENTS_ENABLED = "true";
  setPlatformStoreForTests(platformStoreDouble({ async health() { return { ok: true }; } }));
  setTelegramStarLedgerForTests({
    async init() {},
    async refundStaleReservations() { return { restoredCount: 0 }; }
  });
  const entered = deferred(), release = deferred();
  global.fetch = async () => {
    entered.resolve();
    await release.promise;
    return new Response(JSON.stringify({ ok: false, error_code: 503 }), { status: 503 });
  };
  const setup = configureTelegramBot().catch(error => error);
  await entered.promise;
  const server = createAppServer(), port = await listen(server);
  try {
    const startup = await requestGet(port, "/health/startup");
    const readiness = await requestGet(port, "/health/ready");
    assert.equal(startup.status, 200);
    assert.equal(JSON.parse(startup.text).telegramConfigured, false);
    assert.equal(JSON.parse(startup.text).services.paymentLedger.ok, true);
    assert.equal(readiness.status, 503);
  } finally {
    release.resolve();
    await setup;
    await close(server);
  }
});

test("startup rejects an unavailable payment ledger", async () => {
  enableTelegramPayments();
  process.env.TELEGRAM_PAYMENTS_ENABLED = "true";
  setPlatformStoreForTests(platformStoreDouble({ async health() { return { ok: true }; } }));
  setTelegramStarLedgerForTests({ async init() { throw new Error("fixture ledger unavailable"); } });
  await assert.rejects(configureTelegramBot(), /ledger unavailable/);
  const server = createAppServer(), port = await listen(server);
  try {
    const response = await requestGet(port, "/health/startup");
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.text).services.paymentLedger.ok, false);
  } finally { await close(server); }
});

test("startup rejects an unavailable database even when Telegram payments are disabled", async () => {
  process.env.TELEGRAM_PAYMENTS_ENABLED = "false";
  setPlatformStoreForTests(platformStoreDouble({ async health() { return { ok: false }; } }));
  const server = createAppServer(), port = await listen(server);
  try {
    const response = await requestGet(port, "/health/startup");
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.text).services.database.ok, false);
  } finally { await close(server); }
});

test("liveness stays available and readiness reports NVIDIA as unconfigured without its key", async () => {
  delete process.env.NVIDIA_API_KEY;
  process.env.TELEGRAM_STARS_REQUIRED = "false";
  setPlatformStoreForTests(platformStoreDouble({
    async health() { return { ok: true, latencyMs: 1, migrationVersion: "test" }; }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const liveResponse = await requestGet(port, "/health/live");
    const readyResponse = await requestGet(port, "/health/ready");
    const health = JSON.parse(readyResponse.text);
    assert.equal(liveResponse.status, 200);
    assert.equal(readyResponse.status, 200);
    assert.equal(health.status, "degraded");
    assert.equal(health.aiGenerationAvailable, false);
    assert.deepEqual(health.services.nvidia, {
      ok: false,
      status: "unconfigured",
      requiredForReadiness: false
    });
  } finally {
    await close(server);
  }
});

test("WhatsApp AI is denied safely when its production feature flag is disabled", async () => {
  process.env.META_APP_SECRET = "meta-test-secret";
  const securityEvents = [];
  setPlatformStoreForTests(platformStoreDouble({
    async isFeatureEnabled() { return false; },
    async writeSecurityEvent(event) { securityEvents.push(event); return { written: true }; }
  }));
  let providerCalls = 0;
  global.fetch = async () => { providerCalls += 1; return new Response("unexpected", { status: 500 }); };
  const payload = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ from: "15551234567", text: { body: "hello" } }] } }] }]
  });
  const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(payload).digest("hex")}`;
  const server = createAppServer();
  const port = await listen(server);
  try {
    const response = await requestRaw(port, "/webhooks/whatsapp", payload, { "x-hub-signature-256": signature });
    assert.equal(response.status, 200);
    assert.match(response.text, /disabled/);
    assert.equal(providerCalls, 0);
    assert.ok(securityEvents.some((event) => event.eventType === "whatsapp_ai_denied"));
  } finally {
    await close(server);
  }
});

test("conversation APIs create, list, rename, open, and soft-delete owned history", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble());
  const conversations = new Map();
  setPlatformStoreForTests(platformStoreDouble({
    async getOrCreateConversation(input) {
      const conversation = {
        id: input.conversationId,
        userId: String(input.userId),
        channel: input.channel,
        title: input.title,
        updatedAt: new Date().toISOString()
      };
      conversations.set(conversation.id, conversation);
      return conversation;
    },
    async listConversations(userId) { return [...conversations.values()].filter((item) => item.userId === String(userId)); },
    async getConversation(userId, id) {
      const conversation = conversations.get(id);
      return conversation?.userId === String(userId) ? { conversation, messages: [] } : null;
    },
    async renameConversation(userId, id, title) {
      const conversation = conversations.get(id);
      if (conversation?.userId !== String(userId)) return null;
      conversation.title = title;
      return conversation;
    },
    async deleteConversation(userId, id) {
      const conversation = conversations.get(id);
      return conversation?.userId === String(userId) ? conversations.delete(id) : false;
    }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const session = await launchWebSession(port, 123);
    const headers = { authorization: `Bearer ${session}`, origin: process.env.PUBLIC_URL };
    const created = await requestJson(port, "/api/conversations", { title: "Persistent project" }, headers);
    assert.equal(created.status, 201, created.text);
    const id = JSON.parse(created.text).conversation.id;
    assert.equal((await requestGet(port, "/api/conversations", headers)).status, 200);
    assert.equal((await requestGet(port, `/api/conversations/${id}`, headers)).status, 200);
    const renamed = await requestJsonMethod(port, `/api/conversations/${id}`, "PATCH", { title: "Renamed project" }, headers);
    assert.equal(renamed.status, 200, renamed.text);
    assert.match(renamed.text, /Renamed project/);
    assert.equal((await requestJsonMethod(port, `/api/conversations/${id}`, "DELETE", null, headers)).status, 200);
  } finally {
    await close(server);
  }
});

test("assistant mutation APIs enforce repository ownership", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble());
  const assistantId = "55555555-5555-4555-8555-555555555555";
  setPlatformStoreForTests(platformStoreDouble({
    async listAssistants() { return []; },
    async createAssistant(userId, data) { return { id: assistantId, ownerUserId: String(userId), name: data.name }; },
    async updateAssistant(userId, id, data) {
      return String(userId) === "123" && id === assistantId ? { id, ownerUserId: "123", name: data.name } : null;
    },
    async deleteAssistant(userId, id) { return String(userId) === "123" && id === assistantId; }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const ownerSession = await launchWebSession(port, 123);
    resetTelegramWebAuthForTests();
    const otherSession = await launchWebSession(port, 456);
    const ownerHeaders = { authorization: `Bearer ${ownerSession}`, origin: process.env.PUBLIC_URL };
    const created = await requestJson(port, "/api/assistants", { name: "Owner assistant" }, ownerHeaders);
    assert.equal(created.status, 201, created.text);
    const denied = await requestJsonMethod(port, `/api/assistants/${assistantId}`, "PATCH", { name: "Stolen" }, {
      authorization: `Bearer ${otherSession}`,
      origin: process.env.PUBLIC_URL
    });
    assert.equal(denied.status, 404);
  } finally {
    await close(server);
  }
});

test("website Telegram sessions use secure cookies, current authorization, and CSRF for mutations", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble());
  const token = "t".repeat(64);
  const csrf = "c".repeat(48);
  let redeemed = 0;
  let revoked = 0;
  setPlatformStoreForTests(platformStoreDouble({
    async getWebSession(value) {
      if (value !== token || revoked) return null;
      return { session_id: "77777777-7777-4777-8777-777777777777", user_id: "123", csrf_hash: crypto.createHash("sha256").update(csrf).digest("hex") };
    },
    async consumeSharedRateLimit() { return { allowed: true }; },
    async redeemVoucher() { redeemed += 1; return { redeemed: true, creditsAdded: 5, balance: "7" }; },
    async revokeWebSession() { revoked += 1; return true; }
  }));
  const server = createAppServer();
  const port = await listen(server);
  const cookie = `__Host-nvid_session=${token}; nvid_csrf=${csrf}`;
  try {
    const session = await requestGet(port, "/api/web/session", { cookie });
    assert.equal(session.status, 200, session.text);
    assert.equal(JSON.parse(session.text).user.userId, "123");
    const missingCsrf = await requestJson(port, "/api/vouchers/redeem", { code: "NVID-TEST" }, { cookie, origin: process.env.PUBLIC_URL });
    assert.equal(missingCsrf.status, 403);
    const wrongCsrf = await requestJson(port, "/api/vouchers/redeem", { code: "NVID-TEST" }, { cookie, origin: process.env.PUBLIC_URL, "x-csrf-token": "wrong" });
    assert.equal(wrongCsrf.status, 403);
    const valid = await requestJson(port, "/api/vouchers/redeem", { code: "NVID-TEST" }, { cookie, origin: process.env.PUBLIC_URL, "x-csrf-token": csrf });
    assert.equal(valid.status, 200, valid.text);
    assert.equal(redeemed, 1);
    const logout = await requestJsonMethod(port, "/api/web/logout", "POST", null, { cookie, origin: process.env.PUBLIC_URL, "x-csrf-token": csrf });
    assert.equal(logout.status, 200, logout.text);
    assert.equal(revoked, 1);
  } finally {
    await close(server);
  }
});

test("analytics and voucher administration remain server-authorized and exclude raw messages", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble());
  const analytics = { total_users: 12, secretary_ai_replies: 4, voucher_redemptions: 2 };
  setPlatformStoreForTests(platformStoreDouble({
    async getUserRole(id) { return String(id) === "6643462826" ? "super_admin" : "standard_user"; },
    async getAdminAnalytics() { return analytics; },
    async listVouchers() { return [{ voucher_id: crypto.randomUUID(), display_prefix: "NVID-ABCD", credit_amount: 5, maximum_redemptions: 1, redemptions_used: 0, active: true }]; }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const ordinary = await launchWebSession(port, 123);
    assert.equal((await requestGet(port, "/api/admin/analytics", { authorization: `Bearer ${ordinary}` })).status, 403);
    resetTelegramWebAuthForTests();
    const admin = await launchWebSession(port, 6643462826);
    const response = await requestGet(port, "/api/admin/analytics", { authorization: `Bearer ${admin}` });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(JSON.parse(response.text).analytics, analytics);
    assert.doesNotMatch(response.text, /conversation|message_content|raw_message/i);
    assert.equal((await requestGet(port, "/api/admin/vouchers", { authorization: `Bearer ${admin}` })).status, 200);
  } finally {
    await close(server);
  }
});

test("usage policies and payment CSV exports are administrator-authorized and safe", async () => {
  enableTelegramPayments();
  process.env.PUBLIC_URL = "https://nvidbot.onrender.com";
  setTelegramStarLedgerForTests(webLedgerDouble({
    async listPayments() {
      return [{ chargeId: "=unsafe-formula", userId: "123", amount: 5, currency: "XTR", creditedAt: "2026-07-20T10:00:00.000Z", refundedAt: null, refundedAmount: null }];
    }
  }));
  const policies = [{ policy_id: crypto.randomUUID(), scope_type: "global", scope_id: "*", free_successes: 2, window_seconds: 3600, active: true }];
  setPlatformStoreForTests(platformStoreDouble({
    async getUserRole(id) { return String(id) === "6643462826" ? "super_admin" : "standard_user"; },
    async listUsagePolicies() { return policies; }
  }));
  const server = createAppServer();
  const port = await listen(server);
  try {
    const ordinary = await launchWebSession(port, 123);
    assert.equal((await requestGet(port, "/api/admin/usage-policies", { authorization: `Bearer ${ordinary}` })).status, 403);
    assert.equal((await requestGet(port, "/api/admin/payments.csv", { authorization: `Bearer ${ordinary}` })).status, 403);
    resetTelegramWebAuthForTests();
    const admin = await launchWebSession(port, 6643462826);
    const policyResponse = await requestGet(port, "/api/admin/usage-policies", { authorization: `Bearer ${admin}` });
    assert.equal(policyResponse.status, 200, policyResponse.text);
    assert.deepEqual(JSON.parse(policyResponse.text).policies, policies);
    const exportResponse = await requestGet(port, "/api/admin/payments.csv", { authorization: `Bearer ${admin}` });
    assert.equal(exportResponse.status, 200, exportResponse.text);
    assert.match(exportResponse.headers["content-type"], /^text\/csv/);
    assert.match(exportResponse.headers["content-disposition"], /nvid-ai-payments\.csv/);
    assert.match(exportResponse.text, /"'=unsafe-formula"/);
    assert.doesNotMatch(exportResponse.text, /provider.*secret|bot.*token/i);
  } finally {
    await close(server);
  }
});
