import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join,resolve } from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(productRoot,path)));
const sdkUrl=pathToFileURL(join(productRoot,"node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const {SessionManager}=await import(sdkUrl);
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
const {saveConfig}=await load("src/config.js");
const {createTeamConfig}=await load("src/teams.js");
const {readTask}=await load("src/task.js");
const teamId = "7c8094cd-3476-4bfa-8f53-055d87972896";
const controllerModule = await load("src/gui-controller.js").catch(
  () => ({}),
);
async function controller(t, f) {
  assert.equal(
    typeof controllerModule.createGuiController,
    "function",
    "GUI controller must exist",
  );
  saveConfig(
    f.home,
    createTeamConfig({ formatVersion: 2, ...f.models }, "Fixture", teamId),
  );
  const c = await controllerModule.createGuiController({
    home: f.home,
    cwd: f.cwd,
  });
  t.after(() => c.close());
  return c;
}
async function finished(c, id) {
  for (let n = 0; n < 500; n++) {
    const task = await c.task(id);
    if (task.status !== "running") return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture task did not settle");
}

test("discussion uses three original calls, deduplicates durable submissions and keeps continuous context", async (t) => {
  const f = await fixture(t, (_, n) => ({ text: `original reply ${n}` })),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });
  const first = await c.action("task.submit", {
    sessionId: s.id,
    input: "first question",
    submissionId: "first",
  });
  const duplicate = await c.action("task.submit", {
    sessionId: s.id,
    input: "first question",
    submissionId: "first",
  });
  assert.equal(duplicate.taskId, first.taskId);
  const task = await finished(c, first.taskId);
  assert.equal(task.status, "completed", task.error);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    task.messages.map((m) => m.text),
    ["original reply 1", "original reply 2", "original reply 3"],
  );
  assert.equal(task.participants.filter((p) => p.participated).length, 2);
  const second = await c.action("task.submit", {
    sessionId: s.id,
    input: "second question",
    submissionId: "second",
  });
  await finished(c, second.taskId);
  assert.equal(f.calls.length, 6);
  assert.match(JSON.stringify(f.calls[3].body.messages), /first question/);
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
        submissionId: "first",
      })
    ).taskId,
    first.taskId,
  );
  assert.equal(f.calls.length, 6);
  assert.equal((await restored.session(s.id)).turns.length, 2);
  assert.equal((await restored.session(s.id)).turns[0].submissionId, "first");
});
test("unbound project neither loads startup AGENTS nor exposes work tools; ONE is durable", async (t) => {
  const f = await fixture(t),
    c = await controller(t, f);
  writeFileSync(join(f.cwd, "AGENTS.md"), "STARTUP_PRIVATE_CANARY");
  const s = await c.action("session.create", { project: null });
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "plain chat",
    submissionId: "plain",
  });
  await finished(c, r.taskId);
  assert.equal(f.calls.length, 1);
  const catalog = await c.bootstrap();
  assert.ok(catalog.models.every((m) => Array.isArray(m.thinkingLevels)));
  assert.doesNotMatch(
    JSON.stringify(f.calls),
    /STARTUP_PRIVATE_CANARY|"name":"start_work"/,
  );
  assert.equal((await c.session(s.id)).mode, "one");
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
    submissionId: "slow",
  });
  assert.equal((await c.task(r.taskId)).status, "running");
  await assert.rejects(
    c.action("task.submit", {
      sessionId: s.id,
      input: "other",
      submissionId: "other",
    }),
    /任务|busy/i,
  );
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
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
      submissionId: "old",
    }),
    /team|Team/,
  );
  await c.action("session.team", { sessionId: s.id, teamId });
  writeFileSync(join(f.home,"gui-workspaces.json"),"corrupt workspace directory");
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "/one continue",
    submissionId: "bound",
  });
  assert.equal((await finished(c, r.taskId)).status, "completed");
});
test("bound project invokes real runWork and fixed version diff, leaves original checkout unchanged", async (t) => {
  const repo = repository(t);
  const f = await fixture(t, (_, n) =>
      n === 1
        ? { toolCalls: [{ name: "start_work", args: { reason: "observe" } }] }
        : { text: "observed" },
    ),
    c = await controller(t, f);
  await c.action("settings.work", { work: { checks: [] } });
  const p = await c.action("project.inspect", { path: repo.project });
  assert.equal(p.valid, true);
  const s = await c.action("session.create", { project: repo.project });
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "observe project",
      submissionId: "project",
    }),
    task = await finished(c, r.taskId);
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

