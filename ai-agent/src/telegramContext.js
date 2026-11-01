const MESSAGE_UPDATE_TYPES = Object.freeze([
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
  "guest_message"
]);

const CONTROL_UPDATE_TYPES = Object.freeze([
  "callback_query",
  "inline_query",
  "business_connection",
  "deleted_business_messages",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "managed_bot",
  "pre_checkout_query",
  "shipping_query",
  "subscription"
]);

export const GROUP_ACTIVATION_POLICIES = Object.freeze([
  "mention_only",
  "command_only",
  "mention_command_or_reply",
  "administrators_only",
  "always_on"
]);

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLocaleLowerCase();
}

function updateType(update) {
  if (update?.message?.successful_payment) return "successful_payment";
  if (update?.message?.refunded_payment) return "refunded_payment";
  for (const key of [...MESSAGE_UPDATE_TYPES, ...CONTROL_UPDATE_TYPES]) {
    if (update?.[key] !== undefined && update?.[key] !== null) return key;
  }
  return "unknown";
}

function messageForUpdate(update, type) {
  if (["successful_payment", "refunded_payment"].includes(type)) return update.message;
  if (MESSAGE_UPDATE_TYPES.includes(type)) return update[type];
  if (type === "callback_query") return update.callback_query?.message || null;
  return null;
}

function textEntityValue(text, entity) {
  if (!text || !entity || !Number.isInteger(entity.offset) || !Number.isInteger(entity.length)) return "";
  return text.slice(entity.offset, entity.offset + entity.length);
}

export function parseTelegramCommand(messageOrText, { botUsername = null } = {}) {
  const message = typeof messageOrText === "string" ? { text: messageOrText } : (messageOrText || {});
  const text = String(message.text || message.caption || "");
  if (!text.startsWith("/") || message.forward_origin || message.forward_date) return null;

  const entities = Array.isArray(message.entities) ? message.entities
    : Array.isArray(message.caption_entities) ? message.caption_entities : [];
  const commandEntity = entities.find((entity) => entity?.type === "bot_command" && entity.offset === 0);
  let token;
  if (commandEntity) {
    token = textEntityValue(text, commandEntity);
  } else {
    // Compatibility fallback for clients and tests which omit entities. It is
    // deliberately anchored to the beginning and accepts only Telegram's
    // command alphabet.
    token = text.match(/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?=\s|$)/)?.[0] || "";
  }
  if (!token) return null;

  const match = token.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/);
  if (!match) return null;
  const commandTargetUsername = normalizeUsername(match[2]);
  const configuredUsername = normalizeUsername(botUsername);
  return Object.freeze({
    name: match[1].toLocaleLowerCase(),
    botUsername: commandTargetUsername || null,
    commandTargetUsername: commandTargetUsername || null,
    addressedToThisBot: !commandTargetUsername || !configuredUsername || commandTargetUsername === configuredUsername,
    argument: text.slice(token.length).trim(),
    raw: token
  });
}

function explicitMention(message, botUsername, botId) {
  const text = String(message?.text || message?.caption || "");
  const entities = Array.isArray(message?.entities)
    ? message.entities
    : Array.isArray(message?.caption_entities) ? message.caption_entities : [];
  const expectedUsername = normalizeUsername(botUsername);
  for (const entity of entities) {
    if (entity?.type === "text_mention" && String(entity.user?.id || "") === String(botId || "")) return true;
    if (entity?.type === "mention") {
      const mentioned = normalizeUsername(textEntityValue(text, entity));
      if (expectedUsername && mentioned === expectedUsername) return true;
    }
  }
  if (!expectedUsername) return false;
  return new RegExp(`(^|\\s)@${expectedUsername}(?=\\s|[.,!?;:]|$)`, "i").test(text);
}

function replyTargetsBot(message, botUsername, botId) {
  const author = message?.reply_to_message?.from || message?.reply_to_message?.sender_business_bot;
  if (!author) return false;
  if (botId && String(author.id || "") === String(botId)) return true;
  return Boolean(botUsername && normalizeUsername(author.username) === normalizeUsername(botUsername));
}

function stripMention(text, botUsername) {
  const username = normalizeUsername(botUsername);
  if (!username) return text.trim();
  return text.replace(new RegExp(`(^|\\s)@${username}(?=\\s|[.,!?;:]|$)`, "ig"), "$1").trim();
}

