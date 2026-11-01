import test from "node:test";
import assert from "node:assert/strict";
import {
  nvidiaProviderHealth,
  recordNvidiaCatalog,
  recordNvidiaRequest,
  resetProviderHealthForTests
} from "../src/providerHealth.js";

test("provider health aggregates safe latency and failure signals", () => {
  resetProviderHealthForTests();
  recordNvidiaRequest({ ok: true, statusCode: 200, latencyMs: 100, model: "meta/model-a" });
  recordNvidiaRequest({ ok: false, statusCode: 503, latencyMs: 200, model: "meta/model-a" });
  recordNvidiaCatalog({ ok: true, modelCount: 12 });
  const health = nvidiaProviderHealth();
  assert.equal(health.totalRequests, 2);
  assert.equal(health.successfulRequests, 1);
  assert.equal(health.failedRequests, 1);
  assert.equal(health.status, "degraded");
  assert.equal(health.catalogModelCount, 12);
  assert.equal(health.recentFailureRate, 0.5);
});

test("three consecutive provider failures mark the provider unhealthy", () => {
  resetProviderHealthForTests();
  for (let index = 0; index < 3; index += 1) recordNvidiaRequest({ ok: false, statusCode: 503, latencyMs: 10 });
  assert.equal(nvidiaProviderHealth().status, "unhealthy");
});
