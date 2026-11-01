import crypto from "node:crypto";
import { settings, escalation } from "./policy.js";

export function createGroupManagerStore(transaction) {
  const query=(sql,params=[])=>transaction(async c=>(await c.query(sql,params)).rows);
  return {
    query,
    async group(groupId,title="") {
      return transaction(async c=>{
        await c.query("INSERT INTO gm_groups(group_id,title) VALUES($1,$2) ON CONFLICT DO NOTHING",[groupId,String(title).replace(/[\r\n]/g," ").slice(0,200)]);
        const {rows}=await c.query("SELECT * FROM gm_groups WHERE group_id=$1",[groupId]);
        return {...rows[0],settings:settings(rows[0].settings)};
      });
    },
    async patch(g,patch) {
      await query("UPDATE gm_groups SET settings=settings || $2::jsonb,updated_at=NOW() WHERE group_id=$1",[g,JSON.stringify(patch)]);
    },
    async groups(actor,owner) {
      return query(`SELECT g.* FROM gm_groups g WHERE $2::boolean OR EXISTS
        (SELECT 1 FROM gm_admins a WHERE a.group_id=g.group_id AND a.user_id=$1::bigint) ORDER BY g.group_id LIMIT 1000`,[actor,owner]);
    },
    async admins(g,users) {
      await transaction(async c=>{
        await c.query("DELETE FROM gm_admins WHERE group_id=$1",[g]);
        for(const u of users) await c.query("INSERT INTO gm_admins(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[g,u]);
      });
    },
    async member(g,u,admin) {
      await query(admin ? "INSERT INTO gm_admins(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING"
        : "DELETE FROM gm_admins WHERE group_id=$1 AND user_id=$2",[g,u]);
    },
    async enqueue({dedupe,kind,groupId,payload,delay=0}) {
      await query(`INSERT INTO gm_jobs(dedupe,kind,group_id,payload,run_at,expires_at)
        VALUES($1,$2,$3,$4,NOW()+$5::bigint*INTERVAL '1 millisecond',NOW()+($5::bigint+$6::bigint)*INTERVAL '1 millisecond') ON CONFLICT DO NOTHING`,
        [dedupe,kind,groupId,payload,delay,kind==="delete"?2592000000:300000]);
    },
    async claim(cleanupOnly=false) {
      try {
        return await transaction(async c=>{
          await c.query(`UPDATE gm_jobs SET state='pending',token=NULL WHERE state='running' AND lease_until<NOW()`);
          const {rows}=await c.query(`SELECT * FROM gm_jobs j WHERE state='pending' AND run_at<=NOW()
            AND (NOT $1::boolean OR kind='delete') AND NOT EXISTS
              (SELECT 1 FROM gm_jobs r WHERE r.state='running' AND r.kind='moderate' AND r.group_id=j.group_id AND j.kind='moderate')
            ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[cleanupOnly]);
          if(!rows[0]) return null;
          const token=crypto.randomUUID();
          await c.query("UPDATE gm_jobs SET state='running',token=$2,lease_until=NOW()+INTERVAL '60 seconds',attempts=attempts+1 WHERE id=$1",[rows[0].id,token]);
          return {...rows[0],token,attempts:rows[0].attempts+1};
        });
      } catch(e) { if(e.code==="23505") return null; throw e; }
    },
    async finish(job,error,delay=1000) {
      const deferred=Boolean(error?.delay), state=error ? (!deferred && job.attempts>=5 ? "failed" : "pending") : "done";
      await query(`UPDATE gm_jobs SET state=$3,lease_until=NULL,token=NULL,
        attempts=attempts-$5::int,error_code=$6,
        payload=CASE WHEN $3='pending' THEN payload ELSE NULL END,
        run_at=NOW()+$4::bigint*INTERVAL '1 millisecond' WHERE id=$1 AND token=$2`,
        [job.id,job.token,state,Math.min(300000,Math.max(250,delay)),deferred?1:0,error ? (deferred?"deferred":`processing_${Number(error.statusCode)||500}`):null]);
    },
    async rate(scopes) {
      return transaction(async c=>{
        const sorted=[...scopes].sort((a,b)=>a.key.localeCompare(b.key));
        for(const s of sorted) await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[s.key]);
        for(const s of sorted) {
          const {rows}=await c.query(`SELECT COUNT(*)::int AS n,COALESCE(EXTRACT(EPOCH FROM
            (MIN(at)+$2::bigint*INTERVAL '1 millisecond'-NOW()))*1000,0) AS wait
            FROM gm_rate WHERE scope=$1 AND at>NOW()-$2::bigint*INTERVAL '1 millisecond'`,[s.key,s.window]);
          if(rows[0].n>=s.limit) return {allowed:false,wait:Math.max(250,Number(rows[0].wait))};
        }
        for(const s of sorted) await c.query("INSERT INTO gm_rate(scope) VALUES($1)",[s.key]);
        return {allowed:true};
      });
    },
    async once(key) { return (await query("INSERT INTO gm_once(key) VALUES($1) ON CONFLICT DO NOTHING RETURNING key",[key])).length>0; },
    async warn(g,m,v,s,trusted) {
      return transaction(async c=>{
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`gm:warn:${g}:${m.from.id}`]);
        const old=await c.query("SELECT * FROM gm_cases WHERE group_id=$1 AND message_id=$2",[g,m.message_id]);
        if(old.rows[0] && old.rows[0].status!=="edited") return old.rows[0];
        const n=await c.query(`SELECT COUNT(*)::int AS n FROM gm_cases WHERE group_id=$1 AND user_id=$2
          AND NOT pardoned AND (NOT trusted OR reviewed) AND status<>'protected'
          AND created_at>NOW()-$3::int*INTERVAL '1 day'`,[g,m.from.id,s.windowDays]);
        const warning=n.rows[0].n+1;
        const {rows}=await c.query(`INSERT INTO gm_cases(group_id,message_id,user_id,category,rule,message_type,warning,action,mute_seconds,trusted,update_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT(group_id,message_id) DO UPDATE SET category=$4,rule=$5,warning=$7,action=$8,
            update_version=$11,pardoned=FALSE,status='pending',created_at=NOW(),trusted=$10 RETURNING *`,
          [g,m.message_id,m.from.id,v.category,v.rule,m.mediaType||"text",warning,escalation(warning),s.muteSeconds,trusted,m.version]);
        return rows[0];
      });
    },
    async case(caseId,g) { return (await query("SELECT * FROM gm_cases WHERE id=$1 AND group_id=$2",[caseId,g]))[0]; },
    async mark(caseId,status) { await query("UPDATE gm_cases SET status=$2 WHERE id=$1",[caseId,status]); },
    async review(caseId,g,s,approve) {
      return transaction(async c=>{
        const {rows}=await c.query("SELECT * FROM gm_cases WHERE id=$1 AND group_id=$2 FOR UPDATE",[caseId,g]);
        const item=rows[0]; if(!item?.trusted || item.reviewed) return null;
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`gm:warn:${g}:${item.user_id}`]);
        const n=await c.query(`SELECT COUNT(*)::int AS n FROM gm_cases WHERE group_id=$1 AND user_id=$2 AND id<>$3
          AND NOT pardoned AND (NOT trusted OR reviewed) AND status<>'protected'
          AND created_at>NOW()-$4::int*INTERVAL '1 day'`,[g,item.user_id,item.id,s.windowDays]);
        const warning=n.rows[0].n+1;
        const result=await c.query(`UPDATE gm_cases SET reviewed=TRUE,pardoned=$2,warning=$3,action=$4,status=$5 WHERE id=$1 RETURNING *`,
          [item.id,!approve,warning,escalation(warning),approve?"pending":"dismissed"]);
        return result.rows[0];
      });
    },
    async input(u,chat,g,field) {
      await query(`INSERT INTO gm_inputs(user_id,chat_id,group_id,field) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id) DO UPDATE SET chat_id=$2,group_id=$3,field=$4,expires_at=NOW()+INTERVAL '2 minutes'`,[u,chat,g,field]);
    },
    async takeInput(u,chat) {
      return (await query("DELETE FROM gm_inputs WHERE user_id=$1 AND chat_id=$2 AND expires_at>NOW() RETURNING *",[u,chat]))[0];
    },
    async logs(g=null) {
      return query(`SELECT * FROM (
        SELECT id::text,group_id,user_id,category,rule,message_type,warning,status,created_at FROM gm_cases
        UNION ALL SELECT 'A'||id,group_id,user_id,'admin',event,'control',0,event,created_at FROM gm_audit
        UNION ALL SELECT 'J'||id,group_id,NULL,'queue',kind,'job',0,error_code,created_at FROM gm_jobs WHERE state='failed'
        ) x WHERE $1::bigint IS NULL OR group_id=$1 ORDER BY created_at DESC LIMIT 10`,[g]);
    },
    async audit(g,actor,event,user=null) {
      await query("INSERT INTO gm_audit(group_id,actor_id,event,user_id) VALUES($1,$2,$3,$4)",[g,actor,event,user]);
    },
    async stats(g) {
      const rows=await query(`SELECT COUNT(*)::int AS flagged,COUNT(*) FILTER(WHERE rule='link')::int AS links
        FROM gm_cases WHERE group_id=$1 AND NOT pardoned AND created_at>NOW()-INTERVAL '7 days'`,[g]);
      const score=Math.max(0,100-rows[0].flagged*5);
      return {...rows[0],score,risk:score>=80?"Low":score>=50?"Medium":"High"};
    },
    async prune() {
      await transaction(async c=>{
        await c.query("UPDATE gm_jobs SET payload=NULL,state='failed',token=NULL WHERE expires_at<NOW() AND state IN ('pending','running')");
        await c.query("DELETE FROM gm_jobs WHERE created_at<NOW()-INTERVAL '30 days' AND state IN ('done','failed')");
        await c.query("DELETE FROM gm_cases WHERE created_at<NOW()-INTERVAL '30 days'");
        await c.query("DELETE FROM gm_audit WHERE created_at<NOW()-INTERVAL '30 days'");
        await c.query("DELETE FROM gm_once WHERE created_at<NOW()-INTERVAL '30 days'");
        await c.query("DELETE FROM gm_rate WHERE at<NOW()-INTERVAL '2 hours'");
        await c.query("DELETE FROM gm_ai_cache WHERE expires_at<NOW()");
        await c.query("DELETE FROM gm_versions WHERE created_at<NOW()-INTERVAL '30 days'");
        await c.query("DELETE FROM gm_inputs WHERE expires_at<NOW()");
      });
    }
  };
}
