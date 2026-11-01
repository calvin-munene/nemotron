import test from "node:test";
import assert from "node:assert/strict";
import {
  SECRETARY_ACTIVATION_STARS,
  createSecretaryActivationPayload,
  validateSecretaryActivationPayload
} from "../src/secretaryPayments.js";

function withSigningSecret(callback) {
  const previous = process.env.TELEGRAM_STAR_SIGNING_SECRET;
  process.env.TELEGRAM_STAR_SIGNING_SECRET = "test-only-secretary-signing-secret-123456";
  try { return callback(); } finally {
    if (previous === undefined) delete process.env.TELEGRAM_STAR_SIGNING_SECRET;
    else process.env.TELEGRAM_STAR_SIGNING_SECRET = previous;
  }
}

test("Secretary activation payload is signed and bound to user, connection, price, and currency", () => withSigningSecret(() => {
  const payload = createSecretaryActivationPayload({ userId: "123", connectionId: "business-connection-a", now: 1_800_000_000_000 });
  const valid = validateSecretaryActivationPayload(payload, { userId: "123", connectionId: "business-connection-a", currency: "XTR", totalAmount: SECRETARY_ACTIVATION_STARS, now: 1_800_000_100_000 });
  assert.equal(valid.valid, true);
  assert.equal(validateSecretaryActivationPayload(payload, { userId: "124", currency: "XTR", totalAmount: 500, now: 1_800_000_100_000 }).valid, false);
  assert.equal(validateSecretaryActivationPayload(payload, { userId: "123", currency: "XTR", totalAmount: 499, now: 1_800_000_100_000 }).valid, false);
  assert.equal(validateSecretaryActivationPayload(`${payload}x`, { userId: "123", currency: "XTR", totalAmount: 500, now: 1_800_000_100_000 }).valid, false);
}));
