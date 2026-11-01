import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORM_MIGRATIONS, runMigrations } from "../src/migrations.js";

test("published schema verification performs no DDL or writes", async () => {
  const previous = process.env.NVID_SCHEMA_MODE;
  process.env.NVID_SCHEMA_MODE = "verify";
  const queries = [];
  let released = false;
  try {
    const pool = {
      async connect() {
        return {
          async query(sql, values) {
            queries.push(sql);
            return { rows: values[0].map((table_name) => ({ table_name })) };
          },
          release() { released = true; }
        };
      }
    };
    const result = await runMigrations(pool);
    assert.deepEqual(result.applied, []);
    assert.equal(result.currentVersion, PLATFORM_MIGRATIONS.at(-1).version);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /^SELECT/);
    assert.equal(released, true);
  } finally {
    if (previous === undefined) delete process.env.NVID_SCHEMA_MODE;
    else process.env.NVID_SCHEMA_MODE = previous;
  }
});

test("missing published schema fails with a republish instruction", async () => {
  const previous = process.env.NVID_SCHEMA_MODE;
  process.env.NVID_SCHEMA_MODE = "verify";
  try {
    const pool = { async connect() {
      return { async query() { return { rows: [] }; }, release() {} };
    } };
    await assert.rejects(runMigrations(pool), /Republish to apply/);
  } finally {
    if (previous === undefined) delete process.env.NVID_SCHEMA_MODE;
    else process.env.NVID_SCHEMA_MODE = previous;
  }
});