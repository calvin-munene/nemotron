import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Mini App Telegram mode settings render backend capability state", async () => {
  const source = await fs.readFile(new URL("../public/miniapp.js", import.meta.url), "utf8");
  assert.match(source, /api\("\/api\/telegram\/capabilities"\)/);
  assert.match(source, /telegramCapabilityCard/);
  assert.match(source, /BotFather-controlled features are verified here, not represented as pretend switches/);
  assert.match(source, /Telegram Secretary connections/);
  assert.match(source, /Group Secretary/);
  assert.match(source, /activationPolicy/);
  assert.match(source, /messageStorageEnabled/);
  assert.match(source, /threadIsolationEnabled/);
  assert.match(source, /renderThreads/);
  assert.match(source, /if \(!offline && state\.dashboard\) render\(currentPath\(\)\)/);
});

test("Mini App group management uses durable and live-backed routes", async () => {
  const source = await fs.readFile(new URL("../public/miniapp.js", import.meta.url), "utf8");
  assert.match(source, /api\(admin \? "\/api\/admin\/groups\?limit=100" : "\/api\/groups\?limit=100"\)/);
  assert.match(source, /api\(`\/api\/groups\/\$\{chatId\}`\)/);
  assert.match(source, /api\(`\/api\/groups\/\$\{chatId\}\/settings`/);
  assert.match(source, /Always On allows Nemotron to respond without an explicit mention/);
  assert.match(source, /Verified permissions/);
  assert.match(source, /Recent logs/);
});

test("authorized administrators receive persistent access to every implemented admin module", async () => {
  const [source, html, css] = await Promise.all([
    fs.readFile(new URL("../public/miniapp.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/miniapp.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/miniapp.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="admin-launch"[^>]+hidden/);
  assert.match(html, /id="admin-nav-link"[^>]+hidden/);
  assert.match(source, /function syncRoleNavigation\(\)/);
  assert.match(source, /state\.dashboard\?\.platformAdmin === true/);
  for (const route of ["/admin/users", "/admin/groups", "/admin/analytics", "/admin/access-requests", "/admin/vouchers", "/admin/limits", "/admin/bots", "/admin/models", "/admin/features", "/admin/pricing", "/admin/payments", "/admin/logs", "/admin/system"]) {
    assert.match(source, new RegExp(route.replaceAll("/", "\\/")));
  }
  assert.match(source, /Generate secure voucher/);
  assert.match(source, /Copy code/);
  assert.match(source, /revoke/);
  assert.match(source, /api\/admin\/usage-policies/);
  assert.match(source, /Add audited note/);
  assert.match(source, /Export CSV/);
  assert.match(source, /featured: featuredInput\.checked/);
  assert.match(css, /\.admin-nav/);
  assert.match(css, /\.metric-track/);
  assert.match(css, /repeat\(var\(--nav-items, 5\), 1fr\)/);
});