function transportMode(type) {
  if (type === "inline_query") return "inline";
  if (type === "guest_message") return "guest";
  if (["business_connection", "business_message", "edited_business_message", "deleted_business_messages"].includes(type)) return "telegram_secretary";
  if (type === "managed_bot") return "managed_bot";
  if (type === "chat_join_request") return "guard";
  return "bot_api";
}

function chatContext(chat, threadId) {
  if (threadId !== null && threadId !== undefined) return "thread";
  return ["private", "group", "supergroup", "channel"].includes(chat?.type) ? chat.type : "none";
}

function runtimeMode({ type, chat, threadId, groupSettings }) {
  if (type === "inline_query") return "inline";
  if (type === "guest_message") return "guest";
  if (["business_connection", "business_message", "edited_business_message", "deleted_business_messages"].includes(type)) return "telegram_secretary";
  if (type === "managed_bot") return "managed_bot";
  if (type === "chat_join_request") return "guard";
  if (["group", "supergroup"].includes(chat?.type) && groupSettings?.secretaryEnabled) return "group_secretary";
  if (threadId !== null && threadId !== undefined) return "threaded_ai";
  if (["group", "supergroup"].includes(chat?.type)) return "group_ai";
  if (chat?.type === "channel") return "channel";
  return "private_ai";
}

function operatingContext({ type, chat, threadId, groupSettings }) {
  if (["successful_payment", "refunded_payment", "pre_checkout_query"].includes(type)) return "payment";
  if (type === "inline_query") return "inline";
  if (type === "guest_message") return "guest";
  if (["business_connection", "business_message", "edited_business_message", "deleted_business_messages"].includes(type)) return "telegram_business_secretary";
  if (type === "managed_bot") return "managed_bot";
  if (type === "chat_join_request") return "guard";
  if (type === "callback_query") return "callback";
  if (["group", "supergroup"].includes(chat?.type) && groupSettings?.secretaryEnabled) return "group_secretary";
  if (threadId !== null && threadId !== undefined) return "group_topic";
  if (chat?.type === "private") return "private_bot_chat";
  if (chat?.type === "supergroup") return "supergroup";
  if (chat?.type === "group") return "group";
  return chat?.type || "unknown";
}

function invocationDecision({ type, message, command, mentioned, replyToBot, senderIsBot, groupSettings, senderRole }) {
  const chatType = message?.chat?.type;
  if (type === "inline_query") return { invoked: true, reason: "inline_query" };
  if (type === "guest_message") return { invoked: true, reason: "guest_query" };
  if (type === "business_message") return { invoked: true, reason: "business_message" };
  if (type === "callback_query") return { invoked: true, reason: "callback_action" };
  if (type === "chat_join_request") return { invoked: true, reason: "guard_join_request" };
  if (type === "managed_bot") return { invoked: true, reason: "managed_bot_update" };
  if (["edited_message", "edited_channel_post", "edited_business_message", "deleted_business_messages", "business_connection", "my_chat_member", "chat_member"].includes(type)) {
    return { invoked: false, reason: "observation_only" };
  }
  if (chatType === "channel") return { invoked: false, reason: "unsupported_channel_post" };
  if (chatType === "private") return { invoked: true, reason: command ? "private_command" : "private_message" };
  if (!["group", "supergroup"].includes(chatType)) return { invoked: false, reason: "unsupported_update" };
  if (senderIsBot && !groupSettings?.botToBotEnabled) return { invoked: false, reason: "other_bot_ignored" };

  const nvidCommand = command?.addressedToThisBot && (command.name === "nvid" || command.name.startsWith("nvid_"));
  const explicit = Boolean(nvidCommand || mentioned || replyToBot);
  const policy = GROUP_ACTIVATION_POLICIES.includes(groupSettings?.activationPolicy)
    ? groupSettings.activationPolicy
    : "mention_only";
  if (policy === "always_on" && groupSettings?.alwaysOnConfirmed === true) return { invoked: true, reason: explicit ? "explicit_invocation" : "always_on" };
  if (policy === "administrators_only") {
    const administrator = ["creator", "administrator"].includes(senderRole);
    return { invoked: administrator && explicit, reason: administrator ? (explicit ? "administrator_invocation" : "not_invoked") : "administrator_required" };
  }
  if (policy === "command_only") return { invoked: Boolean(nvidCommand), reason: nvidCommand ? "nvid_command" : "command_required" };
  if (nvidCommand) return { invoked: true, reason: "nvid_command" };
  if (mentioned) return { invoked: true, reason: "bot_mention" };
  if (replyToBot) return { invoked: true, reason: "reply_to_bot" };
  return { invoked: false, reason: "not_invoked" };
}

