import { fieldValue, id } from "./policy.js";
const TOGGLES=["enabled","welcome","links","ai","compliance"];
const FIELDS=["languages","keywords","patterns","whitelist","trusted","rules","windowDays","muteSeconds","kickSeconds","aiPerMinute","threshold","pardon","globalCap"];
const PROMPTS={
  languages:"Enter comma-separated two-letter language codes; default en,sw.",keywords:"Enter comma-separated keywords; - clears the list.",
  patterns:"Enter comma-separated simple regex patterns; - clears the list.",
  whitelist:"Enter comma-separated domains, such as example.com; - clears the list.",
  trusted:"Enter comma-separated trusted user IDs; - clears the list.",
  rules:"Enter a short rules notice, up to 1000 characters.",
  windowDays:"Enter the warning window in days, 1–30.",
  muteSeconds:"Enter mute duration in seconds, 30–2592000; default 172800 (2 days).",
  kickSeconds:"Enter rejoin delay in seconds, 0–2592000; 0 means immediate unban.",
  aiPerMinute:"Enter the group moderation AI cap per minute, 1–120.",
  threshold:"Enter AI confidence threshold, 0.5–1.",
  pardon:"Enter the user ID whose warnings should be pardoned and mute removed.",
  globalCap:"Enter the global moderation AI cap per minute, 1–1000."
};
export async function showPanel(manager,chat,g) {
  const {settings:s}=await manager.store.group(g);
  const b=(label,action)=>({text:label,callback_data:`gm:${g}:${action}`});
  await manager.call("sendMessage",{chat_id:chat,text:`Group Manager: ${s.enabled?"enabled":"disabled"}.`,reply_markup:{inline_keyboard:[
    [b(s.enabled?"Disable group":"Enable group","enabled")],
    [b(`Welcome ${s.welcome?"On":"Off"}`,"welcome"),b(`Link filter ${s.links?"On":"Off"}`,"links")],
    [b(`AI filter ${s.ai?"On":"Off"}`,"ai"),b("Warn rules","warnings")],
    [b("Mute/Kick durations","durations"),b("Whitelist","lists")],
    [b("Logs","logs"),b("Pardon user","pardon")],
    [b(`Compliance ${s.compliance?"On":"Off"}`,"compliance"),b("Filter settings","filters")],
    [b("Health score","health"),b("Edit rules","rules_edit")],
    [{text:"My Groups",callback_data:"gm:0:groups"}]
  ]}});
}
export async function showGroups(manager,user,chat) {
  await manager.seedGroups();
  void manager.bootstrap().catch(()=>undefined);
  if(!await manager.eligible(user)) {
    await manager.call("sendMessage",{chat_id:chat,text:"Admin access required."}); return;
  }
  const owner=manager.owner(user), candidates=await manager.store.groups(user,owner), rows=[];
  for(const g of candidates) if(owner || await manager.admin(g.group_id,user,true)) {
    rows.push([{text:String(g.title||g.group_id).slice(0,60),callback_data:`gm:${g.group_id}:panel`}]);
  }
  // Telegram permits at most 100 inline buttons. Large portfolios paginate.
  const pages=Math.ceil(rows.length/80);
  await manager.call("sendMessage",{chat_id:chat,text:rows.length?`Managed groups: ${rows.length}.`:"No groups with verified admin access.",
    reply_markup: rows.length || owner ? {inline_keyboard:[...rows.slice(0,80),...(pages>1?[[{text:"Next groups",callback_data:"gm:0:page1"}]]:[]),
      ...(owner?[[{text:"Global AI cap",callback_data:"gm:0:globalCap"},{text:"Global logs",callback_data:"gm:0:logs"}]]:[])]}: {inline_keyboard:[]}});
}
export async function handlePanel(manager,update) {
  const q=update.callback_query, message=update.message;
  if(q?.data?.startsWith("gm:")) {
    const match=/^gm:(0|-[1-9]\d{0,15}):([A-Za-z]+\d*)$/.exec(q.data);
    if(!match || q.message?.chat?.type!=="private") {
      await manager.call("answerCallbackQuery",{callback_query_id:q.id,text:"Open My Groups in private chat."}); return true;
    }
    const [,g,action]=match, u=id(q.from.id), chat=q.message.chat.id;
    if((g==="0" && !manager.owner(u) && (!["groups"].includes(action) && !action.startsWith("page") || !await manager.eligible(u)))
      || (g!=="0" && !await manager.admin(g,u,true))) {
      await manager.call("answerCallbackQuery",{callback_query_id:q.id,text:"Admin access required."}); return true;
    }
    await manager.call("answerCallbackQuery",{callback_query_id:q.id});
    if(action==="groups") { await showGroups(manager,u,chat); return true; }
    if(action.startsWith("page")) {
      const page=Number(action.slice(4)); if(!Number.isSafeInteger(page)||page<0||page>12) return true;
      const candidates=await manager.store.groups(u,manager.owner(u)), rows=[];
      for(const x of candidates) if(manager.owner(u)||await manager.admin(x.group_id,u,true)) rows.push([{text:String(x.title||x.group_id).slice(0,60),callback_data:`gm:${x.group_id}:panel`}]);
      await manager.call("sendMessage",{chat_id:chat,text:"Managed groups.",reply_markup:{inline_keyboard:[
        ...rows.slice(page*80,(page+1)*80),
        ...(page>0?[[{text:"Previous",callback_data:`gm:0:page${page-1}`}]]:[]),
        ...(rows.length>(page+1)*80?[[{text:"Next",callback_data:`gm:0:page${page+1}`}]]:[])
      ]}}); return true;
    }
    if(action==="logs") {
      const logs=await manager.store.logs(g==="0"?null:g);
      await manager.call("sendMessage",{chat_id:chat,text:logs.length?logs.map(x=>`#${x.id} ${x.group_id}/${x.user_id}: ${x.rule}, ${x.message_type}, warning ${x.warning}, ${x.status}, ${new Date(x.created_at).toISOString()}`).join("; ").slice(0,3900):"No moderation records."}); return true;
    }
    if(action==="globalCap") {
      await manager.store.input(u,chat,g,action);
      await manager.call("sendMessage",{chat_id:chat,text:PROMPTS[action]}); return true;
    }
    const {settings:s}=await manager.store.group(g);
    if(TOGGLES.includes(action)) {
      await manager.store.patch(g,{[action]:!s[action]}); manager.invalidate(g);
      await manager.store.audit(g,u,`toggle:${action}`);
      await showPanel(manager,chat,g); return true;
    }
    if(action==="health") {
      const v=await manager.store.stats(g);
      await manager.call("sendMessage",{chat_id:chat,text:`Health: ${v.score}/100; Risk: ${v.risk}, ${v.links} links blocked; internal indicator, not a Telegram rating.`}); return true;
    }
    if(/^(approve|dismiss)\d+$/.test(action)) {
      const item=await manager.store.review(action.replace(/^\D+/,""),g,s,action.startsWith("approve"));
      if(item && !item.pardoned) await manager.queue("moderate",g,{reviewCaseId:item.id},`review-apply:${item.id}`);
      await manager.store.audit(g,u,action);
      await manager.call("sendMessage",{chat_id:chat,text:item?(item.pardoned?"Review dismissed.":"Review queued."):"Review already resolved."}); return true;
    }
    const menus={
      warnings:[["Warning window","windowDays"],["AI cap/min","aiPerMinute"],["Confidence","threshold"]],
      durations:[["Mute duration","muteSeconds"],["Kick rejoin delay","kickSeconds"]],
      lists:[["Link whitelist","whitelist"],["Trusted members","trusted"]],
      filters:[["Languages","languages"],["Keywords","keywords"],["Regex patterns","patterns"]],
      rules_edit:[["Rules notice","rules"]]
    };
    if(menus[action]) {
      await manager.call("sendMessage",{chat_id:chat,text:"Choose a setting.",reply_markup:{inline_keyboard:[
        ...menus[action].map(([label,a])=>[{text:label,callback_data:`gm:${g}:${a}`}]),
        [{text:"Back",callback_data:`gm:${g}:panel`}]
      ]}}); return true;
    }
    if(FIELDS.includes(action)) {
      await manager.store.input(u,chat,g,action);
      await manager.call("sendMessage",{chat_id:chat,text:PROMPTS[action]}); return true;
    }
    await showPanel(manager,chat,g); return true;
  }
  if(message?.chat?.type!=="private" || typeof message.text!=="string") return false;
  const u=id(message.from.id);
  if(["My Groups","👥 My Groups"].includes(message.text)) { await showGroups(manager,u,message.chat.id); return true; }
  if(message.text.startsWith("/")) return false; // Existing commands never become settings input.
  const pending=await manager.store.takeInput(u,message.chat.id);
  if(!pending) return false;
  const g=String(pending.group_id);
  if(g==="0" ? !manager.owner(u) : !await manager.admin(g,u,true)) {
    await manager.call("sendMessage",{chat_id:message.chat.id,text:"Admin access required."}); return true;
  }
  try {
    if(pending.field==="pardon") {
      const target=id(message.text.trim());
      if(await manager.protectedUser(g,target,true)) throw new Error("Protected account.");
      const member=await manager.call("getChatMember",{chat_id:g,user_id:target});
      if(member.status==="kicked") await manager.call("unbanChatMember",{chat_id:g,user_id:target,only_if_banned:true});
      else if(["member","restricted"].includes(member.status)) {
        const group=await manager.call("getChat",{chat_id:g});
        await manager.call("restrictChatMember",{chat_id:g,user_id:target,use_independent_chat_permissions:true,
          permissions:group.permissions||{can_send_messages:true}});
      }
      await manager.store.query("UPDATE gm_cases SET pardoned=TRUE WHERE group_id=$1 AND user_id=$2",[g,target]);
      await manager.store.audit(g,u,"pardon",target);
    } else {
      const v=fieldValue(pending.field,message.text);
      if(pending.field==="globalCap") await manager.store.query("UPDATE gm_global SET ai_per_minute=$1 WHERE id=1",[v]);
      else { await manager.store.patch(g,{[pending.field]:v}); manager.invalidate(g); }
      await manager.store.audit(g,u,`setting:${pending.field}`);
    }
    await manager.call("sendMessage",{chat_id:message.chat.id,text:"Setting saved."});
  } catch(e) { await manager.call("sendMessage",{chat_id:message.chat.id,text: e.statusCode?"Telegram action could not be completed.":String(e.message).slice(0,180)}); }
  return true;
}
