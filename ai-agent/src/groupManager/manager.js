import crypto from "node:crypto";
import { createGroupManagerStore } from "./store.js";
import { encryptPayload,decryptPayload,id,prefilter,fingerprint,messageType,verdict } from "./policy.js";
import { classifyModeration } from "./ai.js";
import { handlePanel } from "./panel.js";

export class Defer extends Error { constructor(delay=1000){super("Deferred");this.delay=delay;} }
export function createGroupManager({platform,api,ownerId,botId,botUsername,env=process.env,classify=classifyModeration}) {
  const store=createGroupManagerStore(work=>platform().transaction(work));
  const roles=new Map(), configs=new Map();
  let seeded=false, bootstrapped=false, bootstrapping=false, bootstrapRows=null, bootstrapCursor=0, running=false, maintenance=0;
  const manager={
    store,
    owner:u=>Boolean(ownerId() && String(u)===String(ownerId())),
    enabled:async()=>Boolean(platform()?.transaction && platform()?.isFeatureEnabled && await platform().isFeatureEnabled("group_manager")),
    invalidate(g,u=null) { configs.delete(String(g)); for(const key of roles.keys()) if(key.startsWith(`${g}:`) && (!u||key===`${g}:${u}`)) roles.delete(key); },
    async call(method,payload,{onceKey}={}) {
      const scopes=[{key:"gm:telegram:global",limit:29,window:1000}];
      if(method==="sendMessage" && String(payload.chat_id).startsWith("-")) scopes.push({key:`gm:send:${payload.chat_id}`,limit:20,window:60000});
      let budget=await store.rate(scopes);
      // Brief global bursts should not make multi-button panels impossible to open.
      // Longer per-group waits remain durable queue deferrals.
      for(let n=0;!budget.allowed && budget.wait<=1000 && n<3;n++) {
        await new Promise(r=>setTimeout(r,budget.wait));
        budget=await store.rate(scopes);
      }
      if(!budget.allowed) throw new Defer(budget.wait);
      if(onceKey && !await store.once(onceKey)) return null;
      try { return await api(method,payload,{deadlineAt:Date.now()+8000,groupManagerBudgeted:true}); }
      catch(e) {
        if(e.statusCode===429) {
          if(onceKey) await store.query("DELETE FROM gm_once WHERE key=$1",[onceKey]);
          throw new Defer((e.retryAfter||1)*1000);
        }
        throw e;
      }
    },
    async admin(g,u,fresh=false) {
      if(manager.owner(u)) return true;
      const key=`${g}:${u}`, old=roles.get(key);
      if(!fresh && old?.until>Date.now()) return old.admin;
      const member=await manager.call("getChatMember",{chat_id:g,user_id:u});
      const admin=["creator","administrator"].includes(member?.status);
      if(roles.size>=5000) roles.delete(roles.keys().next().value);
      roles.set(key,{admin,until:Date.now()+30000});
      return admin;
    },
    async protectedUser(g,u,fresh=false) {
      if(manager.owner(u) || String(u)===String(botId())) return true;
      return manager.admin(g,u,fresh);
    },
    async config(g,title="") {
      const old=configs.get(String(g));
      if(old?.until>Date.now()) return old.value;
      const value=await store.group(g,title);
      if(configs.size>=1000) configs.delete(configs.keys().next().value);
      configs.set(String(g),{value,until:Date.now()+5000}); return value;
    },
    async seedGroups() {
      if(seeded)return;
      await store.query(`INSERT INTO gm_groups(group_id,title)
        SELECT chat_id,LEFT(title,200) FROM telegram_groups WHERE active=TRUE AND chat_type IN ('group','supergroup')
        ON CONFLICT DO NOTHING`);
      await store.query(`INSERT INTO gm_admins(group_id,user_id)
        SELECT m.chat_id,m.user_id FROM telegram_group_members m JOIN gm_groups g ON g.group_id=m.chat_id
        WHERE m.telegram_status IN ('creator','administrator') ON CONFLICT DO NOTHING`);
      seeded=true;
    },
    async bootstrap() {
      if(bootstrapped || bootstrapping) return;
      bootstrapping=true;
      try {
      await manager.seedGroups();
      bootstrapRows ||= await store.query("SELECT chat_id,title FROM telegram_groups WHERE active=TRUE AND chat_type IN ('group','supergroup') LIMIT 1000");
      while(bootstrapCursor<bootstrapRows.length) {
        const g=bootstrapRows[bootstrapCursor];
        await store.group(g.chat_id,g.title);
        try {
          const members=await manager.call("getChatAdministrators",{chat_id:g.chat_id});
          await store.admins(g.chat_id,members.filter(x=>!x.user?.is_bot).map(x=>id(x.user.id)));
          await manager.queue("setup",g.chat_id,{},`bootstrap-setup:${g.chat_id}`);
        } catch(e) { if(e instanceof Defer) throw e; }
        bootstrapCursor++;
      }
      bootstrapped=true;
      } finally {bootstrapping=false;}
    },
    async eligible(u) {
      if(!await manager.enabled()) return false;
      if(manager.owner(u)) return true;
      const groups=await store.groups(u,false);
      for(const g of groups) if(await manager.admin(g.group_id,u,true)) return true;
      return false;
    },
    async queue(kind,g,data,dedupe,delay=0) {
      await store.enqueue({kind,groupId:g,dedupe,delay,payload:encryptPayload(data,env.SESSION_SECRET)});
    },
    async capture(update) {
      if(!await manager.enabled()) return false;
      const m=update.message||update.edited_message, membership=update.my_chat_member||update.chat_member;
      if(membership && ["group","supergroup"].includes(membership.chat?.type)) {
        const g=id(membership.chat.id,true);
        await store.group(g,membership.chat.title);
        manager.invalidate(g,membership.new_chat_member?.user?.id);
        const member=membership.new_chat_member;
        if(update.my_chat_member && ["left","kicked"].includes(member?.status)) {
          await store.patch(g,{enabled:false}); manager.invalidate(g); return false;
        }
        if(member?.user?.id && update.chat_member) await store.member(g,id(member.user.id),["creator","administrator"].includes(member.status));
        if(update.my_chat_member) await manager.queue("setup",g,{member},`setup:${update.update_id}`);
        return false;
      }
      if(!m || !["group","supergroup"].includes(m.chat?.type) || m.is_automatic_forward) return false;
      const g=id(m.chat.id,true), {settings:s}=await manager.config(g,m.chat.title);
      if(!s.enabled) return false;
      if(m.new_chat_members?.length) {
        if(s.welcome) await manager.queue("welcome",g,{},`welcome:${g}:${m.message_id}`);
        return true;
      }
      if(!m.from?.id || m.from.is_bot && String(m.from.id)===String(botId())) return false;
      if(!m.text && !m.caption && !["photo","video","document","animation","audio","voice","sticker"].some(k=>m[k])) return false;
      const minimal={message_id:Number(m.message_id),from:{id:id(m.from.id)},mediaType:messageType(m),
        text:String(m.text||m.caption||"").slice(0,4096),entities:(m.entities||m.caption_entities||[]).slice(0,100),date:Number(m.date),
        version:Number(update.update_id??m.edit_date??m.date??m.message_id)};
      if(!Number.isSafeInteger(minimal.message_id)||minimal.message_id<=0) return false;
      if(!Number.isSafeInteger(minimal.version)||minimal.version<0) return false;
      await store.query(`INSERT INTO gm_versions(group_id,message_id,version) VALUES($1,$2,$3)
        ON CONFLICT(group_id,message_id) DO UPDATE SET version=GREATEST(gm_versions.version,$3)`,[g,m.message_id,minimal.version]);
      await store.query(`UPDATE gm_cases SET pardoned=TRUE,status='edited' WHERE group_id=$1 AND message_id=$2
        AND status='pending' AND update_version<$3`,[g,m.message_id,minimal.version]);
      // Update IDs are mandatory for webhook retries; a synthetic test falls back to message identity.
      await manager.queue("moderate",g,minimal,`moderate:${g}:${m.message_id}:${update.update_id??"initial"}`);
      return false;
    },
    async handle(update) {
      if(!await manager.enabled()) return false;
      const m=update.message;
      if(m?.chat?.type==="private" && /^\/start gm_rules_\d{1,16}$/.test(m.text||"")) {
        const g=id(`-${m.text.split("_").at(-1)}`,true), {settings:s}=await store.group(g);
        await manager.call("sendMessage",{chat_id:m.chat.id,text:`Rules: ${s.rules} Privacy: ${s.privacy}`}); return true;
      }
      if(await handlePanel(manager,update)) return true;
      return manager.capture(update);
    },
    async apply(item,s) {
      if(item.pardoned || ["acted","protected","dismissed","kick_started","kicked"].includes(item.status)) return;
      if(!await manager.enabled() || !(await store.group(item.group_id)).settings.enabled) return;
      if(Date.now()-new Date(item.created_at).getTime()>300000) {await store.mark(item.id,"expired");return;}
      if(await manager.protectedUser(item.group_id,item.user_id,true)) { await store.mark(item.id,"protected"); return; }
      const bot=await manager.call("getChatMember",{chat_id:item.group_id,user_id:botId()});
      if(!["administrator","creator"].includes(bot?.status) || !bot.can_delete_messages || !bot.can_restrict_members) return;
      const latest=(await store.query("SELECT version FROM gm_versions WHERE group_id=$1 AND message_id=$2",[item.group_id,item.message_id]))[0];
      if(latest && String(latest.version)!==String(item.update_version)) {
        await store.query("UPDATE gm_cases SET pardoned=TRUE,status='edited' WHERE id=$1",[item.id]); return;
      }
      if(await manager.protectedUser(item.group_id,item.user_id,true)) {await store.mark(item.id,"protected");return;}
      try { await manager.call("deleteMessage",{chat_id:item.group_id,message_id:Number(item.message_id)}); }
      catch(e) { if(!/message to delete not found/i.test(e.message)) throw e; }
      if(item.action==="mute" || item.action==="kick") {
        if(await manager.protectedUser(item.group_id,item.user_id,true)) { await store.mark(item.id,"protected"); return; }
        if(item.action==="mute") await manager.call("restrictChatMember",{chat_id:item.group_id,user_id:item.user_id,
          until_date:Math.floor(new Date(item.created_at).getTime()/1000)+item.mute_seconds,
          use_independent_chat_permissions:true,permissions:{can_send_messages:false,can_send_audios:false,can_send_documents:false,can_send_photos:false,can_send_videos:false,can_send_video_notes:false,can_send_voice_notes:false,can_send_polls:false,can_send_other_messages:false,can_add_web_page_previews:false}});
        else {
          // Persist the compensating unban before banning: a crash must not leave a permanent ban.
          await manager.queue("delete",item.group_id,{method:"unbanChatMember",user_id:item.user_id,caseId:item.id},
            `unban:${item.id}`,Math.max(15000,s.kickSeconds*1000));
          await store.mark(item.id,"kick_started");
          try {await manager.call("banChatMember",{chat_id:item.group_id,user_id:item.user_id,revoke_messages:false});}
          catch(e) {if(e instanceof Defer) await store.mark(item.id,"pending"); throw e;}
          await store.mark(item.id,"kicked");
          if(s.kickSeconds===0) await manager.call("unbanChatMember",{chat_id:item.group_id,user_id:item.user_id,only_if_banned:true});
        }
      }
      await store.mark(item.id,"acted");
      await manager.queue("report",item.group_id,{noticeCaseId:item.id},`notice:${item.id}`);
    },
    async moderate(job,m) {
      const {settings:s}=await store.group(job.group_id);
      if(!s.enabled || await manager.protectedUser(job.group_id,m.from.id)) return;
      const latest=(await store.query("SELECT version FROM gm_versions WHERE group_id=$1 AND message_id=$2",[job.group_id,m.message_id]))[0];
      if(latest && String(latest.version)!==String(m.version)) return;
      let v=prefilter(m,s);
      if(!v && s.ai) {
        const global=(await store.query("SELECT ai_per_minute FROM gm_global WHERE id=1"))[0];
        const hash=crypto.createHmac("sha256",env.SESSION_SECRET).update(fingerprint(m,s)).digest("hex");
        const old=(await store.query("SELECT result FROM gm_ai_cache WHERE hash=$1 AND expires_at>NOW()",[hash]))[0];
        v=verdict(old?.result);
        if(!v) {
        const budget=await store.rate([{key:`gm:ai:${job.group_id}`,limit:s.aiPerMinute,window:60000},
          {key:`gm:abuse:${job.group_id}:${m.from.id}`,limit:s.userAiPerMinute,window:60000},
          {key:"gm:ai:global",limit:global.ai_per_minute,window:60000}]);
        if(!budget.allowed) return; // Moderation budget exhausted: no chat debit and no deletion.
        v=verdict(await classify(m.text,{env,languages:s.languages}));
        if(v) await store.query("INSERT INTO gm_ai_cache(hash,result,expires_at) VALUES($1,$2::jsonb,NOW()+INTERVAL '10 minutes') ON CONFLICT(hash) DO UPDATE SET result=$2::jsonb,expires_at=NOW()+INTERVAL '10 minutes'",[hash,JSON.stringify(v)]);
        else await store.audit(job.group_id,botId(),"ai_unavailable",m.from.id);
        }
      }
      if(!v || v.category==="safe" || v.confidence<s.threshold) return;
      if(v.rule==="ai" && !s.compliance && !["spam","abuse"].includes(v.category)) return;
      if(await manager.protectedUser(job.group_id,m.from.id,true)) return;
      const bot=await manager.call("getChatMember",{chat_id:job.group_id,user_id:botId()});
      if(bot.status!=="administrator" || !bot.can_delete_messages || !bot.can_restrict_members) return;
      const trusted=s.trusted.includes(String(m.from.id)), item=await store.warn(job.group_id,m,v,s,trusted);
      if(trusted && !item.reviewed) {
        const admins=await store.query("SELECT user_id FROM gm_admins WHERE group_id=$1",[job.group_id]);
        for(const a of [...admins,{user_id:ownerId()}].filter(x=>x.user_id)) {
          if(!manager.owner(a.user_id) && !await manager.admin(job.group_id,a.user_id,true)) continue;
          await manager.call("sendMessage",{chat_id:a.user_id,text:`Group ${job.group_id}, user ${m.from.id}, message ${m.message_id}: ${v.category}; review required.`,reply_markup:{inline_keyboard:[[
            {text:"Remove & warn",callback_data:`gm:${job.group_id}:approve${item.id}`},
            {text:"Dismiss",callback_data:`gm:${job.group_id}:dismiss${item.id}`}]]}},{onceKey:`review:${item.id}:${a.user_id}`});
        }
        return;
      }
      await manager.apply(item,s);
    },
    async process(job) {
      if(new Date(job.expires_at)<=new Date()) return;
      const data=decryptPayload(job.payload,env.SESSION_SECRET), g=job.group_id;
      if(job.kind==="delete") {
        if(!["deleteMessage","unbanChatMember"].includes(data.method)) return;
        if(data.caseId) {
          const item=await store.case(data.caseId,g);
          if(item?.status==="pending" && Date.now()-new Date(item.created_at).getTime()<300000) throw new Defer(5000);
        }
        try { await manager.call(data.method,{chat_id:g,...(data.method==="deleteMessage"?{message_id:data.message_id}:{user_id:data.user_id,only_if_banned:true})}); }
        catch(e) { if(!/message to delete not found/i.test(e.message)) throw e; }
        if(data.caseId) await store.mark(data.caseId,"acted");
        return;
      }
      if(!await manager.enabled()) return;
      const {settings:s}=await store.group(g);
      if(job.kind==="moderate") {
        if(data.reviewCaseId) {
          const item=await store.case(data.reviewCaseId,g);
          if(item?.reviewed) return manager.apply(item,s);
          return;
        }
        return manager.moderate(job,data);
      }
      if(job.kind==="setup") {
        manager.invalidate(g);
        const bot=await manager.call("getChatMember",{chat_id:g,user_id:botId()});
        const admins=await manager.call("getChatAdministrators",{chat_id:g});
        await store.admins(g,admins.filter(a=>!a.user?.is_bot).map(a=>id(a.user.id)));
        const missing=[bot.status!=="administrator"?"admin status":null,
          !bot.can_delete_messages?"delete rights":null,!bot.can_restrict_members?"restrict/ban rights":null].filter(Boolean);
        if(missing.length) await manager.call("sendMessage",{chat_id:g,
          text:`Bot needs ${missing.join(", ")}; make it admin. Disable privacy mode in BotFather unless the bot is admin.`},{onceKey:`setup-notice:${job.id}`});
      }
      if(job.kind==="welcome" && s.enabled && s.welcome) {
        const sent=await manager.call("sendMessage",{chat_id:g,text:"New members: review group rules and privacy.",reply_markup:{inline_keyboard:[[
          {text:"Rules & privacy",url:`https://t.me/${botUsername()}?start=gm_rules_${String(g).slice(1)}`}]]}},{onceKey:`welcome:${job.id}`});
        if(sent) await manager.queue("delete",g,{method:"deleteMessage",message_id:sent.message_id},`welcome-delete:${job.id}`,60000);
      }
      if(job.kind==="report" && s.enabled) {
        if(data.noticeCaseId) {
          const item=await store.case(data.noticeCaseId,g);
          if(!item || item.pardoned || await manager.protectedUser(g,item.user_id,true)) return;
          await manager.call("sendMessage",{chat_id:g,text:`${item.rule==="link"?"Link":"Content"} removed. Warning ${Math.min(3,item.warning)}/3${item.action==="mute"?`; muted ${Math.round(item.mute_seconds/3600)}h`:item.action==="kick"?"; kicked":""}.`},{onceKey:`notice:${item.id}`});
          return;
        }
        const v=await store.stats(g), admins=await store.query("SELECT user_id FROM gm_admins WHERE group_id=$1",[g]);
        for(const a of [...admins,{user_id:ownerId()}].filter(x=>x.user_id)) {
          if(!manager.owner(a.user_id) && !await manager.admin(g,a.user_id,true)) continue;
          await manager.call("sendMessage",{chat_id:a.user_id,text:`Group ${g}: Risk ${v.risk}, ${v.links} links blocked; health ${v.score}/100.`},{onceKey:`report:${job.id}:${a.user_id}`});
        }
      }
    },
    async tick() {
      const active=await manager.enabled();
      if(active && !bootstrapped) {try {await manager.bootstrap();} catch(e) {if(!(e instanceof Defer)) throw e;}}
      const job=await store.claim(!active);
      if(job) {
        const heartbeat=setInterval(()=>store.query("UPDATE gm_jobs SET lease_until=NOW()+INTERVAL '60 seconds' WHERE id=$1 AND token=$2",[job.id,job.token]).catch(()=>undefined),15000);
        heartbeat.unref();
        try { await manager.process(job); await store.finish(job,null); }
        catch(e) { await store.finish(job,e,e.delay||Math.min(30000,1000*2**job.attempts)); }
        finally {clearInterval(heartbeat);}
      }
      if(Date.now()-maintenance>60000) {
        maintenance=Date.now(); await store.prune();
        if(active) {
          const groups=await store.query("SELECT group_id FROM gm_groups WHERE settings->>'enabled'='true'");
          for(const g of groups) await manager.queue("report",g.group_id,{},`report:${g.group_id}:${Math.floor(Date.now()/604800000)}`);
        }
      }
      return active && job ? 20 : active ? 500 : 5000;
    },
    start() {
      if(running) return; running=true;
      for(let i=0;i<4;i++) {
        const loop=async()=>{ if(!running)return; let delay=5000; try {delay=await manager.tick();} catch {/* No user content, tokens or payloads in logs. */}
          if(running) {const timer=setTimeout(loop,delay);timer.unref();} };
        void loop();
      }
    },
    stop(){running=false;}
  };
  return manager;
}
