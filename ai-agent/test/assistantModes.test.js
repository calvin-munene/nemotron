import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantModeList,
  assistantSystemPrompt,
  normalizeAssistantMode
} from "../src/assistantModes.js";

test("assistant modes are validated and honor administrator availability", () => {
  assert.equal(normalizeAssistantMode(" CODING "), "coding");
  assert.throws(() => normalizeAssistantMode("untrusted_mode"), /Unknown assistant mode/);
  const modes = assistantModeList({ research: false });
  assert.equal(modes.find((mode) => mode.id === "research").enabled, false);
  assert.equal(modes.find((mode) => mode.id === "coding").enabled, true);
});

test("assistant system prompts combine a bounded mode profile and user preferences", () => {
  const prompt = assistantSystemPrompt({ mode: "secretary", persona: `Concise. ${"x".repeat(2000)}` });
  assert.match(prompt, /Active mode: Executive Secretary/);
  assert.match(prompt, /decisions, owners, deadlines/);
  assert.match(prompt, /User preferences: Concise/);
  assert.ok(prompt.length < 2500);
  assert.doesNotMatch(prompt, /x{1001}/);
});
