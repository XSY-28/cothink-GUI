import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import {tmpdir} from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { controller, controllerModule, finished, load, productRoot, teamId } from "./helpers/gui-controller-fixture.js";
const sdkUrl=pathToFileURL(join(productRoot,"node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const {SessionManager}=await import(sdkUrl);
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
const {saveConfig}=await load("src/config.js");
const {createTeamConfig}=await load("src/teams.js");
const {readTask}=await load("src/task.js");
const checkedPlan=(goal='Observe project',checks=[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}])=>({goal,scope:['a.txt'],readScope:['.'],deliverables:['a.txt'],checks});
async function confirmProject(c,sessionId,submitted){
 const proposal=await finished(c,submitted.taskId);assert.equal(proposal.status,'blocked',proposal.error);
 const accepted=await c.action('task.confirmWork',{sessionId,submissionId:randomUUID(),proposalRef:proposal.proposalRef,protocolVersion:1});
 const root=await finished(c,accepted.taskId);assert.equal(root.status,'completed',root.error);
 return {taskId:accepted.taskId,task:await c.task(root.projectOperation.childTaskIds[0])};
}

test("unified quick answer uses one original call, deduplicates durable submissions and keeps continuous context", async (t) => {
  const f = await fixture(t, (_, n) => ({ text: `original reply ${n}` })),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });
  const first = await c.action("task.submit", {
    sessionId: s.id,
    input: "first question",
    protocolVersion:1, submissionId: "first",
  });
  const duplicate = await c.action("task.submit", {
    sessionId: s.id,
    input: "first question",
    protocolVersion:1, submissionId: "first",
  });
  assert.equal(duplicate.taskId, first.taskId);
  const task = await finished(c, first.taskId);
  assert.equal(task.status, "completed", task.error);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    task.messages.map((m) => m.text),
    ["original reply 1"],
  );
  assert.equal(task.participants.filter((p) => p.participated).length, 1);
  const second = await c.action("task.submit", {
    sessionId: s.id,
    input: "second question",
    protocolVersion:1, submissionId: "second",
  });
  await finished(c, second.taskId);
  assert.equal(f.calls.length, 2);
  assert.match(JSON.stringify(f.calls[1].body.messages), /first question/);
  await c.close();
  const restored = await controllerModule.createGuiController({
    home: f.home,
    cwd: f.cwd,
  });
  t.after(() => restored.close());
  assert.equal(
    (
      await restored.action("task.submit", {
        sessionId: s.id,
        input: "first question",
        protocolVersion:1, submissionId: "first",
      })
    ).taskId,
    first.taskId,
  );
  assert.equal(f.calls.length, 2);
  assert.equal((await restored.session(s.id)).turns.length, 2);
  const restoredTurn=(await restored.session(s.id)).turns[0];
  assert.equal(restoredTurn.submissionId, "first");
  assert.equal(restoredTurn.createdAt,task.createdAt);
  assert.equal(restoredTurn.endedAt,task.endedAt);
  assert.equal(restoredTurn.cancelSettledAt,null);
  // Existing history may predate an end timestamp: reopening must not fabricate one.
  const saved=readTask(f.home,first.taskId);
  saved.status="cancelled";saved.cancelRequestedAt=saved.createdAt;
  saved.cancelSettledAt="2026-11-08T00:00:25Z";
  delete saved.endedAt;
  writeFileSync(join(f.home,"tasks",first.taskId+".json"),JSON.stringify(saved));
  const cancelledTurn=(await restored.session(s.id)).turns[0];
  assert.equal(cancelledTurn.status,"cancelled");
  assert.equal(cancelledTurn.cancelSettledAt,saved.cancelSettledAt);
  assert.equal(cancelledTurn.endedAt,null);
});
test("unbound project neither loads startup AGENTS nor exposes work tools; ONE is durable", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f);
  writeFileSync(join(f.cwd, "AGENTS.md"), "STARTUP_PRIVATE_CANARY");
  const s = await c.action("session.create", { project: null });

  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "plain chat",
    protocolVersion:1, submissionId: "plain",
  });
  await finished(c, r.taskId);
  assert.equal(f.calls.length, 1);
  const catalog = await c.bootstrap();
  assert.ok(catalog.models.every((m) => Array.isArray(m.thinkingLevels)));
  assert.doesNotMatch(
    JSON.stringify(f.calls),
    /STARTUP_PRIVATE_CANARY/,
  );
  assert.equal((await c.session(s.id)).turns[0].flow, "unified");
  assert.equal((await c.session(s.id)).project, null);
});
test("one global active task rejects concurrent submission, reads live status and cancels on host close", async (t) => {
  const f = await fixture(t, async () => {
      await new Promise((r) => setTimeout(r, 350));
      return { text: "slow" };
    }),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "slow",
    protocolVersion:1, submissionId: "slow",
  });
  assert.equal((await c.task(r.taskId)).status, "running");
  await assert.rejects(
    c.action("task.submit", {
      sessionId: s.id,
      input: "other",
      protocolVersion:1, submissionId: "other",
    }),
    /任务|busy/i,
  );

  assert.equal((await c.task(r.taskId)).singleModel, false);
  await c.close();
  assert.notEqual(readTask(f.home, r.taskId).status, "completed");
});
test("historical sessions without team need explicit binding, and read-only viewing takes no writer", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f);
  const m = SessionManager.create(f.cwd, join(f.home, "pi/sessions/main"));
  m.appendCustomEntry("cothink-project",{project:null});
  m.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
  const s = await c.session(m.getSessionId());
  assert.equal(s.team, null);
  await assert.rejects(
    c.action("task.submit", {
      sessionId: s.id,
      input: "continue",
      protocolVersion:1, submissionId: "old",
    }),
    /team|Team/,
  );
  await c.action("session.team", { sessionId: s.id, teamId });
  writeFileSync(join(f.home,"gui-workspaces.json"),"corrupt workspace directory");
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "continue",
    protocolVersion:1, submissionId: "bound",
  });
  assert.equal((await finished(c, r.taskId)).status, "completed");
});
test("bound project confirms formal work and fixed version diff, leaves original checkout unchanged", async (t) => {
  const repo = repository(t);
  const f = await fixture(t, (_, n) =>
      n === 1
        ? { toolCalls: [{ name: "start_work", args: {action:"start",reason:"observe",plan:checkedPlan()} }] }
        : { text: "observed" },
    ),
    c = await controller(t, f);
  await c.action("settings.work", { work: {execution:(await import("./helpers/agent-sync-fixture.js")).execution, checks: [] } });
  const p = await c.action("project.inspect", { path: repo.project });
  assert.equal(p.valid, true);
  const s = await c.action("session.create", { project: repo.project });

  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "observe project",
      protocolVersion:1, submissionId: "project",
    }),
    confirmed=await confirmProject(c,s.id,r),task=confirmed.task;
  r.taskId=confirmed.taskId;
  assert.equal(task.status, "completed", task.error);
  assert.equal(f.calls.length, 2);
  assert.ok(task.work.startVersion);
  assert.equal((await c.diff(r.taskId)).fromVersion, task.work.startVersion);
  assert.equal(await c.patch(r.taskId), (await c.diff(r.taskId)).text);
  await assert.rejects(
    c.output(r.taskId, "unrelated", 0, 10),
    /任务|归属|output/,
  );
});
test("settings initialize custom API key and named team without model requests or credential return", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof controllerModule.createGuiController, "function");
  const c = await controllerModule.createGuiController({
    home: f.home,
    cwd: f.cwd,
  });
  t.after(() => c.close());
  assert.equal((await c.bootstrap()).configured, false);
  await c.action("provider.save", {
    providerId: "localcustom",
    apiKey: "never-return-this-key",
    custom: {
      baseUrl: f.endpoint,
      api: "openai-completions",
      modelId: "newmodel",
      name: "New",
      contextWindow: 32000,
      maxTokens: 4096,
    },
  });
  await c.action("team.save", {
    name: "New team",
    main: { provider: "localcustom", modelId: "newmodel" },
    secondary: [f.models.main],
  });
  const b = await c.bootstrap();
  assert.equal(b.configured, true);
  assert.doesNotMatch(
    JSON.stringify(b),
    /never-return-this-key|fixture-secret/,
  );
  await assert.rejects(
    c.action("provider.save", {
      providerId: "localcustom",
      apiKey: "replacement",
      custom: {
        baseUrl: f.endpoint,
        api: "openai-completions",
        modelId: "oops",
      },
    }),
    /存在/,
  );
  assert.equal(f.calls.length, 0);
});

test("read-only historical browsing creates no lock files or runtime", async (t) => {
  const { existsSync } = await import("node:fs");
  const f = await fixture(t),
    c = await controller(t, f);
  const manager = SessionManager.create(
    f.cwd,
    join(f.home, "pi/sessions/main"),
  );
  manager.appendMessage({
    role: "user",
    content: "history",
    timestamp: Date.now(),
  });
  const lock = join(f.home, "pi/sessions", manager.getSessionId() + ".locks");
  assert.equal(existsSync(lock), false);
  await c.session(manager.getSessionId());
  assert.equal(
    existsSync(lock),
    false,
    "history reading must not acquire a writer",
  );
  assert.equal(f.calls.length, 0);
});

