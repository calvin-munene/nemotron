let runtimeAiChatStarCost = 1;

export function aiChatStarCost() {
  return runtimeAiChatStarCost;
}

export function setAiChatStarCost(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TypeError("AI chat Star cost must be an integer between 1 and 10000");
  }
  runtimeAiChatStarCost = value;
  return value;
}

export function resetPricingForTests() {
  runtimeAiChatStarCost = 1;
}
