import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { GROUP_MANAGER_MIGRATION, GROUP_MANAGER_QUEUE_MIGRATION } from "../src/groupManager/migration.js";
import { createGroupManagerStore } from "../src/groupManager/store.js";
import { DEFAULTS } from "../src/groupManager/policy.js";

test("PostgreSQL integration: windows, retries, leases, sliding limits and 1000-job queue benchmark",
  {skip:process.env.GM_DATABASE_TEST!=="1",timeout:240000},async()=>{
  const {Pool}=await import("pg"), pool=new Pool({connectionString:process.env.DATABASE_URL,max:8});
  const schema=`gm_test_${crypto.randomBytes(8).toString("hex")}`;
  const tx=async work=>{
    const c=await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL search_path TO ${schema},public`);
      const result=await work(c);await c.query("COMMIT");return result;
    }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
  };
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await tx(async c=>{
      await c.query("CREATE TABLE feature_flags(feature_key TEXT PRIMARY KEY,enabled BOOLEAN,description TEXT)");
      await c.query(GROUP_MANAGER_MIGRATION.sql);
      await c.query(GROUP_MANAGER_QUEUE_MIGRATION.sql);
    });
    const store=createGroupManagerStore(tx), g="-9900001", s={...DEFAULTS,enabled:true};
    await store.group(g,"Synthetic test group");
    const m=n=>({message_id:n,from:{id:"990001"},version:n,mediaType:"text"});
    const v={category:"spam",rule:"link"};
    const first=await store.warn(g,m(1),v,s,false);
    assert.equal(first.warning,1);
    assert.equal((await store.warn(g,m(1),v,s,false)).id,first.id);
    assert.equal((await store.warn(g,m(2),v,s,false)).action,"mute");
    assert.equal((await store.warn(g,m(3),v,s,false)).action,"kick");
    await store.query("UPDATE gm_cases SET created_at=NOW()-INTERVAL '8 days' WHERE group_id=$1",[g]);
    assert.equal((await store.warn(g,m(4),v,s,false)).warning,1);
    await store.query("UPDATE gm_cases SET pardoned=TRUE WHERE group_id=$1",[g]);
    assert.equal((await store.warn(g,m(5),v,s,false)).warning,1);
    const limits=[{key:"fixture:scope",limit:2,window:60000}];
    assert.equal((await store.rate(limits)).allowed,true);
    assert.equal((await store.rate(limits)).allowed,true);
    assert.equal((await store.rate(limits)).allowed,false);
    await store.query("UPDATE gm_rate SET at=NOW()-INTERVAL '61 seconds'");
    assert.equal((await store.rate(limits)).allowed,true);
    const start=performance.now();
    for(let n=0;n<1000;n++) await store.enqueue({dedupe:`fixture:${n}`,kind:"moderate",groupId:String(-9901000-n%50),payload:"fixture-no-message-content"});
    await store.enqueue({dedupe:"fixture:1",kind:"moderate",groupId:"-9901001",payload:"duplicate"});
    assert.equal(Number((await store.query("SELECT COUNT(*) AS n FROM gm_jobs"))[0].n),1000);
    const seen=new Set();
    async function worker() {
      while(seen.size<1000) {
        const j=await store.claim();
        if(!j) {await new Promise(r=>setTimeout(r,2));continue;}
        assert.ok(!seen.has(j.id),"A job was claimed twice");
        seen.add(j.id);await store.finish(j,null);
      }
    }
    await Promise.all(Array.from({length:4},worker));
    const elapsed=(performance.now()-start)/1000;
    const done=await store.query("SELECT COUNT(*) AS n FROM gm_jobs WHERE state='done' AND payload IS NULL");
    assert.equal(Number(done[0].n),1000);
    console.log(JSON.stringify({benchmark:"postgres-queue-only",jobs:1000,workers:4,seconds:Number(elapsed.toFixed(2)),jobsPerMinute:Math.round(60000/elapsed),realTelegramOrAI:false}));
    // Lease recovery, wrong-owner completion protection and bounded retries.
    await store.enqueue({dedupe:"lease",kind:"moderate",groupId:g,payload:"fixture"});
    const j=await store.claim();
    await store.finish({...j,token:crypto.randomUUID()},null);
    assert.equal((await store.query("SELECT state FROM gm_jobs WHERE id=$1",[j.id]))[0].state,"running");
    await store.query("UPDATE gm_jobs SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",[j.id]);
    const recovered=await store.claim();assert.equal(recovered.id,j.id);
    await store.finish(recovered,{delay:1000},1000);
    const after=(await store.query("SELECT * FROM gm_jobs WHERE id=$1",[j.id]))[0];
    assert.equal(after.attempts,1);assert.equal(after.state,"pending");
    await store.query("UPDATE gm_jobs SET expires_at=NOW()-INTERVAL '1 second'");
    await store.prune();
    assert.equal((await store.query("SELECT payload FROM gm_jobs WHERE id=$1",[j.id]))[0].payload,null);
    assert.ok(elapsed<60,`1000 synthetic queue jobs took ${elapsed.toFixed(1)}s; target not reached`);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
