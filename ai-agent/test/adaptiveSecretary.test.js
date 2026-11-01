import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptiveSecretaryProfile,
  asksSecretaryIdentity,
  classifyAiFailure,
  detectMessageLanguage,
  safeAiFailureMessage,
  telegramMemoryScope
} from "../src/adaptiveSecretary.js";

test("adaptive Secretary follows the latest contact language and identifies itself honestly", () => {
  assert.equal(detectMessageLanguage("Hola, puedes ayudarme por favor?"), "es");
  assert.equal(detectMessageLanguage("Habari, naomba msaada tafadhali"), "sw");
  assert.equal(asksSecretaryIdentity("Who is this?"), true);
  const profile = adaptiveSecretaryProfile({
    message: "Who is this?",
    recentLanguages: ["fr"],
    ownerStyle: "formal",
    accountName: "Example Studio",
    introductionRequired: true
  });
  assert.equal(profile.language, "fr");
  assert.equal(profile.identityAnswer, true);
  assert.match(profile.systemPrompt, /Nemotron/);
  assert.match(profile.systemPrompt, /Never pretend to be the human account owner/);
  assert.match(profile.systemPrompt, /Example Studio/);
});

test("Telegram memory namespaces isolate contacts, groups, topics, users, and connections", () => {
  const privateScope = telegramMemoryScope({ mode: "private_bot_chat", userId: 10, chatId: 10 });
  const contactA = telegramMemoryScope({ mode: "telegram_business_secretary", businessConnectionId: "connection-a", chatId: 30 });
  const contactB = telegramMemoryScope({ mode: "telegram_business_secretary", businessConnectionId: "connection-a", chatId: 31 });
  const connectionB = telegramMemoryScope({ mode: "telegram_business_secretary", businessConnectionId: "connection-b", chatId: 30 });
  const groupUserA = telegramMemoryScope({ mode: "group", groupId: -100, userId: 10 });
  const groupUserB = telegramMemoryScope({ mode: "group", groupId: -100, userId: 11 });
  const topicA = telegramMemoryScope({ mode: "group_topic", groupId: -100, threadId: 4, userId: 10 });
  const topicB = telegramMemoryScope({ mode: "group_topic", groupId: -100, threadId: 5, userId: 10 });
  assert.equal(new Set([privateScope, contactA, contactB, connectionB, groupUserA, groupUserB, topicA, topicB]).size, 8);
});

test("safe AI failure messages preserve allowance and do not expose internals", () => {
  assert.match(safeAiFailureMessage("entitlement_denied", { secretary: true }), /not been activated/);
  assert.match(safeAiFailureMessage("nvidia_timeout"), /not charged/);
  assert.doesNotMatch(safeAiFailureMessage("database_failure"), /stack|token|secret/i);
});

test("provider TimeoutError failures are classified as NVIDIA timeouts", () => {
  const error = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(classifyAiFailure(error), "nvidia_timeout");
  assert.match(safeAiFailureMessage(classifyAiFailure(error)), /not charged/);
});
