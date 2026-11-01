import test from "node:test";
import assert from "node:assert/strict";
import { createMilestoneStore } from "../src/milestoneStore.js";

function result(rows = []) {
  return { rows, rowCount: rows.length };
}

test("voucher creation is request-idempotent and never persists the redeemable code", async () => {
  const vouchers = new Map();
  const inserts = [];
  const auditStatements = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      if (statement.includes("pg_advisory_xact_lock")) return result();
      if (statement.includes("FROM credit_vouchers WHERE creation_request_id")) {
        const existing = vouchers.get(params[0]);
        return result(existing ? [existing] : []);
      }
      if (statement.includes("INSERT INTO credit_vouchers")) {
        inserts.push(params);
        vouchers.set(params[1], {
          voucher_id: params[0],
          display_prefix: params[3],
          credit_amount: params[4],
          maximum_redemptions: params[5],
          per_user_limit: params[6],
          valid_from: params[11],
          expires_at: params[12]
        });
        return result();
      }
      if (statement.includes("INSERT INTO audit_logs")) { auditStatements.push(statement); return result(); }
      throw new Error(`Unexpected query: ${statement.slice(0, 80)}`);
    }
  };
  const store = createMilestoneStore({
    transaction: (operation) => operation(client),
    ensureUserWithClient: async () => {}
  });
  const requestId = "8ea71f6d-1bb6-41d1-a593-011dfca8e551";
  const first = await store.createVoucher({ actorUserId: "6643462826", requestId, creditAmount: 25 });
  const duplicate = await store.createVoucher({ actorUserId: "6643462826", requestId, creditAmount: 25 });

  assert.equal(first.duplicate, false);
  assert.match(first.code, /^NVID-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.voucherId, first.voucherId);
  assert.equal(duplicate.code, null);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][1], requestId);
  assert.match(inserts[0][2], /^[a-f0-9]{64}$/);
  assert.equal(inserts[0].includes(first.code), false);
  assert.match(auditStatements[0], /\$3::int/);
  assert.match(auditStatements[0], /\$4::int/);
});

test("polymorphic JSON audit values use explicit PostgreSQL parameter types", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/milestoneStore.js", import.meta.url), "utf8"));
  assert.match(source, /jsonb_build_object\('requestId', \$5::text\)/);
  assert.match(source, /jsonb_build_object\('freeSuccesses', \$4::int, 'windowSeconds', \$5::int\)/);
  assert.match(source, /jsonb_build_object\('credits', \$3::int, 'maximumRedemptions', \$4::int\)/);
  assert.match(source, /jsonb_build_object\('creditsAdded', \$3::int\)/);
});

test("usage policy listing is bounded and returns durable policy records", async () => {
  const rows = [{ policy_id: "policy-1", scope_type: "global", scope_id: "*", free_successes: 2, window_seconds: 3600, active: true }];
  const calls = [];
  const store = createMilestoneStore({
    transaction: (operation) => operation({ async query(sql, params) { calls.push({ sql: String(sql), params }); return result(rows); } }),
    ensureUserWithClient: async () => {}
  });
  assert.deepEqual(await store.listUsagePolicies({ limit: 25 }), rows.map((row) => ({ ...row, window_seconds: 60 })));
  assert.deepEqual(calls[0].params, [25]);
  await assert.rejects(() => store.listUsagePolicies({ limit: 251 }), /limit is invalid/);
});

test("user analytics includes internal notes and effective allowance policies without raw messages", async () => {
  const client = {
    async query(sql) {
      const statement = String(sql);
      if (statement.includes("FROM platform_users AS users")) return result([{ user_id: "123", role: "standard_user", plan: "standard", balance: "4" }]);
      if (statement.includes("GROUP BY channel")) return result([{ channel: "miniapp", billing_source: "free", status: "completed", count: 2 }]);
      if (statement.includes("FROM telegram_star_payments")) return result([{ count: 1, stars: "5" }]);
      if (statement.includes("FROM voucher_redemptions")) return result([{ count: 1, credits: "10" }]);
      if (statement.includes("FROM group_user_verifications")) return result([{ count: 2 }]);
      if (statement.includes("FROM telegram_business_connections")) return result([]);
      if (statement.includes("FROM secretary_access_requests")) return result([]);
      if (statement.includes("FROM user_admin_notes")) return result([{ note_id: "note-1", author_user_id: "6643462826", note: "Support follow-up", created_at: new Date() }]);
      if (statement.includes("FROM ai_usage_policies")) return result([{ scope_type: "user", scope_id: "123", free_successes: 3, window_seconds: 3600, active: true }]);
      throw new Error(`Unexpected query: ${statement.slice(0, 90)}`);
    }
  };
  const store = createMilestoneStore({ transaction: (operation) => operation(client), ensureUserWithClient: async () => {} });
  const analytics = await store.getUserAnalytics("123");
  assert.equal(analytics.notes[0].note, "Support follow-up");
  assert.equal(analytics.usagePolicies[0].free_successes, 3);
  assert.equal(analytics.messages, undefined);
});