test("failed mode persistence retains prior mode and blocks generation until reopened", async (t) => {
  const { renameSync, rmSync } = await import("node:fs");
  const f = await fixture(t),
    c = await controller(t, f);
  const s = await c.action("session.create", { project: null });
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "initial",
    submissionId: "initial",
  });
  await finished(c, r.taskId);
  const record = readTask(f.home, r.taskId),
    path = record.stages[0].sessionFile;
  renameSync(path, path + ".backup");
  mkdirSync(path);
  try {
    await assert.rejects(
      c.action("session.mode", { sessionId: s.id, mode: "cothink" }),
      /保存失败|不可用/,
    );
    assert.equal((await c.session(s.id)).mode, "one");
    await assert.rejects(
      c.action("task.submit", {
        sessionId: s.id,
        input: "must not send",
        submissionId: "blocked",
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
        reason: "change a source file",
        scope: ["a.txt"],
        readScope: ["a.txt"],
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
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "change source",
      submissionId: "edit",
    }),
    task = await finished(c, r.taskId);
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
      return tool("start_work", { reason: "independent inspection" });
    if (leader === 2)
      return tool("delegate", {
        model: "fixture/r1",
        assignment: "Inspect",
        implementationAdvice: "Read only",
        reason: "independent source inspection",
        scope: [],
        readScope: ["."],
        readOnly: true,
      });
    if (leader === 3) return tool("collect");
    return { text: "Leader deliverable" };
  });
  const c = await controller(t, f);
  await c.action("settings.work", { work: { checks: [] } });
  const s = await c.action("session.create", { project: repo.project });
  const r = await c.action("task.submit", {
      sessionId: s.id,
      input: "inspect with member",
      submissionId: "delegate",
    }),
    task = await finished(c, r.taskId);
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
  await c.action("session.mode", { sessionId: s.id, mode: "one" });
  const r = await c.action("task.submit", {
    sessionId: s.id,
    input: "healthy",
    submissionId: "healthy",
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
    submissionId: "freeze-warm",
  });
  await finished(c, warm.taskId);
  const pending = c.action("task.submit", {
    sessionId: s.id,
    input: "accepted before edits",
    submissionId: "freeze-current",
  });
  const mode = c.action("session.mode", { sessionId: s.id, mode: "one" });
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
    "accepted current task keeps its three-call mode",
  );
  assert.equal(task.team.main.thinkingLevel, "low");
  assert.equal(f.calls.length, 6);
  const next = await c.action("task.submit", {
    sessionId: s.id,
    input: "next snapshot",
    submissionId: "freeze-next",
  });
  const nextTask = await finished(c, next.taskId);
  assert.equal(nextTask.singleModel, true);
  assert.equal(nextTask.team.main.thinkingLevel, "high");
  assert.equal(f.calls.length, 7);
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
    submissionId: "handoff-current",
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
    c.action("session.mode", { sessionId: s.id, mode: "one" }),
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
  assert.equal(f.calls.length, 3);
  const restored = await c.session(s.id);
  assert.equal(restored.mode, "one");
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
    submissionId: "team-warm",
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
        submissionId: "team-overlap",
      }),
      /任务|设置/,
    );
    assert.equal(
      f.calls.length,
      3,
      "selection overlap must not begin generation",
    );
  } finally {
    release.resolve();
    await selecting;
  }
  assert.equal((await c.session(s.id)).team.id, team.id);
  const next = await c.action("task.submit", {
    sessionId: s.id,
    input: "/one after selection",
    submissionId: "team-next",
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
    submissionId: "catalog-warm",
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
      input: "/one after adding provider",
      submissionId: "catalog-next",
    }),
    task = await finished(c, next.taskId);
  assert.equal(task.status, "completed", task.error);
  assert.equal(task.messages.length, 1);
  assert.equal(task.messages[0].model.provider, "added-later");
  assert.equal(task.usage.calls, 1);
  assert.match(
    JSON.stringify(f.calls[3].body.messages),
    /previous context must survive/,
  );
  assert.equal(
    f.calls[3].headers.authorization,
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
 await assert.rejects(c.action('task.submit',{sessionId:s.id,input:'make my HTML',submissionId:'html-no-project',workRequest:{kind:'html-svg'}}),/项目/);
 assert.equal(f.calls.length,0);
 assert.equal((await c.session(s.id)).draft,'make my HTML');
 for (const input of ['/one','/team','/cothink'])
   await assert.rejects(c.action('task.submit',{sessionId:s.id,input,submissionId:'local-with-html-'+input,workRequest:{kind:'html-svg'}}),/请输入问题/);
 assert.equal(f.calls.length,0,'an HTML marker never changes local commands into generation');
});


