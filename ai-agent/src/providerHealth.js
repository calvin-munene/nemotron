const MAX_RECENT_EVENTS = 100;
const recentEvents = [];
const state = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastStatusCode: null,
  lastLatencyMs: null,
  averageLatencyMs: null,
  lastModel: null,
  catalogLastRefreshAt: null,
  catalogLastErrorAt: null,
  catalogModelCount: 0
};

function boundedLatency(value) {
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null;
}

function safeStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function recordNvidiaRequest({ ok, statusCode, latencyMs, model } = {}) {
  const timestamp = new Date().toISOString();
  const latency = boundedLatency(latencyMs);
  state.totalRequests += 1;
  state.lastStatusCode = safeStatus(statusCode);
  state.lastLatencyMs = latency;
  state.lastModel = typeof model === "string" ? model.slice(0, 200) : null;
  if (latency !== null) {
    state.averageLatencyMs = state.averageLatencyMs === null
      ? latency
      : Math.round((state.averageLatencyMs * 0.8) + (latency * 0.2));
  }
  if (ok) {
    state.successfulRequests += 1;
    state.consecutiveFailures = 0;
    state.lastSuccessAt = timestamp;
  } else {
    state.failedRequests += 1;
    state.consecutiveFailures += 1;
    state.lastFailureAt = timestamp;
  }
  recentEvents.push({ timestamp, ok: Boolean(ok), statusCode: state.lastStatusCode, latencyMs: latency, model: state.lastModel });
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
}

export function recordNvidiaCatalog({ ok, modelCount = 0 } = {}) {
  const timestamp = new Date().toISOString();
  if (ok) {
    state.catalogLastRefreshAt = timestamp;
    state.catalogModelCount = Number.isSafeInteger(modelCount) && modelCount >= 0 ? modelCount : 0;
  } else {
    state.catalogLastErrorAt = timestamp;
  }
}

export function nvidiaProviderHealth() {
  const recentFailures = recentEvents.filter((event) => !event.ok).length;
  const healthy = state.consecutiveFailures < 3;
  return {
    healthy,
    status: healthy ? (state.consecutiveFailures ? "degraded" : "healthy") : "unhealthy",
    ...state,
    recentFailureRate: recentEvents.length ? Number((recentFailures / recentEvents.length).toFixed(3)) : 0
  };
}

export function resetProviderHealthForTests() {
  recentEvents.length = 0;
  Object.assign(state, {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastStatusCode: null,
    lastLatencyMs: null,
    averageLatencyMs: null,
    lastModel: null,
    catalogLastRefreshAt: null,
    catalogLastErrorAt: null,
    catalogModelCount: 0
  });
}
