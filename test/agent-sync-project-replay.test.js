import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { saveConfig } from "../src/config.js";
import { createTask } from "../src/task.js";
import { createRequestPolicy } from "../src/request-policy.js";
import { createProjectPolicy } from "../src/project-policy.js";
import { createProjectStaff } from "../src/project-staff.js";
import { workModelIdentity } from "../src/workers.js";
import { fixture } from "./helpers/pi-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, JSON.stringify(value));
const tool = (name, args) => ({ toolCalls: [{ name, args }] });
const check = (file, id) => ({
  command: "node", args: ["-e", "require('fs').accessSync(process.argv[1])", file, "entry-" + id],
});
function step(id, file, extra = {}) {
  return { id, goal: "Inspect " + id, scope: [file], deliverables: [file], checks: [check(file, id)], ...extra };
}
async function projectFixture(t, steps, handler) {
  const f = await fixture(t, handler);
  const repo = repository(t);
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution } });
  const file = join(f.home, "plan.json");
  save(file, { goal: "Collect evidence for each selected input.", scope: ["."], steps, budget: { maxCalls: 30 } });
  const command = async (...args) => {
    const result = await invoke(f, ["project", ...args, "--json"], "", repo.project);
    assert.ok(result.stdout.trim(), result.stderr);
    return JSON.parse(result.stdout);
  };
  return { f, repo, file, command };
}

for (const disconnect of [false, true]) test(disconnect
  ? "after the provider receives generation and the project process dies, a renamed consumer cannot resend it"
  : "two project jobs consume one generated sample, and an expressly approved second round reaches the provider again",
{ timeout: 90000 }, async (t) => {
  const jobs = [
    { id: "producer", file: "a.txt", model: "r1", round: 1 },
    { id: "report", file: "b.txt", model: "r2", round: 1 },
    { id: "repeat", file: ".gitignore", model: "r3", round: 2 },
  ];
  const steps = jobs.map(({ id, file, round }) => step(id, file, {
    works: [{ id, scope: [file], effect: { target: "frozen-specimen", action: "generate", round } }],
  }));
  const executions = [];
  const leaderTurns = new Map();
  let child;
  const workerInputs = [];
  const { f, repo, command, file } = await projectFixture(t, steps, ({ body }, _number, _req, res) => {
    const prompt = JSON.stringify(body.messages);
    if (body.model !== "main") {
      if (prompt.includes("explicitly authorized generation") && !body.tools?.length) {
        executions.push(body.model);
        if (disconnect && body.model === "r1" && executions.length === 1) {
          child.kill("SIGKILL");
          res.destroy();
          return null;
        }
        return { text: "Received specimen " + body.model };
      }
      if (body.tools?.some((def) => def.function.name === "report_task_conflict")) {
        workerInputs.push({ model: body.model, prompt });
        // Without a shared specimen, an employee asked to generate would do it here.
        if (!prompt.includes("Received specimen ")) {
          executions.push(body.model);
          return { text: "Received specimen " + body.model };
        }
      }
      return { text: "I inspected the selected input." };
    }
    const job = jobs.find((j) => prompt.includes("entry-" + j.id));
    if (!job) throw Error("Missing frozen entry check in leader prompt");
    const turn = (leaderTurns.get(job.id) ?? 0) + 1;
    leaderTurns.set(job.id, turn);
    const model = "fixture/" + job.model;
    if (turn === 1) return tool("project_staff", {
      action: "appoint", input: {
        id: job.id, responsibility: job.id, scope: [job.file], readScope: [job.file],
        models: [model], need: "deliverable", reason: "Separate input ownership",
      },
    });
    if (turn === 2) return tool("delegate", {
      staffId: job.id, workId: job.id, model, assignment: job.id, reason: "Owns this input",
      scope: [job.file], readScope: [job.file],
    });
    if (turn === 3) return tool("collect", {});
    return { text: "Inspected this input." };
  });
  let state;
  if (disconnect) {
    const entry = process.env.COTHINK_TEST_CLI ?? fileURLToPath(new URL("../bin/cothink.js", import.meta.url));
    child = spawn(process.execPath, [entry, "project", "start", "--file", file, "--json"], {
      cwd: repo.project, env: { ...process.env, COTHINK_HOME: f.home, PI_OFFLINE: "1", COTHINK_NO_TTY: "1" },
      stdio: "ignore",
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    assert.equal((await once(child, "exit"))[1], "SIGKILL");
    const interrupted = await command("status");
    const original = interrupted.callIntents.find((c) => c.effect?.round === 1);
    assert.ok(original, "the provider received an already recorded effect intent");
    await command("revise", "--goal", "Produce a differently named lab report and second round.", "--step", "report");
    state = await command("resume");
    assert.equal(state.steps[0].status, "unknown", state.blocker);
    assert.notEqual(state.steps[1].status, "completed", "the report cannot consume an unknown specimen");
    assert.equal(state.steps[2].status, "completed", state.blocker);
    assert.equal(state.callIntents.filter((c) => c.effect?.round === 1).length, 1);
    assert.equal(state.usage.actualCost, null);
    const shown = await invoke(f, ["show", original.taskId, "--json"], "", repo.project);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, new RegExp(original.id));
  } else {
    state = await command("start", "--file", file);
    assert.deepEqual(executions, ["r1", "r3"], "only the producer and approved additional round may generate");
    assert.equal(state.status, "completed", state.blocker);
    assert.match(workerInputs.find((item) => item.model === "r2")?.prompt ?? "", /Received specimen r1/);
    const producer = state.effectReads.find((r) => r.workId === "producer");
    const report = state.effectReads.find((r) => r.workId === "report");
    assert.equal(report.requestId, producer.requestId, "reader consumes the precise generator receipt");
    assert.equal(Object.values(state.staffAssignments).length, 3);
  }
  assert.deepEqual(executions, ["r1", "r3"]);
});

test("reopening with a different model and title preserves an ambiguous legacy send, but allows disjoint work", { timeout: 90000 }, async (t) => {
  const arrived = Promise.withResolvers();
  const { f, repo, file, command } = await projectFixture(t, [
    step("original", "a.txt"), step("overlap", "a.txt"), step("separate", "b.txt"),
  ], ({ body }) => {
    if (body.model === "main") { arrived.resolve(); return null; }
    return { text: "Checked the existing input." };
  });
  const run = command("start", "--file", file);
  await Promise.race([arrived.promise, run.then((state) => { throw Error(JSON.stringify(state)); })]);
  await command("pause");
  const stopped = await run;
  const path = join(f.home, "project-delivery", stopped.id, "state.json");
  const history = json(path);
  const origin = history.callIntents[0];
  assert.equal(f.calls.length, 1);
  // Retain only fields persisted by the previous project format. The physical
  // request and its task journal stay on disk so recovery can inspect both.
  history.callIntents = [{ id: origin.id, taskId: origin.taskId, role: origin.role, identity: origin.identity, at: origin.at }];
  for (const s of history.steps) delete s.works;
  const requestPath = join(f.home, "requests", origin.id + ".json");
  const request = json(requestPath);
  delete request.projectSend;
  save(requestPath, request);
  const taskPath = join(f.home, "tasks", origin.taskId + ".json");
  const legacyTask = json(taskPath);
  delete legacyTask.project.works;
  save(taskPath, legacyTask);
  save(path, history);
  saveConfig(f.home, {
    formatVersion: 2, main: f.models.secondary[0], secondary: [f.models.main], work: { execution },
  });
  await command("revise", "--step", "overlap", "--goal", "Inspect the renamed report and separate input.");
  const restored = await command("resume");
  const received = f.calls.map(({ body }) => JSON.stringify(body.messages));
  assert.equal(received.filter((msg) => msg.includes("entry-overlap")).length, 0, "overlap was physically resent");
  assert.equal(received.filter((msg) => msg.includes("entry-separate")).length, 1, "unrelated work should still send");
  assert.equal(restored.steps[0].status, "unknown");
  assert.equal(restored.steps[2].status, "completed", restored.blocker);
  assert.equal(restored.usage.actualCost, null);
  const shown = await invoke(f, ["show", origin.taskId, "--all"], "", repo.project);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(origin.id));
  assert.equal(f.calls.length, 2);
});