test("English role prompts follow each frozen turn and stage across mode switches and one-shot overrides", async (t) => {
  let c, sessionId, switchDuringDraft = false;
  const f = await fixture(t, async () => {
    if (switchDuringDraft) {
      switchDuringDraft = false;
      await c.action("session.mode", { sessionId, mode: "one" });
    }
    return { text: "answer" };
  });
  c = await controller(t, f);
  sessionId = (await c.action("session.create", { project: null })).id;
  const submit = async (input, count, expected) => {
    const start = f.calls.length;
    const r = await c.action("task.submit", { sessionId, input, submissionId: String(start) });
    const task = await finished(c, r.taskId);
    assert.equal(task.status, "completed", task.error);
    const calls = f.calls.slice(start);
    assert.equal(calls.length, count);
    const system = call => call.body.messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    assert.match(system(calls[0]), expected);
    if (count === 3) {
      assert.doesNotMatch(system(calls[0]), /ONE single-model mode|CoThink revision stage/);
      assert.match(system(calls[1]), /independent reviewer/);
      assert.doesNotMatch(system(calls[1]), /CoThink initial-answer stage|ONE single-model mode/);
      assert.match(system(calls[2]), /CoThink revision stage/);
      assert.doesNotMatch(system(calls[2]), /CoThink initial-answer stage|ONE single-model mode/);
    } else {
      assert.doesNotMatch(system(calls[0]), /CoThink initial-answer stage|CoThink revision stage/);
      assert.match(system(calls[0]), /complete final answer/);
    }
  };
  await submit("/one temporary", 1, /ONE single-model mode/);
  assert.equal((await c.session(sessionId)).mode, "cothink");
  switchDuringDraft = true;
  await submit("discussion frozen before switch", 3, /CoThink initial-answer stage/);
  await submit("next turn uses one", 1, /ONE single-model mode/);
  await c.action("session.mode", { sessionId, mode: "cothink" });
  await submit("discussion again", 3, /CoThink initial-answer stage/);
});

test("navigation persists across restart, preserves history, rejects stale revision and releases real writer", async t => {
  const {acquireSessionWriter, sessionWriterBusy} = await import("../src/storage.js");
  const f = await fixture(t,(_,n)=>({text:`navigation reply ${n}`}));
  let c = await controller(t,f);
  const s = await c.action("session.create",{project:null});
  const accepted = await c.action("task.submit",{sessionId:s.id,input:"archive searchable input",submissionId:"archive"});
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
  assert.equal((await c.sessions({archived:"archived",query:"reply 3"})).items[0].match.taskId,accepted.taskId);
  await assert.rejects(c.action("task.submit",{sessionId:s.id,input:"blocked",submissionId:"new"}),{code:"SESSION_STATE_UNAVAILABLE"});
  const restored = await c.action("session.archive",{sessionId:s.id,archived:false,expectedRevision:2});
  assert.equal(restored.navigation.pinned,true);
  assert.equal((await c.sessions()).items[0].id,s.id);
  assert.equal((await c.sessions({query:"navigation reply 2"})).items.length,0,"internal review is not searchable");
  assert.equal(f.calls.length,3);
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
  const run = await c.action("task.submit",{sessionId:s.id,input:"busy",submissionId:"busy"});
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
    await c.action("session.mode",{sessionId:s.id,mode:"one"});
    const run=await c.action("task.submit",{sessionId:s.id,input:`query item ${n}`,submissionId:`item${n}`});
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
  const first=await c.action("task.submit",{sessionId:s.id,input:"with conversation override",submissionId:"override-first"});
  assert.equal((await finished(c,first.taskId)).team.main.thinkingLevel,"high");
  await c.action("session.thinking",{sessionId:s.id});
  assert.equal((await c.session(s.id)).thinking,null);
  await c.close();
  const reopened=await controllerModule.createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
  assert.equal((await reopened.session(s.id)).thinking,null,"following Team survives closing and reopening the host");
  const second=await reopened.action("task.submit",{sessionId:s.id,input:"follow selected team",submissionId:"override-second"});
  assert.equal((await finished(reopened,second.taskId)).team.main.thinkingLevel,"low");
  assert.equal((await reopened.task(first.taskId)).team.main.thinkingLevel,"high");
  assert.equal((await reopened.bootstrap()).teams.length,2,"the previous Team remains saved");
  assert.equal(f.calls.length,6,"two ordinary answers still use three calls each");
  assert.deepEqual(f.calls.filter(call=>call.body.model==="main").map(call=>call.body.reasoning_effort),
    ["high","high","low","low"], "the fixture receives the effective thinking level, not only a matching task label");
});

