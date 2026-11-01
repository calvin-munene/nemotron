import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPlatformStore, sourceIdentifierHash } from "../src/platformStore.js";

function platformPool() {
  const audit = new Map();
  const conversations = new Map();
  const features = new Map([
    ["group_management", {
      feature_key: "group_management",
      enabled: false,
      description: "Group management",
      config: {},
      updated_by: null,
      updated_at: new Date()
    }]
  ]);
  const models = new Map([
    ["meta/model-a", {
      model_id: "meta/model-a",
      label: "Model A",
      description: "Test model",
      enabled: true,
      featured: false,
      provider_available: true,
      metadata: {},
      last_seen_at: new Date(),
      updated_by: null,
      updated_at: new Date()
    }]
  ]);
  const prices = new Map([["ai_chat", {
    feature_key: "ai_chat",
    star_cost: 1,
    updated_by: null,
    updated_at: new Date()
  }]]);
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      calls.push({ text, values });
      if (text.includes("SELECT version, checksum FROM app_schema_migrations")) return { rows: [], rowCount: 0 };
      if (text.includes("INSERT INTO platform_users") && text.includes("RETURNING user_id::text")) {
        return { rows: [{ user_id: String(values[0]), role: "standard_user" }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO conversations (") && text.includes("ON CONFLICT (scope_key)")) {
        if (!conversations.has(values[1])) {
          conversations.set(values[1], {
            conversation_id: values[0],
            scope_key: values[1],
            user_id: String(values[2]),
            telegram_chat_id: values[3] === null ? null : String(values[3]),
            telegram_thread_id: values[4] === null ? null : String(values[4]),
            channel: values[5],
            assistant_id: values[6],
            selected_model: values[7],
            title: values[8],
            status: "active",
            created_at: new Date(),
            updated_at: new Date(),
            deleted_at: null
          });
        }
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM conversations WHERE scope_key = $1 AND user_id = $2")) {
        const row = conversations.get(values[0]);
        const owned = row && row.user_id === String(values[1]) ? row : null;
        return { rows: owned ? [{ ...owned }] : [], rowCount: owned ? 1 : 0 };
      }
      if (text.includes("SELECT action, target_id, metadata FROM audit_logs")) {
        const row = audit.get(values[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("UPDATE feature_flags SET enabled")) {
        const row = features.get(values[0]);
        if (!row) return { rows: [], rowCount: 0 };
        Object.assign(row, { enabled: values[1], updated_by: String(values[2]), updated_at: new Date() });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO audit_logs") && text.includes("feature_flag.updated")) {
        audit.set(values[0], {
          action: "feature_flag.updated",
          target_id: values[2],
          metadata: JSON.parse(values[3])
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("UPDATE ai_models SET") && text.includes("enabled = COALESCE")) {
        const row = models.get(values[0]);
        if (!row) return { rows: [], rowCount: 0 };
        if (values[1] !== undefined && values[1] !== null) row.enabled = values[1];
        if (values[2] !== undefined && values[2] !== null) row.featured = values[2];
        if (values[3] !== undefined && values[3] !== null) row.label = values[3];
        if (values[4] !== undefined && values[4] !== null) row.description = values[4];
        row.updated_by = String(values[5]);
        row.updated_at = new Date();
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (text.includes("SELECT COUNT(*)::int AS count FROM ai_models")) {
        return { rows: [{ count: [...models.values()].filter((model) => model.enabled).length }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO audit_logs") && text.includes("ai_model.updated")) {
        audit.set(values[0], { action: "ai_model.updated", target_id: values[2], metadata: JSON.parse(values[3]) });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM ai_models WHERE model_id")) {
        const row = models.get(values[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("UPDATE billing_prices SET star_cost")) {
        const row = prices.get(values[0]);
        if (!row) return { rows: [], rowCount: 0 };
        Object.assign(row, { star_cost: values[1], updated_by: String(values[2]), updated_at: new Date() });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO audit_logs") && text.includes("billing_price.updated")) {
        audit.set(values[0], { action: "billing_price.updated", target_id: values[2], metadata: JSON.parse(values[3]) });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM billing_prices WHERE feature_key")) {
        const row = prices.get(values[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("FROM billing_prices ORDER BY feature_key")) {
        return { rows: [...prices.values()].map((row) => ({ ...row })), rowCount: prices.size };
      }
      if (text.includes("FROM feature_flags WHERE feature_key")) {
        const row = features.get(values[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ text: "RELEASE", values: [] }); }
  };
  return { calls, pool: { async connect() { return client; } } };
}

test("feature mutations are transactional, audited, and replay safe", async () => {
  const fake = platformPool();
  const store = createPlatformStore({ pool: fake.pool });
  const requestId = crypto.randomUUID();
  const first = await store.setFeatureFlag({
    actorUserId: "42",
    featureKey: "group_management",
    enabled: true,
    requestId
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.feature.enabled, true);
  assert.ok(fake.calls.some(({ text }) => text.includes("INSERT INTO audit_logs")));

  const replay = await store.setFeatureFlag({
    actorUserId: "42",
    featureKey: "group_management",
    enabled: true,
    requestId
  });
  assert.equal(replay.duplicate, true);

  await assert.rejects(
    store.setFeatureFlag({ actorUserId: "42", featureKey: "group_management", enabled: false, requestId }),
    (error) => error.statusCode === 409
  );
  assert.ok(fake.calls.some(({ text }) => text === "ROLLBACK"));
});

test("security source identifiers use a keyed one-way digest", () => {
  const first = sourceIdentifierHash("203.0.113.10", { TELEGRAM_WEBHOOK_SECRET: "test-secret-a" });
  const repeated = sourceIdentifierHash("203.0.113.10", { TELEGRAM_WEBHOOK_SECRET: "test-secret-a" });
  const rotated = sourceIdentifierHash("203.0.113.10", { TELEGRAM_WEBHOOK_SECRET: "test-secret-b" });
  assert.equal(first, repeated);
  assert.notEqual(first, rotated);
  assert.doesNotMatch(first, /203\.0\.113\.10/);
});

test("model controls require one enabled model and audit idempotent changes", async () => {
  const fake = platformPool();
  const store = createPlatformStore({ pool: fake.pool });
  const requestId = crypto.randomUUID();
  const changed = await store.setAiModelControl({
    actorUserId: "42",
    modelId: "meta/model-a",
    featured: true,
    requestId
  });
  assert.equal(changed.duplicate, false);
  assert.equal(changed.model.featured, true);
  assert.equal((await store.setAiModelControl({ actorUserId: "42", modelId: "meta/model-a", featured: true, requestId })).duplicate, true);

  await assert.rejects(
    store.setAiModelControl({
      actorUserId: "42",
      modelId: "meta/model-a",
      enabled: false,
      requestId: crypto.randomUUID()
    }),
    (error) => error.statusCode === 409
  );
});

test("billing price changes are transactional, audited, and idempotent", async () => {
  const fake = platformPool();
  const store = createPlatformStore({ pool: fake.pool });
  const requestId = crypto.randomUUID();
  const changed = await store.setBillingPrice({
    actorUserId: "42",
    featureKey: "ai_chat",
    starCost: 2,
    requestId
  });
  assert.equal(changed.price.starCost, 2);
  assert.equal(changed.duplicate, false);
  assert.equal((await store.setBillingPrice({ actorUserId: "42", featureKey: "ai_chat", starCost: 2, requestId })).duplicate, true);
  await assert.rejects(
    store.setBillingPrice({ actorUserId: "42", featureKey: "ai_chat", starCost: 3, requestId }),
    (error) => error.statusCode === 409
  );
});

test("conversation persistence accepts Telegram Business, guest, and inline transports", async () => {
  const fake = platformPool();
  const store = createPlatformStore({ pool: fake.pool });
  for (const [index, channel] of ["telegram_business", "telegram_guest", "telegram_inline"].entries()) {
    const conversation = await store.getOrCreateConversation({
      scopeKey: `${channel}:scope:${index}`,
      userId: "42",
      telegramChatId: String(100 + index),
      channel
    });
    assert.equal(conversation.channel, channel);
  }
});