test("failed metadata persistence preserves prior flow and blocks generation until reopened", async (t) => {
  const { renameSync, rmSync } = await import("node:fs");
  const f = await fixture(t),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });

  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "initial",
    protocolVersion:1, submissionId: "initial",
  });
  await finished(c, r.taskId);
  const record = readTask(f.home, r.taskId),
    path = record.stages[0].sessionFile;
  renameSync(path, path + ".backup");
  mkdirSync(path);
  try {
    await assert.rejects(
      c.action("session.name", { sessionId: s.id, title:"Cannot save" }),
      /保存失败|不可用/,
    );
    assert.equal(readTask(f.home,r.taskId).flow,"unified");
    await assert.rejects(
      c.action("task.submit", {
        sessionId: s.id,
        input: "must not send",
        protocolVersion:1, submissionId: "blocked",
      }),
      /保存失败|不可用/,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    rmSync(path, { recursive: true, force: true });
    renameSync(path + ".backup", path);
  }
});

test("project work reads edits checks accepts and returns task-bound logs and immutable diff", async (t) => {
  const { execution } = await import("./helpers/agent-sync-fixture.js");
  const { git } = await import("./helpers/git-fixture.js");
  const repo = repository(t);
  const original = git(repo.project, "status", "--porcelain=v1");
  const f = await fixture(t, (_call, n) => {
    const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
    if (n === 1)
      return tool("start_work", {
        action:"start",reason:"change a source file",plan:checkedPlan("change source",[{command:"node",args:["-e","if(require(\'fs\').readFileSync(\'a.txt\',\'utf8\')!==\'GUI accepted output\\n\')process.exit(1);console.log(\'GUI check log\')"]}]),
      });
    if (n === 2) return tool("read", { path: "a.txt" });
    if (n === 3)
      return tool("write", { path: "a.txt", content: "GUI accepted output\n" });
    if (n === 4 || n === 5) return tool("accept_change");
    return { text: "Delivered original reply" };
  });
  const c = await controller(t, f);
  await c.action("settings.work", {
    work: {
      execution,
      checks: [
        {
          command: "node",
          args: [
            "-e",
            "if(require('fs').readFileSync('a.txt','utf8')!=='GUI accepted output\\n')process.exit(1);console.log('GUI check log')",
          ],
        },
      ],
    },
  });
  const s = await c.action("session.create", { project: repo.project });

  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "change source",
      protocolVersion:1, submissionId: "edit",
    }),
    confirmed=await confirmProject(c,s.id,r),task=confirmed.task;
  r.taskId=confirmed.taskId;
  assert.equal(task.status, "completed", task.error);
  assert.equal(task.work.finalCheck.verification, "passed");
  const d = await c.diff(r.taskId);
  assert.match(d.text, /GUI accepted output/);
  const ref = task.work.finalCheck.checks[0].outputRef;
  const page = await c.output(r.taskId, ref, 0, 3),
    rest = await c.output(r.taskId, ref, page.nextOffset, 65536);
  assert.match(page.text + rest.text, /GUI check log/);
  assert.equal(
    readFileSync(join(task.work.resultWorkspace, "a.txt"), "utf8"),
    "GUI accepted output\n",
  );
  assert.equal(git(repo.project, "status", "--porcelain=v1"), original);
  await c.close();
  assert.deepEqual(await c.diff(r.taskId), d);
});

test("delegated work exposes actual member calls and only evidence-linked handoffs", async (t) => {
  const repo = repository(t);
  let leader = 0;
  const f = await fixture(t, (call) => {
    const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
    if (call.body.model === "r1")
      return { text: "Member inspected original text" };
    leader++;
    if (leader === 1)
      return tool("start_work", {action:"start",reason:"independent inspection",plan:checkedPlan("inspect with member")});
    if(leader===2)return tool("project_staff",{action:"appoint",input:{id:"reader",responsibility:"Inspect original text",scope:[],readScope:["."],models:["fixture/r1"],need:"deliverable",reason:"Need independent inspection"}});
    if (leader === 3)
      return tool("delegate", {
        staffId:"reader",
        model: "fixture/r1",
        assignment: "Inspect",
        implementationAdvice: "Read only",
        reason: "independent source inspection",
        scope: [],
        readScope: ["."],
        readOnly: true,
      });
    if (leader === 4) return tool("collect");
    return { text: "Leader deliverable" };
  });
  const c = await controller(t, f);
  await c.action("settings.work", { work: {execution:(await import("./helpers/agent-sync-fixture.js")).execution, checks: [] } });
  const s = await c.action("session.create", { project: repo.project });
  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "inspect with member",
      protocolVersion:1, submissionId: "delegate",
    }),
    confirmed=await confirmProject(c,s.id,r),task=confirmed.task;
  assert.equal(task.status, "completed", task.error);
  const member = task.participants.find((p) => p.role === "member");
  assert.equal(member.participated, true);
  assert.equal(member.model.modelId, "r1");
  // A worker is actual participation even though that model never reviewed.
  assert.equal(task.participants.find((p) => p.role === "reviewer-1").participated, false);
  assert.ok(
    task.messages.some(
      (m) =>
        m.text === "Member inspected original text" && m.model.modelId === "r1",
    ),
  );
  const handoffs = task.work.activities.filter((a) => a.type === "handoff");
  assert.ok(
    handoffs.some((a) => a.action === "delegate" && a.memberId === member.id),
  );
  assert.ok(
    handoffs.some(
      (a) =>
        a.action === "collect" &&
        a.memberId === member.id &&
        a.text.includes("Member inspected original text"),
    ),
  );
});

