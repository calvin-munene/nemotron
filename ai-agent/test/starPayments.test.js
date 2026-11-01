import test from "node:test";
import assert from "node:assert/strict";
import {
  createStarPurchasePayload,
  parseStarTopupAmount,
  validateStarPurchasePayload
} from "../src/starPayments.js";

const secret = "0123456789abcdef0123456789abcdef";
const now = Date.UTC(2026, 6, 14, 12, 0, 0);

test("parses only whole Star top-up amounts within the application limit", () => {
  assert.equal(parseStarTopupAmount("1"), 1);
  assert.equal(parseStarTopupAmount("10000"), 10_000);
  for (const value of ["0", "-1", "1.5", "10001", "1e3", "", null]) {
    assert.equal(parseStarTopupAmount(value), null);
  }
});

test("creates a compact signed payload bound to the user and amount", () => {
  const payload = createStarPurchasePayload({
    userId: "6643462826",
    amount: 25,
    secret,
    now,
    nonce: "abcDEF12"
  });
  assert.ok(Buffer.byteLength(payload) <= 64);

  const result = validateStarPurchasePayload(payload, {
    secret,
    userId: "6643462826",
    currency: "XTR",
    totalAmount: 25,
    now
  });
  assert.equal(result.valid, true);
  assert.equal(result.purchase.userId, "6643462826");
  assert.equal(result.purchase.amount, 25);
});

test("rejects tampered, mismatched, and expired Star purchase payloads", () => {
  const payload = createStarPurchasePayload({
    userId: 123,
    amount: 5,
    secret,
    now,
    nonce: "abcDEF12"
  });

  assert.equal(validateStarPurchasePayload(`${payload.slice(0, -1)}A`, { secret, now }).valid, false);
  assert.equal(validateStarPurchasePayload(payload, { secret, userId: 999, now }).valid, false);
  assert.equal(validateStarPurchasePayload(payload, { secret, currency: "USD", now }).valid, false);
  assert.equal(validateStarPurchasePayload(payload, { secret, totalAmount: 4, now }).valid, false);
  assert.equal(validateStarPurchasePayload(payload, { secret, now: now + 8 * 24 * 60 * 60 * 1000 }).valid, false);
  assert.equal(validateStarPurchasePayload(payload, {
    secret,
    now: now + 8 * 24 * 60 * 60 * 1000,
    allowExpired: true
  }).valid, true);
});