test("native GUI command dialogs, cancellation, unsupported TUI and idle reload are real zero-model operations", async t=>{
  const f=await fixture(t),root=join(f.home,'gui-plugin');mkdirSync(root);
  const extension=join(root,'index.js');
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'gui-native',version:'1.0.0',type:'module',pi:{extensions:['index.js']}}));
  writeFileSync(join(root,'helper.js'),"export const label=await Promise.resolve('VISIBLE_NOTICE');");
  writeFileSync(extension,`import {label} from './helper.js';export default pi=>{
    pi.registerCommand('dialog',{description:'Choose, enter and confirm',handler:async(_args,ctx)=>{
      ctx.ui.notify(label);ctx.ui.setStatus('fixture','PLUGIN_STATUS');
      const selected=await ctx.ui.select('Choose',['A','B']);
      const input=await ctx.ui.input('Enter','value');
      const confirmed=await ctx.ui.confirm('Confirm','Proceed?');
      ctx.ui.notify(JSON.stringify({selected,input,confirmed}));
    }});
    pi.registerCommand('terminal-only',{handler:async(_args,ctx)=>ctx.ui.custom(()=>{throw Error('must not execute TUI factory');})});
    pi.registerCommand('wait-input',{handler:async(_args,ctx)=>{await ctx.ui.input('Waiting');}});
    pi.registerCommand('generate',{handler:async()=>pi.sendUserMessage('Unbound model request')});
  };`);
  const {runPackageCommand}=await load('src/packages.js');assert.equal((await runPackageCommand({home:f.home,cwd:f.cwd,command:'install',source:root})).exitCode,0);
  const c=await controller(t,f),workspaceId=randomUUID();
  await c.action("workspace.create",{workspaceId,name:"Plugin prompts",project:null,defaultRosterId:teamId});
  const s=await c.action('session.create',{sessionId:randomUUID(),workspaceId});
  const attention=async()=> (await c.bootstrap()).workspaces.find(workspace=>workspace.id===workspaceId).attention;
  assert.ok((await c.action('extension.commands',{sessionId:s.id})).some(command=>command.name==='dialog'));
  const prompt=async kind=>{for(let n=0;n<300;n++){const p=(await c.bootstrap()).extensionUI.prompts[0];if(p?.kind===kind)return p;await new Promise(r=>setTimeout(r,5));}throw Error('Missing '+kind+' dialog');};
  const pending=c.action('extension.command',{sessionId:s.id,input:'/dialog'});
  let p=await prompt('select');
  assert.deepEqual(await attention(),{kind:"needs_attention",sessionId:s.id,taskId:null});
  await assert.rejects(c.action("workspace.update",{workspaceId,expectedRevision:0,change:{defaultRosterId:null}}),{code:"WORKSPACE_CONFLICT"});
  await assert.rejects(c.action("workspace.update",{workspaceId,expectedRevision:0,change:{archived:true}}),{code:"WORKSPACE_CONFLICT"});
  await assert.rejects(c.action('extension.respond',{sessionId:'other',promptId:p.id,value:'B'}));
  await c.action('extension.respond',{sessionId:s.id,promptId:p.id,value:'B'});
  p=await prompt('input');await c.action('extension.respond',{sessionId:s.id,promptId:p.id,value:'<script>literal</script>'});
  p=await prompt('confirm');await c.action('extension.respond',{sessionId:s.id,promptId:p.id,value:true});await pending;
  assert.equal(await attention(),null);
  const ui=(await c.bootstrap()).extensionUI;assert.ok(ui.notifications.some(n=>n.message==='VISIBLE_NOTICE'));assert.ok(ui.notifications.some(n=>n.message.includes('"selected":"B"')&&n.message.includes('"confirmed":true')));assert.equal(ui.statuses[0].text,'PLUGIN_STATUS');
  await assert.rejects(c.action('extension.command',{sessionId:s.id,input:'/terminal-only'}),error=>error.code==='EXTENSION_UI_UNSUPPORTED'&&/custom.*terminal/.test(error.message));
  await c.action('extension.reload',{sessionId:s.id});
  await assert.rejects(c.action('extension.command',{sessionId:s.id,input:'/generate'}),{code:'UNADAPTED_PLUGIN'});assert.equal(f.calls.length,0);
  writeFileSync(join(root,'helper.js'),"export const label=await Promise.resolve('FRESH_HELPER');");
  globalThis.__stage3SharedSessionManager=SessionManager;t.after(()=>{delete globalThis.__stage3SharedSessionManager;});
  writeFileSync(extension,`import {label} from './helper.js';import {SessionManager} from '@earendil-works/pi-coding-agent';export default pi=>pi.registerCommand('fresh',{handler:async(_args,ctx)=>{pi.registerCommand('late',{handler:async(_a,c)=>c.ui.notify('LATE_COMMAND')});ctx.ui.notify(label);ctx.ui.notify('SHARED_IDENTITY:'+String(SessionManager===globalThis.__stage3SharedSessionManager));}});`);
  await c.action('extension.reload',{sessionId:s.id});
  let commands=await c.action('extension.commands',{sessionId:s.id});assert.ok(commands.some(command=>command.name==='fresh'),JSON.stringify(commands));assert.ok(!commands.some(command=>command.name==='dialog'));assert.equal((await c.bootstrap()).extensionUI.statuses.length,0);
  await c.action('extension.command',{sessionId:s.id,input:'/fresh'});assert.ok((await c.bootstrap()).extensionUI.notifications.some(n=>n.message==='FRESH_HELPER'));assert.ok((await c.bootstrap()).extensionUI.notifications.some(n=>n.message==='SHARED_IDENTITY:true'));commands=await c.action('extension.commands',{sessionId:s.id});assert.ok(commands.some(command=>command.name==='late'));await c.action('extension.command',{sessionId:s.id,input:'/late'});
  assert.equal(f.calls.length,0);
  writeFileSync(extension,'export default (');await assert.rejects(c.action('extension.reload',{sessionId:s.id}));
  const blocked=await c.action('task.submit',{sessionId:s.id,input:'must not generate after failed reload',submissionId:'failed-reload'});
  const failed=await finished(c,blocked.taskId);assert.notEqual(failed.status,'completed');assert.equal(f.calls.length,0);
  writeFileSync(extension,'export default pi=>pi.registerCommand("wait",{handler:async(_a,ctx)=>{await ctx.ui.input("Waiting");}});');
  await c.action('extension.reload',{sessionId:s.id});const waiting=c.action('extension.command',{sessionId:s.id,input:'/wait'});await prompt('input');await c.close();await waiting;assert.equal(f.calls.length,0);
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
  assert.deepEqual(saved.editor,{text:"未发送",workRequest:{kind:"html-svg"},selectionId,editId});
  await assert.rejects(c.action("session.draft",{sessionId:id,text:"old request"}),{code:"DRAFT_CONFLICT"});
  await assert.rejects(c.action("session.draft",{...args,editId:randomUUID(),text:"stale"}),{code:"DRAFT_CONFLICT"});
  await assert.rejects(c.action("session.create",{sessionId:id,workspaceId:null}),{code:"SESSION_STATE_CONFLICT"});
  await c.close();
  const reopened=await controllerModule.createGuiController({home:f.home,cwd:f.cwd}); t.after(()=>reopened.close());
  const restored=await reopened.session(id);
  assert.deepEqual(restored.editor,saved.editor); assert.equal(restored.draftRevision,saved.draftRevision);
  assert.equal((await reopened.sessions()).items.some(s=>s.id===id),true); assert.equal(f.calls.length,0);
  await reopened.action("session.mode",{sessionId:id,mode:"one"});
  const task=await reopened.action("task.submit",{sessionId:id,input:"first real message",submissionId:"durable-first"});
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

