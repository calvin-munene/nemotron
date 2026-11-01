import assert from "node:assert/strict";
import test from "node:test";
import { parseTelegramCommand, resolveTelegramUpdateContext } from "../src/telegramContext.js";

test("photo captions support addressed commands without interpreting forwarded commands", () => {
  const command = parseTelegramCommand({
    caption: "/nvid@NvidBot draw a cat",
    caption_entities: [{ type: "bot_command", offset: 0, length: 13 }]
  }, { botUsername: "NvidBot" });
  assert.equal(command.name, "nvid");
  assert.equal(command.argument, "draw a cat");
  assert.equal(command.addressedToThisBot, true);
  assert.equal(parseTelegramCommand({ caption: "/nvid draw", forward_origin: { type: "user" } }), null);
});

function messageUpdate({ type = "private", text = "hello", entities, from, threadId, replyTo, updateType = "message" } = {}) {
  return {
    update_id: 10,
    [updateType]: {
      message_id: 20,
      chat: { id: type === "private" ? 7 : -1007, type, title: "Test Group" },
      from: from || { id: 8, is_bot: false, first_name: "User" },
      text,
      ...(entities ? { entities } : {}),
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...(replyTo ? { reply_to_message: replyTo } : {})
    }
  };
}

test("detects private, group, supergroup, channel, and threaded contexts", () => {
  const privateContext = resolveTelegramUpdateContext(messageUpdate(), { botUsername: "Nvidk_bot", botId: 99 });
  const groupContext = resolveTelegramUpdateContext(messageUpdate({ type: "group" }), { botUsername: "Nvidk_bot", botId: 99 });
  const supergroupContext = resolveTelegramUpdateContext(messageUpdate({ type: "supergroup", threadId: 42 }), { botUsername: "Nvidk_bot", botId: 99 });
  const channelContext = resolveTelegramUpdateContext(messageUpdate({ type: "channel", updateType: "channel_post" }), { botUsername: "Nvidk_bot", botId: 99 });
  assert.equal(privateContext.isPrivate, true);
  assert.equal(groupContext.isGroup, true);
  assert.equal(groupContext.invoked, false);
  assert.equal(supergroupContext.isSupergroup, true);
  assert.equal(supergroupContext.chatContext, "thread");
  assert.equal(supergroupContext.messageThreadId, 42);
  assert.equal(channelContext.isChannel, true);
  assert.equal(channelContext.invocationReason, "unsupported_channel_post");
});

test("parses addressed nvid commands using Telegram command entities", () => {
  const text = "/NVID@Nvidk_bot explain this";
  const command = parseTelegramCommand({
    text,
    entities: [{ type: "bot_command", offset: 0, length: 15 }]
  }, { botUsername: "Nvidk_bot" });
  assert.equal(command.name, "nvid");
  assert.equal(command.botUsername, "nvidk_bot");
  assert.equal(command.addressedToThisBot, true);
  assert.equal(command.argument, "explain this");
});

test("activates /nvid, mention, and reply while ignoring ordinary group messages", () => {
  const options = { botUsername: "Nvidk_bot", botId: 99, groupState: { activationPolicy: "mention_only" } };
  const command = resolveTelegramUpdateContext(messageUpdate({
    type: "supergroup",
    text: "/nvid explain photosynthesis",
    entities: [{ type: "bot_command", offset: 0, length: 5 }]
  }), options);
  const addressed = resolveTelegramUpdateContext(messageUpdate({
    type: "supergroup",
    text: "@Nvidk_bot build a plan",
    entities: [{ type: "mention", offset: 0, length: 10 }]
  }), options);
  const reply = resolveTelegramUpdateContext(messageUpdate({
    type: "supergroup",
    text: "continue",
    replyTo: { message_id: 19, from: { id: 99, is_bot: true, username: "Nvidk_bot" } }
  }), options);
  const ordinary = resolveTelegramUpdateContext(messageUpdate({ type: "supergroup", text: "ordinary conversation" }), options);
  assert.equal(command.invoked, true);
  assert.equal(command.promptText, "explain photosynthesis");
  assert.equal(addressed.invocationReason, "bot_mention");
  assert.equal(addressed.promptText, "build a plan");
  assert.equal(reply.invocationReason, "reply_to_bot");
  assert.equal(ordinary.invoked, false);
});

