import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, realpathSync, existsSync, rmSync } from "node:fs";
import {fixtureConversation,prepareSubmit,seedFixtureConversationRepository,submitDraft} from "./helpers/gui-controller-fixture.js";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { done, execution, host, load, root, run, setup, tool } from "./gui-integration.fixture.js";

const { neutralDirectory } = await load("src/conversation.js");

test("blank HTTP setup uses unified calls and actual new CLI PTY refuses continuation before generation",async t=>{
 const f=await fixture(t,(_,n)=>({text:'ROUNDTRIP_REPLY '+n}));writeFileSync(join(f.cwd,'AGENTS.md'),'UNBOUND_AGENTS_CANARY');
 let h=await host(t,f);assert.equal((await h.get('/api/bootstrap')).configured,false);const team=await setup(h,f);
 const session=await fixtureConversation(t,h,{defaultRosterId:team.id});
 const requests=new Map();
 const send=async(input,id)=>{if(!requests.has(id))requests.set(id,await prepareSubmit(h,{sessionId:session.id,input,submissionId:id}));const r=await h.action('task.submit',requests.get(id));assert.equal((await done(h,r.taskId)).status,'completed');return r;};
 const first=await send('GUI first question','first');await send('GUI second question','second');assert.equal(f.calls.length,2);
 await h.h.close();
 const cli=await run('python3',[fileURLToPath(new URL('./helpers/gui-cli-roundtrip.py',import.meta.url)),f.home,join(root,'bin/cothink.js'),neutralDirectory(f.home),'--expect-unified']);
 assert.equal(cli.code,0,cli.err);assert.match(cli.out,/unifiedRefused/);assert.equal(f.calls.length,2);
 h=await host(t,f);const restored=await h.get('/api/session?id='+session.id);assert.equal(restored.project,session.project);assert.equal(restored.workspaceId,session.workspaceId);assert.equal(restored.team.id,team.id);assert.equal(restored.turns.length,2);assert.doesNotMatch(JSON.stringify(f.calls),/UNBOUND_AGENTS_CANARY/);
 assert.equal((await send('GUI first question','first')).taskId,first.taskId);assert.equal(f.calls.length,2);
});

test("old GUI input can only retrieve the exact saved submission digest",async t=>{
  const {digest,normalizeConstraints,normalizeRootBudget}=await load("src/project-turn.js");
  const {readTask}=await load("src/task.js");
  const f=await fixture(t);
  let h=await host(t,f);
  const roster=await setup(h,f);
  const {id:sessionId}=await fixtureConversation(t,h,{defaultRosterId:roster.id});
  const args=await prepareSubmit(h,{sessionId,input:"saved response",submissionId:"original"});
  const {taskId}=await h.action("task.submit",args);
  await done(h,taskId);
  await h.h.close();
  // Reproduce the previous renderer's fields and the old host's saved digest.
  const legacy={...args,constraints:{...args.constraints,requireDifferentModelReview:true}};
  const task=readTask(f.home,taskId);
  task.constraints=normalizeConstraints(legacy.constraints);
  delete task.turnIntent;
  task.inputDigest=digest({input:legacy.input,editorEditId:legacy.editorEditId,refs:[],
    constraints:task.constraints,budget:normalizeRootBudget(legacy.budget),readAuthorization:null,continuation:null,confirmation:null});
  writeFileSync(join(f.home,"tasks",taskId+".json"),JSON.stringify(task));
  h=await host(t,f);
  const query=async args=>{
    const response=await fetch(h.origin+"/api/action",{method:"POST",
      headers:{...h.headers,"Content-Type":"application/json","X-CoThink-GUI-Input":"2"},
      body:JSON.stringify({action:"task.submit",args})});
    return {status:response.status,body:await response.json()};
  };
  assert.deepEqual(await query(legacy),{status:200,body:{taskId,sessionId}});
  assert.equal((await query({...legacy,input:"different"})).body.code,"SUBMISSION_CONFLICT");
  assert.equal((await query({...legacy,submissionId:"fresh"})).body.code,"GUI_INPUT_UPGRADE");
  assert.equal(f.calls.length,1);
});