test("legacy project creation chooses a roster only for a genuinely new workspace",async t=>{
  const {repository}=await import("./helpers/git-fixture.js");
  const f=await fixture(t),c=await controller(t,f),project=repository(t).project;
  const first=await c.action("session.create",{project}); assert.equal(first.team.id,teamId);
  const w=(await c.bootstrap()).workspaces.find(w=>w.id===first.workspaceId);
  await c.action("workspace.update",{workspaceId:w.id,expectedRevision:w.revision,change:{defaultRosterId:null}});
  const existing=await c.action("session.create",{project}); assert.equal(existing.team,null);
  const modern=await c.action("session.create",{sessionId:randomUUID(),workspaceId:w.id}); assert.equal(modern.team,null);
  assert.equal(f.calls.length,0);
});

test("GUI publication survives optional view initialization failure and retries the empty baseline",async t=>{
  const {rmSync,readdirSync}=await import("node:fs"); const f=await fixture(t),c=await controller(t,f);
  writeFileSync(join(f.home,"gui-ui"),"blocked UI lock directory");
  const s=await c.action("session.create",{sessionId:randomUUID(),workspaceId:null});
  assert.equal(s.persisted,true); assert.match(s.viewError,/阅读状态/); assert.deepEqual(s.view.seenResults,{});
  await c.action("session.mode",{sessionId:s.id,mode:"one"});
  const task=await c.action("task.submit",{sessionId:s.id,input:"view save is optional",submissionId:"view-optional"});
  await finished(c,task.taskId);
  rmSync(join(f.home,"gui-ui"));
  const restored=await c.session(s.id); assert.equal(restored.viewError,null); assert.deepEqual(restored.view.seenResults,{});
  assert.equal(f.calls.length,1); assert.ok(readdirSync(join(f.home,"session-ui")).includes(s.id+".json"));
});