test("does not accept commands addressed to another bot or forwarded command text", () => {
  const other = resolveTelegramUpdateContext(messageUpdate({
    type: "supergroup",
    text: "/nvid@Other_bot hello",
    entities: [{ type: "bot_command", offset: 0, length: 15 }]
  }), { botUsername: "Nvidk_bot", botId: 99 });
  const forwarded = parseTelegramCommand({ text: "/nvid quoted", forward_origin: { type: "user" } }, { botUsername: "Nvidk_bot" });
  assert.equal(other.invoked, false);
  assert.equal(other.command.addressedToThisBot, false);
  assert.equal(forwarded, null);
});

test("distinguishes Telegram Secretary, Group Secretary, inline, guest, Guard, and managed bot modes", () => {
  const business = resolveTelegramUpdateContext({
    update_id: 1,
    business_message: {
      message_id: 2,
      business_connection_id: "bc_1",
      chat: { id: 3, type: "private" },
      from: { id: 4, is_bot: false },
      text: "hello"
    }
  });
  const group = resolveTelegramUpdateContext(messageUpdate({ type: "supergroup" }), {
    groupState: { secretaryEnabled: true }
  });
  const inline = resolveTelegramUpdateContext({ update_id: 2, inline_query: { id: "i", from: { id: 4 }, query: "ask" } });
  const guest = resolveTelegramUpdateContext({
    update_id: 3,
    guest_message: { message_id: 4, guest_query_id: "g", chat: { id: -8, type: "group" }, from: { id: 5 }, text: "ask" }
  });
  const guard = resolveTelegramUpdateContext({ update_id: 4, chat_join_request: { chat: { id: -8, type: "supergroup" }, from: { id: 5 } } });
  const managed = resolveTelegramUpdateContext({ update_id: 5, managed_bot: { user: { id: 5 }, bot: { id: 6, is_bot: true } } });
  assert.equal(business.effectiveRuntimeMode, "telegram_secretary");
  assert.equal(business.businessConnectionId, "bc_1");
  assert.equal(group.effectiveRuntimeMode, "group_secretary");
  assert.equal(inline.telegramTransportMode, "inline");
  assert.equal(guest.telegramTransportMode, "guest");
  assert.equal(guard.productFeatureMode, "guard");
  assert.equal(managed.productFeatureMode, "managed_bot");
});

test("messages from other bots are ignored unless bot-to-bot mode is enabled and explicitly addressed", () => {
  const update = messageUpdate({
    type: "supergroup",
    text: "@Nvidk_bot coordinate",
    entities: [{ type: "mention", offset: 0, length: 10 }],
    from: { id: 77, is_bot: true, username: "Other_bot" }
  });
  const ignored = resolveTelegramUpdateContext(update, { botUsername: "Nvidk_bot", botId: 99 });
  const allowed = resolveTelegramUpdateContext(update, { botUsername: "Nvidk_bot", botId: 99, groupState: { botToBotEnabled: true } });
  assert.equal(ignored.invocationReason, "other_bot_ignored");
  assert.equal(allowed.invoked, true);
});

test("payment messages retain their message context while identifying the payment update", () => {
  const successful = resolveTelegramUpdateContext({
    update_id: 70,
    message: { message_id: 8, from: { id: 1 }, chat: { id: 1, type: "private" }, successful_payment: { currency: "XTR" } }
  });
  const refunded = resolveTelegramUpdateContext({
    update_id: 71,
    message: { message_id: 9, from: { id: 1 }, chat: { id: 1, type: "private" }, refunded_payment: { currency: "XTR" } }
  });
  assert.equal(successful.updateType, "successful_payment");
  assert.equal(successful.chatId, 1);
  assert.equal(refunded.updateType, "refunded_payment");
  assert.equal(refunded.messageId, 9);
});
