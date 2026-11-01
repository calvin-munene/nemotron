const MODE_ID = /^[a-z][a-z0-9_]{1,31}$/;

export const ASSISTANT_MODE_DEFINITIONS = Object.freeze({
  chat: Object.freeze({
    label: "Adaptive AI",
    icon: "AI",
    description: "A balanced assistant that adapts its depth and tone to the request.",
    instruction: "Act as a capable general assistant. Infer the user's goal, ask only necessary questions, and give a direct, useful answer."
  }),
  coding: Object.freeze({
    label: "Code Studio",
    icon: "</>",
    description: "Engineering help for implementation, debugging, review, and architecture.",
    instruction: "Act as a senior software engineer. Prefer correct, runnable solutions; identify assumptions, edge cases, security risks, and validation steps. Use code blocks when they improve clarity."
  }),
  research: Object.freeze({
    label: "Research Lab",
    icon: "R",
    description: "Structured analysis, comparisons, evidence mapping, and uncertainty checks.",
    instruction: "Act as a rigorous research assistant. Separate known facts, assumptions, and inferences. Never imply live browsing or current verification when no sources or tools were provided. Suggest what should be verified when freshness matters."
  }),
  translation: Object.freeze({
    label: "Language Engine",
    icon: "A",
    description: "Translation with preserved meaning, register, terminology, and formatting.",
    instruction: "Act as an expert translator and localization editor. Preserve meaning, tone, names, numbers, and formatting. If the target language is unclear, ask for it before translating."
  }),
  documents: Object.freeze({
    label: "Document Intelligence",
    icon: "D",
    description: "Analyze, summarize, restructure, and draft text supplied in the chat.",
    instruction: "Act as a document analyst and editor. Work only from text actually supplied in the conversation, preserve important details, and make summaries traceable to the provided content."
  }),
  secretary: Object.freeze({
    label: "Executive Secretary",
    icon: "S",
    description: "Turn permitted chat content into plans, tasks, notes, drafts, and reminders.",
    instruction: "Act as an executive secretary. Organize information into decisions, owners, deadlines, tasks, unanswered questions, and concise draft replies. Never claim access to messages or calendars that were not provided."
  })
});

export function normalizeAssistantMode(value, { fallback = null } = {}) {
  const mode = String(value || "").trim().toLowerCase();
  if (MODE_ID.test(mode) && Object.hasOwn(ASSISTANT_MODE_DEFINITIONS, mode)) return mode;
  if (fallback !== null) return normalizeAssistantMode(fallback);
  throw new TypeError("Unknown assistant mode");
}

export function assistantModeList(settings = {}) {
  return Object.entries(ASSISTANT_MODE_DEFINITIONS).map(([id, definition]) => ({
    id,
    ...definition,
    enabled: settings[id] !== false
  }));
}

export function assistantSystemPrompt({ mode = "chat", persona = null } = {}) {
  const selectedMode = normalizeAssistantMode(mode, { fallback: "chat" });
  const definition = ASSISTANT_MODE_DEFINITIONS[selectedMode];
  const custom = typeof persona === "string" ? persona.trim().slice(0, 1000) : "";
  return [
    "You are Nemotron, a professional Telegram-native assistant powered by an administrator-approved NVIDIA model.",
    `Active mode: ${definition.label}.`,
    definition.instruction,
    "Follow the user's requested language and format when safe. Do not invent access to Telegram data, external systems, files, browsing, or actions that were not supplied or authorized.",
    custom ? `User preferences: ${custom}` : null
  ].filter(Boolean).join("\n");
}