export function activationPolicyLabel(policy) {
  return ({
    mention_only: "Mention or /nvid",
    command_only: "/nvid only",
    mention_command_or_reply: "Mention, /nvid, or reply",
    administrators_only: "Administrators only",
    always_on: "Always on"
  })[policy] || "Mention or /nvid";
}

export function resolveTelegramUpdateContext(update, {
  botUsername = null,
  botId = null,
  groupState = null,
  senderMember = null,
  botMember = null,
  assistantMode = "chat",
  managedBot = null,
  platformUser = null,
  activeEntitlement = null,
  billingOwnerUserId = null
} = {}) {
  const type = updateType(update);
  const message = messageForUpdate(update, type);
  const membership = update?.my_chat_member || update?.chat_member || null;
  const joinRequest = update?.chat_join_request || null;
  const deletedBusiness = update?.deleted_business_messages || null;
  const inlineQuery = update?.inline_query || null;
  const managedBotUpdate = update?.managed_bot || null;
  const chat = message?.chat || membership?.chat || joinRequest?.chat || deletedBusiness?.chat || null;
  const from = message?.from || update?.callback_query?.from || inlineQuery?.from || membership?.from || joinRequest?.from || managedBotUpdate?.user || null;
  const command = parseTelegramCommand(message || "", { botUsername });
  const mentioned = explicitMention(message, botUsername, botId);
  const replyToBot = replyTargetsBot(message, botUsername, botId);
  const senderRole = senderMember?.status || (membership?.new_chat_member?.user?.id === from?.id ? membership?.new_chat_member?.status : null) || "unknown";
  const settings = groupState?.settings || groupState || {};
  const invocation = invocationDecision({
    type,
    message,
    command,
    mentioned,
    replyToBot,
    senderIsBot: from?.is_bot === true,
    groupSettings: settings,
    senderRole
  });
  const rawText = String(message?.text || message?.caption || "").trim();
  const promptText = command?.name === "nvid"
    ? command.argument
    : mentioned ? stripMention(rawText, botUsername) : rawText;
  const threadId = message?.message_thread_id ?? null;
  const businessConnectionId = message?.business_connection_id
    || update?.business_connection?.id
    || deletedBusiness?.business_connection_id
    || null;

  return Object.freeze({
    updateType: type,
    updateId: update?.update_id ?? null,
    chatId: chat?.id ?? null,
    chatType: chat?.type || null,
    isPrivate: chat?.type === "private",
    isGroup: chat?.type === "group",
    isSupergroup: chat?.type === "supergroup",
    isChannel: chat?.type === "channel",
    isThread: threadId !== null,
    telegramUserId: from?.id ?? null,
    senderIsBot: from?.is_bot === true,
    botUsername: normalizeUsername(botUsername) || null,
    messageId: message?.message_id ?? null,
    replyTarget: message?.reply_to_message?.from?.id ?? null,
    messageThreadId: threadId,
    businessConnectionId,
    guestQueryId: message?.guest_query_id || null,
    managedBot: managedBot || managedBotUpdate || null,
    command,
    commandTargetUsername: command?.commandTargetUsername || null,
    explicitBotMention: mentioned,
    replyToBotActivation: replyToBot,
    senderGroupRole: senderRole,
    botGroupPermissions: botMember || groupState?.group?.botPermissions || null,
    groupConfiguration: settings,
    telegramTransportMode: transportMode(type),
    chatContext: chatContext(chat, threadId),
    invocationMode: invocation.reason,
    productFeatureMode: runtimeMode({ type, chat, threadId, groupSettings: settings }),
    assistantMode,
    effectiveRuntimeMode: runtimeMode({ type, chat, threadId, groupSettings: settings }),
    operatingContext: operatingContext({ type, chat, threadId, groupSettings: settings }),
    platformUserStatus: platformUser?.status || platformUser?.role || null,
    activeEntitlement: activeEntitlement || null,
    effectiveBillingOwnerUserId: billingOwnerUserId ?? from?.id ?? null,
    invocationReason: invocation.reason,
    invoked: invocation.invoked,
    promptText,
    message
  });
}
