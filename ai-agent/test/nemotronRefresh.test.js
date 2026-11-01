import test from "node:test";
import assert from "node:assert/strict";
import { PROFESSIONAL_TONE, stripGreeting, repetitiveOpening, boundedContext, openingStream } from "../src/responseStyle.js";
import { effectiveFreePolicy, createLimitNotices } from "../src/freeAllowance.js";
import { keyboardCommand, keyboardLabel, telegramCommandKeyboard, createCommandInputs } from "../src/telegramKeyboard.js";
import { createMilestoneStore } from "../src/milestoneStore.js";
import { reply, streamReply } from "../src/agent.js";
import { setPlatformStoreForTests } from "../src/platformRuntime.js";
import { handleTelegram, setTelegramStarLedgerForTests } from "../src/channels.js";

test("professional tone strips only stock openers, not occurrences in the body", () => {
  assert.equal(PROFESSIONAL_TONE, "Never greet or introduce yourself after the first message. Never open with Hello, Hi, Sure or Great question. Answer directly, short and professional.");
  assert.equal(stripGreeting("Hello! Sure, The answer is 42. Say Hi to Ada."), "The answer is 42. Say Hi to Ada.");
  assert.equal(stripGreeting("Surety is a contractual guarantee."), "Surety is a contractual guarantee.");
  assert.equal(stripGreeting("Great question. I'm Nemotron, your assistant. Use this command."), "Use this command.");
});

test("opening comparison considers only the last three assistant replies", () => {
  const same = { role: "assistant", content: "Here are the steps you need. Old details." };
  assert.equal(repetitiveOpening("Here are the steps you need. New details.", [same]), true);
  assert.equal(repetitiveOpening("Here are the steps you need. New details.", [same, ...Array.from({ length: 3 }, () => ({ role: "assistant", content: "Different answer." }))]), false);
  assert.equal(repetitiveOpening("42", [{ role: "assistant", content: "42" }]), false);
});