test("HTTP rejected pelican plans never initialize managed folders or count inline HTML as files",async t=>{
  const checks=[{command:"node",args:["-e","if (!require('node:fs').readFileSync('index.html','utf8').includes('<svg')) process.exit(1)"]}];
  const base={goal:"Draw a cycling pelican",scope:["index.html"],deliverables:["index.html"],checks};
  const wrong=[
    {...base,steps:[{goal:base.goal,deliverables:base.deliverables,checks}]},
    {...base,steps:[{id:"main",goal:base.goal,checks}]},
    {...base,scope:{write:["index.html"]}},
  ];
  const f=await fixture(t,(_,n)=>{
    const attempt=(n-1)%4;
    return attempt<3?tool("start_work",{action:"start",reason:"Create the requested illustration",plan:wrong[attempt]}):{text:"<html><svg></svg></html>"};
  });
  const h=await host(t,f);
  const roster=await setup(h,f);
  await h.action("settings.work",{work:{execution,checks:[]}});
  const folder=realpathSync(mkdtempSync(join(tmpdir(),"cothink-pelican-http-")));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const workspaceId=randomUUID();
  await h.action("workspace.create",{workspaceId,name:"Illustration",project:folder,defaultRosterId:roster.id});
  for(const fileWork of [true,false]){
    const session=await h.action("session.create",{workspaceId,sessionId:randomUUID()});
    const {taskId}=await submitDraft(h,{sessionId:session.id,
      input:fileWork?"把说过的内容做出来，不得联网。":"画一只骑自行车的鹈鹕",
      ...(fileWork?{turnOptions:{id:randomUUID(),fileWork:true}}:{})});
    const task=await done(h,taskId);
    assert.equal(task.status,fileWork?"partial":"completed",task.error);
    if(fileWork){
      assert.match(task.error,/未交付可核验的文件.*scope/);
      assert.match(JSON.stringify(f.calls[0].body.messages),/artifact-offline/);
      assert.match(JSON.stringify(f.calls[1].body.messages),/step id/i);
      assert.match(JSON.stringify(f.calls[2].body.messages),/step main deliverables/);
    }
    assert.equal(task.proposalRef,undefined);
    assert.equal(existsSync(join(session.project,".git")),false);
  }
  assert.equal(existsSync(join(folder,".git")),false);
  assert.equal(f.calls.length,8);
});

test("HTTP cancellation stops the active manager or project member after SSE disconnect", async (t) => {
  for (const member of [false, true]) {
    let entered;
    const barrier = new Promise((r) => (entered = r));
    let managerTurns = 0;
    const f = await fixture(t, async (call, _n, _req, res) => {
      if (call.body.messages.some(message => JSON.stringify(message.content)?.includes("cothink-process-observation")))
        return { text: JSON.stringify({ issues: [] }) };
      const slowRequest = member ? call.body.model === "r1" : managerTurns === 0;
      if (slowRequest) {
        if (!member) managerTurns++;
        entered();
        await new Promise((r) => {
          const timer = setTimeout(r, 30000);
          res.once("close", () => {
            clearTimeout(timer);
            r();
          });
        });
        return res.destroyed ? null : { text: "delayed response" };
      }
      if (member) {
        const turn = ++managerTurns;
        if (turn === 1)
          return tool("start_work", {action:"start",reason:"member cancellation",plan:{goal:"member cancel",scope:["a.txt"],readScope:["."],deliverables:["a.txt"],checks:[{command:"node",args:["-e","require(\'fs\').accessSync(\'a.txt\')"]}]}});
        if(turn===2)return tool("project_staff",{action:"appoint",input:{id:"reader",responsibility:"Read source",scope:[],readScope:["."],models:["fixture/r1"],need:"deliverable",reason:"inspect"}});
        if (turn === 3)
          return tool("delegate", {
            staffId:"reader",
            model: "fixture/r1",
            assignment: "slow member",
            implementationAdvice: "read only fixture",
            reason: "inspection",
            scope: [],
            readScope: ["."],
            readOnly: true,
          });
        return tool("collect");
      }
      return {text:"unexpected second manager request"};
    });
    const h = await host(t, f);
    const roster = await setup(h, f);
    await h.action("settings.work", { work: {execution, checks: [] } });
    const repo = member ? repository(t) : null;
    const s = await fixtureConversation(t,h,{defaultRosterId:roster.id});
    if (repo) seedFixtureConversationRepository(repo.project,s);
    let a = await submitDraft(h, {
      sessionId: s.id,
      input: member ? "member cancel" : "manager cancel",
      protocolVersion:1, submissionId: "cancel",
    });
    if(member){const proposal=await done(h,a.taskId);a=await h.action("task.confirmWork",{sessionId:s.id,protocolVersion:1,submissionId:"confirm-member",proposalRef:proposal.proposalRef});}
    let timer;
    try {
      await Promise.race([
        barrier,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("fixture did not enter manager/member")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const abort = new AbortController();
    const events = await fetch(h.origin + "/api/events", {
      headers: h.headers,
      signal: abort.signal,
    });
    await events.body.getReader().read();
    abort.abort();
    assert.equal((await h.get("/api/task?id=" + a.taskId)).status, "running");
    const n = f.calls.length;
    await h.action("task.cancel", { taskId: a.taskId });
    let task = await done(h, a.taskId);
    if(member)task=await done(h,task.projectOperation.childTaskIds[0]);
    assert.notEqual(task.status, "completed");
    assert.equal(f.calls.length, n);
    if (member)
      assert.ok(
        task.participants.some((x) => x.role === "member" && x.participated),
      );
  }
});
