import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, redactSecretText, sanitizeLogData } from "../src/logger.js";

test("structured logging redacts secret fields and recognizable credential patterns", () => {
  const lines = [];
  const sink = { log: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) };
  const logger = createLogger({ sink, level: "debug" });
  logger.error("provider.failed", {
    authorization: "Bearer abc.def.ghi",
    nested: { databaseUrl: "postgresql://user:pass@example.test/db" },
    error: new Error(`request used ${"nvapi"}-${"abcdefghijklmnopqrstuvwxyz"}`)
  });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.authorization, "[REDACTED]");
  assert.equal(record.nested.databaseUrl, "[REDACTED]");
  assert.doesNotMatch(lines[0], /abc\.def|user:pass|nvapi-/);
  assert.equal(record.error.name, "Error");
});

test("log sanitization handles circular data and direct secret text", () => {
  const value = { name: "safe" };
  value.self = value;
  assert.equal(sanitizeLogData(value).self, "[Circular]");
  assert.equal(redactSecretText("Bearer top-secret-value"), "[REDACTED]");
});
