import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleTelegram, setTelegramStarLedgerForTests } from "../src/channels.js";
import { setPlatformStoreForTests } from "../src/platformRuntime.js";

const keys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_USER_ID", "NVIDIA_API_KEY",
  "NVIDIA_AUTO_TOOLS", "TELEGRAM_STARS_REQUIRED", "TELEGRAM_ALLOWED_USER_IDS"];
let saved, savedFetch;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  savedFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_ADMIN_USER_ID = "123";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  process.env.NVIDIA_AUTO_TOOLS = "true";
  delete process.env.TELEGRAM_STARS_REQUIRED;
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  setPlatformStoreForTests(null);
  setTelegramStarLedgerForTests(null);
});
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  global.fetch = savedFetch;
  setPlatformStoreForTests(null);
  setTelegramStarLedgerForTests(null);
});
const telegramOk = () => Response.json({ ok: true, result: { message_id: 45 } });
const update = (text, messageId = 901) => ({
  update_id: messageId, message: { message_id: messageId, from: { id: 123 },
    chat: { id: 123, type: "private" }, text }
});

test("automatic image requests upload NVIDIA bytes as a Telegram photo", async () => {
  let imageRequest = false, photoSent = false;
  global.fetch = async (url, options) => {
    if (new URL(url).hostname === "ai.api.nvidia.com") {
      imageRequest = true;
      assert.equal(JSON.parse(options.body).prompt, "Draw a cat on the moon");
      return Response.json({ artifacts: [{
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        finishReason: "SUCCESS"
      }] });
    }
    if (new URL(url).pathname.endsWith("/sendPhoto")) {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get("chat_id"), "123");
      assert.equal(options.body.get("photo").type, "image/png");
      assert.match(options.body.get("caption"), /NVIDIA/);
      photoSent = true;
    }
    return telegramOk();
  };
  await handleTelegram(update("Draw a cat on the moon"));
  assert.equal(imageRequest, true);
  assert.equal(photoSent, true);
});

test("trial-image requests never spend Stars credits and restore a reservation", async () => {
  process.env.TELEGRAM_STARS_REQUIRED = "true";
  process.env.TELEGRAM_ADMIN_USER_ID = "999";
  const restored = [];
  let providerCalled = false, completed = false;
  const messages = [];
  setTelegramStarLedgerForTests({
    async reservePrompt(userId, { reservationId }) {
      return { reserved: true, changed: true, userId, reservationId, balance: "1" };
    },
    async restorePrompt(id) { restored.push(id); },
    async completePrompt() { completed = true; }
  });
  global.fetch = async (url, options) => {
    if (String(url).includes("nvidia.com")) providerCalled = true;
    else if (new URL(url).pathname.endsWith("/sendMessage")) messages.push(JSON.parse(options.body));
    return telegramOk();
  };
  await handleTelegram(update("Draw a cat"));
  assert.equal(providerCalled, false);
  assert.equal(completed, false);
  assert.deepEqual(restored, ["telegram:123:901"]);
  assert.ok(messages.some(({ text }) => /will not spend your Stars credits/.test(text)));
});

test("automatic current-information replies use free sources and deliver citations", async () => {
  const messages = [], searchedHosts = [];
  global.fetch = async (url, options) => {
    const host = new URL(url).hostname;
    if (["news.google.com", "www.bing.com"].includes(host)) {
      searchedHosts.push(host);
      return new Response("<rss><channel><item><title>Kenya report</title><link>https://example.org/kenya</link><description>Latest Kenya report</description></item></channel></rss>");
    }
    if (host === "integrate.api.nvidia.com") {
      assert.match(JSON.parse(options.body).messages[0].content, /untrusted_search_evidence/);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "A current Kenya report [1]." } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }
    if (new URL(url).pathname.endsWith("/sendMessage")) messages.push(JSON.parse(options.body));
    return telegramOk();
  };
  await handleTelegram(update("Latest Kenya news"));
  assert.deepEqual(searchedHosts.sort(), ["news.google.com", "www.bing.com"]);
  assert.ok(messages.some(({ text }) => text.includes("https://example.org/kenya") && text.includes("Live sources")));
});