// Interpret the original seeded global 2/hour policy as the approved 2/minute
// default without migrating schema or rewriting administrator overrides.
export function effectiveFreePolicy(policy, feature = "ai_chat") {
  const freeLimit = Number(policy?.free_successes ?? 2);
  const configured = Number(policy?.window_seconds ?? 60);
  const legacyDefault = feature === "ai_chat" && freeLimit === 2 && configured === 3600
    && policy?.scope_type === "global" && policy?.scope_id === "*";
  return { freeLimit, windowSeconds: legacyDefault ? 60 : configured };
}

// Notification state ONLY. Every request still passes fresh authorization,
// quota and paid-balance checks. No access decision is cached here.
export function createLimitNotices({ now = Date.now, capacity = 1000 } = {}) {
  const notices = new Map();
  return {
    shouldNotify(key, resetAt) {
      const time = now();
      const until = new Date(resetAt).getTime();
      if (!Number.isFinite(until) || until <= time) return true;
      for (const [id, expiration] of notices) if (expiration <= time) notices.delete(id);
      if ((notices.get(key) || 0) > time) return false;
      if (notices.size >= capacity) notices.delete(notices.keys().next().value);
      notices.set(key, until);
      return true;
    }
  };
}