test("one corrupt task surfaces its error while healthy history and settings remain readable", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });

  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "healthy",
    protocolVersion:1, submissionId: "healthy",
  });
  await finished(c, r.taskId);
  const bad = "ea869a12-0612-4bda-8bbe-b30404f74f53";
  writeFileSync(join(f.home, "tasks", bad + ".json"), "{invalid JSON");
  const boot = await c.bootstrap();
  assert.ok(boot.historyErrors.some((error) => error.taskId === bad));
  assert.equal((await c.session(s.id)).turns[0].taskId, r.taskId);
  assert.equal((await c.task(r.taskId)).status, "completed");
});

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("accepted submit freezes mode and thinking before immediately following changes, with a cached runtime", async (t) => {
  const f = await fixture(t);
  const catalogPath = join(f.home, "pi/models.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  catalog.providers.fixture.models[0].reasoning = true;
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const c = await controller(t, f),
    s = await c.action("session.create", { project: null });
  await c.action("session.thinking", { sessionId: s.id, level: "low" });
  const warm = await c.action("task.submit", {
    sessionId: s.id,
    input: "warm context",
    protocolVersion:1, submissionId: "freeze-warm",
  });
  await finished(c, warm.taskId);
  const pending = c.action("task.submit", {
    sessionId: s.id,
    input: "accepted before edits",
    protocolVersion:1, submissionId: "freeze-current",
  });
  const mode = assert.rejects(c.action("session.mode", { sessionId: s.id, mode:"one" }),/移除/);
  const thinking = c.action("session.thinking", {
    sessionId: s.id,
    level: "high",
  });
  const current = await pending;
  await Promise.all([mode, thinking]);
  const task = await finished(c, current.taskId);
  assert.equal(
    task.singleModel,
    false,
    "accepted current task keeps its unified flow",
  );
  assert.equal(task.team.main.thinkingLevel, "low");
  assert.equal(f.calls.length, 2);
  const next = await c.action("task.submit", {
    sessionId: s.id,
    input: "next snapshot",
    protocolVersion:1, submissionId: "freeze-next",
  });
  const nextTask = await finished(c, next.taskId);
  assert.equal(nextTask.flow, "unified");
  assert.equal(nextTask.team.main.thinkingLevel, "high");
  assert.equal(f.calls.length, 3);
});

test("runtime initialization handoff allows concurrent metadata saves without losing writer ownership", async (t) => {
  const { ModelRuntime } = await import(sdkUrl);
  const f = await fixture(t),
    c = await controller(t, f),
    s = await c.action("session.create", { project: null });
  const entered = deferred(),
    release = deferred(),
    original = ModelRuntime.create;
  let first = true;
  t.mock.method(ModelRuntime, "create", async function (...args) {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return original.apply(this, args);
  });
  const pending = c.action("task.submit", {
    sessionId: s.id,
    input: "first initialization",
    protocolVersion:1, submissionId: "handoff-current",
  });
  await entered.promise;
  const starting = await c.bootstrap();
  const callsWhilePreparing = f.calls.length;
  const saves = Promise.allSettled([
    c.action("session.draft", {
      sessionId: s.id,expectedDraftRevision:s.draftRevision,branchAnchor:s.branchAnchor,
      editId:randomUUID(),workRequest:null,selectionId:null,
      text: "typed during initialization",
    }),
    c.action("session.name", { sessionId: s.id, title:"Opening name" }),
    c.action("session.name", {
      sessionId: s.id,
      title: "Saved during opening",
    }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const outcomes = await saves,
    current = await pending;
  assert.equal(starting.active.status,"preparing","reserved task ID is not a readable running record before registration");
  assert.equal(starting.active.sessionId,s.id);
  assert.equal(callsWhilePreparing,0);
  assert.equal(current.taskId,starting.active.taskId);
  assert.equal((await c.task(current.taskId)).id,current.taskId,"ready receipt refers to a readable task");
  for (const result of outcomes)
    assert.equal(result.status, "fulfilled", result.reason?.message);
  const task = await finished(c, current.taskId);
  assert.equal(task.singleModel, false);
  assert.equal(f.calls.length, 1);
  const restored = await c.session(s.id);
  assert.equal(restored.turns[0].flow, "unified");
  assert.equal(restored.draft, "typed during initialization");
  assert.equal(restored.title, "Saved during opening");
});

test("async Team switching reserves management until native model selection has completed", async (t) => {
  const { AgentSession } = await import(sdkUrl);
  const f = await fixture(t),
    c = await controller(t, f),
    s = await c.action("session.create", { project: null });
  const warm = await c.action("task.submit", {
    sessionId: s.id,
    input: "warm context",
    protocolVersion:1, submissionId: "team-warm",
  });
  await finished(c, warm.taskId);
  const team = await c.action("team.save", {
    name: "Reversed",
    main: f.models.secondary[0],
    secondary: [f.models.main],
  });
  const entered = deferred(),
    release = deferred(),
    original = AgentSession.prototype.setModel;
  t.mock.method(
    AgentSession.prototype,
    "setModel",
    async function (model, ...args) {
      if (model.id === "r1") {
        entered.resolve();
        await release.promise;
      }
      return original.call(this, model, ...args);
    },
  );
  const selecting = c.action("session.team", {
    sessionId: s.id,
    teamId: team.id,
  });
  await entered.promise;
  try {
    await assert.rejects(
      c.action("task.submit", {
        sessionId: s.id,
        input: "must not race Team",
        protocolVersion:1, submissionId: "team-overlap",
      }),
      /任务|设置/,
    );
    assert.equal(
      f.calls.length,
      1,
      "selection overlap must not begin generation",
    );
  } finally {
    release.resolve();
    await selecting;
  }
  assert.equal((await c.session(s.id)).team.id, team.id);
  const next = await c.action("task.submit", {
    sessionId: s.id,
    input: "after selection",
    protocolVersion:1, submissionId: "team-next",
  });
  assert.equal((await finished(c, next.taskId)).team.id, team.id);
});

test("provider saves refresh idle cached catalog and auth while preserving context and managed requests", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f),
    s = await c.action("session.create", { project: null });
  const warm = await c.action("task.submit", {
    sessionId: s.id,
    input: "previous context must survive",
    protocolVersion:1, submissionId: "catalog-warm",
  });
  await finished(c, warm.taskId);
  await c.action("provider.save", {
    providerId: "added-later",
    apiKey: "first-local-key",
    custom: {
      baseUrl: f.endpoint,
      api: "openai-completions",
      modelId: "new-main",
    },
  });
  const team = await c.action("team.save", {
    name: "Added provider",
    main: { provider: "added-later", modelId: "new-main" },
    secondary: [f.models.main],
  });
  await c.action("session.team", { sessionId: s.id, teamId: team.id });
  await c.action("provider.save", {
    providerId: "added-later",
    apiKey: "replacement-local-key",
  });
  const next = await c.action("task.submit", {
      sessionId: s.id,
      input: "after adding provider",
      protocolVersion:1, submissionId: "catalog-next",
    }),
    task = await finished(c, next.taskId);
  assert.equal(task.status, "completed", task.error);
  assert.equal(task.messages.length, 1);
  assert.equal(task.messages[0].model.provider, "added-later");
  assert.equal(task.usage.calls, 1);
  assert.match(
    JSON.stringify(f.calls[1].body.messages),
    /previous context must survive/,
  );
  assert.equal(
    f.calls[1].headers.authorization,
    "Bearer replacement-local-key",
  );
  assert.doesNotMatch(
    JSON.stringify(task),
    /replacement-local-key|first-local-key/,
  );
});

test('HTML action without associated project preserves draft and sends zero model requests',async t=>{
 const f=await fixture(t), c=await controller(t,f);
 const s=await c.action('session.create',{project:null});
 await c.action('session.draft',{sessionId:s.id,text:'make my HTML',expectedDraftRevision:s.draftRevision,branchAnchor:s.branchAnchor,editId:randomUUID(),workRequest:null,selectionId:null});
 await assert.rejects(c.action('task.submit',{sessionId:s.id,input:'make my HTML',protocolVersion:1, submissionId:'html-no-project',workRequest:{kind:'html-svg'}}),/协议/);
 assert.equal(f.calls.length,0);
 assert.equal((await c.session(s.id)).draft,'make my HTML');
 for (const input of ['/one','/team','/cothink'])
   await assert.rejects(c.action('task.submit',{sessionId:s.id,input,protocolVersion:1, submissionId:'local-with-html-'+input,workRequest:{kind:'html-svg'}}),/协议/);
 assert.equal(f.calls.length,0,'an HTML marker never changes local commands into generation');
});


test("unified role prompts preserve direct answer and explicit review responsibilities",async t=>{
 const f=await fixture(t,(call,n)=>n===2?{toolCalls:[{name:'request_review',args:{reason:'check',draft:'draft'}}]}:{text:'answer'}),c=await controller(t,f),s=await c.action('session.create',{project:null});
 const one=await c.action('task.submit',{sessionId:s.id,input:'direct',submissionId:'direct',protocolVersion:1});await finished(c,one.taskId);
 const review=await c.action('task.submit',{sessionId:s.id,input:'review draft',submissionId:'review',protocolVersion:1});assert.equal((await finished(c,review.taskId)).status,'completed');
 assert.equal(f.calls.length,4);assert.match(JSON.stringify(f.calls[0].body.messages),/unified conversation/);assert.match(JSON.stringify(f.calls[2].body.messages),/independent reviewer/);
 await assert.rejects(c.action('session.mode',{sessionId:s.id,mode:'one'}),/移除/);await assert.rejects(c.action('task.submit',{sessionId:s.id,input:'/one temporary',submissionId:'old',protocolVersion:1}),/移除/);
});

test("navigation persists across restart, preserves history, rejects stale revision and releases real writer", async t => {
  const {acquireSessionWriter, sessionWriterBusy} = await import("../src/storage.js");
  const f = await fixture(t,(_,n)=>({text:`navigation reply ${n}`}));
  let c = await controller(t,f);
  const s = await c.action("session.create",{project:null});
  const accepted = await c.action("task.submit",{sessionId:s.id,input:"archive searchable input",protocolVersion:1, submissionId:"archive"});
  await finished(c,accepted.taskId);
  const before = await c.session(s.id), file = readTask(f.home,accepted.taskId).stages[0].sessionFile, bytes = readFileSync(file);
  assert.equal(sessionWriterBusy(join(f.home,"pi"),s.id),true);
  const pinned = await c.action("session.pin",{sessionId:s.id,pinned:true,expectedRevision:0});
  assert.equal(pinned.navigation.revision,1);
  await assert.rejects(c.action("session.archive",{sessionId:s.id,archived:true,expectedRevision:0}),{code:"SESSION_STATE_CONFLICT"});
  const archived = await c.action("session.archive",{sessionId:s.id,archived:true,expectedRevision:1});
  assert.equal(archived.navigation.archived,true);
  assert.equal(sessionWriterBusy(join(f.home,"pi"),s.id),false);
  const external = acquireSessionWriter(join(f.home,"pi"),s.id);
  await assert.rejects(c.action("session.archive",{sessionId:s.id,archived:false,expectedRevision:2}),{code:"SESSION_BUSY"});
  external.release();
  await c.close(); c = await controller(t,f);
  assert.deepEqual((await c.session(s.id)).turns,before.turns);
  assert.deepEqual(readFileSync(file),bytes);
  assert.equal((await c.sessions()).items.length,0);
  assert.equal((await c.sessions({archived:"archived",query:"reply 1"})).items[0].match.taskId,accepted.taskId);
  await assert.rejects(c.action("task.submit",{sessionId:s.id,input:"blocked",protocolVersion:1, submissionId:"new"}),{code:"SESSION_STATE_UNAVAILABLE"});
  const restored = await c.action("session.archive",{sessionId:s.id,archived:false,expectedRevision:2});
  assert.equal(restored.navigation.pinned,true);
  assert.equal((await c.sessions()).items[0].id,s.id);
  assert.equal((await c.sessions({query:"navigation reply 2"})).items.length,0,"internal review is not searchable");
  assert.equal(f.calls.length,1);
});

test("navigation archives persisted empty records and rejects busy tasks, damaged metadata and preserves bytes on atomic failure",async t=>{
  const {readSessionUiState,writeSessionUiState} = await import("../src/session-ui-state.js");
  const {sessionWriterBusy} = await import("../src/storage.js");
  const f = await fixture(t,async()=>{await new Promise(r=>setTimeout(r,30)); return {text:"done"};});
  const c = await controller(t,f), empty = await c.action("session.create",{project:null});
  assert.equal(empty.persisted,true);
  await c.action("session.draft",{sessionId:empty.id,text:"keep my draft",expectedDraftRevision:empty.draftRevision,branchAnchor:empty.branchAnchor,editId:randomUUID(),workRequest:null,selectionId:null});
  await assert.rejects(c.action("session.close",{sessionId:empty.id}),/归档/);
  await c.action("session.archive",{sessionId:empty.id,archived:true,expectedRevision:0});
  assert.equal(sessionWriterBusy(join(f.home,"pi"),empty.id),false);
  assert.equal((await c.session(empty.id)).draft,"keep my draft");
  const s = await c.action("session.create",{project:null});
  const run = await c.action("task.submit",{sessionId:s.id,input:"busy",protocolVersion:1, submissionId:"busy"});
  await assert.rejects(c.action("session.archive",{sessionId:s.id,archived:true,expectedRevision:0}),{code:"SESSION_BUSY"});
  await finished(c,run.taskId);
  await assert.rejects(c.action("session.close",{sessionId:s.id}),{code:"SESSION_STATE_UNAVAILABLE"});
  await c.action("session.pin",{sessionId:s.id,pinned:true,expectedRevision:0});
  const path = join(f.home,"session-ui",s.id+".json"), original = readFileSync(path);
  let checks = 0;
  assert.throws(()=>writeSessionUiState(f.home,{sessionId:s.id,expectedRevision:1,archived:true},()=>{if(++checks===2)throw Error("ownership lost before atomic rename");}),/ownership lost/);
  assert.deepEqual(readFileSync(path),original);
  assert.equal(readSessionUiState(f.home,s.id).archived,false);
  for (const content of ['{"broken',JSON.stringify({schemaVersion:2})]) {
    writeFileSync(path,content);
    const saved = await c.session(s.id);
    assert.equal(saved.navigation,null); assert.match(saved.navigationError,/损坏|版本/);
    assert.ok((await c.sessions()).errors.some(e=>e.sessionId===s.id));
    await assert.rejects(c.action("session.pin",{sessionId:s.id,pinned:false,expectedRevision:1}),{code:"SESSION_STATE_UNAVAILABLE"});
    assert.equal(readFileSync(path,"utf8"),content);
  }
});

test("session query pages pinned recent IDs with explicit project filtering and expiring cursors",async t=>{
  const f = await fixture(t,()=>({text:"final search text"}));
  const c = await controller(t,f), ids=[];
  for (let n=0;n<3;n++) {
    const s=await c.action("session.create",{project:null}); ids.push(s.id);

    const run=await c.action("task.submit",{sessionId:s.id,input:`query item ${n}`,protocolVersion:1, submissionId:`item${n}`});
    await finished(c,run.taskId);
  }
  const page=await c.sessions({limit:1,project:null});
  const next=await c.sessions({limit:1,project:null,cursor:page.nextCursor});
  assert.notEqual(next.items[0].id,page.items[0].id);
  await c.action("session.pin",{sessionId:ids[0],pinned:true,expectedRevision:0});
  await assert.rejects(c.sessions({limit:1,project:null,cursor:page.nextCursor}),{code:"CURSOR_EXPIRED"});
  assert.equal((await c.sessions({project:null})).items[0].id,ids[0]);
  assert.equal((await c.sessions({project:"/missing-project"})).items.length,0);
  assert.equal((await c.sessions({query:"final search"})).items.length,3);
  assert.equal((await c.sessions({query:"no match"})).items.length,0);
  assert.equal(f.calls.length,3);
});

test("saving a Team validates the real directory and thinking of later secondary seats without generation", async t=>{
  const f=await fixture(t), c=await controller(t,f);
  const original=readFileSync(join(f.home,"config.json"),"utf8");
  await assert.rejects(c.action("team.save",{name:"missing later seat",main:f.models.main,
    secondary:[f.models.secondary[0],{provider:"fixture",modelId:"missing"}]}),/模型不可用/);
  await assert.rejects(c.action("team.save",{name:"unsupported later setting",main:f.models.main,
    secondary:[f.models.secondary[0],{...f.models.secondary[1],thinkingLevel:"not-a-level"}]}),/不支持思考档位/);
  assert.equal(readFileSync(join(f.home,"config.json"),"utf8"),original);
  assert.equal(f.calls.length,0);
  const provider=(await c.bootstrap()).providers.find(p=>p.id==="fixture");
  assert.equal(provider.configured,true);
  assert.ok(["api_key","configured","environment"].includes(provider.authKind));
  assert.doesNotMatch(JSON.stringify(provider),/fixture-secret/);
});

test("an explicit follow-Team choice clears a durable conversation thinking override without rewriting older tasks",async t=>{
  const f=await fixture(t), path=join(f.home,"pi/models.json"), catalog=JSON.parse(readFileSync(path,"utf8"));
  catalog.providers.fixture.models[0].reasoning=true;
  writeFileSync(path,JSON.stringify(catalog));
  const c=await controller(t,f), s=await c.action("session.create",{project:null});
  await c.action("session.thinking",{sessionId:s.id,level:"high"});
  const team=await c.action("team.save",{name:"Low team",main:{...f.models.main,thinkingLevel:"low"},secondary:f.models.secondary});
  await c.action("session.team",{sessionId:s.id,teamId:team.id});
  assert.equal((await c.session(s.id)).thinking,"high");
  const first=await c.action("task.submit",{sessionId:s.id,input:"with conversation override",protocolVersion:1, submissionId:"override-first"});
  assert.equal((await finished(c,first.taskId)).team.main.thinkingLevel,"high");
  await c.action("session.thinking",{sessionId:s.id});
  assert.equal((await c.session(s.id)).thinking,null);
  await c.close();
  const reopened=await controllerModule.createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
  assert.equal((await reopened.session(s.id)).thinking,null,"following Team survives closing and reopening the host");
  const second=await reopened.action("task.submit",{sessionId:s.id,input:"follow selected team",protocolVersion:1, submissionId:"override-second"});
  assert.equal((await finished(reopened,second.taskId)).team.main.thinkingLevel,"low");
  assert.equal((await reopened.task(first.taskId)).team.main.thinkingLevel,"high");
  assert.equal((await reopened.bootstrap()).teams.length,2,"the previous Team remains saved");
  assert.equal(f.calls.length,2,"two ordinary answers use one main request each");
  assert.deepEqual(f.calls.filter(call=>call.body.model==="main").map(call=>call.body.reasoning_effort),
    ["high","low"], "the fixture receives the effective thinking level, not only a matching task label");
});

test("unified GUI never imports native command code and directs unmanaged commands away from the clean host",async t=>{
 const f=await fixture(t),root=join(f.home,'native-gui');mkdirSync(root);
 const canary=join(f.home,'native-imported');writeFileSync(join(root,'package.json'),JSON.stringify({name:'gui-native',version:'1.0.0',type:'module',pi:{extensions:['index.js']}}));
 writeFileSync(join(root,'index.js'),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(canary)},'imported');export default pi=>pi.registerCommand('dialog',{handler:async()=>{}});`);
 const {runPackageCommand}=await load('src/packages.js');assert.equal((await runPackageCommand({home:f.home,cwd:f.cwd,command:'install',source:root})).exitCode,0);
 const c=await controller(t,f),session=await c.action('session.create',{project:null});
 assert.deepEqual(await c.action('extension.commands',{sessionId:session.id}),[]);assert.equal((await import('node:fs')).existsSync(canary),false);
 await assert.rejects(c.action('extension.command',{sessionId:session.id,input:'/dialog'}),/未知|不存在|unavailable/i);assert.equal(f.calls.length,0);
 const response=await c.action('task.submit',{sessionId:session.id,input:'plain question',submissionId:'clean',protocolVersion:1});assert.equal((await finished(c,response.taskId)).status,'completed');assert.equal((await import('node:fs')).existsSync(canary),false);
});

test("GUI creation persists a stable empty identity and complete versioned editor before any runtime", async t => {
  const {randomUUID} = await import("node:crypto"), {readdirSync} = await import("node:fs");
  const f = await fixture(t), c = await controller(t,f), id = randomUUID();
  const s = await c.action("session.create", {sessionId:id,workspaceId:null});
  assert.equal(s.id,id); assert.equal(s.persisted,true); assert.equal(s.draftRevision,null);
  assert.deepEqual(s.view.seenResults,{});
  const editId=randomUUID(), selectionId=randomUUID();
  const args={sessionId:id,expectedDraftRevision:s.draftRevision,branchAnchor:s.branchAnchor,editId,text:"未发送",workRequest:{kind:"html-svg"},selectionId};
  const saved=await c.action("session.draft",args);
  assert.equal(saved.sessionId,id);
  assert.deepEqual(saved.editor,{editorVersion:2,text:"未发送",workRequest:{kind:"html-svg"},selectionId,editId,materials:[]});
  await assert.rejects(c.action("session.draft",{sessionId:id,text:"old request"}),{code:"DRAFT_CONFLICT"});
  await assert.rejects(c.action("session.draft",{...args,editId:randomUUID(),text:"stale"}),{code:"DRAFT_CONFLICT"});
  await assert.rejects(c.action("session.create",{sessionId:id,workspaceId:null}),{code:"SESSION_STATE_CONFLICT"});
  await c.close();
  const reopened=await controllerModule.createGuiController({home:f.home,cwd:f.cwd}); t.after(()=>reopened.close());
  const restored=await reopened.session(id);
  assert.deepEqual(restored.editor,saved.editor); assert.equal(restored.draftRevision,saved.draftRevision);
  assert.equal((await reopened.sessions()).items.some(s=>s.id===id),true); assert.equal(f.calls.length,0);

  const task=await reopened.action("task.submit",{sessionId:id,input:"first real message",protocolVersion:1, submissionId:"durable-first"});
  await finished(reopened,task.taskId);
  const files=readdirSync(join(f.home,"pi/sessions/main")).filter(n=>n.endsWith(id+".jsonl")); assert.equal(files.length,1);
  const entries=readFileSync(join(f.home,"pi/sessions/main",files[0]),"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(entries.filter(e=>e.type==="session").length,1);
  assert.equal(entries.filter(e=>e.type==="message" && e.message.role==="user").length,1);
  assert.equal(f.calls.length,1);
});

test("GUI stable ID creation rejects damaged or duplicate candidate headers without overwriting",async t=>{
  const {randomUUID}=await import("node:crypto"); const f=await fixture(t), c=await controller(t,f);
  const id=randomUUID(), path=join(f.home,"pi/sessions/main",`2026-11-07_${id}.jsonl`);
  writeFileSync(path,'{"broken');
  await assert.rejects(c.action("session.create",{sessionId:id,workspaceId:null}),{code:"SESSION_STATE_UNAVAILABLE"});
  assert.equal(readFileSync(path,"utf8"),'{"broken'); assert.equal(f.calls.length,0);
  const s=await c.action("session.create",{sessionId:randomUUID(),workspaceId:null});
  const {readdirSync}=await import("node:fs"); const file=readdirSync(join(f.home,"pi/sessions/main")).find(n=>n.endsWith(s.id+".jsonl"));
  writeFileSync(join(f.home,"pi/sessions/main",file),'bad external write');
  assert.equal((await c.session(s.id)).readOnly,true);
  await assert.rejects(c.action("session.draft",{sessionId:s.id,expectedDraftRevision:null,branchAnchor:s.branchAnchor,editId:randomUUID(),text:"keep",workRequest:null,selectionId:null}),/损坏/);
});

test("GUI draft rejects a former branch anchor even when its draft revision matches",async t=>{
  const {randomUUID}=await import("node:crypto"); const f=await fixture(t), c=await controller(t,f);
  const s=await c.action("session.create",{sessionId:randomUUID(),workspaceId:null}); await c.close();
  const {readdirSync}=await import("node:fs"), dir=join(f.home,"pi/sessions/main");
  const path=join(dir,readdirSync(dir).find(n=>n.endsWith(s.id+".jsonl")));
  const manager=SessionManager.open(path); const oldAnchor=manager.appendCustomEntry("cothink-title",{title:"old branch"});
  manager.branch(s.branchAnchor); manager.appendCustomEntry("cothink-title",{title:"sibling"});
  const reopened=await controllerModule.createGuiController({home:f.home,cwd:f.cwd}); t.after(()=>reopened.close());
  await assert.rejects(reopened.action("session.draft",{sessionId:s.id,branchAnchor:oldAnchor,expectedDraftRevision:null,editId:randomUUID(),text:"late",workRequest:null,selectionId:null}),{code:"DRAFT_CONFLICT"});
  assert.equal((await reopened.session(s.id)).draft,"");
});

test("UI schema 2 initialization and management preserve each other's revisions and corruption",async t=>{
  const ui=await import("../src/session-ui-state.js"), {randomUUID}=await import("node:crypto"); const f=await fixture(t), id=randomUUID();
  const path=join(f.home,"session-ui",id+".json"); mkdirSync(join(f.home,"session-ui"),{recursive:true});
  const old={schemaVersion:1,revision:3,archived:false,pinned:true,changedAt:null}; writeFileSync(path,JSON.stringify(old));
  assert.equal(ui.readSessionUiState(f.home,id).revision,3); assert.deepEqual(JSON.parse(readFileSync(path)),old);
  assert.equal(typeof ui.initializeSessionView,"function");
  const init=ui.initializeSessionView(f.home,{sessionId:id,seenResults:{task:"result"}});
  assert.equal(init.revision,3); assert.equal(init.viewRevision,1);
  const changed=ui.writeSessionUiState(f.home,{sessionId:id,expectedRevision:3,archived:true},()=>{});
  assert.deepEqual(changed.view,init.view); assert.equal(changed.viewRevision,1);
  assert.deepEqual(ui.initializeSessionView(f.home,{sessionId:id,seenResults:{other:"result"}}),changed);
  writeFileSync(path,'{broken'); assert.throws(()=>ui.initializeSessionView(f.home,{sessionId:id,seenResults:{}}),{code:"SESSION_STATE_UNAVAILABLE"}); assert.equal(readFileSync(path,"utf8"),'{broken');
});

test("legacy and modern creation inherit recent roster when a workspace default is unset",async t=>{
  const {repository}=await import("./helpers/git-fixture.js");
  const f=await fixture(t),c=await controller(t,f),project=repository(t).project;
  const first=await c.action("session.create",{project}); assert.equal(first.team.id,teamId);
  const w=(await c.bootstrap()).workspaces.find(w=>w.id===first.workspaceId);
  await c.action("workspace.update",{workspaceId:w.id,expectedRevision:w.revision,change:{defaultRosterId:null}});
  const existing=await c.action("session.create",{project}); assert.equal(existing.team.id,teamId);
  const modern=await c.action("session.create",{sessionId:randomUUID(),workspaceId:w.id}); assert.equal(modern.team.id,teamId);
  assert.equal((await c.bootstrap()).workspaces.find(row=>row.id===w.id).defaultRosterId,null);
  assert.equal(f.calls.length,0);
});

test("GUI publication survives optional view initialization failure and retries the empty baseline",async t=>{
  const {rmSync,readdirSync}=await import("node:fs"); const f=await fixture(t),c=await controller(t,f);
  writeFileSync(join(f.home,"gui-ui"),"blocked UI lock directory");
  const s=await c.action("session.create",{sessionId:randomUUID(),workspaceId:null});
  assert.equal(s.persisted,true); assert.match(s.viewError,/阅读状态/); assert.deepEqual(s.view.seenResults,{});

  const task=await c.action("task.submit",{sessionId:s.id,input:"view save is optional",protocolVersion:1, submissionId:"view-optional"});
  await finished(c,task.taskId);
  rmSync(join(f.home,"gui-ui"));
  const restored=await c.session(s.id); assert.equal(restored.viewError,null); assert.deepEqual(restored.view.seenResults,{});
  assert.equal(f.calls.length,1); assert.ok(readdirSync(join(f.home,"session-ui")).includes(s.id+".json"));
});

test("external damaged GUI association keeps readable turns but blocks writes for a cached session",async t=>{
  const {readdirSync}=await import("node:fs"); const f=await fixture(t),c=await controller(t,f);
  const s=await c.action("session.create",{sessionId:randomUUID(),workspaceId:null});

  await finished(c,(await c.action("task.submit",{sessionId:s.id,input:"readable history",protocolVersion:1, submissionId:"association"})).taskId);
  const dir=join(f.home,"pi/sessions/main"),path=join(dir,readdirSync(dir).find(n=>n.endsWith(s.id+".jsonl")));
  const entries=readFileSync(path,"utf8").trim().split("\n").map(JSON.parse);
  entries.find(e=>e.customType==="cothink-gui-workspace").data={workspaceId:"bad"};
  const bytes=entries.map(JSON.stringify).join("\n")+"\n"; writeFileSync(path,bytes);
  const read=await c.session(s.id); assert.equal(read.turns.length,1); assert.match(read.workspaceError,/归属损坏/);
  await assert.rejects(c.action("session.name",{sessionId:s.id,title:"unsafe"}),{code:"WORKSPACE_UNAVAILABLE"});
  assert.equal(readFileSync(path,"utf8"),bytes); assert.equal(f.calls.length,1);
});

test("view records exact results, preserves concurrent management, and updates workspace attention", async t => {
  const {acquireSessionWriter} = await load("src/storage.js");
  let release;
  const pending = new Promise(resolve => {release=resolve;});
  const f = await fixture(t,async () => {await pending; return {text:"Can you review this?"};}), c = await controller(t,f);
  t.after(release);
  const workspaceId = randomUUID();
  await c.action("workspace.create",{workspaceId,name:"Review",project:null,defaultRosterId:teamId});
  const s = await c.action("session.create",{sessionId:randomUUID(),workspaceId});
  const another = await c.action("session.create",{sessionId:randomUUID(),workspaceId});

  const accepted = await c.action("task.submit",{sessionId:s.id,input:"Review",protocolVersion:1, submissionId:"review"});
  const workspace = async () => (await c.bootstrap()).workspaces.find(w => w.id===workspaceId);
  try {
    assert.equal((await workspace()).attention.kind,"running");
    await assert.rejects(c.action("workspace.update",{workspaceId,expectedRevision:0,change:{defaultRosterId:null}}),{code:"WORKSPACE_CONFLICT"});
  } finally { release(); }
  const done = await finished(c,accepted.taskId);
  const first = await c.session(s.id);
  assert.equal(first.turns[0].resultRevision,done.resultRevision);
  assert.equal((await workspace()).attention.kind,"unread");
  await c.action("session.pin",{sessionId:s.id,pinned:true,expectedRevision:0});
  await c.action("session.archive",{sessionId:s.id,archived:true,expectedRevision:1});
  const external = acquireSessionWriter(join(f.home,"pi"),s.id);
  try {
    const seen = {taskId:done.id,resultRevision:done.resultRevision};
    const saved = await c.action("session.view",{sessionId:s.id,expectedViewRevision:first.viewRevision,opened:true,seen,
      anchor:{taskId:done.id,part:"result",offsetPx:12}});
    assert.equal(saved.view.seenResults[done.id],done.resultRevision);
    assert.equal(saved.view.anchor.taskId,done.id);
    await assert.rejects(c.action("session.view",{sessionId:s.id,expectedViewRevision:first.viewRevision,seen}),{code:"VIEW_CONFLICT"});
  } finally { external.release(); }
  await c.action("session.archive",{sessionId:s.id,archived:false,expectedRevision:2});
  const reread = await c.session(s.id);
  assert.equal(reread.navigation.pinned,true);
  assert.equal(reread.navigation.revision,3);
  assert.equal(reread.view.anchor.offsetPx,12);
  assert.equal((await workspace()).recentSessionId,s.id);
  assert.equal((await workspace()).attention,null);
  const path=join(f.home,"requests",readTask(f.home,done.id).finalCallId+".json");
  const stored=JSON.parse(readFileSync(path,"utf8"));
  writeFileSync(path,JSON.stringify({...stored,text:"New saved result"}));
  const updated = await c.session(s.id);
  const latest = updated.turns[0].resultRevision;
  assert.notEqual(latest,done.resultRevision);
  assert.equal((await c.task(done.id)).resultRevision,latest);
  assert.equal((await workspace()).recentSessionId,s.id);
  assert.equal((await workspace()).attention.taskId,done.id);
  await assert.rejects(c.action("session.view",{sessionId:s.id,expectedViewRevision:updated.viewRevision,
    seen:{taskId:done.id,resultRevision:done.resultRevision}}),{code:"VIEW_CONFLICT"});
  await c.action("session.view",{sessionId:another.id,expectedViewRevision:another.viewRevision,opened:true});
  assert.equal((await workspace()).recentSessionId,another.id);
  assert.deepEqual((await c.sessions({query:"Review"})).workspaceMatches,[workspaceId]);
  await c.action("workspace.update",{workspaceId,expectedRevision:0,change:{archived:true}});
  const archived = await c.sessions({query:"Review",archived:"all"});
  assert.equal(archived.workspaces.find(w=>w.id===workspaceId).recentSessionId,another.id);
  assert.equal(archived.workspaces.find(w=>w.id===workspaceId).attention,null);
  assert.deepEqual(archived.workspaceMatches,[workspaceId]);
  assert.deepEqual((await c.sessions({query:"Review"})).workspaceMatches,[]);
  assert.equal(f.calls.length,1);
});

test("archived workspace and session refuse the same conversation mutations; recovery stays available", async t => {
  const f = await fixture(t,()=>({text:"Done"})), c = await controller(t,f), workspaceId = randomUUID();
  await c.action("workspace.create",{workspaceId,name:"Archive",project:null,defaultRosterId:teamId});
  const {id:sessionId} = await c.action("session.create",{sessionId:randomUUID(),workspaceId});

  const submitted={sessionId,input:"Before archive",protocolVersion:1, submissionId:"existing"};
  const {taskId}=await c.action("task.submit",submitted);
  await finished(c,taskId);
  const before=await c.session(sessionId);
  const mutations = [
    ["session.name",{title:"Late rename"}],
    ["session.name",{title:"Archived change"}],
    ["session.team",{teamId}],
    ["session.thinking",{level:"high"}],
    ["session.draft",{text:"Late draft",expectedDraftRevision:before.draftRevision,branchAnchor:before.branchAnchor,
      editId:randomUUID(),workRequest:null,selectionId:null}],
    ["session.fork",{taskId}],
    ["extension.commands",{}],
    ["extension.command",{input:"/help"}],
    ["extension.reload",{}],
    ["task.submit",{input:"Late task",protocolVersion:1, submissionId:"new"}],
  ];
  await c.action("workspace.update",{workspaceId,expectedRevision:0,change:{archived:true}});
  for (const [action,args] of mutations)
    await assert.rejects(c.action(action,{sessionId,...args}),{code:"WORKSPACE_ARCHIVED"},action);
  await assert.rejects(c.action("session.create",{sessionId:randomUUID(),workspaceId}),{code:"WORKSPACE_ARCHIVED"});
  assert.equal((await c.action("task.submit",submitted)).taskId,taskId);
  assert.equal((await c.session(sessionId)).turns[0].finalText,"Done");
  await c.action("workspace.update",{workspaceId,expectedRevision:1,change:{archived:false}});
  await c.action("session.archive",{sessionId,expectedRevision:0,archived:true});
  for (const [action,args] of mutations)
    await assert.rejects(c.action(action,{sessionId,...args}),{code:"SESSION_STATE_UNAVAILABLE"},action);
  assert.equal((await c.action("task.submit",submitted)).taskId,taskId);
  assert.equal(f.calls.length,1);
});

test("a rejected default roster write preserves the confirmed conversation switch only", async t => {
  const f = await fixture(t), c = await controller(t,f), workspaceId=randomUUID();
  await c.action("workspace.create",{workspaceId,name:"Rosters",project:null,defaultRosterId:teamId});
  const s = await c.action("session.create",{sessionId:randomUUID(),workspaceId});
  const other = await c.action("session.create",{sessionId:randomUUID(),workspaceId});
  const newRoster = await c.action("team.save",{name:"New roster",main:f.models.secondary[0],secondary:[f.models.main]});
  const switched = await c.action("session.team",{sessionId:s.id,teamId:newRoster.id});
  assert.equal(switched.team.id,newRoster.id);
  await c.action("workspace.update",{workspaceId,expectedRevision:0,change:{name:"Renamed concurrently"}});
  await assert.rejects(c.action("workspace.update",{workspaceId,expectedRevision:0,change:{defaultRosterId:newRoster.id}}),{code:"WORKSPACE_CONFLICT"});
  await c.close();
  const reopened=await controllerModule.createGuiController({home:f.home,cwd:f.cwd});
  t.after(()=>reopened.close());
  assert.equal((await reopened.session(s.id)).team.id,newRoster.id);
  assert.equal((await reopened.session(other.id)).team.id,teamId);
  assert.equal((await reopened.bootstrap()).workspaces.find(w=>w.id===workspaceId).defaultRosterId,teamId);
  assert.equal(f.calls.length,0);
});

test("workspace attention targets corrupt navigation and clears after repair, without flagging missing view", async t => {
  const {rmSync} = await import("node:fs");
  const f = await fixture(t), c = await controller(t,f), workspaceId = randomUUID();
  await c.action("workspace.create",{workspaceId,name:"Reading repair",project:null,defaultRosterId:teamId});
  const {id:sessionId} = await c.action("session.create",{sessionId:randomUUID(),workspaceId});
  const path = join(f.home,"session-ui",sessionId+".json"), original = readFileSync(path);
  const workspace = async () => (await c.bootstrap()).workspaces.find(w=>w.id===workspaceId);
  rmSync(path);
  assert.equal((await workspace()).attention,null,"a missing optional view does not block the conversation");
  const corrupt = '{"broken"';
  writeFileSync(path,corrupt);
  const session = await c.session(sessionId);
  assert.equal(session.readOnly,true);
  assert.match(session.navigationError,/损坏/);
  await assert.rejects(c.action("task.submit",{sessionId,input:"Blocked before generation",protocolVersion:1, submissionId:"blocked"}),
    {code:"SESSION_STATE_UNAVAILABLE"});
  assert.deepEqual((await workspace()).attention,{kind:"needs_attention",sessionId,taskId:null});
  assert.equal(readFileSync(path,"utf8"),corrupt);
  writeFileSync(path,original);
  const repaired = await workspace();
  assert.equal(repaired.attention,null);
  assert.equal(repaired.recentSessionId,sessionId);
  assert.equal(f.calls.length,0);
});


test('GUI submit validates explicit builtin skills through the unified frozen catalog',async t=>{
 const f=await fixture(t,()=>({text:'Selected skill received'})),c=await controller(t,f);
 const s=await c.action('session.create',{project:null});
 const submitted=await c.action('task.submit',{sessionId:s.id,input:'/skill:doc-maintenance explain documentation checks',protocolVersion:1,submissionId:randomUUID()});
 assert.equal((await finished(c,submitted.taskId)).status,'completed');
 assert.equal(f.calls.length,1);
 assert.ok(f.calls[0].body.tools.some(x=>x.function.name==='read_skill'));
 await assert.rejects(c.action('task.submit',{sessionId:s.id,input:'/skill:unknown-skill explain',protocolVersion:1,submissionId:randomUUID()}),/技能|命令/);
 assert.equal(f.calls.length,1);
});


test('GUI disabled builtin and explicit-only external skill retain their selection boundaries',async t=>{
 const f=await fixture(t,()=>({text:'answer'})),skill=join(f.home,'explicit','SKILL.md');
 mkdirSync(join(f.home,'explicit'));writeFileSync(skill,'---\nname: explicit-only\ndescription: Explicit test\ndisable-model-invocation: true\n---\nEXPLICIT_BODY');
 const c=await controller(t,f,{piResources:{skills:[skill],builtinSkills:{disabled:['doc-maintenance']}}});
 const s=await c.action('session.create',{project:null});
 const submit=input=>c.action('task.submit',{sessionId:s.id,input,protocolVersion:1,submissionId:randomUUID()});
 await assert.rejects(submit('/skill:doc-maintenance explain'),/技能/);assert.equal(f.calls.length,0);
 const normal=await submit('ordinary question');assert.equal((await finished(c,normal.taskId)).status,'completed');
 assert.doesNotMatch(JSON.stringify(f.calls[0].body.messages),/explicit-only|EXPLICIT_BODY/);
 const selected=await submit('/skill:explicit-only explain');assert.equal((await finished(c,selected.taskId)).status,'completed');
 assert.match(JSON.stringify(f.calls[1].body.messages),/explicit-only/);assert.equal(f.calls.length,2);
});

test("ordinary chat survives a vanished Team directory and inherits the recent roster when no default is set", async t => {
  const f=await fixture(t,()=>({text:"reply without project"})), c=await controller(t,f);
  const {renameSync}=await import("node:fs");
  const repo=await repository(t);
  const {project}=repo;
  const workspaceId=randomUUID();
  const workspace=await c.action("workspace.create",{workspaceId,name:"vanishing",project,defaultRosterId:null});
  renameSync(project,project+"-moved");
  const s=await c.action("session.create",{sessionId:randomUUID(),workspaceId});
  assert.equal(s.project,workspace.project);
  assert.equal(s.team.id,teamId);
  const accepted=await c.action("task.submit",{sessionId:s.id,input:"hello",protocolVersion:1,submissionId:randomUUID()});
  assert.equal((await finished(c,accepted.taskId)).status,"completed");
  assert.equal(f.calls.length,1);
});

test("home editor reserves and recovers the same creation across host restarts without sending", async t => {
  const f=await fixture(t), c=await controller(t,f);
  const draftId=randomUUID(), sessionId=randomUUID();
  const editor={editorVersion:2,text:"retained home draft",editId:randomUUID(),workRequest:null,selectionId:null,turnOptions:null,materials:[]};
  const saved=await c.action("home.draft",{draftId,expectedRevision:null,editor});
  await assert.rejects(c.action("home.draft",{draftId,expectedRevision:null,editor}),{code:"DRAFT_CONFLICT"});
  const pending=await c.action("home.reserve",{draftId,expectedRevision:saved.revision,sessionId,workspaceId:null});
  assert.equal(pending.pendingCreateSessionId,sessionId);
  await c.action("session.create",{sessionId,workspaceId:null,homeDraftId:draftId});
  await c.close();
  const restored=await controllerModule.createGuiController({home:f.home,cwd:f.cwd});
  t.after(()=>restored.close());
  const loaded=(await restored.bootstrap()).homeDraft;
  assert.equal(loaded.pendingCreateSessionId,sessionId);
  assert.equal(loaded.editor.text,editor.text);
  const transferred=await restored.action("home.transfer",{draftId,expectedRevision:loaded.revision,sessionId});
  assert.equal(transferred.editor.text,editor.text);
  assert.equal(transferred.editor.editId,editor.editId);
  assert.equal((await restored.bootstrap()).homeDraft,null);
  assert.equal(f.calls.length,0);
});

test("failure freezing a skill before first progress confirms the original failed submission",async t=>{
  const f=await fixture(t);
  const {symlinkSync}=await import("node:fs");
  const skill=join(f.home,"resource-freeze-probe");
  mkdirSync(skill);
  writeFileSync(join(skill,"SKILL.md"),"---\nname: resource-freeze-probe\ndescription: Test freeze rejection before any model call\n---\nProbe.\n");
  symlinkSync(join(skill,"SKILL.md"),join(skill,"references"));
  const c=await controller(t,f,{piResources:{skills:[join(skill,"SKILL.md")]}});
  const s=await c.action("session.create",{sessionId:randomUUID(),workspaceId:null}), submissionId=randomUUID();
  let timer;
  try {
    const accepted=await Promise.race([
      c.action("task.submit",{sessionId:s.id,submissionId,input:"no request should leave this process",protocolVersion:1}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("submission never settled")),1500);})
    ]);
    const saved=await c.task(accepted.taskId);
    assert.equal(saved.status,"failed");
    assert.match(saved.error,/symbolic link/);
    assert.equal((await c.session(s.id)).submissions[0].submissionId,submissionId);
    assert.equal(f.calls.length,0);
  } finally { clearTimeout(timer); }
});

test("new conversations prefer Team default, then the saved source roster, and require selection after drift",async t=>{
  const f=await fixture(t), c=await controller(t,f);
  const source=await c.action("session.create",{sessionId:randomUUID(),workspaceId:null});
  const roster=await c.action("team.save",{name:"Alternative",main:f.models.secondary[0],secondary:[f.models.main]});
  const pinned=await c.action("workspace.create",{workspaceId:randomUUID(),name:"With default",defaultRosterId:roster.id,project:null});
  const plain=await c.action("workspace.create",{workspaceId:randomUUID(),name:"Inherit",defaultRosterId:null,project:null});
  const from={sourceSessionId:source.id,sourceLeafId:source.branchAnchor};
  const pinnedChat=await c.action("session.create",{sessionId:randomUUID(),workspaceId:pinned.id,...from});
  assert.equal(pinnedChat.team.id,roster.id);
  const inherited=await c.action("session.create",{sessionId:randomUUID(),workspaceId:plain.id,...from});
  assert.equal(inherited.team.id,source.team.id);
  await c.action("session.name",{sessionId:source.id,title:"Leaf changed"});
  const drift=await c.action("session.create",{sessionId:randomUUID(),workspaceId:plain.id,...from});
  assert.equal(drift.team,null);
  assert.match(drift.rosterRequired,/来源对话.*变化/);
  assert.equal((await c.bootstrap()).workspaces.find(row=>row.id===plain.id).defaultRosterId,null);
  assert.equal(f.calls.length,0);
});

test("setting a default with an unavailable later roster seat preserves the Team",async t=>{
  const f=await fixture(t), c=await controller(t,f);
  const config=createTeamConfig({formatVersion:2,...f.models},"Fixture",teamId);
  const brokenId=randomUUID();
  config.teams.push({id:brokenId,name:"Removed provider model",main:f.models.main,secondary:[f.models.secondary[0],{provider:"fixture",modelId:"removed-r2"}]});
  saveConfig(f.home,config);
  const group=await c.action("workspace.create",{workspaceId:randomUUID(),name:"Working default",project:null,defaultRosterId:teamId});
  await assert.rejects(c.action("workspace.update",{workspaceId:group.id,expectedRevision:group.revision,change:{defaultRosterId:brokenId}}),/默认阵容.*不可用/);
  const saved=(await c.bootstrap()).workspaces.find(row=>row.id===group.id);
  assert.equal(saved.defaultRosterId,teamId);
  assert.equal(saved.revision,group.revision);
  assert.equal(f.calls.length,0);
});

test("ordinary directory binding, preparation and explicit continuation reach formal work", async t => {
  const checks=[{command:"node",args:["-e","if(require('fs').readFileSync('a.txt','utf8').trim()!=='prepared result')process.exit(1)"]}];
  const f = await fixture(t, (_, n) => {
    const tool=(name,args={})=>({toolCalls:[{name,args}]});
    if (n<=2) return tool("start_work",{action:"start",reason:"edit",plan:checkedPlan("Edit prepared file",checks)});
    if (n===3) return tool("read",{path:"a.txt"});
    if (n===4) return tool("write",{path:"a.txt",content:"prepared result\n"});
    if (n===5 || n===6) return tool("accept_change");
    return {text:"delivered"};
  });
  const c = await controller(t,f);
  const {execution}=await import("./helpers/agent-sync-fixture.js");
  await c.action("settings.work",{work:{execution,checks}});
  const ordinary = mkdtempSync(join(tmpdir(),"cothink-t2-ordinary-"));
  t.after(()=>rmSync(ordinary,{recursive:true,force:true}));
  writeFileSync(join(ordinary,"a.txt"),"initial\n");
  const directory=await c.action("project.inspect",{path:ordinary,purpose:"directory"});
  assert.equal(directory.directoryAvailable,true);
  assert.equal((await c.action("project.inspect",{path:ordinary})).executionReady,false);
  const workspace=await c.action("workspace.create",{workspaceId:randomUUID(),name:"普通目录",project:ordinary,defaultRosterId:teamId});
  const s=await c.action("session.create",{workspaceId:workspace.id,sessionId:randomUUID()});
  const first=await c.action("task.submit",{sessionId:s.id,input:"work with a.txt",protocolVersion:1,submissionId:randomUUID()});
  const blocked=await finished(c,first.taskId);
  assert.equal(blocked.status,"blocked");
  assert.equal(blocked.projectPreparationBlocked?.code,"PROJECT_NOT_PREPARED");
  assert.equal(blocked.proposalRef??null,null);
  assert.equal(f.calls.length,1);
  const operationId=randomUUID();
  const prep=(action,rest={})=>c.action("project.prepare",{action,operationId,...rest});
  assert.equal((await prep("preview",{path:ordinary})).status,"inventory");
  const preview=await prep("preview",{path:ordinary,selectedPaths:["a.txt"]});
  assert.equal(preview.status,"preview");
  assert.equal((await prep("confirm")).status,"ready");
  assert.equal((await prep("query")).commit,preview.expectedCommit);
  assert.equal(f.calls.length,1);
  const continued=await c.action("task.continuePrepared",{sessionId:s.id,sourceTaskId:first.taskId,submissionId:randomUUID(),protocolVersion:1});
  assert.equal(readTask(f.home,continued.taskId).continuationSource.taskId,first.taskId);
  assert.equal((await finished(c,first.taskId)).status,"blocked");
  const delivery=await confirmProject(c,s.id,continued);
  assert.ok(delivery.task.work.version);
  assert.match((await c.diff(delivery.task.id)).text,/prepared result/);
  assert.equal(readFileSync(join(ordinary,"a.txt"),"utf8"),"initial\n");
});

test("rebind preserves every legacy branch and blocks when a sibling is owned elsewhere", async t => {
  const f=await fixture(t), c=await controller(t,f);
  const old=join(f.cwd,"old"),other=join(f.cwd,"other"),next=join(f.cwd,"next");
  for (const path of [old,other,next]) mkdirSync(path);
  const oldTeam=await c.action("workspace.create",{workspaceId:randomUUID(),name:"Old",project:old,defaultRosterId:teamId});
  const otherTeam=await c.action("workspace.create",{workspaceId:randomUUID(),name:"Other",project:other,defaultRosterId:teamId});
  const m=SessionManager.create(f.cwd,join(f.home,"pi/sessions/main"));
  m.appendMessage({role:"user",content:"legacy",timestamp:Date.now()});
  const fork=m.getLeafId();
  m.appendCustomEntry("cothink-project",{project:oldTeam.project});
  m.branch(fork);
  m.appendCustomEntry("cothink-project",{project:otherTeam.project});
  const before=readFileSync(m.getSessionFile());
  const {acquireSessionWriter}=await load("src/storage.js");
  const writer=acquireSessionWriter(join(f.home,"pi"),m.getSessionId());
  const nextPath=(await c.action("project.inspect",{path:next,purpose:"directory"})).canonicalPath;
  const operationId=randomUUID(), args={workspaceId:oldTeam.id,expectedRevision:0,path:nextPath,operationId};
  try { await assert.rejects(c.action("workspace.rebind",args),{code:"WORKSPACE_CONFLICT"}); }
  finally { writer.release(); }
  const changed=await c.action("workspace.rebind",args);
  assert.equal(changed.project,nextPath);
  assert.deepEqual(readFileSync(m.getSessionFile()),before);
  const state=JSON.parse(readFileSync(join(f.home,"gui-workspaces.json")));
  assert.equal(state.legacyMembership[m.getSessionId()][oldTeam.project],oldTeam.id);
  assert.equal(state.legacyMembership[m.getSessionId()][otherTeam.project],otherTeam.id);
  assert.equal((await c.action("workspace.rebind.query",{workspaceId:oldTeam.id,expectedRevision:0,operationId})).status,"confirmed");
  const existing=await c.session(m.getSessionId());
  assert.equal(existing.project,otherTeam.project);
  assert.equal(existing.workspaceId,otherTeam.id);
  const created=await c.action("session.create",{workspaceId:oldTeam.id,sessionId:randomUUID()});
  assert.equal((await c.session(created.id)).project,nextPath);
  const detached=await c.action("workspace.rebind",{workspaceId:oldTeam.id,expectedRevision:1,path:null,operationId:randomUUID()});
  assert.equal(detached.project,null);
  assert.equal((await c.session(created.id)).project,nextPath);
  assert.equal((await c.session(created.id)).workspaceId,oldTeam.id);
});

test("browser folder chooser creates a directory without Git and preserves it when not attached", async t => {
  const f=await fixture(t), c=await controller(t,f);
  const listing=await c.action("project.browse",{path:f.cwd});
  const name="学习资料-"+ "汉".repeat(30);
  const {path}=await c.action("project.mkdir",{parent:listing.path,name});
  const later=await c.action("project.browse",{path:listing.path});
  assert.ok(later.folders.some(item=>item.path===path));
  assert.equal((await c.action("project.inspect",{path,purpose:"directory"})).directoryAvailable,true);
  assert.equal((await c.action("project.inspect",{path,purpose:"execution"})).executionReady,false);
  await assert.rejects(c.action("project.mkdir",{parent:listing.path,name:"../escape"}),/名称/);
  assert.equal(f.calls.length,0);
});

test("rebind cannot absorb an undiscovered legacy session at the destination", async t => {
  const f=await fixture(t), c=await controller(t,f);
  const from=join(f.cwd,"original"), into=join(f.cwd,"late-legacy");
  mkdirSync(from); mkdirSync(into);
  const team=await c.action("workspace.create",{workspaceId:randomUUID(),name:"Original",project:from,defaultRosterId:teamId});
  const {canonicalPath:destination}=await c.action("project.inspect",{path:into,purpose:"directory"});
  const m=SessionManager.create(f.cwd,join(f.home,"pi/sessions/main"));
  m.appendCustomEntry("cothink-project",{project:destination});
  m.appendMessage({role:"user",content:"late legacy history",timestamp:Date.now()});
  const priorBytes=readFileSync(m.getSessionFile());
  const change={workspaceId:team.id,expectedRevision:team.revision,operationId:randomUUID(),path:destination};
  await assert.rejects(c.action("workspace.rebind",change),{code:"WORKSPACE_CONFLICT"});
  const legacy=await c.session(m.getSessionId());
  assert.ok(legacy.workspaceId && legacy.workspaceId!==team.id);
  const snapshot=await c.bootstrap();
  assert.equal(snapshot.workspaces.find(item=>item.id===team.id).project,team.project);
  assert.equal(snapshot.workspaces.find(item=>item.id===legacy.workspaceId).project,destination);
  assert.deepEqual(readFileSync(m.getSessionFile()),priorBytes);
  assert.equal(f.calls.length,0);
});

test("shutdown drains OAuth SDK completion and device identity flush", async t => {
  const f = await fixture(t);
  const entered = deferred(), aborted = deferred(), finishLogin = deferred(), flushing = deferred(), finishFlush = deferred();
  const {SettingsManager} = await import(sdkUrl);
  const flush = SettingsManager.prototype.flush;
  t.mock.method(SettingsManager.prototype,"flush",async function(){
    flushing.resolve();
    await finishFlush.promise;
    return flush.call(this);
  });
  const c = await controllerModule.createGuiController({
    home:f.home,cwd:f.cwd,oauthRuntime:async()=>({
      getProvider:()=>({auth:{oauth:{login:true}}}),
      async login(_provider,_kind,io,options){
        options.getDeviceId();
        io.signal.addEventListener("abort",aborted.resolve,{once:true});
        entered.resolve();
        await finishLogin.promise;
        io.signal.throwIfAborted();
      },
    }),
  });
  const started=await c.action("oauth.start",{providerId:"fixture"});
  await entered.promise;
  let closed=false;
  const shutting=c.beginShutdown(),closing=c.close().then(()=>{closed=true;});
  try{
    await aborted.promise;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,false,"a cancellation signal is not a settled login");
    assert.equal(c.shutdownState().settled,false);
    assert.equal((await c.bootstrap()).oauthOperations.find(row=>row.operationId===started.operationId).status,"cancelling");
    finishLogin.resolve();
    await flushing.promise;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,false,"device identity flush belongs to OAuth completion");
    assert.equal(c.shutdownState().settled,false);
  }finally{
    finishLogin.resolve();finishFlush.resolve();
    await closing;
  }
  assert.equal((await shutting).settled,true);
  assert.equal(closed,true);
});

function executionFixtureForShutdown(f,remove){
  const image="sha256:"+"d".repeat(64),commands=[];
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,work:{execution:{
    engine:"docker",network:"none",image,limits:{memoryBytes:33554432,cpus:1,pids:16},
  }}},"Fixture",teamId));
  return {
    commands,
    async inspect(home,options){
      const {inspectGuiExecution}=await load("src/gui-settings.js");
      return inspectGuiExecution(home,{...options,runDocker:async args=>{
        commands.push(args);
        if(args[0]==="context")return JSON.stringify("unix:///fixture/docker.sock");
        switch(args[2]){
          case "version":return "28.0.0";
          case "image":return image;
          case "container":return "exited 0";
          case "rm":return remove(args);
          default:return "";
        }
      }});
    },
  };
}

test("shutdown waits for the Docker probe container and volumes to be removed", async t=>{
  const f=await fixture(t),removing=deferred(),allowRemoval=deferred();
  const execution=executionFixtureForShutdown(f,async()=>{removing.resolve();await allowRemoval.promise;return "";});
  const c=await controllerModule.createGuiController({home:f.home,cwd:f.cwd,executionInspector:execution.inspect});
  const check=c.action("settings.inspectExecution",{probe:true});
  await removing.promise;
  let closed=false;
  const shutting=c.beginShutdown(),closing=c.close().then(()=>{closed=true;});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,false);
    assert.equal(c.shutdownState().settled,false);
  }finally{
    allowRemoval.resolve();
    await closing;
  }
  assert.equal((await check).probe.status,"passed");
  assert.deepEqual(execution.commands.at(-1).slice(2,-1),["rm","--force","--volumes"]);
  assert.equal((await shutting).settled,true);
});

test("unverified probe cleanup blocks shutdown until the same named probe is removed", async t=>{
  const f=await fixture(t);
  let recover=false;
  const execution=executionFixtureForShutdown(f,async()=>{
    if(!recover)throw Object.assign(Error("private Docker diagnostic"),{stderr:"connection unavailable"});
    return "";
  });
  const c=await controllerModule.createGuiController({home:f.home,cwd:f.cwd,executionInspector:execution.inspect});
  try{
    const result=await c.action("settings.inspectExecution",{probe:true});
    assert.equal(result.probe.code,"PROBE_CLEANUP");
    await assert.rejects(c.close(),{code:"SHUTDOWN_UNSETTLED"});
    const state=c.shutdownState();
    assert.equal(state.settled,false);
    assert.match(state.reason,/探针/);
    assert.doesNotMatch(state.reason,/private Docker diagnostic/);
    assert.equal(execution.commands.filter(args=>args[2]==="rm").length,2);
  }finally{
    recover=true;
    await c.close();
  }
  const removals=execution.commands.filter(args=>args[2]==="rm");
  assert.equal(removals.length,3);
  assert.equal(new Set(removals.map(args=>args.at(-1))).size,1);
  assert.deepEqual(removals[0].slice(0,-1),["--host","unix:///fixture/docker.sock","rm","--force","--volumes"]);
  assert.equal(c.shutdownState().settled,true);
});
