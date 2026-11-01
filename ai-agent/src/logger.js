const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|credential|api[_-]?key|database[_-]?url|connection[_-]?string)/i;
const SECRET_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]{16,}/g,
  /\b\d{6,12}:AA[A-Za-z0-9_-]{20,}\b/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /postgres(?:ql)?:\/\/[^\s"']+/gi
];
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

export function redactSecretText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

function sanitize(value, key = "", seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return value === undefined ? undefined : "[REDACTED]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecretText(value.message),
      ...(value.statusCode ? { statusCode: value.statusCode } : {})
    };
  }
  if (typeof value === "string") return redactSecretText(value);
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, "", seen));
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    sanitize(childValue, childKey, seen)
  ]));
}

export function sanitizeLogData(value) {
  return sanitize(value);
}

export function createLogger({ service = "nvid-ai", level = process.env.LOG_LEVEL || "info", sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (logLevel, event, data = {}) => {
    if (LEVELS[logLevel] < threshold) return;
    const record = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      service,
      event: redactSecretText(event),
      ...sanitizeLogData(data)
    };
    const method = logLevel === "error" ? "error" : logLevel === "warn" ? "warn" : "log";
    sink[method](JSON.stringify(record));
  };
  return Object.freeze({
    debug: (event, data) => emit("debug", event, data),
    info: (event, data) => emit("info", event, data),
    warn: (event, data) => emit("warn", event, data),
    error: (event, data) => emit("error", event, data)
  });
}

export const logger = createLogger();
