import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import {randomUUID} from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repository } from "./helpers/git-fixture.js";
import { fixture } from "./helpers/pi-fixture.js";

// Use the distributed runtime as well as the distributed controller in installed checks.
const root = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const load = (path) => import(pathToFileURL(join(root, path)));
const { SessionManager } = await load("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { startGuiServer } = await load("src/gui-server.js");
const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");
const { readTask } = await load("src/task.js");
const { createApi } = await load("gui/src/api.js");

async function host(t, f) {
  const h = await startGuiServer({ home: f.home, cwd: f.cwd, open: false });
  t.after(() => h.close());
  const origin = new URL(h.url).origin;
  async function request(path, body) {
    return fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${h.token}`, ...(body ? { "Content-Type": "application/json", "X-CoThink-GUI-Input":"2" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function json(path, body) {
    const response = await request(path, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const reads = [];
  const api = createApi(h.token, (path, options) => { reads.push(options.method); return fetch(origin + path, options); });
  return { close: h.close, get: json, action: (action, args) => json("/api/action", { action, args }), reads, recover: api.recover, request,
    reject: async (action, args) => {
      const response = await request("/api/action", { action, args });
      assert.equal(response.status, 400, await response.clone().text());
      assert.match(await response.text(), /损坏|缺失|不可用|修复/);
    } };
}
async function setup(t) {
  const f = await fixture(t, (_, n) => ({ text: `HISTORY_REPLY_${n}` }));
  saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models }, "History fixture", "7c8094cd-3476-4bfa-8f53-055d87972896"));
  return f;
}
async function send(h, sessionId, input, submissionId = input) {
  const accepted = await h.action("task.submit", { sessionId, input, submissionId,protocolVersion:1 });
  for (let i = 0; i < 500; i++) {
    const task = await h.get("/api/task?id=" + accepted.taskId);
    if (task.status !== "running") {
      assert.equal(task.status, "completed", task.error);
      return task;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("history fixture did not settle");
}
async function newSession(h) {
  const s = await h.action("session.create", { project: null });

  return s.id;
}

test("real Pi selected-branch fork inherits ancestor turns and keeps submission identity independent when continuing", async (t) => {
  const f = await setup(t);
  let h = await host(t, f);
  const id = await newSession(h), first = await send(h, id, "FORK_ANCESTOR");
  const source = readTask(f.home, first.id).stages[0].sessionFile;
  const ancestorLeaf = SessionManager.open(source).getLeafId();
  await send(h, id, "FORK_EXCLUDED_SIBLING");
  await h.close();
  const manager = SessionManager.open(source);
  manager.createBranchedSession(ancestorLeaf);
  // This is the SDK's other actual fork entry point; task origins keep the old ID.
  const fork = SessionManager.forkFrom(manager.getSessionFile(), manager.getCwd(), join(f.home, "pi/sessions/main"));
  const forkId = fork.getSessionId();
  h = await host(t, f);
  const restored = await h.get("/api/session?id=" + forkId);
  assert.deepEqual(restored.turns.map((x) => x.taskId), [first.id]);
  assert.equal(restored.title, "FORK_ANCESTOR");
  assert.deepEqual(restored.submissions, [], "inherited turns retain their original submission ownership");
  assert.equal(await h.recover({ sessionId: forkId, protocolVersion:1, submissionId: "FORK_ANCESTOR" }), null);
  const next = await send(h, forkId, "FORK_CONTINUE", "FORK_ANCESTOR");
  assert.notEqual(next.id, first.id, "a different session owns an independent submission key");
  assert.match(JSON.stringify(f.calls[2].body.messages), /FORK_ANCESTOR/);
  assert.doesNotMatch(JSON.stringify(f.calls[2].body.messages), /FORK_EXCLUDED_SIBLING/);
  assert.deepEqual((await h.get("/api/session?id=" + forkId)).turns.map((x) => x.taskId), [first.id, next.id]);
  assert.equal((await h.recover({ sessionId: forkId, protocolVersion:1, submissionId: "FORK_ANCESTOR" })).taskId, next.id);
});

test("real Pi same-session branch displays branch order, excludes sibling turns and retains durable deduplication", async (t) => {
  const f = await setup(t);
  let h = await host(t, f);
  const id = await newSession(h), first = await send(h, id, "TREE_ANCESTOR");
  const source = readTask(f.home, first.id).stages[0].sessionFile;
  const ancestorLeaf = SessionManager.open(source).getLeafId();
  const sibling = await send(h, id, "TREE_EXCLUDED_SIBLING");
  await h.close();
  const manager = SessionManager.open(source);
  manager.appendSessionInfo("SIBLING_TITLE_ONLY");
  manager.branch(ancestorLeaf);
  manager.appendCustomEntry("cothink-draft", { text: "new selected branch" });
  h = await host(t, f);
  assert.deepEqual((await h.get("/api/session?id=" + id)).turns.map((x) => x.taskId), [first.id]);
  assert.equal((await h.recover({ sessionId: id, protocolVersion:1, submissionId: "TREE_EXCLUDED_SIBLING" })).taskId, sibling.id);
  assert.deepEqual(h.reads, ["GET"], "confirmation recovery observes durable association without mutation");
  const replay = await h.action("task.submit", { sessionId: id, input: "TREE_EXCLUDED_SIBLING", protocolVersion:1, submissionId: "TREE_EXCLUDED_SIBLING" });
  assert.equal(replay.taskId, sibling.id);
  assert.equal(f.calls.length, 2);
  assert.equal((await h.get("/api/sessions?query=TREE_EXCLUDED_SIBLING")).items.length,0);
  assert.equal((await h.get("/api/sessions?query=SIBLING_TITLE_ONLY")).items.length,0);
  const found = await h.get("/api/sessions?query=HISTORY_REPLY_1");
  assert.equal(found.items[0].match.taskId,first.id);
  const wrongBranch=await h.request("/api/action",{action:"session.fork",args:{sessionId:id,taskId:sibling.id}});
  assert.equal(wrongBranch.status,400);
  assert.match((await wrongBranch.json()).error,/分支|属于/);
  const next = await send(h, id, "TREE_CONTINUE");
  assert.match(JSON.stringify(f.calls[2].body.messages), /TREE_ANCESTOR/);
  assert.doesNotMatch(JSON.stringify(f.calls[2].body.messages), /TREE_EXCLUDED_SIBLING/);
  assert.deepEqual((await h.get("/api/session?id=" + id)).turns.map((x) => x.taskId), [first.id, next.id]);
});

for (const damage of ["truncated session", "missing request", "corrupt request"]) {
  test(`${damage} stays unavailable without breaking healthy bootstrap/settings or changing original bytes`, async (t) => {
    const f = await setup(t);
    let h = await host(t, f);
    const healthyId = await newSession(h), healthy = await send(h, healthyId, "HEALTHY_HISTORY");
    const badId = await newSession(h), bad = await send(h, badId, "DAMAGED_HISTORY");
    await h.close();
    const record = readTask(f.home, bad.id), sessionPath = record.stages[0].sessionFile;
    const requestPath = join(f.home, "requests", record.requestIds[0] + ".json");
    if (damage === "truncated session") appendFileSync(sessionPath, '{"type":"message","id":"crash');
    else if (damage === "missing request") rmSync(requestPath);
    else writeFileSync(requestPath, '{"id":"truncated');
    const beforeSession = readFileSync(sessionPath), beforeRequest = damage === "missing request" ? null : readFileSync(requestPath);
    h = await host(t, f);
    const boot = await h.get("/api/bootstrap");
    assert.equal(boot.configured, true);
    assert.equal(boot.sessions.find((s) => s.id === badId).readOnly, true);
    assert.ok(boot.historyErrors.some((e) => e.sessionId === badId));
    const damaged = await h.get("/api/session?id=" + badId);
    assert.equal(damaged.readOnly, true);
    assert.match(damaged.selectionError, /损坏|缺失|不可用|修复/);
    assert.equal((await h.get("/api/session?id=" + healthyId)).turns[0].taskId, healthy.id);
    assert.equal((await h.get("/api/task?id=" + healthy.id)).status, "completed");
    await h.action("settings.work", { work: { checks: [] } });
    assert.deepEqual((await h.get("/api/bootstrap")).work.checks, []);
    await h.reject("task.submit", { sessionId: badId, input: "MUST_NOT_SEND", protocolVersion:1, submissionId: "blocked" });
    await h.reject("session.name", { sessionId: badId, title:"Blocked rename" });
    await h.reject("session.fork", {sessionId:badId,taskId:bad.id});
    const old = await h.action("task.submit", { sessionId: badId, input: "DAMAGED_HISTORY", protocolVersion:1, submissionId: "DAMAGED_HISTORY" });
    assert.equal(old.taskId, bad.id, "known association may be queried, never replayed");
    assert.equal(f.calls.length, 2);
    assert.deepEqual(readFileSync(sessionPath), beforeSession);
    if (beforeRequest) assert.deepEqual(readFileSync(requestPath), beforeRequest);
    else assert.throws(() => readFileSync(requestPath), { code: "ENOENT" });
  });
}

test("completed live caches cannot hide newly damaged durable session or request facts", async (t) => {
  const f = await setup(t), h = await host(t, f);
  const id = await newSession(h), task = await send(h, id, "CACHED_HISTORY");
  const record = readTask(f.home, task.id), sessionPath = record.stages[0].sessionFile;
  const requestPath = join(f.home, "requests", record.requestIds[0] + ".json");
  for (const path of [sessionPath, requestPath]) {
    const original = readFileSync(path);
    appendFileSync(path, '{"broken');
    const damaged = readFileSync(path);
    assert.equal((await h.get("/api/session?id=" + id)).readOnly, true);
    await h.reject("task.submit", { sessionId: id, input: "NO_CACHED_CONTINUATION", protocolVersion:1, submissionId: "blocked-cache" });
    assert.deepEqual(readFileSync(path), damaged);
    assert.equal(f.calls.length, 1);
    writeFileSync(path, original);
    assert.equal((await h.get("/api/session?id=" + id)).readOnly, false);
  }
});

test("same-process GUI close and reopen leaves released parent and fork sessions writable", async (t) => {
  const f = await setup(t);
  let h = await host(t, f);
  const parentId = await newSession(h), first = await send(h, parentId, "REOPEN_PARENT");
  const source = readTask(f.home, first.id).stages[0].sessionFile;
  await h.close();
  const fork = SessionManager.forkFrom(source, SessionManager.open(source).getCwd(), join(f.home, "pi/sessions/main"));
  const forkId = fork.getSessionId();
  h = await host(t, f);
  assert.equal((await h.get("/api/session?id=" + parentId)).readOnly, false);
  assert.equal((await h.get("/api/bootstrap")).sessions.find((s) => s.id === parentId).readOnly, false);
  await send(h, forkId, "REOPEN_FORK");
  await h.close();
  h = await host(t, f);
  for (const id of [parentId, forkId]) {
    assert.equal((await h.get("/api/session?id=" + id)).readOnly, false);
    assert.equal((await h.get("/api/bootstrap")).sessions.find((s) => s.id === id).readOnly, false);
  }
  await send(h, parentId, "REOPEN_PARENT_CONTINUE");
  await send(h, forkId, "REOPEN_FORK_CONTINUE");
  assert.equal(f.calls.length, 4);
  assert.match(JSON.stringify(f.calls[3].body.messages), /REOPEN_FORK/);
  assert.doesNotMatch(JSON.stringify(f.calls[3].body.messages), /REOPEN_PARENT_CONTINUE/);
});


test("GUI reply fork copies only completed ancestors, restores their selections and leaves source bytes and submission ownership intact", async (t) => {
  const f = await setup(t), h = await host(t, f);
  const id = await newSession(h);
  const editor=await h.get("/api/session?id="+id);
  await h.action("session.draft", {sessionId:id,text:"draft belongs to source",expectedDraftRevision:editor.draftRevision,branchAnchor:editor.branchAnchor,editId:randomUUID(),workRequest:null,selectionId:null});
  const first = await send(h,id,"GUI_FORK_FIRST");
  const source = readTask(f.home,first.id).stages[0].sessionFile;
  const original = await h.get("/api/session?id="+id);
  assert.equal(original.turns[0].canFork,true,"completed durable replies become forkable after active clears");

  const laterTeam = await h.action("team.save", {name:"Later team",main:f.models.secondary[0],secondary:[f.models.main]});
  await h.action("session.team",{sessionId:id,teamId:laterTeam.id});
  await send(h,id,"GUI_FORK_LATER");
  const before = readFileSync(source), callCount = f.calls.length;
  const fork = await h.action("session.fork",{sessionId:id,taskId:first.id});
  assert.notEqual(fork.id,id);
  assert.equal(fork.title,"GUI_FORK_FIRST · 分支");
  assert.deepEqual(fork.turns.map(t=>t.taskId),[first.id]);
  assert.equal(fork.turns[0].flow,"unified");
  assert.deepEqual(fork.team,original.team);
  assert.equal(fork.project,original.project);
  assert.equal(fork.draft,"");
  assert.deepEqual(fork.forkOf,{sessionId:id,taskId:first.id});
  assert.deepEqual(fork.submissions,[]);
  assert.match(fork.turns[0].resultRevision,/^[0-9a-f]{64}$/);
  assert.deepEqual(fork.view.seenResults,{[first.id]:fork.turns[0].resultRevision});
  assert.deepEqual(readFileSync(source),before);
  assert.equal(f.calls.length,callCount,"forking never makes a model request");
  const continued = await send(h,fork.id,"GUI_FORK_CONTINUE","GUI_FORK_FIRST");
  assert.notEqual(continued.id,first.id);
  assert.match(JSON.stringify(f.calls[callCount].body.messages),/GUI_FORK_FIRST/);
  assert.doesNotMatch(JSON.stringify(f.calls[callCount].body.messages),/GUI_FORK_LATER/);
  assert.deepEqual(readFileSync(source),before);
  await h.close();
  const reopened = await host(t,f), restored = await reopened.get("/api/session?id="+fork.id);
  assert.deepEqual(restored.forkOf,{sessionId:id,taskId:first.id});
  assert.equal(restored.title,"GUI_FORK_FIRST · 分支");
  assert.deepEqual(restored.turns.map(t=>t.taskId),[first.id,continued.id]);
  assert.deepEqual(restored.view.seenResults,fork.view.seenResults);
});

test("GUI reply fork rejects another branch, incomplete replies and damaged history without mutation", async (t) => {
  const f = await setup(t), h = await host(t,f);
  const id = await newSession(h), first = await send(h,id,"FORK_GUARDS_FIRST");
  const otherId = await newSession(h), other = await send(h,otherId,"FORK_GUARDS_OTHER");
  const source = readTask(f.home,first.id).stages[0].sessionFile;
  const before = readFileSync(source), callCount = f.calls.length;
  const unrelated = await h.request("/api/action",{action:"session.fork",args:{sessionId:id,taskId:other.id}});
  assert.equal(unrelated.status,400);
  assert.match((await unrelated.json()).error,/分支|属于/);
  const taskPath = join(f.home,"tasks",first.id+".json"), taskBytes=readFileSync(taskPath);
  const record=JSON.parse(taskBytes); record.status="partial";
  writeFileSync(taskPath,JSON.stringify(record));
  const partial=await h.request("/api/action",{action:"session.fork",args:{sessionId:id,taskId:first.id}});
  assert.equal(partial.status,400);
  assert.match((await partial.json()).error,/完成/);
  writeFileSync(taskPath,taskBytes);
  appendFileSync(source,'{"broken');
  await h.reject("session.fork",{sessionId:id,taskId:first.id});
  writeFileSync(source,before);
  assert.deepEqual(readFileSync(source),before);
  assert.equal(f.calls.length,callCount);
});

test("GUI reply fork refuses an active source without cancelling it",async t=>{
  let unblock;
  const f=await fixture(t,async (_,n)=>{
    if(n===2) await new Promise(resolve=>{unblock=resolve;});
    return {text:`active reply ${n}`};
  });
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"Active fork fixture","7c8094cd-3476-4bfa-8f53-055d87972896"));
  const h=await host(t,f), id=await newSession(h), first=await send(h,id,"FIRST_DONE");
  const running=await h.action("task.submit",{sessionId:id,input:"KEEP_RUNNING",protocolVersion:1, submissionId:"active"});
  for(let n=0;n<500&&!unblock;n++) await new Promise(r=>setTimeout(r,10));
  assert.ok(unblock);
  try {
    const busy=await h.request("/api/action",{action:"session.fork",args:{sessionId:id,taskId:first.id}});
    assert.equal(busy.status,409);
    assert.equal((await busy.json()).code,"SESSION_BUSY");
    assert.equal((await h.get("/api/task?id="+running.taskId)).status,"running");
    assert.equal(readTask(f.home,running.taskId).cancelRequestedAt,undefined);
  } finally {unblock();}
  await send(h,id,"KEEP_RUNNING","active");
  assert.equal(f.calls.length,2);
});


test("fork gets its own folder and respects archive and writer guards",async t=>{
  const f=await setup(t), project=realpathSync(repository(t).project);
  const manager=SessionManager.create(project,join(f.home,"pi/sessions/main"));
  manager.appendCustomEntry("cothink-project",{project});
  manager.appendCustomEntry("cothink-mode",{singleModel:true});
  manager.appendCustomEntry("cothink-team",{team:{id:"7c8094cd-3476-4bfa-8f53-055d87972896",name:"History fixture",...f.models}});
  manager.appendMessage({role:"user",content:"previous project context",timestamp:Date.now()});
  const h=await host(t,f), id=manager.getSessionId(), first=await send(h,id,"PROJECT_FORK");
  const source=manager.getSessionFile(), before=readFileSync(source);
  const other=await host(t,f);
  const busy=await other.request("/api/action",{action:"session.fork",args:{sessionId:id,taskId:first.id}});
  assert.equal(busy.status,409);
  assert.equal((await busy.json()).code,"SESSION_BUSY");
  assert.deepEqual(readFileSync(source),before);
  await h.action("session.archive",{sessionId:id,archived:true,expectedRevision:0});
  const archived=await h.request("/api/action",{action:"session.fork",args:{sessionId:id,taskId:first.id}});
  assert.equal(archived.status,409);
  assert.equal((await archived.json()).code,"SESSION_STATE_UNAVAILABLE");
  assert.equal((await h.get("/api/session?id="+id)).navigation.archived,true);
  await h.action("session.archive",{sessionId:id,archived:false,expectedRevision:1});
  const fork=await h.action("session.fork",{sessionId:id,taskId:first.id});
  assert.equal(fork.navigation.archived,false);
  assert.equal(fork.project,join(project,"对话-"+fork.id));
  assert.equal(fork.turns[0].flow,"unified");
  assert.deepEqual(readFileSync(source),before);
  assert.equal(f.calls.length,1);
});

test("reply fork does not let Pi opening a legacy schema rewrite the original history",async t=>{
  const f=await setup(t),h=await host(t,f),id=await newSession(h),first=await send(h,id,"LEGACY_FORK");
  const source=readTask(f.home,first.id).stages[0].sessionFile;
  const lines=readFileSync(source,"utf8").trim().split("\n").map(JSON.parse);
  lines[0].version=2;
  writeFileSync(source,lines.map(x=>JSON.stringify(x)).join("\n")+"\n");
  const before=readFileSync(source);
  const rejected=await h.request("/api/action",{action:"session.fork",args:{sessionId:id,taskId:first.id}});
  assert.equal(rejected.status,400);
  assert.match((await rejected.json()).error,/版本|迁移/);
  assert.deepEqual(readFileSync(source),before);
  assert.equal(f.calls.length,1);
});

test("workspace bootstrap imports healthy legacy paths incrementally without rewriting Pi history", async t => {
  const f = await setup(t);
  const h = await host(t, f);
  const directory = join(f.home, "pi/sessions/main");
  const team = createTeamConfig({formatVersion:2,...f.models},"History fixture","7c8094cd-3476-4bfa-8f53-055d87972896").teams[0];
  const make = (project, title) => {
    const manager = SessionManager.create(f.cwd, directory);
    manager.appendCustomEntry("cothink-project", {project});
    manager.appendCustomEntry("cothink-team", {team});
    manager.appendCustomEntry("cothink-title", {title});
    const path = manager.getSessionFile();
    const bytes = [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(path, bytes);
    return {id:manager.getSessionId(), path, bytes};
  };
  const missing = join(f.home,"moved","old-repo");
  const legacy = make(missing, "Moved directory");
  const generic = make(null, "No directory");
  const first = await h.get("/api/bootstrap");
  const imported = first.workspaces.find(w => w.project === missing);
  assert.equal(imported.name, "old-repo");
  assert.equal(imported.projectAvailable, false);
  const another = make(join(f.home,"another-repo"), "Other directory");
  const second = await h.get("/api/bootstrap");
  assert.equal(second.workspaces.length, 2);
  assert.equal(second.workspaces.find(w => w.project === missing).id, imported.id);
  assert.deepEqual((await h.get("/api/sessions?workspaceId="+imported.id)).items.map(row=>row.id), [legacy.id]);
  assert.deepEqual((await h.get("/api/sessions?workspaceId=")).items.map(row=>row.id), [generic.id]);
  const damaged = '{"schemaVersion":999}';
  writeFileSync(join(f.home,"gui-workspaces.json"), damaged);
  const degraded = await h.get("/api/bootstrap");
  assert.equal(degraded.workspaces, null);
  assert.equal(degraded.workspaceErrors[0].code, "WORKSPACE_UNAVAILABLE");
  assert.equal((await h.get("/api/session?id="+legacy.id)).project, missing);
  assert.equal((await h.get("/api/session?id="+generic.id)).title, "No directory");
  for (const original of [legacy,generic,another]) assert.equal(readFileSync(original.path,"utf8"), original.bytes);
  assert.equal(readFileSync(join(f.home,"gui-workspaces.json"),"utf8"), damaged);
  assert.equal(f.calls.length, 0);
});

test("invalid workspace markers retain completed turns without reclassifying them as generic", async t => {
  const f = await setup(t);
  let h = await host(t,f);
  const id = await newSession(h), task = await send(h,id,"WORKSPACE_HISTORY");
  const path = readTask(f.home,task.id).stages[0].sessionFile;
  await h.close();
  SessionManager.open(path).appendCustomEntry("cothink-gui-workspace",{workspaceId:"malformed"});
  const original = readFileSync(path,"utf8");
  h = await host(t,f);
  const session = await h.get("/api/session?id="+id);
  assert.equal(session.workspaceId,undefined);
  assert.match(session.workspaceError,/归属/);
  assert.deepEqual(session.turns.map(turn=>turn.taskId),[task.id]);
  assert.deepEqual((await h.get("/api/sessions?workspaceId=")).items,[]);
  const rejected = await h.request("/api/action",{action:"task.submit",args:{sessionId:id,input:"Do not run",protocolVersion:1, submissionId:"WORKSPACE_UNCERTAIN"}});
  assert.equal(rejected.status,409);
  assert.equal((await rejected.json()).code,"WORKSPACE_UNAVAILABLE");
  assert.equal(readFileSync(path,"utf8"),original);
  assert.equal(f.calls.length,1);
});

test("HTTP editor requires complete version fields and keeps DRAFT_CONFLICT visible",async t=>{
  const f=await setup(t),h=await host(t,f),s=await h.action("session.create",{sessionId:randomUUID(),workspaceId:null});
  const rejected=await h.request("/api/action",{action:"session.draft",args:{sessionId:s.id,text:"obsolete caller"}});
  assert.equal(rejected.status,409); assert.equal((await rejected.json()).code,"DRAFT_CONFLICT");
  assert.equal((await h.get("/api/session?id="+s.id)).draft,""); assert.equal(f.calls.length,0);
});

test("legacy view stays byte-identical until explicit save and preserves the first observed result across a later revision", async t => {
  const {mkdirSync} = await import("node:fs");
  const f = await setup(t);
  let h = await host(t,f);
  const sessionId = await newSession(h), first = await send(h,sessionId,"Legacy result");
  const task = readTask(f.home,first.id), piPath = task.stages[0].sessionFile;
  await h.close();
  // Keep the exact Pi branch topology while recreating an old session without a GUI marker.
  const entries = readFileSync(piPath,"utf8").trim().split("\n").map(JSON.parse);
  const marker = entries.find(entry => entry.customType==="cothink-gui-workspace");
  marker.customType = "legacy-fixture";
  writeFileSync(piPath,entries.map(entry=>JSON.stringify(entry)).join("\n")+"\n");
  const viewDir=join(f.home,"session-ui"), viewPath=join(viewDir,sessionId+".json");
  mkdirSync(viewDir,{recursive:true});
  const original='{"schemaVersion":1, "revision":3, "archived":false, "pinned":true, "changedAt":null}\n';
  writeFileSync(viewPath,original);
  h = await host(t,f);
  const observed = await h.get("/api/session?id="+sessionId);
  assert.equal(observed.view.initialized,false);
  assert.equal(observed.view.seenResults[first.id],first.resultRevision);
  assert.equal(readFileSync(viewPath,"utf8"),original);
  const path=join(f.home,"requests",task.finalCallId+".json");
  const call=JSON.parse(readFileSync(path,"utf8"));
  writeFileSync(path,JSON.stringify({...call,text:"A newer result"}));
  const latest = await h.get("/api/session?id="+sessionId);
  assert.notEqual(latest.turns[0].resultRevision,first.resultRevision);
  assert.equal(latest.view.seenResults[first.id],first.resultRevision);
  const saved=await h.action("session.view",{sessionId,expectedViewRevision:observed.viewRevision,opened:true});
  assert.equal(saved.view.initialized,true);
  assert.equal(saved.view.seenResults[first.id],first.resultRevision);
  await h.close();
  h = await host(t,f);
  const restored = await h.get("/api/session?id="+sessionId);
  assert.equal(restored.view.seenResults[first.id],first.resultRevision);
  assert.equal(restored.turns[0].resultRevision,latest.turns[0].resultRevision);
  assert.equal(restored.navigation.revision,3);
  assert.equal(restored.navigation.pinned,true);
  assert.equal(f.calls.length,1);
});

test("a published fork without its reading file restarts with an explicit empty baseline", async t => {
  const f = await setup(t);
  let h = await host(t,f);
  const sessionId = await newSession(h), task = await send(h,sessionId,"Fork source");
  const fork=await h.action("session.fork",{sessionId,taskId:task.id});
  assert.equal(fork.view.seenResults[task.id],task.resultRevision);
  await h.close();
  rmSync(join(f.home,"session-ui",fork.id+".json"));
  h = await host(t,f);
  const recovered = await h.get("/api/session?id="+fork.id);
  assert.equal(recovered.view.initialized,false);
  assert.deepEqual(recovered.view.seenResults,{});
  assert.match(recovered.viewError,/分支/);
  const saved = await h.action("session.view",{sessionId:fork.id,expectedViewRevision:0,opened:true});
  assert.deepEqual(saved.view.seenResults,{});
  assert.equal(f.calls.length,1);
});