test("external damaged GUI association keeps readable turns but blocks writes for a cached session",async t=>{
  const {readdirSync}=await import("node:fs"); const f=await fixture(t),c=await controller(t,f);
  const s=await c.action("session.create",{sessionId:randomUUID(),workspaceId:null});
  await c.action("session.mode",{sessionId:s.id,mode:"one"});
  await finished(c,(await c.action("task.submit",{sessionId:s.id,input:"readable history",submissionId:"association"})).taskId);
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
  await c.action("session.mode",{sessionId:s.id,mode:"one"});
  const accepted = await c.action("task.submit",{sessionId:s.id,input:"Review",submissionId:"review"});
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
  await c.action("session.mode",{sessionId,mode:"one"});
  const submitted={sessionId,input:"Before archive",submissionId:"existing"};
  const {taskId}=await c.action("task.submit",submitted);
  await finished(c,taskId);
  const before=await c.session(sessionId);
  const mutations = [
    ["session.name",{title:"Late rename"}],
    ["session.mode",{mode:"cothink"}],
    ["session.team",{teamId}],
    ["session.thinking",{level:"high"}],
    ["session.draft",{text:"Late draft",expectedDraftRevision:before.draftRevision,branchAnchor:before.branchAnchor,
      editId:randomUUID(),workRequest:null,selectionId:null}],
    ["session.fork",{taskId}],
    ["extension.commands",{}],
    ["extension.command",{input:"/help"}],
    ["extension.reload",{}],
    ["task.submit",{input:"Late task",submissionId:"new"}],
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
  await assert.rejects(c.action("task.submit",{sessionId,input:"Blocked before generation",submissionId:"blocked"}),
    {code:"SESSION_STATE_UNAVAILABLE"});
  assert.deepEqual((await workspace()).attention,{kind:"needs_attention",sessionId,taskId:null});
  assert.equal(readFileSync(path,"utf8"),corrupt);
  writeFileSync(path,original);
  const repaired = await workspace();
  assert.equal(repaired.attention,null);
  assert.equal(repaired.recentSessionId,sessionId);
  assert.equal(f.calls.length,0);
});
