const LANGUAGE_HINTS = Object.freeze([
  { id: "ar", script: /[\u0600-\u06ff]/u },
  { id: "ru", script: /[\u0400-\u04ff]/u },
  { id: "zh", script: /[\u3400-\u9fff]/u },
  { id: "ja", script: /[\u3040-\u30ff]/u },
  { id: "ko", script: /[\uac00-\ud7af]/u }
]);

const WORD_HINTS = Object.freeze({
  es: ["hola", "gracias", "por favor", "puedes", "necesito", "buenos"],
  fr: ["bonjour", "merci", "s'il vous", "pouvez", "besoin", "bonsoir"],
  pt: ["olá", "obrigado", "por favor", "você", "preciso", "bom dia"],
  sw: ["habari", "asante", "tafadhali", "naomba", "unaweza", "sawa"],
  de: ["hallo", "danke", "bitte", "können", "brauche", "guten"],
  it: ["ciao", "grazie", "per favore", "puoi", "bisogno", "buongiorno"]
});

function safeId(value, field, { signed = false } = {}) {
  const text = String(value ?? "");
  const pattern = signed ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/;
  if (!pattern.test(text)) throw new TypeError(`${field} is invalid`);
  return text;
}

export function telegramMemoryScope({
  mode,
  userId,
  chatId,
  groupId,
  threadId = null,
  businessConnectionId = null,
  managedBotId = null
}) {
  const resolvedMode = String(mode || "");
  if (resolvedMode === "private_bot_chat") {
    return `private:user:${safeId(userId, "userId")}:chat:${safeId(chatId, "chatId", { signed: true })}`;
  }
  if (resolvedMode === "telegram_business_secretary") {
    const connection = String(businessConnectionId || "");
    if (!connection || connection.length > 256) throw new TypeError("businessConnectionId is invalid");
    return `secretary:connection:${connection}:contact:${safeId(chatId, "chatId", { signed: true })}`;
  }
  if (["group", "supergroup"].includes(resolvedMode)) {
    return `group:${safeId(groupId ?? chatId, "groupId", { signed: true })}:user:${safeId(userId, "userId")}`;
  }
  if (resolvedMode === "group_topic") {
    return `group:${safeId(groupId ?? chatId, "groupId", { signed: true })}:thread:${safeId(threadId, "threadId", { signed: true })}:user:${safeId(userId, "userId")}`;
  }
  if (resolvedMode === "group_secretary") {
    return `group-secretary:${safeId(groupId ?? chatId, "groupId", { signed: true })}:thread:${threadId == null ? "main" : safeId(threadId, "threadId", { signed: true })}`;
  }
  if (resolvedMode === "managed_bot") {
    return `managed-bot:${safeId(managedBotId, "managedBotId")}:chat:${safeId(chatId, "chatId", { signed: true })}:user:${safeId(userId, "userId")}`;
  }
  throw new TypeError("Unsupported memory mode");
}

function normalizedLanguage(value) {
  const language = String(value || "").trim().toLowerCase().replace("_", "-").split("-")[0];
  return /^[a-z]{2,3}$/.test(language) ? language : null;
}