test("history uses 12 bounded recent messages plus an untrusted extractive summary", () => {
  const history = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ${"x".repeat(4000)}` }));
  const context = boundedContext(history);
  assert.equal(context.length, 13);
  assert.match(context[0].content, /untrusted historical excerpts/);
  assert.ok(context[0].content.length < 1650);
  assert.ok(context.slice(1).every((message) => message.content.length <= 2400));
  assert.ok(context.at(-1).content.startsWith("23 "));
});

test("opening filter buffers split greetings then streams ordinary replies", async () => {
  const output = [];
  const filter = openingStream([], (delta) => output.push(delta));
  await filter.push("Hel");
  await filter.push("lo! Here is the answer. ");
  await filter.push("Details.");
  await filter.finish();
  assert.equal(output.join(""), "Here is the answer. Details.");
});

test("default quota is 2/minute and explicit user or non-default policies survive", () => {
  assert.deepEqual(effectiveFreePolicy(), { freeLimit: 2, windowSeconds: 60 });
  assert.equal(effectiveFreePolicy({ scope_type: "global", scope_id: "*", free_successes: 2, window_seconds: 3600 }).windowSeconds, 60);
  assert.equal(effectiveFreePolicy({ scope_type: "user", free_successes: 2, window_seconds: 3600 }).windowSeconds, 3600);
  assert.equal(effectiveFreePolicy({ scope_type: "global", free_successes: 10, window_seconds: 3600 }).freeLimit, 10);
});

test("notice suppression is isolated, bounded and resumes at the sliding reset", () => {
  let time = 1000;
  const notices = createLimitNotices({ now: () => time, capacity: 2 });
  assert.equal(notices.shouldNotify("user:private", 60_000), true);
  assert.equal(notices.shouldNotify("user:private", 60_000), false);
  assert.equal(notices.shouldNotify("other:private", 60_000), true);
  time = 60_000;
  assert.equal(notices.shouldNotify("user:private", 120_000), true);
});

test("keyboard layout, current owner-only row and bounded input isolation", () => {
  const labels = (owner) => telegramCommandKeyboard(owner).keyboard.map((row) => row.map((button) => keyboardLabel(button.text)));
  assert.deepEqual(labels(false), [["Dashboard", "Modes"], ["Persona", "Models"], ["Switch Model", "Reset Chat"], ["Help"]]);
  assert.deepEqual(labels(true).at(-1), ["Admin Panel"]);
  assert.equal(telegramCommandKeyboard().is_persistent, true);
  for (const [label, name] of Object.entries({ Dashboard: "dashboard", Modes: "modes", Persona: "persona", Models: "models", "Switch Model": "model", "Reset Chat": "reset", Help: "help", "Admin Panel": "dashboard" })) {
    assert.equal(keyboardCommand(label).name, name);
  }
  assert.equal(keyboardCommand("ordinary AI prompt"), null);
  let time = 1000;
  const inputs = createCommandInputs({ now: () => time });
  inputs.remember("user:chat:thread", "Persona");
  assert.equal(inputs.take("another:chat:thread", "data"), null);
  assert.equal(inputs.take("user:chat:thread", "professional").name, "persona");
  assert.equal(inputs.take("user:chat:thread", "next"), null);
  inputs.remember("user:chat:thread", "Switch Model");
  time += 120_000;
  assert.equal(inputs.take("user:chat:thread", "1"), null);
});

test("sliding quota uses creation times consistently, reserves atomically and releases failures", async () => {
  let time = 100_000;
  const events = [];
  const rows = (items = []) => ({ rows: items, rowCount: items.length });
  const client = { async query(sql, params = []) {
    if (sql.includes("pg_advisory_xact_lock")) {
      assert.match(params[0], /^free-usage:/);
      return rows();
    }
    if (sql.includes("WHERE idempotency_key = $1") && sql.startsWith("SELECT")) {
      return rows(events.filter((e) => e.key === params[0]));
    }
    if (sql.includes("SELECT role, plan")) return rows([{ role: "standard_user", plan: "standard" }]);
    if (sql.includes("FROM ai_usage_policies")) {
      // $1 is also a TEXT scope ID in this query, so BIGINT user comparisons
      // need an explicit cast instead of PostgreSQL's ambiguous inference.
      if (sql.includes("SELECT role FROM")) {
        assert.match(sql, /SELECT role FROM platform_users WHERE user_id = \$1::bigint/);
        assert.match(sql, /SELECT plan FROM platform_users WHERE user_id = \$1::bigint/);
      }
      return rows([{ scope_type: "global", scope_id: "*", free_successes: 2, window_seconds: 3600 }]);
    }
    if (sql.includes("COUNT(*)::int AS used")) {
      assert.equal(params[3], 60);
      assert.match(sql, /status IN \('reserved', 'completed'\)/);
      assert.match(sql, /created_at > NOW/);
      const active = events.filter((e) => e.owner === params[0] && e.channel === params[2] && ["reserved", "completed"].includes(e.status) && e.at > time - params[3] * 1000);
      return rows([{ used: active.length, oldest: active.length ? new Date(Math.min(...active.map((e) => e.at))) : null }]);
    }
    if (sql.includes("INSERT INTO ai_usage_events")) {
      events.push({ key: params[1], owner: params[2], channel: params[5], at: time, status: "reserved" });
      return rows();
    }
    if (sql.includes("UPDATE ai_usage_events")) {
      const item = events.find((e) => e.key === params[0]);
      if (item) item.status = params[1];
      return rows(item ? [{ status: item.status }] : []);
    }
    throw new Error(`Unexpected query: ${sql.slice(0, 50)}`);
  } };
  const store = createMilestoneStore({ transaction: (operation) => operation(client), ensureUserWithClient: async () => {} });
  const reserve = (id) => store.reserveFreeUsage({ idempotencyKey: id, ownerUserId: "123", channel: "telegram_private" });
  assert.equal((await reserve("one")).reserved, true);
  time += 20_000;
  assert.equal((await reserve("two")).reserved, true);
  const limit = await reserve("three");
  assert.equal(limit.exhausted, true);
  assert.equal(limit.resetAt.getTime(), 160_000);
  assert.equal((await store.getUsageAllowance("123", { channel: "telegram_private" })).remaining, 0);
  assert.equal((await reserve("one")).duplicate, true);
  await store.finishUsageEvent("two", { success: false });
  assert.equal((await store.getUsageAllowance("123", { channel: "telegram_private" })).remaining, 1);
  time = 160_000;
  assert.equal((await store.getUsageAllowance("123", { channel: "telegram_private" })).remaining, 2);
  assert.equal((await reserve("three")).reserved, true);
});

async function withFakeProvider(run) {
  const names = ["NVIDIA_API_KEY", "NVIDIA_MODEL", "NVIDIA_MODELS", "NVIDIA_AUTO_TOOLS", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_USER_ID", "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_STARS_REQUIRED"];
  const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const fetch = globalThis.fetch;
  process.env.NVIDIA_API_KEY = "test-only-key";
  process.env.NVIDIA_MODEL = "meta/llama-3.1-8b-instruct";
  process.env.NVIDIA_MODELS = "meta/llama-3.1-8b-instruct";
  process.env.NVIDIA_AUTO_TOOLS = "false";
  try { await run(); } finally {
    globalThis.fetch = fetch;
    setPlatformStoreForTests(null);
    setTelegramStarLedgerForTests(null);
    for (const name of names) if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  }
}

test("stream regeneration is once only, publishes one clean answer and persists one turn", async () => withFakeProvider(async () => {
  let calls = 0, begun = 0, finished = 0;
  setPlatformStoreForTests({
    async getOrCreateConversation() { return { id: "test-conversation" }; },
    async conversationContext() { return [{ role: "assistant", content: "Here are the steps you need. Previous details." }]; },
    async beginConversationTurn() { begun += 1; return { assistantMessageId: "answer" }; },
    async finishConversationTurn() { finished += 1; }
  });
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.frequency_penalty, 0.15);
    assert.match(body.messages[0].content, /conversation has already begun/);
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"Sure! Here are the steps you need. Fresh details."}}]}\n\ndata: [DONE]\n\n');
    return new Response(JSON.stringify({ choices: [{ message: { content: "Run the migration before restarting the server." } }] }));
  };
  const chunks = [];
  const answer = await streamReply({ conversationId: "regen", text: "help", persistence: { userId: "123" }, onDelta: (delta) => chunks.push(delta) });
  assert.equal(answer, "Run the migration before restarting the server.");
  assert.equal(chunks.join(""), answer);
  assert.equal(calls, 2);
  assert.equal(begun, 1);
  assert.equal(finished, 1);
}));

test("failed correction keeps the usable original and does not retry correction", async () => withFakeProvider(async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls > 1) return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Here are the steps you need. Complete useful details." } }] }));
  };
  const answer = await reply({ conversationId: "failed-correction", text: "help", history: [{ role: "assistant", content: "Here are the steps you need. Older." }] });
  assert.match(answer, /Complete useful details/);
  assert.equal(calls, 2);
}));

test("an accepted request has at most one network retry", async () => withFakeProvider(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("busy", { status: 503, headers: { "retry-after": "0" } }); };
  await assert.rejects(reply({ conversationId: "retry-budget", text: "help" }), /503/);
  assert.equal(calls, 2);
}));

function message(text, id, user = 88001, chat = 88001) {
  return { update_id: id, message: { message_id: id, from: { id: user }, chat: { id: chat, type: "private" }, text } };
}

test("every keyboard tap reuses command handlers; stale owner buttons cannot grant access", async () => withFakeProvider(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "test-only-token";
  process.env.TELEGRAM_ADMIN_USER_ID = "99999";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_STARS_REQUIRED = "false";
  let roleReads = 0, inputsSaved = 0;
  const sent = [];
  setPlatformStoreForTests({ async getUserRole() { roleReads += 1; return "standard_user"; } });
  setTelegramStarLedgerForTests({
    async getUserControl() { return { selectedMode: "chat", persona: null }; },
    async setUserPersona(_id, text) { assert.equal(text, "Keep it concise"); inputsSaved += 1; }
  });
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, "api.telegram.org", "Commands must not invoke AI");
    sent.push({ method: new URL(url).pathname.split("/").at(-1), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: true }));
  };
  for (const [i, label] of ["Dashboard", "Modes", "Persona", "Models", "Switch Model", "Reset Chat", "Help"].entries()) {
    await handleTelegram(message(label, i + 1));
  }
  assert.equal(roleReads, 7);
  assert.equal(sent.filter((item) => item.method === "sendMessage").length, 7);
  assert.ok(sent.find((item) => item.body.reply_markup?.inline_keyboard), "Existing dashboard inline link stays intact");
  await handleTelegram(message("Persona", 10));
  await handleTelegram(message("Keep it concise", 11));
  assert.equal(inputsSaved, 1);
  process.env.TELEGRAM_ADMIN_USER_ID = "88001";
  await handleTelegram(message("Help", 12));
  assert.equal(keyboardLabel(sent.at(-1).body.reply_markup.keyboard.at(-1)[0].text), "Admin Panel");
  process.env.TELEGRAM_ADMIN_USER_ID = "99999";
  await handleTelegram(message("Admin Panel", 13));
  assert.match(sent.at(-1).body.text, /only to the configured bot administrator/);
  assert.equal(sent.at(-1).body.reply_markup.keyboard.some((row) => row.some((button) => keyboardLabel(button.text) === "Admin Panel")), false);
}));

test("limited Telegram requests notify once, invoke no AI, and commands remain free", async () => withFakeProvider(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "test-only-token";
  process.env.TELEGRAM_STARS_REQUIRED = "true";
  process.env.TELEGRAM_ADMIN_USER_ID = "99999";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  const notices = [];
  let freeChecks = 0, paidChecks = 0;
  setPlatformStoreForTests({
    async reserveFreeUsage() {
      freeChecks += 1;
      return { reserved: false, exhausted: true, freeLimit: 2, windowSeconds: 60, resetAt: new Date(Date.now() + 60_000) };
    }
  });
  setTelegramStarLedgerForTests({
    async getUserControl() { return {}; },
    async reservePrompt() { paidChecks += 1; return { reserved: false, balance: "0", state: "insufficient" }; }
  });
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, "api.telegram.org", "Denied requests must not invoke AI");
    if (new URL(url).pathname.endsWith("sendMessage")) notices.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: true }));
  };
  await handleTelegram(message("A useful question", 100, 88002, 88002));
  await handleTelegram(message("Another useful question", 101, 88002, 88002));
  await handleTelegram(message("/help", 102, 88002, 88002));
  assert.equal(notices.filter((item) => /Free limit reached/.test(item.text)).length, 1);
  assert.equal(freeChecks, 2);
  assert.equal(paidChecks, 2, "Paid balance must be rechecked, not cached or bypassed");
  assert.match(notices.at(-1).text, /Nemotron commands/);
}));
