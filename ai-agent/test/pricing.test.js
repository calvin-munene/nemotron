import test from "node:test";
import assert from "node:assert/strict";
import { aiChatStarCost, resetPricingForTests, setAiChatStarCost } from "../src/pricing.js";

test("AI chat pricing defaults to one Star credit and validates updates", () => {
  resetPricingForTests();
  assert.equal(aiChatStarCost(), 1);
  assert.equal(setAiChatStarCost(2), 2);
  assert.equal(aiChatStarCost(), 2);
  for (const invalid of [0, -1, 1.5, 10_001, "2"]) assert.throws(() => setAiChatStarCost(invalid));
  resetPricingForTests();
});