export function detectMessageLanguage(text, { recentLanguages = [], telegramLanguageCode = null, defaultLanguage = "auto" } = {}) {
  const body = String(text || "").trim();
  for (const hint of LANGUAGE_HINTS) if (hint.script.test(body)) return hint.id;
  const comparable = ` ${body.toLocaleLowerCase()} `;
  let best = null;
  let bestScore = 0;
  for (const [language, words] of Object.entries(WORD_HINTS)) {
    const score = words.reduce((total, word) => total + (comparable.includes(` ${word} `) ? 1 : 0), 0);
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  if (bestScore > 0) return best;
  const stable = recentLanguages.map(normalizedLanguage).find(Boolean);
  return stable || normalizedLanguage(telegramLanguageCode) || normalizedLanguage(defaultLanguage) || "en";
}

export function detectMessageTone(text) {
  const body = String(text || "").trim();
  const words = body.split(/\s+/u).filter(Boolean);
  const emojiCount = (body.match(/\p{Extended_Pictographic}/gu) || []).length;
  const formal = /\b(dear|regards|sincerely|kindly|please advise|good morning|good afternoon)\b/i.test(body);
  const casual = /\b(hey|hi|yo|thanks|thx|cool|okay|ok)\b/i.test(body) || emojiCount > 0;
  return {
    style: formal ? "formal" : casual ? "friendly" : "adaptive",
    sentenceLength: words.length <= 12 ? "short" : words.length >= 45 ? "detailed" : "balanced",
    emojiFrequency: emojiCount === 0 ? "none" : emojiCount > 2 ? "frequent" : "light",
    direct: /\?|\bplease\b|\bneed\b|\bwant\b/i.test(body)
  };
}

export function asksSecretaryIdentity(text) {
  return /^(who (?:is|are) (?:this|you)|what (?:is|are) you|are you (?:a )?bot)\??[.!\s]*$/i.test(String(text || "").trim());
}

export function adaptiveSecretaryProfile({
  message,
  recentLanguages = [],
  telegramLanguageCode = null,
  defaultLanguage = "auto",
  languageOverride = null,
  ownerStyle = "friendly",
  customStyle = null,
  accountName = "the connected account",
  introductionRequired = false
} = {}) {
  const language = normalizedLanguage(languageOverride)
    || detectMessageLanguage(message, { recentLanguages, telegramLanguageCode, defaultLanguage });
  const contactTone = detectMessageTone(message);
  const allowedOwnerStyle = ["formal", "friendly", "concise", "custom"].includes(ownerStyle) ? ownerStyle : "friendly";
  const tone = allowedOwnerStyle === "custom" ? "custom" : allowedOwnerStyle === "friendly" ? contactTone.style : allowedOwnerStyle;
  return {
    language,
    tone,
    contactTone,
    identityAnswer: asksSecretaryIdentity(message),
    introductionRequired: introductionRequired === true,
    systemPrompt: [
      `You are Nemotron, transparently assisting ${String(accountName || "the connected account").slice(0, 120)} through Telegram Business.`,
      "Never pretend to be the human account owner. If asked who you are, clearly say you are Nemotron assisting the connected account.",
      `Reply primarily in ${language}. Switch when the contact clearly changes language and do not mix languages unnecessarily.`,
      `Use a ${tone} business tone. Match the contact moderately: ${contactTone.sentenceLength} replies, ${contactTone.emojiFrequency} emoji use, and ${contactTone.direct ? "direct" : "conversational"} phrasing.`,
      "Do not imitate abuse, infer sensitive traits, or reveal data from any other contact, group, private chat, business connection, or memory scope.",
      allowedOwnerStyle === "custom" && customStyle ? `Owner style instructions: ${String(customStyle).slice(0, 1000)}` : "",
      introductionRequired ? `On this first reply, briefly identify yourself as Nemotron assisting ${String(accountName || "the connected account").slice(0, 120)}.` : ""
    ].filter(Boolean).join("\n")
  };
}

export function classifyAiFailure(error) {
  const code = String(error?.code || error?.category || "").toLowerCase();
  const status = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || "").toLowerCase();
  if (code.includes("entitlement") || status === 402 || status === 403) return "entitlement_denied";
  if (code.includes("business_disabled")) return "business_connection_disabled";
  if (code.includes("business_right")) return "missing_business_right";
  if (code.includes("credit") || message.includes("credit")) return "no_credits";
  if (status === 429) return message.includes("quota") ? "provider_quota_exhausted" : "rate_limited";
  if (
    code.includes("timeout")
    || status === 504
    || ["AbortError", "TimeoutError"].includes(error?.name)
    || message.includes("timed out")
    || message.includes("aborted due to timeout")
  ) return "nvidia_timeout";
  if (status === 404 || message.includes("model") && message.includes("unavailable")) return "model_unavailable";
  if (status === 400 && (message.includes("nvidia") || code.includes("provider"))) return "model_unavailable";
  if (status === 500 && message.includes("database") || code.includes("database")) return "database_failure";
  if (code.includes("delivery")) return "delivery_failure";
  if (status >= 500) return "provider_temporary_failure";
  if (status === 400 || code.includes("malformed")) return "malformed_update";
  return "internal_error";
}

export function safeAiFailureMessage(category, { secretary = false } = {}) {
  const messages = {
    entitlement_denied: secretary ? "Secretary access has not been activated for this account." : "AI access is not active for this account.",
    business_connection_disabled: "This Telegram Business connection is currently disabled.",
    missing_business_right: "Nemotron no longer has permission to reply for this Telegram Business account.",
    no_credits: "Your free allowance is used. Add credits, redeem a voucher, or wait for it to reset.",
    rate_limited: "Too many requests were received. Please try again shortly.",
    provider_quota_exhausted: "Nemotron has reached its current provider limit. Your allowance was not charged.",
    nvidia_timeout: "The AI provider took too long to respond. Your allowance was not charged.",
    model_unavailable: "The selected model is unavailable. Your allowance was not charged.",
    database_failure: "Usage controls are temporarily unavailable, so no allowance was charged.",
    delivery_failure: "A reply was generated but Telegram could not deliver it. The event has been recorded safely.",
    malformed_update: "Telegram sent an update that could not be processed safely.",
    provider_temporary_failure: "I am temporarily unable to generate a reply. Your allowance was not charged.",
    internal_error: "I am temporarily unable to complete that request. Your allowance was not charged."
  };
  return messages[category] || messages.internal_error;
}