test("two concurrent Pi calls can both prepare for the final budget slot, but exactly one reaches localhost", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const taskId = randomUUID();
  const works = ["a", "b"].map((id) => ({ id, scope: [id + ".txt"] }));
  const file = join(f.home, "budget.json");
  const step = { id: "build", scope: ["."], works, revision: 1, status: "running", attempts: [{ taskId }] };
  save(file, { id: "p", status: "active", staff: [], scope: ["."], budget: { maxCalls: 1 }, steps: [step] });
  const host = {
    home: f.home, assertOwned() {}, read: () => json(file),
    update(fn) { const state = json(file); const result = fn(state); save(file, state); return result; },
  };
  const barrier = Promise.withResolvers();
  let preflights = 0;
  const model = {
    provider: "fixture", id: "main", api: "openai-completions", baseUrl: f.endpoint, reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096,
  };
  const staff = createProjectStaff(host);
  const binding = { projectId: "p", stepId: step.id, revision: 1, taskId };
  const task = createTask({
    home: f.home, id: taskId, input: "Check two inputs", models: f.models, project: binding,
    projectPolicy: createProjectPolicy({ home: f.home, host, binding, staff }),
  });
  const members = works.map(({ id, scope }) => {
    staff.change("appoint", { id, responsibility: id, scope });
    const grant = staff.begin({
      staffId: id, workId: id, taskId, scope, readScope: scope,
      assignment: "Check " + id, actor: "root", actorRole: "main",
      model: "fixture/main", identity: workModelIdentity(f.models.main),
    });
    return { memberId: grant.dispatchId, role: grant.role, workId: id, feedback: [] };
  });
  task.record.members = members;
  const denied = [];
  const results = await Promise.all(members.map(async (member) => {
    const stage = task.beginPhase("worker", member.role, f.models.main);
    stage.sessionId = randomUUID();
    const sessionBinding = { task, stage };
    const policy = createRequestPolicy({ getBinding: () => sessionBinding });
    const result = policy.stream(model, { messages: [{ role: "user", content: member.workId, timestamp: Date.now() }] },
      { apiKey: "fixture-secret" }, (m, ctx, opts) => streamSimple(m, ctx, {
        ...opts,
        async onPayload(payload, actual) {
          const prepared = await opts.onPayload(payload, actual);
          if (++preflights === members.length) barrier.resolve();
          await barrier.promise;
          return prepared;
        },
      }));
    const response = await result.result();
    if (response.stopReason === "error") denied.push(sessionBinding.error?.message ?? response.errorMessage);
    return response;
  }));
  assert.equal(preflights, 2);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(results.map((r) => r.stopReason).sort(), ["error", "stop"]);
  assert.match(denied[0], /budget/i);
});
