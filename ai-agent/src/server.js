import http from "node:http";
import crypto from "node:crypto";
import { prepareIntelligentRequest, appendLiveSources } from "./requestRouter.js";
import { activateApprovedModel } from "./featureActivation.js";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  availableModels,
  defaultModel,
  discoveredNvidiaModels,
  refreshNvidiaModelCatalog,
  selectModel,
  setRuntimeEnabledModels,
  streamReply
} from "./agent.js";
import { runtimeConfig, safeConfigurationStatus, validateRuntimeConfiguration } from "./config.js";
import {
  configureTelegramBot,
  completeTelegramWebAiUsage,
  executeTelegramModerationAction,
  handleTelegram,
  captureGroupManagerUpdate,
  startGroupManagerWorker,
  handleWhatsApp,
  reserveTelegramWebAiUsage,
  restoreTelegramWebAiUsage,
  sendSecretaryActivationInvoice,
  startSecretaryReminderWorker,
  transitionTelegramWebAiUsage,
  setTelegramAssistantMode,
  setTelegramUserAiSettings,
  setTelegramUserPreferredModel,
  telegramBillingHistory,
  telegramCapabilities,
  telegramDashboardState,
  telegramPublicStatus,
  telegramGroupPermissionState,
  telegramServiceReady,
  telegramStartupReady,
  telegramUpdateRequiresSynchronousAck,
  validMetaSignature
} from "./channels.js";
import {
  consumeTelegramWebAppInitData,
  issueTelegramWebAppSession,
  verifyTelegramWebAppSession
} from "./telegramWebAuth.js";
import { authorizeHttpRequest, bearerToken, mutationOriginAllowed } from "./httpAuth.js";
import { logger } from "./logger.js";
import {
  getPlatformStore,
  initializePlatformFoundation,
  platformHealth,
  platformRuntimeStatus
} from "./platformRuntime.js";
import { sourceIdentifierHash } from "./platformStore.js";
import { nvidiaProviderHealth } from "./providerHealth.js";
import { aiChatStarCost, setAiChatStarCost } from "./pricing.js";
import { authorizePlatformPermission, platformPrincipal } from "./rbac.js";
import {
  beginTelegramOidcLogin,
  completeTelegramOidcLogin,
  telegramOidcConfigured
} from "./telegramOidc.js";
import {
  decryptManagedBotToken,
  encryptManagedBotToken,
  managedBotEncryptionStatus,
  testManagedBotConnection
} from "./managedBots.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const port = Number(process.env.PORT || 3000);
const startedAt = Date.now();
const requestRateLimits = new Map();
const webUsersInFlight = new Set();
let activeWebAiRequests = 0;
let providerFailures = [];
let providerCircuitOpenUntil = 0;

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  });
  res.end(JSON.stringify(value));
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(res, filename, columns, rows) {
  const body = [
    columns.map(({ label }) => csvCell(label)).join(","),
    ...rows.map((row) => columns.map(({ key }) => csvCell(row[key])).join(","))
  ].join("\r\n");
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  res.end(body);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const WEB_SESSION_COOKIE = "__Host-nvid_session";
const WEB_CSRF_COOKIE = "nvid_csrf";

function cookieMap(req) {
  const result = new Map();
  for (const item of String(req.headers.cookie || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    try { result.set(key, decodeURIComponent(item.slice(separator + 1).trim())); } catch { /* ignore malformed cookies */ }
  }
  return result;
}

function cookieHeader(name, value, { httpOnly = true, maxAge = null } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "Secure",
    httpOnly ? "HttpOnly" : "",
    "SameSite=Lax",
    maxAge === null ? "" : `Max-Age=${Math.max(0, Math.floor(maxAge))}`
  ].filter(Boolean).join("; ");
}

function hashSessionSecret(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function websiteSession(req, { mutation = false } = {}) {
  const cookies = cookieMap(req);
  const token = cookies.get(WEB_SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{40,256}$/.test(token)) return null;
  const config = runtimeConfig();
  const stored = await getPlatformStore()?.getWebSession?.(token, { touchIdleSeconds: config.telegram.webSessionIdleSeconds });
  if (!stored) return null;
  if (mutation) {
    if (!mutationOriginAllowed(req, config.publicOrigin)) return { denied: true, status: 403, error: "The request origin is not allowed" };
    const csrfCookie = cookies.get(WEB_CSRF_COOKIE);
    const csrfHeader = String(req.headers["x-csrf-token"] || "");
    if (!csrfCookie || csrfHeader !== csrfCookie || hashSessionSecret(csrfHeader) !== stored.csrf_hash) {
      return { denied: true, status: 403, error: "The security token is invalid" };
    }
  }
  return {
    userId: String(stored.user_id),
    sessionId: stored.session_id,
    kind: "website",
    token,
    csrfToken: cookies.get(WEB_CSRF_COOKIE) || null
  };
}

async function body(req, { maxBytes = 1_000_000 } = {}) {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw httpError(413, "Request body too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req, options) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw httpError(415, "Content-Type must be application/json");
  const raw = await body(req, options);
  return JSON.parse(raw.toString("utf8") || "{}");
}

function normalizedIp(value) {
  let candidate = String(value || "").trim();
  if (candidate.startsWith("[") && candidate.includes("]")) candidate = candidate.slice(1, candidate.indexOf("]"));
  if (candidate.startsWith("::ffff:")) candidate = candidate.slice(7);
  if (net.isIP(candidate)) return candidate;
  const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)?.[1];
  return net.isIP(ipv4WithPort) ? ipv4WithPort : null;
}

export function resolveClientIp(req, env = process.env) {
  const socketIp = normalizedIp(req.socket?.remoteAddress) || "unknown";
  const trustProxy = env.RENDER === "true" || env.TRUST_PROXY === "render";
  if (!trustProxy) return socketIp;
  const raw = req.headers?.["x-forwarded-for"];
  const forwarded = (Array.isArray(raw) ? raw.join(",") : String(raw || ""))
    .split(",")
    .map(normalizedIp)
    .filter(Boolean);
  return forwarded.at(-1) || socketIp;
}

function chatClient(req) {
  return resolveClientIp(req);
}

function consumeRequestBudget(req, route, { limit, windowMs, cost = 1 }) {
  const now = Date.now();
  if (requestRateLimits.size > 5000) {
    for (const [key, bucket] of requestRateLimits) {
      if (bucket.resetAt <= now) requestRateLimits.delete(key);
    }
  }
  const key = `${route}:${chatClient(req)}`;
  const current = requestRateLimits.get(key);
  const bucket = !current || current.resetAt <= now ? { used: 0, resetAt: now + windowMs } : current;
  if (bucket.used + cost > limit) return false;
  bucket.used += cost;
  requestRateLimits.set(key, bucket);
  return true;
}

async function authenticateTelegramWebRequest(req, data, { allowLaunch = false } = {}) {
  const existing = verifyTelegramWebAppSession(bearerToken(req));
  if (existing) return { verified: existing, sessionToken: null };
  if (!allowLaunch) return { verified: null, sessionToken: null, code: "missing" };
  const launch = consumeTelegramWebAppInitData(data?.initData);
  if (!launch.ok) return { verified: null, sessionToken: null, code: launch.code };
  const store = getPlatformStore();
  if (store?.claimReplay) {
    const claimed = await store.claimReplay({
      fingerprint: launch.fingerprint,
      userId: launch.userId,
      expiresAt: launch.expiresAt
    });
    if (!claimed) return { verified: null, sessionToken: null, code: "replayed" };
  }
  return {
    verified: launch,
    sessionToken: issueTelegramWebAppSession(launch)
  };
}

async function recordSecurityEvent(req, event) {
  const store = getPlatformStore();
  if (!store?.writeSecurityEvent) return;
  try {
    await store.writeSecurityEvent({
      ...event,
      sourceHash: sourceIdentifierHash(chatClient(req))
    });
  } catch (error) {
    logger.error("security.event.write_failed", { error, eventType: event.eventType });
  }
}

async function authorizeAdminRequest(req, { permission, mutation = false } = {}) {
  let authorization;
  if (bearerToken(req)) {
    authorization = await authorizeHttpRequest(req, {
      permission,
      mutation,
      store: getPlatformStore(),
      expectedOrigin: runtimeConfig().publicOrigin
    });
  } else {
    const userAuthorization = await authorizeUserRequest(req, { mutation });
    if (!userAuthorization.allowed) authorization = userAuthorization;
    else {
      const permissionResult = await authorizePlatformPermission({
        userId: userAuthorization.session.userId,
        permission,
        store: getPlatformStore()
      });
      authorization = permissionResult.allowed
        ? { ...userAuthorization, principal: permissionResult.principal }
        : { ...permissionResult, session: userAuthorization.session };
    }
  }
  if (!authorization.allowed) {
    await recordSecurityEvent(req, {
      eventType: "admin_access_denied",
      severity: authorization.status === 401 ? "medium" : "high",
      userId: authorization.session?.userId || null,
      metadata: { permission, status: authorization.status }
    });
    return authorization;
  }
  if (mutation && getPlatformStore()?.consumeSharedRateLimit) {
    const budget = await getPlatformStore().consumeSharedRateLimit({
      key: `admin:${authorization.session.userId}:${permission}`,
      limit: 30,
      windowMs: 60_000
    });
    if (!budget.allowed) {
      await recordSecurityEvent(req, {
        eventType: "admin_mutation_rate_denied",
        severity: "medium",
        userId: authorization.session.userId,
        metadata: { permission }
      });
      return { allowed: false, status: 429, error: "Administrator mutation limit reached" };
    }
  }
  const dashboard = await telegramDashboardState({ userId: authorization.session.userId });
  if (dashboard.banned && !dashboard.isAdmin) {
    await recordSecurityEvent(req, {
      eventType: "banned_user_admin_access",
      severity: "high",
      userId: authorization.session.userId,
      metadata: { permission }
    });
    return { allowed: false, status: 403, error: "This account is banned" };
  }
  return { ...authorization, dashboard };
}

async function authorizeUserRequest(req, { mutation = false } = {}) {
  let session = verifyTelegramWebAppSession(bearerToken(req));
  if (!session) {
    const web = await websiteSession(req, { mutation });
    if (web?.denied) return { allowed: false, status: web.status, error: web.error };
    session = web;
  }
  if (!session) return { allowed: false, status: 401, error: "Telegram authentication is required" };
  if (mutation && session.kind !== "website" && !mutationOriginAllowed(req, runtimeConfig().publicOrigin)) {
    await recordSecurityEvent(req, {
      eventType: "user_mutation_origin_denied",
      severity: "medium",
      userId: session.userId
    });
    return { allowed: false, status: 403, error: "The request origin is not allowed" };
  }
  const dashboard = await telegramDashboardState({ userId: session.userId });
  if (dashboard.banned && !dashboard.isAdmin) {
    await recordSecurityEvent(req, {
      eventType: "current_user_authorization_denied",
      severity: "high",
      userId: session.userId,
      metadata: { reason: "telegram_user_banned" }
    });
    return { allowed: false, status: 403, error: "This account is banned" };
  }
  const store = getPlatformStore();
  if (store?.ensureUser) {
    await store.ensureUser(session.userId);
    const principal = await platformPrincipal(session.userId, store);
    if (["banned_user", "restricted_user"].includes(principal?.role)) {
      await recordSecurityEvent(req, {
        eventType: "current_user_authorization_denied",
        severity: "high",
        userId: session.userId,
        metadata: { reason: "platform_role_restricted", role: principal.role }
      });
      return { allowed: false, status: 403, error: "This platform account is restricted" };
    }
    return { allowed: true, session, dashboard, principal };
  }
  return { allowed: true, session, dashboard, principal: null };
}

function parseLimit(url) {
  const value = Number(url.searchParams.get("limit") || 50);
  return Number.isSafeInteger(value) && value >= 1 && value <= 250 ? value : 50;
}

async function authorizeLiveGroupAdministrator(req, auth, chatId, { action = "modlog", requireBotPermission = false } = {}) {
  try {
    const state = await telegramGroupPermissionState({
      chatId,
      actorUserId: auth.session.userId,
      action
    });
    if (!state.actorAllowed || (requireBotPermission && !state.botAllowed)) {
      await recordSecurityEvent(req, {
        eventType: "telegram_group_permission_denied",
        severity: "medium",
        userId: auth.session.userId,
        metadata: { chatId: String(chatId), permission: state.permission, botPermissionRequired: requireBotPermission }
      });
      return { allowed: false, status: 403, error: requireBotPermission && !state.botAllowed
        ? `Nemotron needs Telegram's ${state.permission} permission`
        : `You need Telegram's ${state.permission} permission` };
    }
    await getPlatformStore()?.syncGroupMember?.({ chatId, member: state.actor }).catch(() => undefined);
    return { allowed: true, state };
  } catch {
    return { allowed: false, status: 503, error: "Telegram could not verify current group permissions" };
  }
}

async function initializeNvidiaModelControls({ forceRefresh = false } = {}) {
  const catalog = await refreshNvidiaModelCatalog({ force: forceRefresh });
  const store = getPlatformStore();
  if (catalog.refreshed && store?.syncAiModels) await store.syncAiModels(catalog.models);
  await activateApprovedModel(store);
  if (store?.enabledAiModelIds) {
    const enabled = await store.enabledAiModelIds();
    if (enabled.length) setRuntimeEnabledModels(enabled);
  }
  if (store?.getBillingPrice) {
    const pricing = await store.getBillingPrice("ai_chat");
    if (pricing) setAiChatStarCost(pricing.starCost);
  }
  logger.info("nvidia.model_catalog.ready", {
    refreshed: catalog.refreshed,
    cached: catalog.cached,
    discoveredModels: catalog.models.length,
    enabledModels: availableModels().length
  });
  return catalog;
}

function positiveEnvironmentInteger(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function providerCircuitIsOpen() {
  return providerCircuitOpenUntil > Date.now();
}

function recordProviderSuccess() {
  providerFailures = [];
  providerCircuitOpenUntil = 0;
}

function recordProviderFailure(error) {
  if (![429, 500, 502, 503, 504].includes(Number(error?.statusCode || 0))) return;
  const now = Date.now();
  providerFailures = providerFailures.filter((timestamp) => now - timestamp < 60_000);
  providerFailures.push(now);
  const threshold = positiveEnvironmentInteger("NVIDIA_CIRCUIT_FAILURE_THRESHOLD", 5, 2, 50);
  if (providerFailures.length >= threshold) {
    providerCircuitOpenUntil = now + positiveEnvironmentInteger("NVIDIA_CIRCUIT_COOLDOWN_SECONDS", 60, 10, 900) * 1000;
  }
}

function acquireWebAiConcurrency(userId) {
  const maximum = positiveEnvironmentInteger("NVIDIA_MAX_CONCURRENT_REQUESTS", 4, 1, 100);
  if (activeWebAiRequests >= maximum || webUsersInFlight.has(userId)) return false;
  activeWebAiRequests += 1;
  webUsersInFlight.add(userId);
  return true;
}

function releaseWebAiConcurrency(userId) {
  webUsersInFlight.delete(userId);
  activeWebAiRequests = Math.max(0, activeWebAiRequests - 1);
}

function streamErrorMessage(error) {
  if (typeof error.publicMessage === "string") return error.publicMessage.slice(0, 700);
  return [429, 500, 502, 503, 504].includes(error.statusCode)
    ? "NVIDIA is temporarily busy. Please try again in a moment."
    : "The assistant could not complete that request";
}

function writeSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return Promise.reject(new DOMException("Client disconnected", "AbortError"));
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (res.write(frame)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", drained);
      res.off("close", closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new DOMException("Client disconnected", "AbortError"));
    };
    res.once("drain", drained);
    res.once("close", closed);
  });
}

