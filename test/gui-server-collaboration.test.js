import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repository, git } from "./helpers/git-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { readTask } from "../src/task.js";
import { GUI_INPUT_VERSION } from "../src/gui-turn-options.js";
import { fixtureConversation, prepareSubmit, seedFixtureConversationRepository } from "./helpers/gui-controller-fixture.js";
import { completed, host } from "./gui-server.fixture.js";

test("HTTP completion respects direct collaboration requirements and leaves quoted and optional requests to the manager", async (t) => {
  const f = await host(t, true, () => ({ text: "The manager's useful analysis." }));
  const session = await fixtureConversation(t,f);
  for (const [input, status] of [
    ["请组队完成这项分析。", "partial"],
    ["Please delegate this analysis to two workers in parallel.", "partial"],
    ["解释这段引用\n> 请组队完成这项分析。", "completed"],
    ["解释‘请组队完成这项分析’这句话。", "completed"],
    ["Use two models to fit this data.", "completed"],
    ["请用两个模型拟合这组数据。", "completed"],
    ["Please use two workers if helpful.", "completed"],
    ["可以考虑组队分析，也可以直接作答。", "completed"],
  ]) {
    const args = await prepareSubmit(f, { sessionId: session.id, input, submissionId: randomUUID() });
    const reply = await f.action("task.submit", args);
    const done = await completed(f, reply.taskId);
    assert.equal(done.status, status, input);
    if (status === "partial") {
      assert.match(done.error, /协作承诺/);
      assert.match(done.finalText, /manager's useful analysis/);
    }
    assert.equal((await f.action("task.submit", args)).taskId, reply.taskId);
  }
  assert.equal(f.calls.length, 8);
  const conflict = "请组队完成这项分析。";
  const args = await prepareSubmit(f, { sessionId: session.id, input: conflict,
    submissionId: "collaboration-denied", constraints: { allowedSubtasks: [] } });
  const response = await fetch(f.origin + "/api/action", {
    method: "POST",
    headers: { ...f.headers, "Content-Type": "application/json", "X-CoThink-GUI-Input": GUI_INPUT_VERSION, Origin: f.origin },
    body: JSON.stringify({ action: "task.submit", args }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /要求协作.*禁止派工/);
  assert.equal((await f.get(`/api/session?id=${session.id}`)).draft, conflict);
  assert.equal(f.calls.length, 8);
});

test("HTTP plan cannot promise concurrent execution of dependent steps", async t => {
  const repo = repository(t);
  const checks = [{ command: "node", args: ["-e", "require('fs').accessSync('a.txt')"] }];
  const plan = { goal: "Change both files", scope: ["a.txt", "b.txt"], steps: [
    { id: "A", goal: "Change a.txt", deliverables: ["a.txt"], checks },
    { id: "B", goal: "Change b.txt after A", deliverables: ["b.txt"], checks, dependsOn: ["A"] },
  ], collaboration: { parallel: true, stepIds: ["A", "B"] } };
  const f = await host(t, true, (_call, n) => n===1
    ? { toolCalls: [{ name: "start_work", args: { action: "start", reason: "Change both files", plan } }] }
    : { text: "I can revise the sequence." });
  await f.action("settings.work", { work: { execution } });
  const session = seedFixtureConversationRepository(repo.project,await fixtureConversation(t,f));
  const accepted = await f.action("task.submit", await prepareSubmit(f, { sessionId: session.id,
    input: "Change a.txt and b.txt.", submissionId: "dependent-parallel" }));
  const task = await completed(f, accepted.taskId);
  assert.equal(task.status, "partial");
  assert.equal(task.proposalRef, undefined);
  assert.match(task.workPlanError.message, /collaboration.*dependent/i);
});

test("HTTP confirmation keeps an unfulfilled sealed collaboration promise and its verified file", async (t) => {
  const repo = repository(t);
  const plan = {
    goal: "Change a.txt",
    scope: ["a.txt"],
    deliverables: ["a.txt"],
    checks: [{ command: "node", args: ["-e", "if(require('fs').readFileSync('a.txt','utf8')!=='ready\\n')process.exit(1)"] }],
    collaboration: { workers: 1, stepIds: ["main"] },
  };
  const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
  const f = await host(t, true, (_call, n) => [
    tool("start_work", { action: "start", reason: "Change the file with one worker", plan }),
    tool("project_staff", { action: "appoint", input: {
      id: "unused", responsibility: "Change a.txt", need: "deliverable", reason: "Proposed file owner",
      models: ["fixture/r1"], scope: ["a.txt"],
    } }),
    tool("read", { path: "a.txt" }),
    tool("write", { path: "a.txt", content: "ready\n" }),
    tool("accept_change"),
    { text: "The manager completed the file directly." },
  ][n - 1]);
  await f.action("settings.work", { work: { execution } });
  const session = seedFixtureConversationRepository(repo.project,await fixtureConversation(t,f));
  const pending = await f.action("task.submit", await prepareSubmit(f, { sessionId: session.id, input: "Change a.txt", submissionId: "sealed-promise" }));
  const proposed = await completed(f, pending.taskId);
  assert.ok(proposed.proposalRef, proposed.error);
  const root = await f.action("task.confirmWork", { sessionId: session.id, protocolVersion: 1, submissionId: "confirmed-promise", proposalRef: proposed.proposalRef });
  const done = await completed(f, root.taskId);
  assert.equal(done.status, "partial", done.error);
  assert.match(done.error, /协作承诺/);
  const files = await f.get(`/api/files?id=${root.taskId}`);
  assert.equal(files.items.length, 1);
  const file = await fetch(f.origin + "/api/file?" + new URLSearchParams({ ...files.items[0].ref, purpose: "download" }), { headers: f.headers });
  assert.equal(await file.text(), "ready\n");
  assert.equal(f.calls.length, 6);
  const child = readTask(f.home, readTask(f.home, root.taskId).projectOperation.childTaskIds[0]);
  assert.deepEqual(child.members, []);
  assert.ok(f.calls.every(call => call.body.model === "main"));
});

test("HTTP confirmation reports budget exhaustion before spending more on a sealed promise", async t => {
  const repo = repository(t);
  const plan = { goal: "Change a.txt", scope: ["a.txt"], deliverables: ["a.txt"], collaboration: { workers: 1 },
    checks: [{ command: "node", args: ["-e", "require('fs').accessSync('a.txt')"] }] };
  const f = await host(t, true, () => ({ toolCalls: [{ name: "start_work", args: { action: "start", reason: "Delegate a.txt", plan } }] }));
  await f.action("settings.work", { work: { execution } });
  const session = seedFixtureConversationRepository(repo.project,await fixtureConversation(t,f));
  const accepted = await f.action("task.submit", await prepareSubmit(f, { sessionId: session.id,
    input: "Change a.txt.", submissionId: "planned-budget", budget: { maxCalls: 1 } }));
  const source = await completed(f, accepted.taskId);
  assert.equal(source.status, "blocked");
  assert.ok(source.proposalRef, source.error);
  const response = await fetch(f.origin + "/api/action", {
    method: "POST",
    headers: { ...f.headers, "Content-Type": "application/json", "X-CoThink-GUI-Input": GUI_INPUT_VERSION, Origin: f.origin },
    body: JSON.stringify({ action: "task.confirmWork", args: { sessionId: session.id, protocolVersion: 1,
      submissionId: "exhausted-budget", proposalRef: source.proposalRef } }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /请求额度已用完/);
  assert.equal(f.calls.length, 1);
});

test("HTTP collaboration requires overlapping physical worker requests when parallel work was promised", { timeout: 60000 }, async t => {
  for (const parallel of [true, false]) await t.test(parallel ? "overlap" : "serial", async t => {
    const repo = repository(t);
    const plan = {
      goal: "Inspect and record both inputs",
      scope: ["a.txt", "b.txt"],
      deliverables: ["a.txt", "b.txt"],
      checks: [{ command: "node", args: ["-e", "for(const p of ['a.txt','b.txt'])if(!require('fs').readFileSync(p,'utf8').startsWith('base'))process.exit(1)"] }],
      collaboration: { workers: 2, stepIds: ["main"], parallel: true, distinctModels: true },
    };
    const tool = (name, args = {}) => ({ name, args });
    const reply = (...toolCalls) => ({ toolCalls });
    const appoint = (id, path) => tool("project_staff", { action: "appoint", input: {
      id, responsibility: "Check " + path, need: "deliverable", reason: "Independent input verification",
      models: ["fixture/" + id], scope: [], readScope: [path],
    } });
    const assign = (id, path) => tool("delegate", {
      staffId: id, model: "fixture/" + id, workId: "main:" + path, readOnly: true, scope: [], readScope: [path],
      assignment: "Verify contents of " + path, reason: "Independent input owner",
    });
    const workerTurns = new Map();
    const bothActive = Promise.withResolvers();
    let resumeRef;
    let leaderTurns = 0, activeWorkers = 0, peakWorkers = 0;
    const f = await host(t, true, async ({ body }, n) => {
      if (n === 1) return reply(tool("start_work", { action: "start", reason: "Both inputs can be verified independently", plan }));
      if (resumeRef&&body.tools?.some(entry=>entry.function.name==="start_work"))
        return reply(tool("start_work", { action: "resume", reason: "Use the saved delivery for this explicit continuation", planRef: resumeRef }));
      const messages = body.messages.map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
      if (messages.some(text => text.includes("cothink-process-observation")))
        return { text: JSON.stringify({ issues: [] }) };
      if (body.model === "main") {
        const turn = ++leaderTurns;
        if (turn === 1) return reply(appoint("r1", "a.txt"));
        if (turn === 2) return reply(appoint("r2", "b.txt"));
        if (turn === 3) return reply(assign("r1", "a.txt"), ...(parallel ? [assign("r2", "b.txt")] : []));
        if (turn === 4 || turn === 6) return reply(tool("collect"));
        if (turn === 5 && !parallel) return reply(assign("r2", "b.txt"));
        if (turn === 5) return reply(tool("collect"));
        return { text: "The worker reports confirm the tracked input bytes." };
      }
      const turn = (workerTurns.get(body.model)??0)+1;
      workerTurns.set(body.model, turn);
      const path=body.model==="r1"?"a.txt":"b.txt";
      if (turn === 1) return { text: "I will inspect the original version of " + path };
      if (turn === 2) {
        peakWorkers=Math.max(peakWorkers,++activeWorkers);
        if (activeWorkers===2) bothActive.resolve();
        if (parallel) await Promise.race([bothActive.promise,new Promise(resolve=>setTimeout(resolve,1200))]);
        activeWorkers--;
        return reply(tool("read", { path }));
      }
      return { text: "I verified the contents of " + path };
    });
    await f.action("settings.work", { work: { execution } });
    const session = seedFixtureConversationRepository(repo.project,await fixtureConversation(t,f));
    const pending = await f.action("task.submit", await prepareSubmit(f, { sessionId: session.id,
      input: "Verify a.txt and b.txt.\nPlease delegate this task to two different models in parallel.", submissionId: "workers" }));
    const source = await completed(f, pending.taskId);
    assert.ok(source.proposalRef, source.error);
    const root = await f.action("task.confirmWork", { sessionId: session.id, protocolVersion: 1, submissionId: "dispatch-workers", proposalRef: source.proposalRef });
    const result = await completed(f, root.taskId);
    const saved = readTask(f.home, root.taskId);
    assert.equal(peakWorkers, parallel ? 2 : 1);
    assert.equal(saved.projectOperation.status, "completed", result.error);
    const observations = saved.processCheck?.observations ?? [];
    assert.equal(new Set(observations.filter(observation => observation.status === "completed")
      .flatMap(observation => observation.covered.map(fact => fact.memberId))).size, 2,
      JSON.stringify(observations.map(observation => [observation.kind, observation.status, observation.error])));
    assert.equal(result.status, parallel ? "completed" : "partial", result.error);
    assert.equal(saved.collaborationResult.length, 2);
    assert.ok(saved.collaborationResult.every(fact => fact.status === (parallel ? "fulfilled" : "unfulfilled")));
    assert.ok(saved.collaborationResult.every(fact => fact.evidence.length === 2));
    assert.deepEqual(saved.collaborationResult[0].missing, parallel ? [] : ["parallel_overlap"]);
    if (!parallel) return;
    resumeRef={taskId:pending.taskId,field:"proposal",sha256:source.proposalRef.planDigest};
    const resume=async input=>{
      const reply=await f.action("task.submit",await prepareSubmit(f,{
        sessionId:session.id,input,submissionId:randomUUID(),
      }));
      await completed(f,reply.taskId);
      return readTask(f.home,reply.taskId);
    };
    const reused=await resume("Resume the confirmed project using its existing results.");
    assert.equal(reused.status,"completed",reused.error);
    assert.deepEqual(reused.projectOperation.childTaskIds,[]);
    assert.deepEqual(reused.collaborationResult,saved.collaborationResult);
    const fresh=await resume("Please delegate this task to two different models in parallel.");
    assert.equal(fresh.status,"partial",fresh.error);
    assert.deepEqual(fresh.projectOperation.childTaskIds,[]);
    assert.equal(fresh.collaborationResult[0].requirement.source.taskId,fresh.id);
    assert.deepEqual(fresh.collaborationResult[0].evidence,[]);
    assert.deepEqual(fresh.collaborationResult.slice(1),saved.collaborationResult);
  });
});

test("HTTP work routes serve fixed diffs, plain patches and only task-owned paginated output", async (t) => {
  const repo = repository(t);
  const f = await host(t, true, (_call, n) => {
    const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
    if (n === 1) return tool("start_work", {action:"start",reason:"change fixture",plan:{goal:"change source",scope:["a.txt"],deliverables:["a.txt"],checks:[{command:"node",args:["-e","console.log(\'HTTP check log\')"]}]}});
    if (n === 2) return tool("read", { path: "a.txt" });
    if (n === 3) return tool("write", { path: "a.txt", content: "HTTP accepted output\n" });
    if (n === 4 || n === 5) return tool("accept_change");
    return { text: "Delivered original reply" };
  });
  const original = git(repo.project, "status", "--porcelain=v1");
  await f.action("settings.work", { work: { execution, maxConcurrentRequests:3, checks: [{ command: "node", args: ["-e", "console.log('HTTP check log')"] }] } });
  assert.equal((await f.get("/api/bootstrap")).work.maxConcurrentRequests,3);
  const s = seedFixtureConversationRepository(repo.project,await fixtureConversation(t,f));
  await f.action("session.name", { sessionId: s.id, title: "Fixture conversation" });
  const proposal = await f.action("task.submit",await prepareSubmit(f,{sessionId:s.id,input:"change source",submissionId:"http-work"}));
  const proposed=await completed(f,proposal.taskId);
  const task=await f.action("task.confirmWork",{sessionId:s.id,protocolVersion:1,submissionId:"http-confirm",proposalRef:proposed.proposalRef});
  const rootDone=await completed(f,task.taskId);
  const done=await completed(f,rootDone.projectOperation.childTaskIds[0]);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.work.finalCheck.verification, "passed");
  const diff = await (await fetch(`${f.origin}/api/diff?id=${task.taskId}`, { headers: f.headers })).json();
  assert.equal(diff.fromVersion, done.work.startVersion);
  assert.match(diff.text, /HTTP accepted output/);
  const patch = await fetch(`${f.origin}/api/patch?id=${task.taskId}`, { headers: f.headers });
  assert.equal(patch.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(await patch.text(), diff.text);
  const ref = done.work.finalCheck.checks[0].outputRef;
  const page = async (offset, limit) => (await fetch(`${f.origin}/api/output?id=${task.taskId}&ref=${ref}&offset=${offset}&limit=${limit}`, { headers: f.headers })).json();
  const first = await page(0, 3), rest = await page(first.nextOffset, 65536);
  assert.match(first.text + rest.text, /HTTP check log/);
  assert.equal(rest.eof, true);
  const foreign = await fetch(`${f.origin}/api/output?id=${task.taskId}&ref=foreign`, { headers: f.headers });
  assert.equal(foreign.status, 400);
  assert.match((await foreign.json()).error, /outputRef.*任务/);
  assert.equal(readFileSync(join(s.project, "a.txt"), "utf8"), "HTTP accepted output\n");
  assert.equal(readFileSync(join(repo.project, "a.txt"), "utf8"), "base A\n");
  assert.equal(git(repo.project, "status", "--porcelain=v1"), original);
});

test('visual artifacts require authentication and exact task registration; traversal, cross-task paths and non-PNG bytes fail',async t=>{
 const f=await host(t);const {createTask}=await import('../src/task.js');const {createHash}=await import('node:crypto');
 const task=createTask({home:f.home,input:'visual',models:f.models});const ref='preview-ref',dir=join(f.home,'artifacts',task.record.id,ref);mkdirSync(dir,{recursive:true});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1kAAAAASUVORK5CYII=','base64');const path=join(dir,'0.png');writeFileSync(path,png);
 task.record.work={visualEvidence:[{outputRef:ref,images:[{path,sha256:createHash('sha256').update(png).digest('hex')}]}]};task.save();
 const url=`${f.origin}/api/artifact?id=${task.record.id}&ref=${ref}&index=0`;
 assert.equal((await fetch(url)).status,403);const ok=await fetch(url,{headers:f.headers});assert.equal(ok.status,200);assert.equal(ok.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await ok.arrayBuffer()),png);
 for(const query of [`id=${task.record.id}&ref=../preview-ref&index=0`,`id=${task.record.id}&ref=${ref}&index=1`])assert.equal((await fetch(`${f.origin}/api/artifact?${query}`,{headers:f.headers})).status,400);
 task.record.work.visualEvidence[0].images[0].path=join(f.home,'elsewhere.png');writeFileSync(join(f.home,'elsewhere.png'),png);task.save();assert.equal((await fetch(url,{headers:f.headers})).status,400);
 task.record.work.visualEvidence[0].images[0].path=path;writeFileSync(path,'<svg onload="bad()"/>');task.save();assert.equal((await fetch(url,{headers:f.headers})).status,400);
});
