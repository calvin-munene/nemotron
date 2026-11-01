import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORM_MIGRATIONS, runMigrations } from "../src/migrations.js";

function migrationPool(existingRows = []) {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (String(sql).includes("SELECT version, checksum")) return { rows: existingRows, rowCount: existingRows.length };
      return { rows: [], rowCount: 0 };
    },
    release() { queries.push({ sql: "RELEASE" }); }
  };
  return { queries, pool: { async connect() { return client; } } };
}

test("migration runner applies additive migrations once inside a transaction", async () => {
  const fake = migrationPool();
  const result = await runMigrations(fake.pool);
  assert.deepEqual(result.applied, PLATFORM_MIGRATIONS.map((migration) => migration.version));
  assert.equal(result.currentVersion, PLATFORM_MIGRATIONS.at(-1).version);
  assert.equal(fake.queries[0].sql, "BEGIN");
  assert.ok(fake.queries.some(({ sql }) => String(sql).includes("CREATE TABLE IF NOT EXISTS platform_users")));
  assert.equal(fake.queries.at(-2).sql, "COMMIT");
  assert.equal(fake.queries.at(-1).sql, "RELEASE");
});

test("migration checksum drift rolls back without applying modified history", async () => {
  const fake = migrationPool([{ version: PLATFORM_MIGRATIONS[0].version, checksum: "0".repeat(64) }]);
  await assert.rejects(runMigrations(fake.pool), /checksum mismatch/i);
  assert.ok(fake.queries.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(fake.queries.at(-1).sql, "RELEASE");
});

test("stabilization migration is additive and upgrades an existing migration history", async () => {
  const baseline = migrationPool();
  await runMigrations(baseline.pool, { migrations: PLATFORM_MIGRATIONS.slice(0, 4) });
  const existingRows = baseline.queries
    .filter(({ sql }) => String(sql).includes("INSERT INTO app_schema_migrations"))
    .map(({ values }) => ({ version: values[0], checksum: values[1] }));
  const upgrade = migrationPool(existingRows);
  const result = await runMigrations(upgrade.pool);
  assert.deepEqual(result.applied, ["2026071505_stabilization_foundation", "2026071701_operating_services", "2026071702_telegram_contexts", "2026071703_adaptive_access_billing", "2026071901_conversation_transport_channels", "2026100501_group_manager_postgres", "2026100502_group_manager_queue_safety"]);
  const stabilizationSql = PLATFORM_MIGRATIONS.find((migration) => migration.version === "2026071505_stabilization_foundation").sql;
  assert.match(stabilizationSql, /CREATE TABLE IF NOT EXISTS conversations/);
  assert.match(stabilizationSql, /CREATE TABLE IF NOT EXISTS conversation_messages/);
  assert.match(stabilizationSql, /CREATE TABLE IF NOT EXISTS durable_leases/);
  assert.match(stabilizationSql, /ADD COLUMN IF NOT EXISTS response_produced_at/);
  assert.doesNotMatch(stabilizationSql, /DROP TABLE|TRUNCATE TABLE|DELETE FROM telegram_star_accounts/i);
  const operatingSql = PLATFORM_MIGRATIONS.find((migration) => migration.version === "2026071701_operating_services").sql;
  assert.match(operatingSql, /CREATE TABLE IF NOT EXISTS telegram_groups/);
  assert.match(operatingSql, /CREATE TABLE IF NOT EXISTS group_moderation_actions/);
  assert.match(operatingSql, /CREATE TABLE IF NOT EXISTS guard_join_requests/);
  assert.match(operatingSql, /CREATE TABLE IF NOT EXISTS secretary_reminders/);
  assert.match(operatingSql, /CREATE TABLE IF NOT EXISTS managed_bot_credentials/);
  assert.doesNotMatch(operatingSql, /DROP TABLE|TRUNCATE TABLE|DELETE FROM/i);
  const contextSql = PLATFORM_MIGRATIONS.find((migration) => migration.version === "2026071702_telegram_contexts").sql;
  assert.match(contextSql, /CREATE TABLE IF NOT EXISTS telegram_business_connections/);
  assert.match(contextSql, /CREATE TABLE IF NOT EXISTS telegram_observed_messages/);
  assert.match(contextSql, /CREATE TABLE IF NOT EXISTS telegram_group_bot_permissions/);
  assert.match(contextSql, /activation_policy TEXT NOT NULL DEFAULT 'mention_only'/);
  assert.match(contextSql, /activation_policy <> 'always_on' OR always_on_confirmed_at IS NOT NULL/);
  assert.doesNotMatch(contextSql, /DROP TABLE|TRUNCATE TABLE|DELETE FROM/i);
  const adaptiveSql = PLATFORM_MIGRATIONS.find((migration) => migration.version === "2026071703_adaptive_access_billing").sql;
  assert.match(adaptiveSql, /CREATE TABLE IF NOT EXISTS secretary_entitlements/);
  assert.match(adaptiveSql, /CREATE TABLE IF NOT EXISTS ai_usage_events/);
  assert.match(adaptiveSql, /CREATE TABLE IF NOT EXISTS captcha_challenges/);
  assert.match(adaptiveSql, /CREATE TABLE IF NOT EXISTS credit_vouchers/);
  assert.match(adaptiveSql, /CREATE TABLE IF NOT EXISTS web_sessions/);
  assert.doesNotMatch(adaptiveSql, /DROP TABLE|TRUNCATE TABLE|DELETE FROM/i);
  const transportSql = PLATFORM_MIGRATIONS.find((migration) => migration.version === "2026071901_conversation_transport_channels").sql;
  assert.match(transportSql, /DROP CONSTRAINT IF EXISTS conversations_channel_check/);
  assert.match(transportSql, /'telegram_business'/);
  assert.match(transportSql, /'telegram_guest'/);
  assert.match(transportSql, /'telegram_inline'/);
  assert.doesNotMatch(transportSql, /DROP TABLE|TRUNCATE TABLE|DELETE FROM/i);
});
