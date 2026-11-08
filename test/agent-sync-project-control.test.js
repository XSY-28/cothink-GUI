import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTeamConfig } from "../src/teams.js";
import { readTask, readRequests } from "../src/task.js";
import { saveConfig } from "../src/config.js";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";

const entry =
  process.env.COTHINK_TEST_CLI ??
  fileURLToPath(new URL("../bin/cothink.js", import.meta.url));

async function projectFixture(t) {
  const sent = Promise.withResolvers();
  const f = await fixture(t, () => {
    sent.resolve();
    return null;
  });
  const { project } = repository(t);
  const checks = [
    { command: "node", args: ["-e", "require('fs').accessSync('a.txt')"] },
  ];
  saveConfig(
    f.home,
    createTeamConfig(
      { formatVersion: 2, ...f.models, work: { execution, checks } },
      "fixture",
      randomUUID(),
    ),
  );
  const file = join(f.home, "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      goal: "核对现有文本",
      scope: ["a.txt"],
      budget: { maxCalls: 1 },
      steps: [
        {
          id: "first",
          goal: "确认 a.txt 可以读取",
          deliverables: ["a.txt"],
          checks,
        },
      ],
    }),
  );
  const start = (args, preload) => {
    const child = spawn(
      process.execPath,
      [
        ...(preload ? ["--require", preload] : []),
        entry,
        "project",
        ...args,
        "--json",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          COTHINK_HOME: f.home,
          COTHINK_NO_TTY: "1",
          PI_OFFLINE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = [];
    child.stdout.on("data", (part) => output.push(part));
    child.stderr.on("data", (part) => output.push(part));
    const ended = once(child, "close");
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    return {
      child,
      ended,
      async received() {
        await Promise.race([
          sent.promise,
          ended.then(() => {
            throw Error(Buffer.concat(output).toString());
          }),
        ]);
      },
    };
  };
  const control = async (...args) => {
    const r = await invoke(f, ["project", ...args, "--json"], "", project);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  return { f, file, start, control };
}

test(
  "a second CLI pauses an active project; revised goals and unknown sends survive reopening",
  { timeout: 90000 },
  async (t) => {
    const { f, file, start, control } = await projectFixture(t);
    const live = start(["start", "--file", file]);
    await live.received();
    const running = await control("status");
    const before = running.steps[0].attempts[0];
    assert.equal((await control("pause")).status, "paused");
    await live.ended;
    const revised = await control(
      "revise",
      "--goal",
      "保留已有文本再重新核对",
      "--step",
      "first",
    );
    assert.equal(revised.status, "paused");
    assert.equal(revised.originalGoal, "核对现有文本");
    assert.equal(revised.goal, "保留已有文本再重新核对");
    await invoke(f, ["project", "resume", "--json"], "", running.repo);
    const reopened = await control("status");
    assert.equal(reopened.steps[0].attempts.length, 1);
    assert.equal(
      reopened.steps[0].attempts[0].submissionId,
      before.submissionId,
    );
    assert.equal(f.calls.length, 1);
  },
);

test(
  "killing a project after the HTTP send keeps the same unknown request on resume",
  { timeout: 90000 },
  async (t) => {
    const { f, file, start, control } = await projectFixture(t);
    const live = start(["start", "--file", file]);
    await live.received();
    const first = (await control("status")).steps[0].attempts[0];
    live.child.kill("SIGKILL");
    assert.equal((await live.ended)[1], "SIGKILL");
    const stopped = await control("status");
    await invoke(f, ["project", "resume", "--json"], "", stopped.repo);
    const checked = await control("status");
    assert.equal(
      checked.steps[0].status,
      "unknown",
      JSON.stringify(checked.steps[0]),
    );
    assert.deepEqual(
      checked.steps[0].attempts.map((a) => a.taskId),
      [first.taskId],
    );
    assert.equal(f.calls.length, 1);
  },
);

for (const [label, boundary] of [
  [
    "startup intent",
    "record.steps?.some(s => s.attempts?.some(a => a.taskId && a.submissionId))",
  ],
  [
    "reserved request before transport",
    "record.payload && record.actualModel && !record.transport?.projectDispatched",
  ],
])
  test(
    `killing after ${label} resumes that submission once under a one-call budget`,
    { timeout: 90000 },
    async (t) => {
      const { f, file, start, control } = await projectFixture(t);
      // Inject a crash immediately after the real atomic snapshot has been renamed into place.
      const hook = join(f.home, "kill-before-send.cjs");
      writeFileSync(
        hook,
        `
    const fs = require("node:fs"), rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      const result = rename.apply(this, arguments);
      if (String(to).endsWith(".json")) {
        const record = JSON.parse(fs.readFileSync(to));
        if (${boundary}) process.kill(process.pid, "SIGKILL");
      }
      return result;
    };
    require("node:module").syncBuiltinESMExports();
  `,
      );
      const interrupted = start(["start", "--file", file], hook);
      assert.equal((await interrupted.ended)[1], "SIGKILL");
      const before = (await control("status")).steps[0].attempts[0];
      const prepared = label === "reserved request before transport"
        ? readRequests(f.home, readTask(f.home, before.taskId)).find((r) => r.payload && !r.sent)
        : null;
      if (label === "reserved request before transport") assert.ok(prepared);
      assert.equal(f.calls.length, 0);
      const resumed = start(["resume"]);
      await resumed.received();
      await control("pause");
      await resumed.ended;
      const after = (await control("status")).steps[0].attempts;
      assert.equal(after.length, 1);
      assert.equal(after[0].taskId, before.taskId);
      assert.equal(after[0].submissionId, before.submissionId);
      assert.equal(f.calls.length, 1);
      if (prepared) {
        const sent = readRequests(f.home, readTask(f.home, before.taskId)).filter((r) => r.sent);
        assert.deepEqual(sent.map((r) => r.id), [prepared.id]);
      }
    },
  );

test(
  "a goal change from another CLI cancels affected work without replaying an unknown send",
  { timeout: 90000 },
  async (t) => {
    const { f, file, start, control } = await projectFixture(t);
    const live = start(["start", "--file", file]);
    await live.received();
    const edit = await control(
      "revise",
      "--goal",
      "核对文本并保留已有文件",
      "--step",
      "first",
    );
    assert.equal(edit.goal, "核对文本并保留已有文件");
    assert.equal(edit.revision, 2);
    await live.ended;
    const final = await control("status");
    assert.equal(final.steps[0].attempts.length, 1);
    assert.equal(final.steps[0].status, "unknown");
    assert.equal(f.calls.length, 1);
  },
);

test(
  "explicit projects do not execute configured native extension top-level code before admission",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, () => ({ text: "Checked the existing file." }));
    const { project } = repository(t);
    const marker = join(f.home, "native-ran.txt");
    const extension = join(f.home, "normally-trusted.mjs");
    writeFileSync(
      extension,
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)},"loaded"); export default function() {}`,
    );
    const checks = [
      { command: "node", args: ["-e", "require('fs').accessSync('a.txt')"] },
    ];
    const cfg = createTeamConfig(
      {
        formatVersion: 2,
        ...f.models,
        piResources: { extensions: [extension] },
        work: { execution, checks },
      },
      "fixture",
      randomUUID(),
    );
    saveConfig(f.home, cfg);
    const file = join(f.home, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        goal: "Read a.txt",
        scope: ["a.txt"],
        steps: [
          {
            id: "first",
            goal: "Check a.txt exists",
            deliverables: ["a.txt"],
            checks,
          },
        ],
      }),
    );
    const run = await invoke(
      f,
      ["project", "start", "--file", file, "--json"],
      "",
      project,
    );
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).status, "completed");
    assert.equal(existsSync(marker), false);
    assert.equal(f.calls.length, 1);
    const ordinary = await invoke(
      f,
      ["ask", "--one", "Ordinary answer"],
      "",
      project,
    );
    assert.equal(ordinary.code, 0, ordinary.stderr);
    assert.equal(existsSync(marker), true);
  },
);

test("revision cannot erase an independent work or substitute an easier entry check", async t => {
  const {project} = repository(t);
  const f = await fixture(t);
  const file = join(f.home,"plan.json");
  const check = {command:"node",args:["-e","require('fs').accessSync('a.txt')"]};
  const step = {id:"verify",goal:"Verify the entry",deliverables:["a.txt"],checks:[check],
    works:[{id:"sample",scope:["a.txt"],independentReview:true,effect:{target:"sample",action:"collect",round:1}}]};
  const plan = {goal:"Inspect files",scope:["."],steps:[step],budget:{maxCalls:0}};
  const run = async (action,args,definition) => {
    writeFileSync(file,JSON.stringify(definition));
    return invoke(f,["project",action,...args,"--file",file,"--json"],"",project);
  };
  const started = await run("start",[],plan);
  assert.equal(JSON.parse(started.stdout).steps[0].works[0].effect.round,1);
  for (const edit of [
    s => { s.works[0].independentReview = false; },
    s => { s.works[0].id = "renamed"; },
    s => { s.checks = [{command:"node",args:["--version"]}]; },
    s => { s.deliverables = ["b.txt"]; s.works.push({id:"other",scope:["b.txt"]}); },
    s => { s.works[0].effect.round = 2; },
  ]) {
    const revision = structuredClone(plan);
    edit(revision.steps[0]);
    const r = await run("revise",["--goal",plan.goal,"--step",step.id],revision);
    assert.equal(r.code,2,r.stdout);
    assert.match(r.stderr,/Revision cannot/i);
    assert.equal(f.calls.length,0);
  }
  // A distinct explicitly authorized round can be added, while the original remains bound.
  const next = structuredClone(plan);
  next.steps[0].works.push({id:"repeat",scope:["b.txt"],effect:{target:"sample",action:"collect",round:2}});
  const ok = await run("revise",["--goal",plan.goal,"--step",step.id],next);
  assert.equal(ok.code,0,ok.stderr);
  const state = JSON.parse(ok.stdout);
  assert.equal(state.revision,2);
  assert.deepEqual(state.steps[0].works.map(w => w.effect.round),[1,2]);
  assert.deepEqual(state.revisions[0].previousDefinitions[0].works,step.works);
});