async function streamWebChat(req, res, { authenticated, usage, message, model, conversation, lease }) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
  const close = () => { if (!res.writableEnded) abort(); };
  req.once("aborted", abort);
  res.once("close", close);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
  }, 15_000);
  let responseDelivered = false;
  let responseProduced = false;
  let deliveredModel = model;

  try {
    await transitionTelegramWebAiUsage(usage, "generation_started");
    const prepared = await prepareIntelligentRequest({
      text: message, systemPrompt: usage.systemPrompt,
      signal: controller.signal, allowImages: false
    });
    const answer = await streamReply({
      conversationId: conversation.scopeKey,
      text: message,
      model,
      temperature: usage.creativity,
      maxTokens: usage.maxTokens,
      systemPrompt: prepared.systemPrompt,
      answerSuffix: appendLiveSources("", prepared),
      persistence: {
        userId: authenticated.userId,
        channel: "miniapp",
        conversationId: conversation.id,
        requestId: usage.reservationId,
        memoryEnabled: usage.memoryEnabled !== false
      },
      signal: controller.signal,
      onModelSelected: (selectedModel) => {
        deliveredModel = selectedModel;
        return writeSse(res, "meta", { model: selectedModel, mode: usage.selectedMode });
      },
      onDelta: (text) => writeSse(res, "delta", { text })
    });
    responseProduced = Boolean(answer);
    await transitionTelegramWebAiUsage(usage, "response_produced");
    recordProviderSuccess();
    await transitionTelegramWebAiUsage(usage, "delivery_attempted");
    await writeSse(res, "done", { model: deliveredModel, mode: usage.selectedMode, conversationId: conversation.id });
    responseDelivered = true;
    await transitionTelegramWebAiUsage(usage, "delivered");
    await completeTelegramWebAiUsage(usage).catch((error) => {
      logger.error("web_ai.credit_completion_failed", { error, userId: authenticated.userId });
      return transitionTelegramWebAiUsage(usage, "completion_pending", { errorCode: "ledger_completion_failed" })
        .catch((transitionError) => logger.error("web_ai.credit_completion_pending_failed", { error: transitionError, userId: authenticated.userId }));
    });
  } catch (error) {
    recordProviderFailure(error);
    if (!responseProduced) {
      await transitionTelegramWebAiUsage(usage, "failed", { errorCode: "generation_failed" }).catch(() => undefined);
      await restoreTelegramWebAiUsage(usage).catch((restoreError) => {
        logger.error("web_ai.credit_restoration_failed", { error: restoreError, userId: authenticated.userId });
      });
    } else {
      await transitionTelegramWebAiUsage(usage, "completion_pending", { errorCode: "delivery_failed" }).catch((transitionError) => {
        logger.error("web_ai.delivery_pending_failed", { error: transitionError, userId: authenticated.userId });
      });
    }
    if (!controller.signal.aborted) {
      logger.error("web_ai.generation_failed", { error, userId: authenticated.userId, model });
      try {
        await writeSse(res, "error", { error: streamErrorMessage(error) });
      } catch {
        // The client disconnected before the safe error event could be sent.
      }
    }
  } finally {
    clearInterval(heartbeat);
    req.off("aborted", abort);
    res.off("close", close);
    releaseWebAiConcurrency(authenticated.userId);
    if (lease?.acquired) {
      await getPlatformStore()?.releaseLease?.({ key: lease.key, ownerId: lease.ownerId }).catch((error) => {
        logger.error("web_ai.conversation_lease_release_failed", { error, userId: authenticated.userId });
      });
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health/live") {
      return json(res, 200, { ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
    }

    if (req.method === "GET" && url.pathname === "/health/startup") {
      const database = await platformHealth();
      const ledgerReady = telegramStartupReady();
      const ok = database.ok && ledgerReady;
      return json(res, ok ? 200 : 503, {
        ok,
        services: { database, paymentLedger: { ok: ledgerReady } },
        telegramConfigured: telegramPublicStatus().configured
      });
    }

    if (req.method === "GET" && ["/health", "/health/ready"].includes(url.pathname)) {
      const database = await platformHealth();
      const telegramReady = telegramServiceReady();
      const ready = telegramReady && database.ok;
      const provider = nvidiaProviderHealth();
      const nvidiaConfigured = runtimeConfig().nvidia.configured;
      const aiGenerationAvailable = nvidiaConfigured && provider.healthy && !providerCircuitIsOpen();
      return json(res, ready ? 200 : 503, {
        ok: ready,
        ready,
        status: ready ? (aiGenerationAvailable ? "ready" : "degraded") : "unavailable",
        aiGenerationAvailable,
        services: {
          telegram: { ok: telegramReady },
          database,
          nvidia: {
            ok: nvidiaConfigured && provider.healthy,
            status: nvidiaConfigured ? provider.status : "unconfigured",
            requiredForReadiness: false
          }
        },
        deploymentVersion: runtimeConfig().deploymentVersion
      });
    }

    if (req.method === "GET" && url.pathname === "/auth/telegram") {
      if (!telegramOidcConfigured()) return json(res, 503, { error: "Telegram website login requires BotFather setup" });
      const store = getPlatformStore();
      const sourceHash = sourceIdentifierHash(chatClient(req));
      const budget = await store?.consumeSharedRateLimit?.({ key: `oidc:start:${sourceHash}`, limit: 10, windowMs: 10 * 60_000 });
      if (budget && !budget.allowed) return json(res, 429, { error: "Too many login attempts" });
      const login = await beginTelegramOidcLogin({ store, returnTo: url.searchParams.get("returnTo") || "/home", sourceHash });
      res.writeHead(302, { location: login.authorizationUrl, "cache-control": "no-store" });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/auth/telegram/callback") {
      const store = getPlatformStore();
      const identity = await completeTelegramOidcLogin({
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        store
      });
      await store.syncUserProfile?.({ ...identity.user, id: identity.userId, interactionSource: "website_login" });
      const principal = await platformPrincipal(identity.userId, store);
      if (["banned_user", "restricted_user"].includes(principal?.role)) {
        await recordSecurityEvent(req, { eventType: "telegram_oidc_restricted_user", severity: "high", userId: identity.userId });
        return json(res, 403, { error: "This account is restricted" });
      }
      const token = crypto.randomBytes(48).toString("base64url");
      const csrfToken = crypto.randomBytes(32).toString("base64url");
      const settings = runtimeConfig().telegram;
      const now = Date.now();
      await store.createWebSession({
        userId: identity.userId,
        token,
        csrfToken,
        idleExpiresAt: new Date(now + settings.webSessionIdleSeconds * 1000),
        expiresAt: new Date(now + settings.webSessionAbsoluteSeconds * 1000)
      });
      await store.writeAudit?.({
        actorUserId: identity.userId,
        action: "website.telegram_login",
        targetType: "web_session",
        targetId: identity.userId,
        metadata: { issuer: identity.claims.iss }
      });
      res.writeHead(302, {
        location: identity.returnTo,
        "cache-control": "no-store",
        "set-cookie": [
          cookieHeader(WEB_SESSION_COOKIE, token, { maxAge: settings.webSessionAbsoluteSeconds }),
          cookieHeader(WEB_CSRF_COOKIE, csrfToken, { httpOnly: false, maxAge: settings.webSessionAbsoluteSeconds })
        ]
      });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/api/web/session") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed || auth.session.kind !== "website") return json(res, auth.status || 401, { authenticated: false, error: auth.error || "Website login is required" });
      return json(res, 200, {
        authenticated: true,
        csrfToken: auth.session.csrfToken,
        user: { userId: auth.session.userId, role: auth.principal?.role || "standard_user", plan: auth.dashboard?.plan || "standard" },
        dashboard: auth.dashboard
      });
    }

    if (req.method === "POST" && url.pathname === "/api/web/logout") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed || auth.session.kind !== "website") return json(res, auth.status || 401, { error: auth.error || "Website login is required" });
      await getPlatformStore()?.revokeWebSession?.(auth.session.token);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": [cookieHeader(WEB_SESSION_COOKIE, "", { maxAge: 0 }), cookieHeader(WEB_CSRF_COOKIE, "", { httpOnly: false, maxAge: 0 })]
      });
      return res.end(JSON.stringify({ loggedOut: true }));
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      return json(res, 200, { models: availableModels(), defaultModel: defaultModel() });
    }

    if (req.method === "GET" && url.pathname === "/api/channels") {
      return json(res, 200, { telegram: telegramPublicStatus() });
    }

    if (req.method === "GET" && url.pathname === "/api/modes") {
      if (!consumeRequestBudget(req, "user-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        selectedMode: auth.dashboard.selectedMode,
        modes: auth.dashboard.assistantModes,
        aiChatStarCost: aiChatStarCost()
      });
    }

    if (req.method === "POST" && url.pathname === "/api/modes/selection") {
      if (!consumeRequestBudget(req, "user-write", { limit: 30, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 8_000 });
      if (typeof data.mode !== "string") return json(res, 400, { error: "mode is required" });
      const control = await setTelegramAssistantMode({ userId: auth.session.userId, mode: data.mode });
      return json(res, 200, { selectedMode: control.selectedMode });
    }

    if (req.method === "GET" && url.pathname === "/api/user/settings") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        settings: {
          preferredModel: auth.dashboard.preferredModel,
          preferredLanguage: auth.dashboard.preferredLanguage,
          defaultAssistantMode: auth.dashboard.selectedMode,
          responseLength: auth.dashboard.responseLength,
          creativity: auth.dashboard.creativity,
          memoryEnabled: auth.dashboard.memoryEnabled,
          customInstructions: auth.dashboard.customInstructions,
          persona: auth.dashboard.persona
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/user/settings") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 16_000 });
      const settings = await setTelegramUserAiSettings({ userId: auth.session.userId, settings: data });
      return json(res, 200, { settings });
    }

    if (req.method === "GET" && url.pathname === "/api/usage/allowance") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const channel = String(url.searchParams.get("channel") || "telegram_private").slice(0, 64);
      const allowance = await getPlatformStore()?.getUsageAllowance?.(auth.session.userId, { channel });
      return json(res, 200, { allowance, plan: auth.dashboard?.plan || "standard", balance: auth.dashboard?.balance || "0" });
    }

    if (req.method === "POST" && url.pathname === "/api/vouchers/redeem") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const budget = await getPlatformStore()?.consumeSharedRateLimit?.({ key: `voucher:${auth.session.userId}`, limit: 10, windowMs: 60 * 60_000 });
      if (budget && !budget.allowed) return json(res, 429, { error: "Voucher attempt limit reached" });
      const data = await jsonBody(req, { maxBytes: 4_000 });
      if (typeof data.code !== "string" || data.code.length > 100) return json(res, 400, { error: "A valid voucher code is required" });
      const redemption = await getPlatformStore()?.redeemVoucher?.({ userId: auth.session.userId, code: data.code });
      return json(res, 200, { redemption });
    }

    if (req.method === "GET" && url.pathname === "/api/conversations") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const store = getPlatformStore();
      if (!store?.listConversations) return json(res, 503, { error: "Conversation history is temporarily unavailable" });
      return json(res, 200, {
        conversations: await store.listConversations(auth.session.userId, {
          search: url.searchParams.get("search") || "",
          limit: parseLimit(url)
        })
      });
    }

    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 8_000 });
      const store = getPlatformStore();
      if (!store?.getOrCreateConversation) return json(res, 503, { error: "Conversation history is temporarily unavailable" });
      const conversationId = crypto.randomUUID();
      const model = data.model ? selectModel(data.model) : null;
      const conversation = await store.getOrCreateConversation({
        conversationId,
        scopeKey: `miniapp:${auth.session.userId}:conversation:${conversationId}`,
        userId: auth.session.userId,
        channel: "miniapp",
        selectedModel: model,
        title: typeof data.title === "string" && data.title.trim() ? data.title : "New conversation"
      });
      return json(res, 201, { conversation });
    }

    const conversationRoute = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})$/i);
    if (conversationRoute && req.method === "GET") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const result = await getPlatformStore()?.getConversation?.(auth.session.userId, conversationRoute[1]);
      return result ? json(res, 200, result) : json(res, 404, { error: "Conversation was not found" });
    }
    if (conversationRoute && req.method === "PATCH") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 4_000 });
      const conversation = await getPlatformStore()?.renameConversation?.(auth.session.userId, conversationRoute[1], data.title);
      return conversation ? json(res, 200, { conversation }) : json(res, 404, { error: "Conversation was not found" });
    }
    if (conversationRoute && req.method === "DELETE") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const deleted = await getPlatformStore()?.deleteConversation?.(auth.session.userId, conversationRoute[1]);
      return deleted ? json(res, 200, { deleted: true }) : json(res, 404, { error: "Conversation was not found" });
    }

    if (req.method === "GET" && url.pathname === "/api/assistants") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { assistants: await getPlatformStore()?.listAssistants?.(auth.session.userId) || [] });
    }
    if (req.method === "POST" && url.pathname === "/api/assistants") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 16_000 });
      const assistant = await getPlatformStore()?.createAssistant?.(auth.session.userId, data);
      if (!assistant) return json(res, 503, { error: "Assistants are temporarily unavailable" });
      return json(res, 201, { assistant });
    }

    const assistantRoute = url.pathname.match(/^\/api\/assistants\/([0-9a-f-]{36})$/i);
    if (assistantRoute && req.method === "PATCH") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 16_000 });
      const assistant = await getPlatformStore()?.updateAssistant?.(auth.session.userId, assistantRoute[1], data);
      return assistant ? json(res, 200, { assistant }) : json(res, 404, { error: "Assistant was not found" });
    }
    if (assistantRoute && req.method === "DELETE") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const deleted = await getPlatformStore()?.deleteAssistant?.(auth.session.userId, assistantRoute[1]);
      return deleted ? json(res, 200, { deleted: true }) : json(res, 404, { error: "Assistant was not found" });
    }

    if (req.method === "POST" && url.pathname === "/api/miniapp/state") {
      if (!consumeRequestBudget(req, "miniapp-state", { limit: 60, windowMs: 60_000 })) {
        return json(res, 429, { error: "Request limit reached. Please try again shortly." });
      }
      const data = await jsonBody(req, { maxBytes: 64_000 });
      const authStore = getPlatformStore();
      if (authStore?.consumeSharedRateLimit) {
        const budget = await authStore.consumeSharedRateLimit({
          key: `auth:${sourceIdentifierHash(chatClient(req))}`,
          limit: 30,
          windowMs: 10 * 60_000
        });
        if (!budget.allowed) return json(res, 429, { error: "Authentication attempt limit reached" });
      }
      const auth = await authenticateTelegramWebRequest(req, data, { allowLaunch: true });
      if (!auth.verified) {
        return json(res, 401, {
          error: auth.code === "replayed"
            ? "This Telegram launch was already used. Reopen the Mini App to continue."
            : "Fresh Telegram Mini App authentication is required"
        });
      }
      await authStore?.syncUserProfile?.({ id: auth.verified.userId, ...auth.verified.user }).catch((error) => {
        logger.error("miniapp.user_profile_sync_failed", { error, userId: auth.verified.userId });
      });
      const dashboard = await telegramDashboardState({ userId: auth.verified.userId });
      if (dashboard.banned && !dashboard.isAdmin) {
        await recordSecurityEvent(req, {
          eventType: "banned_user_miniapp_access",
          severity: "medium",
          userId: auth.verified.userId
        });
        return json(res, 403, { error: "This account is not permitted to use Nemotron" });
      }
      const store = getPlatformStore();
      let principal = null;
      if (store?.ensureUser) {
        await store.ensureUser(auth.verified.userId);
        principal = await platformPrincipal(auth.verified.userId, store);
        if (["banned_user", "restricted_user"].includes(principal?.role)) {
          await recordSecurityEvent(req, {
            eventType: "restricted_platform_user_miniapp_access",
            severity: "medium",
            userId: auth.verified.userId,
            metadata: { role: principal.role }
          });
          return json(res, 403, { error: "This platform account is restricted" });
        }
      }
      return json(res, 200, {
        verified: true,
        sessionToken: auth.sessionToken,
        dashboard: {
          ...dashboard,
          platformRole: principal?.role || (dashboard.isAdmin ? "super_admin" : "standard_user"),
          platformAdmin: ["super_admin", "admin"].includes(principal?.role) || dashboard.isAdmin,
          pricing: { aiChatStarCost: aiChatStarCost() }
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/analytics") {
      const auth = await authorizeAdminRequest(req, { permission: "admin.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { analytics: await getPlatformStore()?.getAdminAnalytics?.() });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/access-requests") {
      const auth = await authorizeAdminRequest(req, { permission: "users.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { requests: await getPlatformStore()?.listSecretaryAccessRequests?.({ status: url.searchParams.get("status") || null, limit: parseLimit(url) }) || [] });
    }

    const accessDecisionMatch = url.pathname.match(/^\/api\/admin\/access-requests\/([0-9a-f-]{36})$/i);
    if (accessDecisionMatch && req.method === "POST") {
      const auth = await authorizeAdminRequest(req, { permission: "users.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 8_000 });
      const result = await getPlatformStore()?.decideSecretaryAccess?.({
        requestId: accessDecisionMatch[1],
        actorUserId: auth.session.userId,
        decision: data.decision,
        reason: data.reason,
        cooldownSeconds: data.cooldownSeconds || 86400
      });
      return json(res, 200, { result });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/vouchers") {
      const auth = await authorizeAdminRequest(req, { permission: "billing.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { vouchers: await getPlatformStore()?.listVouchers?.({ limit: parseLimit(url) }) || [] });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/vouchers") {
      const auth = await authorizeAdminRequest(req, { permission: "billing.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 12_000 });
      const voucher = await getPlatformStore()?.createVoucher?.({ actorUserId: auth.session.userId, ...data });
      return json(res, 201, { voucher, warning: "The full voucher code is shown once. Store it securely now." });
    }

    const voucherAdminMatch = url.pathname.match(/^\/api\/admin\/vouchers\/([0-9a-f-]{36})\/revoke$/i);
    if (voucherAdminMatch && req.method === "POST") {
      const auth = await authorizeAdminRequest(req, { permission: "billing.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 4_000 });
      const result = await getPlatformStore()?.revokeVoucher?.({ voucherId: voucherAdminMatch[1], actorUserId: auth.session.userId, reason: data.reason });
      return json(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/admin/usage-policy") {
      const auth = await authorizeAdminRequest(req, { permission: "billing.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 8_000 });
      const policy = await getPlatformStore()?.setUsagePolicy?.({ actorUserId: auth.session.userId, ...data });
      return json(res, 200, { policy });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/usage-policies") {
      const auth = await authorizeAdminRequest(req, { permission: "billing.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const policies = await getPlatformStore()?.listUsagePolicies?.({ limit: parseLimit(url) }) || [];
      return json(res, 200, { policies });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/overview") {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "admin.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        overview: await getPlatformStore().getOverview(),
        system: {
          deploymentVersion: runtimeConfig().deploymentVersion,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          telegram: telegramPublicStatus()
        },
        pricing: { aiChatStarCost: aiChatStarCost() },
        billing: auth.dashboard?.stats || null
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "users.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const users = await getPlatformStore().listManagedUsers({
        search: url.searchParams.get("search") || "",
        limit: parseLimit(url)
      });
      return json(res, 200, { users });
    }

    const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (adminUserMatch && req.method === "GET") {
      const auth = await authorizeAdminRequest(req, { permission: "users.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const user = await getPlatformStore().getUserAnalytics?.(adminUserMatch[1])
        || await getPlatformStore().getManagedUser(adminUserMatch[1]);
      return user ? json(res, 200, { user }) : json(res, 404, { error: "User was not found" });
    }
    if (adminUserMatch && req.method === "PATCH") {
      if (!consumeRequestBudget(req, "admin-write", { limit: 30, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "users.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 20_000 });
      if (typeof data.requestId !== "string") return json(res, 400, { error: "requestId is required" });
      const targetUserId = adminUserMatch[1];
      const current = await getPlatformStore().getManagedUser(targetUserId);
      if (!current) return json(res, 404, { error: "User was not found" });
      const isSuperAdmin = auth.principal.role === "super_admin";
      const primaryAdmin = String(process.env.TELEGRAM_ADMIN_USER_ID || "");
      if (targetUserId === primaryAdmin && (data.banned === true || (data.role !== undefined && data.role !== "super_admin"))) {
        return json(res, 409, { error: "The configured primary administrator cannot be banned or demoted" });
      }
      if (targetUserId === auth.principal.userId && data.banned === true) return json(res, 409, { error: "Administrators cannot ban their own active session" });
      if (!isSuperAdmin && (["admin", "super_admin"].includes(current.role)
        || data.role !== undefined || data.unlimitedCredits !== undefined || data.creditDelta !== undefined)) {
        return json(res, 403, { error: "Only the Super Admin can change roles, unlimited access, credits, or other administrators" });
      }
      const changed = await getPlatformStore().manageUser({
        actorUserId: auth.principal.userId,
        userId: targetUserId,
        requestId: data.requestId,
        role: data.role,
        banned: data.banned,
        banReason: data.banReason,
        unlimitedCredits: data.unlimitedCredits,
        creditDelta: data.creditDelta,
        note: data.note,
        allowPrivilegedChanges: isSuperAdmin
      });
      return json(res, 200, changed);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/features") {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "admin.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { features: await getPlatformStore().listFeatureFlags() });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/models") {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "admin.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        models: await getPlatformStore().listAiModels(),
        provider: nvidiaProviderHealth(),
        discovered: discoveredNvidiaModels().length
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/models") {
      if (!consumeRequestBudget(req, "admin-write", { limit: 30, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "models.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 16_000 });
      if (typeof data.modelId !== "string" || typeof data.requestId !== "string") {
        return json(res, 400, { error: "modelId and requestId are required" });
      }
      const changed = await getPlatformStore().setAiModelControl({
        actorUserId: auth.principal.userId,
        modelId: data.modelId,
        enabled: data.enabled,
        featured: data.featured,
        label: data.label,
        description: data.description,
        requestId: data.requestId
      });
      const enabled = await getPlatformStore().enabledAiModelIds();
      setRuntimeEnabledModels(enabled);
      return json(res, 200, changed);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/pricing") {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "billing.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { prices: await getPlatformStore().getBillingPrices() });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/pricing") {
      if (!consumeRequestBudget(req, "admin-write", { limit: 30, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "billing.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 16_000 });
      if (data.featureKey !== "ai_chat"
          || !Number.isSafeInteger(data.starCost)
          || data.starCost < 1
          || data.starCost > 10_000
          || typeof data.requestId !== "string") {
        return json(res, 400, { error: "Valid featureKey, starCost, and requestId are required" });
      }
      const changed = await getPlatformStore().setBillingPrice({
        actorUserId: auth.principal.userId,
        featureKey: data.featureKey,
        starCost: data.starCost,
        requestId: data.requestId
      });
      setAiChatStarCost(changed.price.starCost);
      return json(res, 200, changed);
    }

    if (req.method === "POST" && url.pathname === "/api/admin/features") {
      if (!consumeRequestBudget(req, "admin-write", { limit: 30, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "features.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 16_000 });
      if (typeof data.featureKey !== "string" || typeof data.enabled !== "boolean" || typeof data.requestId !== "string") {
        return json(res, 400, { error: "featureKey, enabled, and requestId are required" });
      }
      const changed = await getPlatformStore().setFeatureFlag({
        actorUserId: auth.principal.userId,
        featureKey: data.featureKey,
        enabled: data.enabled,
        requestId: data.requestId
      });
      return json(res, 200, changed);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/logs") {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "logs.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { logs: await getPlatformStore().listAuditLogs({ limit: parseLimit(url) }) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/security-events") {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "security_events.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { events: await getPlatformStore().listSecurityEvents({ limit: parseLimit(url) }) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/system") {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "admin.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        configuration: safeConfigurationStatus(),
        platform: platformRuntimeStatus(),
        telegram: telegramPublicStatus(),
        nvidia: { ...nvidiaProviderHealth(), circuitOpen: providerCircuitIsOpen(), activeRequests: activeWebAiRequests },
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/telegram/capabilities") {
      if (!consumeRequestBudget(req, "telegram-capabilities", { limit: 30, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const refresh = url.searchParams.get("refresh") === "true";
      return json(res, 200, await telegramCapabilities({ refresh }));
    }

    if (req.method === "GET" && url.pathname === "/api/admin/groups") {
      const auth = await authorizeAdminRequest(req, { permission: "groups.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        groups: await getPlatformStore().listTelegramGroups({ search: url.searchParams.get("search") || "", limit: parseLimit(url) })
      });
    }

    if (req.method === "GET" && url.pathname === "/api/groups") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        groups: await getPlatformStore().listTelegramGroups({
          userId: auth.session.userId,
          search: url.searchParams.get("search") || "",
          limit: parseLimit(url)
        })
      });
    }

    const groupMatch = url.pathname.match(/^\/api\/(?:groups|group)\/(-?\d+)$/);
    if (groupMatch && req.method === "GET") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const live = await authorizeLiveGroupAdministrator(req, auth, groupMatch[1]);
      if (!live.allowed) return json(res, live.status, { error: live.error });
      const group = await getPlatformStore().getTelegramGroup(groupMatch[1]);
      return group ? json(res, 200, { ...group, livePermissions: { actor: live.state.actor, bot: live.state.botMember } }) : json(res, 404, { error: "Group was not found" });
    }

    const groupSettingsMatch = url.pathname.match(/^\/api\/groups\/(-?\d+)\/settings$/);
    if (groupSettingsMatch && req.method === "PATCH") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const live = await authorizeLiveGroupAdministrator(req, auth, groupSettingsMatch[1]);
      if (!live.allowed) return json(res, live.status, { error: live.error });
      const data = await jsonBody(req, { maxBytes: 40_000 });
      if (typeof data.requestId !== "string" || !data.changes || typeof data.changes !== "object") {
        return json(res, 400, { error: "requestId and changes are required" });
      }
      if (data.changes.activationPolicy === "always_on") {
        if (live.state.actor?.status !== "creator" || data.changes.alwaysOnConfirmed !== true) {
          await recordSecurityEvent(req, {
            eventType: "telegram_group_always_on_denied",
            severity: "medium",
            userId: auth.session.userId,
            metadata: { chatId: groupSettingsMatch[1], reason: "creator_confirmation_required" }
          });
          return json(res, 403, { error: "Only the current Telegram group creator can explicitly confirm Always On" });
        }
      }
      const changed = await getPlatformStore().updateGroupSettings({
        actorUserId: auth.session.userId,
        chatId: groupSettingsMatch[1],
        requestId: data.requestId,
        changes: data.changes
      });
      return json(res, 200, changed);
    }

    if (url.pathname === "/api/secretary/connections" && req.method === "GET") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        connections: await getPlatformStore().listBusinessConnections({ ownerUserId: auth.session.userId, limit: parseLimit(url) })
      });
    }

    const secretaryConnectionMatch = url.pathname.match(/^\/api\/secretary\/connections\/([^/]+)\/(settings|request-access|invoice)$/);
    if (secretaryConnectionMatch && req.method === "POST") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const connectionId = decodeURIComponent(secretaryConnectionMatch[1]);
      const data = await jsonBody(req, { maxBytes: 12_000 });
      if (secretaryConnectionMatch[2] === "request-access") {
        const request = await getPlatformStore()?.requestSecretaryAccess?.({ connectionId, ownerUserId: auth.session.userId });
        return json(res, request?.duplicate ? 200 : 201, { request });
      }
      if (secretaryConnectionMatch[2] === "invoice") {
        const invoice = await sendSecretaryActivationInvoice({ ownerUserId: auth.session.userId, connectionId });
        return json(res, 200, { invoice });
      }
      const connection = await getPlatformStore()?.updateSecretarySettings?.({ connectionId, ownerUserId: auth.session.userId, changes: data });
      return connection ? json(res, 200, { connection }) : json(res, 404, { error: "Business connection was not found" });
    }

    const secretaryContactsMatch = url.pathname.match(/^\/api\/secretary\/connections\/([^/]+)\/contacts(?:\/(-?\d+))?$/);
    if (secretaryContactsMatch && req.method === "GET" && !secretaryContactsMatch[2]) {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const contacts = await getPlatformStore()?.listSecretaryContacts?.({ connectionId: decodeURIComponent(secretaryContactsMatch[1]), ownerUserId: auth.session.userId, limit: parseLimit(url) }) || [];
      return json(res, 200, { contacts });
    }
    if (secretaryContactsMatch && req.method === "PATCH" && secretaryContactsMatch[2]) {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 8_000 });
      const contact = await getPlatformStore()?.updateSecretaryContactSettings?.({ connectionId: decodeURIComponent(secretaryContactsMatch[1]), contactChatId: secretaryContactsMatch[2], ownerUserId: auth.session.userId, changes: data });
      return json(res, 200, { contact });
    }

    const groupModerationMatch = url.pathname.match(/^\/api\/groups\/(-?\d+)\/moderation$/);
    if (groupModerationMatch && req.method === "POST") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 20_000 });
      if (typeof data.requestId !== "string" || typeof data.action !== "string") {
        return json(res, 400, { error: "requestId and action are required" });
      }
      const result = await executeTelegramModerationAction({
        actorUserId: auth.session.userId,
        chatId: groupModerationMatch[1],
        action: data.action,
        targetUserId: data.targetUserId,
        reason: data.reason,
        durationSeconds: data.durationSeconds,
        telegramMessageId: data.telegramMessageId,
        telegramMessageIds: data.telegramMessageIds,
        lockType: data.lockType,
        requestId: data.requestId
      });
      return json(res, 200, result);
    }

    const groupGuardMatch = url.pathname.match(/^\/api\/groups\/(-?\d+)\/guard$/);
    if (groupGuardMatch && req.method === "GET") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const live = await authorizeLiveGroupAdministrator(req, auth, groupGuardMatch[1], { action: "approve" });
      if (!live.allowed) return json(res, live.status, { error: live.error });
      return json(res, 200, { requests: await getPlatformStore().listGuardJoinRequests(groupGuardMatch[1], { limit: parseLimit(url) }) });
    }
    if (groupGuardMatch && req.method === "POST") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const data = await jsonBody(req, { maxBytes: 16_000 });
      if (!["approve", "reject"].includes(data.action) || typeof data.userId !== "string" || typeof data.requestId !== "string") {
        return json(res, 400, { error: "action, userId, and requestId are required" });
      }
      const result = await executeTelegramModerationAction({
        actorUserId: auth.session.userId,
        chatId: groupGuardMatch[1],
        action: data.action,
        targetUserId: data.userId,
        reason: data.reason || "Guard Mini App decision",
        requestId: data.requestId
      });
      return json(res, 200, result);
    }

    if (url.pathname === "/api/secretary/reminders" && req.method === "GET") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      if (!(await getPlatformStore().isFeatureEnabled("secretary_automation"))) return json(res, 403, { error: "Secretary automation is disabled" });
      return json(res, 200, { reminders: await getPlatformStore().listSecretaryReminders(auth.session.userId, { limit: parseLimit(url) }) });
    }
    if (url.pathname === "/api/secretary/reminders" && req.method === "POST") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      if (!(await getPlatformStore().isFeatureEnabled("secretary_automation"))) return json(res, 403, { error: "Secretary automation is disabled" });
      const data = await jsonBody(req, { maxBytes: 16_000 });
      const targetChat = data.chatId || auth.session.userId;
      if (String(targetChat) !== auth.session.userId) {
        const live = await authorizeLiveGroupAdministrator(req, auth, targetChat);
        if (!live.allowed) return json(res, live.status, { error: live.error });
      }
      const reminder = await getPlatformStore().createSecretaryReminder({
        ownerUserId: auth.session.userId,
        chatId: targetChat,
        threadId: data.threadId,
        title: data.title,
        message: data.message,
        dueAt: data.dueAt
      });
      return json(res, 201, { reminder });
    }
    const reminderMatch = url.pathname.match(/^\/api\/secretary\/reminders\/([0-9a-f-]{36})$/i);
    if (reminderMatch && req.method === "DELETE") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const reminder = await getPlatformStore().cancelSecretaryReminder(auth.session.userId, reminderMatch[1]);
      return reminder ? json(res, 200, { reminder }) : json(res, 404, { error: "Scheduled reminder was not found" });
    }
    if (url.pathname === "/api/secretary/jobs" && req.method === "GET") {
      const auth = await authorizeUserRequest(req);
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      if (!(await getPlatformStore().isFeatureEnabled("secretary_automation"))) return json(res, 403, { error: "Secretary automation is disabled" });
      return json(res, 200, { jobs: await getPlatformStore().listSecretaryJobs(auth.session.userId) });
    }
    if (url.pathname === "/api/secretary/jobs" && req.method === "POST") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      if (!(await getPlatformStore().isFeatureEnabled("secretary_automation"))) return json(res, 403, { error: "Secretary automation is disabled" });
      const data = await jsonBody(req, { maxBytes: 12_000 });
      const targetChat = data.chatId || auth.session.userId;
      if (String(targetChat) !== auth.session.userId) {
        const live = await authorizeLiveGroupAdministrator(req, auth, targetChat);
        if (!live.allowed) return json(res, live.status, { error: live.error });
      }
      const job = await getPlatformStore().createSecretaryJob({
        ownerUserId: auth.session.userId,
        chatId: targetChat,
        threadId: data.threadId,
        jobType: data.jobType || "task_digest",
        schedule: data.schedule,
        timezone: data.timezone || "UTC"
      });
      return json(res, 201, { job });
    }
    const secretaryJobMatch = url.pathname.match(/^\/api\/secretary\/jobs\/([0-9a-f-]{36})$/i);
    if (secretaryJobMatch && req.method === "DELETE") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const job = await getPlatformStore().cancelSecretaryJob(auth.session.userId, secretaryJobMatch[1]);
      return job ? json(res, 200, { job }) : json(res, 404, { error: "Enabled Secretary job was not found" });
    }

    if (url.pathname === "/api/bots" && req.method === "GET") {
      const auth = await authorizeAdminRequest(req, { permission: "bots.manage" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      return json(res, 200, {
        bots: await getPlatformStore().listManagedBotProfiles(auth.session.userId),
        encryption: managedBotEncryptionStatus()
      });
    }
    if (url.pathname === "/api/bots" && req.method === "POST") {
      const auth = await authorizeAdminRequest(req, { permission: "bots.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      if (!(await getPlatformStore().isFeatureEnabled("managed_bots"))) return json(res, 403, { error: "Managed Bots is disabled" });
      const data = await jsonBody(req, { maxBytes: 20_000 });
      const profileId = crypto.randomUUID();
      const credential = data.token ? encryptManagedBotToken(data.token, { profileId }) : null;
      const bot = await getPlatformStore().createManagedBotProfile({
        profileId,
        ownerUserId: auth.session.userId,
        displayName: data.displayName,
        credential,
        configuration: data.configuration
      });
      if (credential && bot.id !== profileId) {
        return json(res, 500, { error: "Managed bot profile could not bind its encrypted credential" });
      }
      return json(res, 201, { bot });
    }

    const managedBotMatch = url.pathname.match(/^\/api\/bots\/([0-9a-f-]{36})$/i);
    if (managedBotMatch && req.method === "DELETE") {
      const auth = await authorizeAdminRequest(req, { permission: "bots.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const deleted = await getPlatformStore().deleteManagedBotProfile(auth.session.userId, managedBotMatch[1]);
      return deleted ? json(res, 200, { deleted: true }) : json(res, 404, { error: "Managed bot profile was not found" });
    }
    const managedBotTestMatch = url.pathname.match(/^\/api\/bots\/([0-9a-f-]{36})\/test$/i);
    if (managedBotTestMatch && req.method === "POST") {
      const auth = await authorizeAdminRequest(req, { permission: "bots.manage", mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const record = await getPlatformStore().getManagedBotProfile(auth.session.userId, managedBotTestMatch[1], { includeCredential: true });
      if (!record?.credential) return json(res, 409, { error: "This profile does not have an encrypted credential" });
      const token = decryptManagedBotToken(record.credential, { profileId: managedBotTestMatch[1] });
      const result = await testManagedBotConnection(token);
      await getPlatformStore().updateManagedBotHealth(auth.session.userId, managedBotTestMatch[1], {
        connected: result.connected,
        telegramBotId: result.bot?.id || null,
        telegramUsername: result.bot?.username || null,
        errorCode: result.errorCode || null
      });
      await getPlatformStore().writeAudit({
        actorUserId: auth.session.userId,
        action: "managed_bot.connectivity_tested",
        targetType: "managed_bot",
        targetId: managedBotTestMatch[1],
        result: result.connected ? "success" : "failed",
        metadata: { errorCode: result.errorCode || null }
      });
      return json(res, result.connected ? 200 : 502, result);
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const auth = await authorizeUserRequest(req, { mutation: true });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const authenticated = auth.session;
      if (auth.dashboard?.modes?.chat?.enabled === false) {
        return json(res, 403, { error: "AI Chat Mode is currently disabled" });
      }
      if (!consumeRequestBudget(req, "web-chat", { limit: 30, windowMs: 10 * 60_000 })) {
        return json(res, 429, { error: "Request limit reached. Please try again in a few minutes." });
      }
      if (providerCircuitIsOpen()) {
        return json(res, 503, { error: "NVIDIA is temporarily paused after repeated provider failures" });
      }
      const data = await jsonBody(req, { maxBytes: 32_000 });
      if (typeof data.message !== "string" || !data.message.trim() || data.message.length > 8000) {
        return json(res, 400, { error: "Message must contain 1-8000 characters" });
      }
      let model;
      try {
        model = selectModel(data.model);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      await setTelegramUserPreferredModel({ userId: authenticated.userId, model });
      const store = getPlatformStore();
      if (store?.consumeSharedRateLimit) {
        const userBudget = await store.consumeSharedRateLimit({
          key: `ai:user:${authenticated.userId}`,
          limit: 30,
          windowMs: 10 * 60_000
        });
        if (!userBudget.allowed) return json(res, 429, { error: "Your shared AI request limit has been reached" });
      }
      const requestedConversationId = data.conversationId === undefined || data.conversationId === null || data.conversationId === ""
        ? crypto.randomUUID()
        : String(data.conversationId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedConversationId)) {
        return json(res, 400, { error: "conversationId must be a UUID" });
      }
      let conversation = {
        id: requestedConversationId,
        scopeKey: `miniapp:${authenticated.userId}:conversation:${requestedConversationId}`
      };
      if (store?.getOrCreateConversation) {
        const existing = data.conversationId ? await store.getConversation(authenticated.userId, requestedConversationId) : null;
        if (data.conversationId && !existing) return json(res, 404, { error: "Conversation was not found" });
        const persisted = existing?.conversation || await store.getOrCreateConversation({
          conversationId: requestedConversationId,
          scopeKey: conversation.scopeKey,
          userId: authenticated.userId,
          channel: "miniapp",
          selectedModel: model
        });
        conversation = { id: persisted.id, scopeKey: `miniapp:${authenticated.userId}:conversation:${persisted.id}` };
      }
      if (store?.consumeSharedRateLimit) {
        const conversationBudget = await store.consumeSharedRateLimit({
          key: `ai:conversation:${conversation.id}`,
          limit: 12,
          windowMs: 60_000
        });
        if (!conversationBudget.allowed) return json(res, 429, { error: "This conversation is receiving messages too quickly" });
      }
      let lease = null;
      if (store?.acquireLease) {
        lease = await store.acquireLease({
          key: `ai:conversation:${conversation.id}`,
          ownerId: crypto.randomUUID(),
          ttlMs: 120_000
        });
        if (!lease.acquired) return json(res, 409, { error: "A response is already being generated for this conversation" });
      }
      if (!acquireWebAiConcurrency(authenticated.userId)) {
        if (lease?.acquired) await store.releaseLease({ key: lease.key, ownerId: lease.ownerId });
        return json(res, 429, { error: "An AI response is already running or the service is at capacity" });
      }
      let usage;
      try {
        usage = await reserveTelegramWebAiUsage({
          userId: authenticated.userId,
          requestId: data.requestId,
          model
        });
      } catch (error) {
        releaseWebAiConcurrency(authenticated.userId);
        if (lease?.acquired) await store?.releaseLease?.({ key: lease.key, ownerId: lease.ownerId });
        throw error;
      }
      if (!usage.allowed) {
        releaseWebAiConcurrency(authenticated.userId);
        if (lease?.acquired) await store?.releaseLease?.({ key: lease.key, ownerId: lease.ownerId });
        return json(res, usage.status, { error: usage.error });
      }
      return streamWebChat(req, res, {
        authenticated,
        usage,
        message: data.message.trim(),
        model,
        conversation,
        lease
      });
    }

    if (req.method === "GET" && url.pathname === "/api/billing/history") {
      const authenticated = verifyTelegramWebAppSession(bearerToken(req));
      if (!authenticated) return json(res, 401, { error: "Fresh Telegram authentication is required" });
      if (!consumeRequestBudget(req, "billing-history", { limit: 60, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const dashboard = await telegramDashboardState({ userId: authenticated.userId });
      if (dashboard.banned && !dashboard.isAdmin) return json(res, 403, { error: "This account is banned" });
      return json(res, 200, await telegramBillingHistory({ userId: authenticated.userId, limit: parseLimit(url) }));
    }

    if (req.method === "GET" && ["/api/admin/payments", "/api/admin/usage"].includes(url.pathname)) {
      if (!consumeRequestBudget(req, "admin-read", { limit: 120, windowMs: 60_000 })) return json(res, 429, { error: "Request limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "billing.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const userId = url.searchParams.get("userId");
      if (userId && !/^[1-9]\d*$/.test(userId)) return json(res, 400, { error: "userId must be a Telegram user ID" });
      const history = await telegramBillingHistory({ userId: userId || null, limit: parseLimit(url) });
      return json(res, 200, url.pathname.endsWith("/payments") ? { payments: history.payments } : { usage: history.usage });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/payments.csv") {
      if (!consumeRequestBudget(req, "admin-export", { limit: 12, windowMs: 60_000 })) return json(res, 429, { error: "Export limit reached" });
      const auth = await authorizeAdminRequest(req, { permission: "billing.view" });
      if (!auth.allowed) return json(res, auth.status, { error: auth.error });
      const userId = url.searchParams.get("userId");
      if (userId && !/^[1-9]\d*$/.test(userId)) return json(res, 400, { error: "userId must be a Telegram user ID" });
      const history = await telegramBillingHistory({ userId: userId || null, limit: parseLimit(url) });
      return csv(res, "nvid-ai-payments.csv", [
        { key: "chargeId", label: "Telegram charge ID" },
        { key: "userId", label: "Telegram user ID" },
        { key: "amount", label: "Stars" },
        { key: "currency", label: "Currency" },
        { key: "creditedAt", label: "Credited at" },
        { key: "refundedAt", label: "Refunded at" },
        { key: "refundedAmount", label: "Refunded Stars" }
      ], history.payments);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/telegram") {
      if (!process.env.TELEGRAM_WEBHOOK_SECRET || req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
        return json(res, 401, { error: "Invalid webhook secret" });
      }
      if (!consumeRequestBudget(req, "telegram-webhook", { limit: 1200, windowMs: 60_000 })) {
        return json(res, 429, { error: "Webhook request limit reached" });
      }
      const webhookStore = getPlatformStore();
      if (webhookStore?.consumeSharedRateLimit) {
        const budget = await webhookStore.consumeSharedRateLimit({ key: "telegram:webhook", limit: 1200, windowMs: 60_000 });
        if (!budget.allowed) return json(res, 429, { error: "Shared webhook limit reached" });
      }
      const data = await jsonBody(req, { maxBytes: 1_000_000 });
      // Commit the isolated moderation job before acknowledging Telegram.
      // Database failure leaves a non-2xx response, allowing Telegram to retry.
      await captureGroupManagerUpdate(data);
      if (telegramUpdateRequiresSynchronousAck(data)) {
        await handleTelegram(data);
        return json(res, 200, { ok: true });
      }
      handleTelegram(data).catch((error) => logger.error("telegram.update_failed", { error, updateId: data?.update_id }));
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/webhooks/whatsapp") {
      if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(url.searchParams.get("hub.challenge"));
      }
      return json(res, 403, { error: "Verification failed" });
    }

    if (req.method === "POST" && url.pathname === "/webhooks/whatsapp") {
      if (!consumeRequestBudget(req, "whatsapp-webhook", { limit: 600, windowMs: 60_000 })) {
        return json(res, 429, { error: "Webhook request limit reached" });
      }
      const raw = await body(req, { maxBytes: 1_000_000 });
      if (!validMetaSignature(raw, req.headers["x-hub-signature-256"])) return json(res, 401, { error: "Invalid signature" });
      const data = JSON.parse(raw.toString("utf8"));
      const store = getPlatformStore();
      const whatsappEnabled = await store?.isFeatureEnabled?.("whatsapp_ai").catch(() => false) === true;
      if (!whatsappEnabled) {
        await recordSecurityEvent(req, {
          eventType: "whatsapp_ai_denied",
          severity: "low",
          metadata: { reason: "feature_disabled" }
        });
        return json(res, 200, { ok: true, ai: "disabled" });
      }
      const sender = String(data.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from || "");
      const senderHash = sourceIdentifierHash(sender || "unknown");
      if (!sender || !store?.consumeSharedRateLimit || !store?.acquireLease) {
        await recordSecurityEvent(req, {
          eventType: "whatsapp_ai_denied",
          severity: "medium",
          metadata: { reason: "durable_controls_unavailable" }
        });
        return json(res, 200, { ok: true, ai: "unavailable" });
      }
      const [userBudget, globalBudget] = await Promise.all([
        store.consumeSharedRateLimit({ key: `whatsapp:user:${senderHash}`, limit: 10, windowMs: 60 * 60_000 }),
        store.consumeSharedRateLimit({ key: "whatsapp:global", limit: 100, windowMs: 60 * 60_000 })
      ]);
      if (!userBudget.allowed || !globalBudget.allowed) {
        await recordSecurityEvent(req, {
          eventType: "whatsapp_ai_denied",
          severity: "medium",
          metadata: { reason: "shared_quota_exhausted" }
        });
        return json(res, 200, { ok: true, ai: "rate_limited" });
      }
      const lease = await store.acquireLease({ key: `whatsapp:user:${senderHash}`, ownerId: crypto.randomUUID(), ttlMs: 120_000 });
      if (!lease.acquired) return json(res, 200, { ok: true, ai: "busy" });
      handleWhatsApp(data)
        .catch((error) => logger.error("whatsapp.update_failed", { error }))
        .finally(() => store.releaseLease({ key: lease.key, ownerId: lease.ownerId })
          .catch((error) => logger.error("whatsapp.lease_release_failed", { error })));
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET") {
      const miniAppRoute = /^\/(home|chat|models|assistants|groups|moderation|bots|guard|secretary|threads|usage|history|payments|vouchers|settings|help|admin(?:\/.*)?|group\/[^/]+)\/?$/.test(url.pathname);
      const name = url.pathname === "/" ? "index.html" : miniAppRoute ? "miniapp.html" : decodeURIComponent(url.pathname.slice(1));
      const filePath = path.normalize(path.join(root, name));
      if (!filePath.startsWith(root + path.sep) && filePath !== root) return json(res, 404, { error: "Not found" });
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml; charset=utf-8"
      };
      try {
        const content = await fs.readFile(filePath);
        res.writeHead(200, {
          "content-type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream",
          "x-content-type-options": "nosniff",
          "referrer-policy": "strict-origin-when-cross-origin",
          "permissions-policy": "camera=(), microphone=(), geolocation=()",
          "content-security-policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
        });
        return res.end(content);
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EISDIR") throw error;
      }
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    if (!res.headersSent && error instanceof SyntaxError) {
      return json(res, 400, { error: "Request body must be valid JSON" });
    }
    if (!res.headersSent && [413, 415].includes(error?.statusCode)) {
      return json(res, error.statusCode, { error: error.message });
    }
    if (!res.headersSent && error instanceof TypeError) {
      logger.warn("http.request_validation_failed", { error, method: req.method, path: url.pathname });
      return json(res, 400, { error: "Invalid request parameters" });
    }
    if (res.headersSent) {
      logger.error("http.request_failed_after_headers", { error, method: req.method, path: url.pathname });
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    logger.error("http.request_failed", { error, method: req.method, path: url.pathname });
    if (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500) {
      return json(res, Number(error.statusCode), { error: error.message });
    }
    const providerUnavailable = [429, 500, 502, 503, 504].includes(error.statusCode);
    json(res, providerUnavailable ? 503 : 500, {
      error: providerUnavailable
        ? "NVIDIA is temporarily busy. Please try again in a moment."
        : "The assistant could not complete that request"
    });
  }
  });
}

export function startAppServer(listenPort = port) {
  const config = validateRuntimeConfiguration(process.env, { requireNvidia: false });
  const server = createAppServer();
  server.listen(listenPort, () => {
    logger.info("application.listening", { port: listenPort, environment: config.environment, deploymentVersion: config.deploymentVersion });
    initializePlatformFoundation()
      .then(() => {
        startSecretaryReminderWorker();
        startGroupManagerWorker();
        if (!config.nvidia.configured) {
          logger.warn("nvidia.provider_unconfigured", { reason: "NVIDIA_API_KEY is not configured" });
          return;
        }
        return initializeNvidiaModelControls();
      })
      .catch((error) => logger.error("platform.startup_initialization_failed", { error }));
    configureTelegramBot().catch((error) => logger.error("telegram.setup_failed", { error }));
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startAppServer();
}
