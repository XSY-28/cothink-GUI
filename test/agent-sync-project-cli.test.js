import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fixture } from "./helpers/pi-fixture.js";
import { git, repository } from "./helpers/git-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { saveConfig } from "../src/config.js";
import { listTasks } from "../src/task.js";

const cases = [
  {
    name: "pelican",
    goal: "Repair the pelican flight coordinate script, then produce and verify its replay frames.",
    entry: "flight.cjs",
    artifact: "frames.json",
    old: "x % width",
    fix: "((x % width) + width) % width",
    source: `const {width, positions} = require('./input.json');
process.stdout.write(JSON.stringify(positions.map(x => x % width)));\n`,
    input: { width: 10, positions: [3, 10, -1, 24] },
    expected: [3, 0, 9, 4],
    symptom: "west edge frame is outside canvas",
  },
  {
    name: "legacy",
    goal: "Repair the export of saved version-one records, then export and reopen the result.",
    entry: "export.cjs",
    artifact: "export.json",
    old: "const defaultMode = 'numeric'",
    fix: "const defaultMode = 'preserve'",
    guide: [
      "Default export converts IDs to numbers.",
      "Default export preserves ID strings.",
    ],
    source: `const legacy = require('./input.json');
const defaultMode = 'numeric';
const mode = process.argv.includes('--numeric') ? 'numeric' : defaultMode;
process.stdout.write(JSON.stringify(legacy.rows.map(([id,title]) => ({id:mode === 'numeric' ? Number(id) : id, title}))));\n`,
    input: {
      version: 1,
      rows: [
        ["0007", "图书"],
        ["21", "a,b"],
      ],
    },
    expected: [
      { id: "0007", title: "图书" },
      { id: "21", title: "a,b" },
    ],
    symptom: "reopened export changed an identifier",
  },
];
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
const check = (args) => ({ command: "node", args: ["verify.cjs", ...args] });

function seed(t, c) {
  const r = repository(t);
  const verifier = `const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const expected = ${JSON.stringify(c.expected)};
const chosen = process.argv[2] === '--current' ? (require('node:fs').existsSync(${JSON.stringify(c.artifact)}) ? ${JSON.stringify(c.artifact)} : null) : process.argv[2];
const source = chosen ? readFileSync(chosen, 'utf8')
  : execFileSync(process.execPath, [${JSON.stringify(c.entry)}], {encoding: 'utf8'});
const actual = JSON.parse(source);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error(${JSON.stringify(c.symptom)}, {expected, actual});
  process.exitCode = 1;
}
${
  c.guide
    ? `if (!process.exitCode) {
  const guide = readFileSync('README.md', 'utf8');
  if (!guide.includes(${JSON.stringify(c.guide[1])}) || !guide.includes('"id":"0007"') || !guide.includes('--numeric')) throw Error('Export guide/default/example disagree');
  const override = JSON.parse(execFileSync(process.execPath, ['export.cjs', '--numeric'], {encoding:'utf8'}));
  if (override[0].id !== 7) throw Error('Explicit numeric conversion changed');
}`
    : ""
}\n`;
  const guideBefore = c.guide
    ? c.guide[0] +
      '\nExample output: [{"id":7,"title":"图书"}]\nUse --numeric to convert legacy IDs.\n'
    : null;
  const files = {
    [c.entry]: c.source,
    "input.json": JSON.stringify(c.input),
    "verify.cjs": verifier,
  };
  if (guideBefore) files["README.md"] = guideBefore;
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(r.project, path), content);
  const changes = git(r.project, "status", "--porcelain");
  for (const path of Object.keys(files)) assert.ok(changes.includes(path));
  git(r.project, "add", "--", ...Object.keys(files));
  git(r.project, "commit", "-m", "Seed the user entry and regression data");
  const initial = spawnSync(process.execPath, ["verify.cjs"], {
    cwd: r.project,
    encoding: "utf8",
  });
  assert.equal(initial.status, 1);
  assert.ok(initial.stderr.includes(c.symptom));
  return { ...r, baseVersion: git(r.project, "rev-parse", "HEAD") };
}

function plan(c) {
  return {
    goal: c.goal,
    budget: { maxCalls: 28 },
    scope: [c.entry, c.artifact, ...(c.guide ? ["README.md"] : [])],
    steps: [
      {
        id: "repair",
        scope: [c.entry, ...(c.guide ? ["README.md"] : [])],
        goal: `Repair ${c.entry}. Run node verify.cjs and repair the diagnosed problem.`,
        deliverables: [c.entry, ...(c.guide ? ["README.md"] : [])],
        checks: [check([])],
      },
      {
        id: "export",
        scope: [c.artifact],
        goal: `Run the repaired ${c.entry}, save its output in ${c.artifact} and validate by reopening it.`,
        dependsOn: ["repair"],
        deliverables: [c.artifact],
        checks: [check([c.artifact])],
      },
    ],
  };
}

// Both arms use this same bounded responder. The injected symptom is absent from the
// prompts. It will propose a fix only after the executable verifier actually emits it.
async function responder(t, c, singleTurn) {
  let phase = 0,
    action = null,
    sawFault = false;
  const errors = [];
  const f = await fixture(t, ({ body }, n) => {
    try {
      assert.ok(n <= 28, "fixture exceeded the identical request budget");
      const tools = body.tools?.map((x) => x.function.name) ?? [];
      const target = phase === 0 ? c.entry : c.artifact;
      if (tools.includes("start_work"))
        return tool("start_work", {
          reason: "Execute the assigned step",
          scope: phase === 0 && c.guide ? [target, "README.md"] : [target],
          readScope: ["."],
        });
      const last =
        body.messages.findLast((m) => m.role === "tool")?.content ?? "";
      if (
        !action &&
        !last &&
        JSON.stringify(body.messages).includes("readOnly=true")
      ) {
        action = "acquire";
        return tool("next_change", {
          reason: "Run the user entry and produce the assigned deliverable",
          scope: phase === 0 && c.guide ? [target, "README.md"] : [target],
          readScope: ["."],
        });
      }
      if (!action || action === "acquire") {
        action = "read";
        return tool("read", { path: c.entry });
      }
      switch (action) {
        case "read":
          assert.ok(last.includes(phase === 0 ? c.old : c.fix), last);
          action = "execute";
          return tool("bash", {
            command:
              phase === 0
                ? "node verify.cjs"
                : `node ${c.entry} > ${c.artifact}`,
          });
        case "execute":
          if (phase === 0) {
            assert.ok(last.includes(c.symptom), last);
            sawFault = true;
            action = "edit";
            return tool("edit", {
              path: c.entry,
              edits: [{ oldText: c.old, newText: c.fix }],
            });
          }
          assert.ok(last.includes("exitCode=0"), last);
          action = "reread";
          return tool("read", { path: c.artifact });
        case "reread":
          assert.ok(last.includes(JSON.stringify(c.expected)), last);
          break;
        case "accept":
          if (last.includes("review_required")) return tool("accept_change");
          assert.equal(JSON.parse(last).status, "accepted", last);
          phase++;
          action = null;
          if (singleTurn && phase === 1) {
            return tool("next_change", {
              reason: "Build the requested export from the integrated script",
              scope: [c.artifact],
              readScope: ["."],
            });
          }
          return { text: "The checked artifact is available." };
        case "edit":
          if (c.guide) {
            action = "guide";
            return tool("read", { path: "README.md" });
          }
          break;
        case "guide":
          assert.ok(last.includes(c.guide[0]), last);
          action = "guide edited";
          return tool("edit", {
            path: "README.md",
            edits: [
              { oldText: c.guide[0], newText: c.guide[1] },
              { oldText: '"id":7', newText: '"id":"0007"' },
            ],
          });
        case "guide edited":
          break;
        default:
          throw Error("Unexpected action");
      }
      action = "accept";
      return tool("accept_change");
    } catch (error) {
      errors.push(error.message);
      return { text: "Fixture stopped after an unexpected response." };
    }
  });
  return { f, errors, metrics: () => ({ sawFault, phases: phase }) };
}

async function comparison(t, c, r, arm) {
  const cwd = join(r.root, "run-" + arm);
  cpSync(r.project, cwd, { recursive: true });
  const singleTurn = arm === "ordinary-single-turn";
  const { f, errors, metrics } = await responder(t, c, singleTurn);
  const p = plan(c);
  const setup = (checks) =>
    saveConfig(f.home, {
      formatVersion: 2,
      ...f.models,
      work: { execution, checks },
    });
  const started = performance.now();
  let manualContinuations = 0;
  let ended, projectState;
  if (singleTurn) {
    setup([check(["--current"])]);
    const run = await invoke(
      f,
      ["ask", "--json", p.goal + "\n" + p.steps.map((s) => s.goal).join("\n")],
      "",
      cwd,
    );
    assert.deepEqual(errors, []);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal(JSON.parse(run.stdout).task.status, "completed", run.stdout);
  } else if (arm === "ordinary") {
    for (const [index, s] of p.steps.entries()) {
      if (index) manualContinuations++;
      setup(s.checks);
      const run = await invoke(
        f,
        ["ask", "--json", p.goal + "\nCurrent step: " + s.goal],
        "",
        cwd,
      );
      assert.deepEqual(errors, []);
      assert.equal(run.code, 0, run.stderr + run.stdout);
      assert.equal(JSON.parse(run.stdout).task.status, "completed", run.stdout);
    }
  } else {
    setup([]);
    const file = join(r.root, arm + ".json");
    writeFileSync(file, JSON.stringify(p));
    const run = await invoke(
      f,
      ["project", "start", "--file", file, "--json"],
      "",
      cwd,
    );
    assert.deepEqual(errors, []);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    const state = JSON.parse(run.stdout);
    projectState = state;
    assert.equal(state.status, "completed", JSON.stringify(state));
    assert.equal(state.next, null);
    assert.ok(
      state.steps.every(
        (step) => step.status === "completed" && step.attempts.length === 1,
      ),
    );
    ended = performance.now();
    const before = f.calls.length;
    const viewed = await invoke(f, ["project", "status", "--json"], "", cwd);
    assert.equal(viewed.code, 0, viewed.stderr);
    assert.equal(JSON.parse(viewed.stdout).version, state.version);
    assert.equal(f.calls.length, before, "view generated a model request");
  }
  const elapsedMs = Math.round((ended ?? performance.now()) - started);
  assert.deepEqual(metrics(), { sawFault: true, phases: 2 });
  const tasks = listTasks(f.home).reverse();
  assert.equal(tasks.length, singleTurn ? 1 : 2);
  const first = tasks[0].work,
    last = tasks.at(-1).work;
  const accepted = tasks.flatMap((t) =>
    t.work.acceptance.filter((a) => a.status === "accepted"),
  );
  assert.equal(accepted.length, 2);
  const repairVersion = accepted[0].acceptedVersion;
  if (projectState) {
    for (const [i, step] of projectState.steps.entries()) {
      const attempt = step.attempts[0],
        task = tasks[i];
      assert.equal(attempt.taskId, task.id);
      assert.equal(attempt.submissionId, task.submissionId);
      assert.equal(attempt.startVersion, task.work.startVersion);
      assert.equal(attempt.version, task.work.version);
      assert.deepEqual(
        attempt.artifacts.map((a) => a.path),
        step.deliverables,
      );
      for (const a of attempt.artifacts)
        assert.match(a.sha256, /^[a-f0-9]{64}$/);
    }
  }
  assert.equal(accepted[1].acceptedVersion, last.version);
  assert.equal(first.startVersion, r.baseVersion);
  if (singleTurn) {
    assert.ok(
      last.changes.some(
        (change) =>
          change.baseVersion === repairVersion &&
          change.scope.includes(c.artifact),
      ),
    );
  } else {
    assert.equal(first.version, repairVersion);
    assert.equal(last.startVersion, repairVersion);
  }
  assert.notEqual(last.version, repairVersion);
  assert.deepEqual(
    git(cwd, "diff", "--name-only", r.baseVersion, repairVersion)
      .split("\n")
      .sort(),
    (c.guide ? [c.entry, "README.md"] : [c.entry]).sort(),
  );
  assert.equal(
    git(cwd, "diff", "--name-only", repairVersion, last.version),
    c.artifact,
  );
  assert.equal(git(cwd, "rev-parse", "HEAD"), r.baseVersion);
  for (const w of [first, last])
    assert.equal(w.finalCheck.verification, "passed");
  const contents = git(cwd, "show", last.version + ":" + c.artifact);
  assert.deepEqual(JSON.parse(contents), c.expected);
  execFileSync(process.execPath, ["verify.cjs", c.artifact], {
    cwd: last.resultWorkspace,
  });
  const usage = tasks.reduce(
    (totals, t) => {
      totals.input += t.usage.known.input;
      totals.output += t.usage.known.output;
      totals.unknown += t.usage.unknownCalls;
      return totals;
    },
    { input: 0, output: 0, unknown: 0 },
  );
  // "Wasted actions" here counts unneeded mutations between the observed counterexample
  // and the first accepted repair. The wire and task logs remain available for audit.
  const operations = tasks[0].tools.filter(
    (t) => t.changeId === accepted[0].changeId,
  );
  const faultIndex = operations.findIndex((t) => t.name === "bash");
  assert.ok(faultIndex >= 0);
  const remainingEdits = new Set(c.guide ? [c.entry, "README.md"] : [c.entry]);
  const invalidAfterFailure = operations.slice(faultIndex + 1).filter((t) => {
    if (!["edit", "write", "bash"].includes(t.name)) return false;
    return t.status !== "completed" || !remainingEdits.delete(t.sourcePath);
  }).length;
  assert.equal(remainingEdits.size, 0);
  assert.equal(invalidAfterFailure, 0);
  const prematureStops = tasks.filter(
    (task) => task.status !== "completed",
  ).length;
  const summary = {
    case: c.name,
    arm,
    versions: [r.baseVersion, repairVersion, last.version],
    requests: f.calls.length,
    manualContinuations,
    invalidAfterFailure,
    prematureStops,
    elapsedMs,
    fixtureUsage: usage,
    paidRequests: 0,
    actualCost: null,
  };
  if (process.env.COTHINK_TEST_EVIDENCE_DIR) {
    const output = resolve(
      process.env.COTHINK_TEST_EVIDENCE_DIR,
      "project-comparison",
      c.name,
      arm,
    );
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(output);
    // --all contains the formal accepted ref and the unchanged input HEAD.
    assert.equal(git(cwd, "status", "--porcelain"), "");
    const bundle = join(output, "versions.bundle");
    git(cwd, "bundle", "create", bundle, "--all");
    assert.ok(git(cwd, "bundle", "list-heads", bundle).includes(last.version));
    if (projectState)
      writeFileSync(
        join(output, "project.json"),
        JSON.stringify(projectState, null, 2) + "\n",
      );
    writeFileSync(
      join(output, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    writeFileSync(
      join(output, "tasks.json"),
      JSON.stringify(tasks, null, 2) + "\n",
    );
    writeFileSync(
      join(output, "wire.json"),
      JSON.stringify(
        f.calls.map((x) => x.body),
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(output, c.artifact), contents + "\n");
  }
  t.diagnostic(JSON.stringify(summary));
  return contents;
}

for (const c of cases) {
  test(`project and ordinary CLI from identical ${c.name} source both deliver and reopen the checked version`, async (t) => {
    const r = seed(t, c);
    const ordinary = await comparison(t, c, r, "ordinary");
    const single = await comparison(t, c, r, "ordinary-single-turn");
    assert.equal(single, ordinary);
    const project = await comparison(t, c, r, "project");
    assert.equal(project, ordinary);
  });
}

async function runRoleProject(f, repo, plan) {
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution } });
  const file = join(repo.root, "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  const run = await invoke(f, ["project", "start", "--file", file, "--json"], "", repo.project);
  return { run, state: JSON.parse(run.stdout) };
}

test("project CLI overlaps two same-model employees on separate files without granting root authority", async (t) => {
  const repo = repository(t);
  const positions = [
    ["frontend", "a.txt"],
    ["algorithm", "b.txt"],
  ];
  const dispatches = [],
    rejected = [],
    employeeTurns = new Map();
  let release,
    timer,
    active = 0,
    peak = 0,
    root = 0;
  const arrivals = new Set();
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async ({ body }) => {
    const tools = body.tools.map((t) => t.function.name);
    const latest = body.messages.findLast((m) => m.role === "tool")?.content;
    if (tools.includes("accept_change")) {
      switch (++root) {
        case 1:
        case 2: {
          const [id, path] = positions[root - 1];
          return tool("project_staff", {
            action: "appoint",
            input: {
              id,
              responsibility: "Implement " + path,
              models: ["fixture/main"],
              scope: [path],
              need: "deliverable",
              reason: "Own separate deliverable " + path,
            },
          });
        }
        case 3:
        case 4: {
          if (root === 4) dispatches.push(JSON.parse(latest));
          const [staffId, path] = positions[root - 3];
          return tool("delegate", {
            staffId,
            model: "fixture/main",
            scope: [path],
            readScope: [path],
            assignment: "Implement " + path,
            reason: "Owns this deliverable",
          });
        }
        case 5:
          dispatches.push(JSON.parse(latest));
          if (dispatches.some((r) => !r.memberId)) return { text: "Employee dispatch was rejected." };
          return tool("collect", { memberId: dispatches[0].memberId });
        case 6:
          return tool("collect", { memberId: dispatches[1].memberId });
        case 7:
          return tool("accept_change", { memberId: dispatches[0].memberId });
        case 8:
          return tool("accept_change", { memberId: dispatches[1].memberId });
        default:
          return { text: "Both files have been reviewed." };
      }
    }
    const content = body.messages.findLast((m) => m.role === "user").content;
    const material = JSON.parse(
      typeof content === "string" ? content : content.map((x) => x.text).join("\n"),
    );
    const path = material.execution.scope[0];
    if (material.phase === "Independent task preparation") {
      // Only return a normal response once *both* distinct scopes reached the HTTP receiver.
      // The watchdog lets a serialization bug fail with observed arrivals instead of hanging CI.
      arrivals.add(path);
      peak = Math.max(peak, ++active);
      if (!timer) timer = setTimeout(release, 15000);
      if (arrivals.size === 2) {
        clearTimeout(timer);
        release();
      }
      await barrier;
      active--;
      return { text: "Read the original goal and inspect only my assigned file." };
    }
    const n = (employeeTurns.get(path) ?? 0) + 1;
    employeeTurns.set(path, n);
    if (n === 1) return tool("accept_change", { memberId: "main" });
    if (n === 2) {
      rejected.push(latest);
      return tool("read", { path });
    }
    if (n === 3) {
      return tool("write", { path, content: "delivered " + path + "\n" });
    }
    return { text: "Prepared my file for root acceptance." };
  });
  const checks = [
    {
      command: "node",
      args: [
        "-e",
        "for (const path of ['a.txt','b.txt']) if (!/^(base [AB]|delivered [ab]\\.txt)\\n$/.test(require('fs').readFileSync(path,'utf8'))) process.exit(1)",
      ],
    },
  ];
  const { run, state } = await runRoleProject(f, repo, {
    goal: "Deliver both files independently",
    scope: ["a.txt", "b.txt"],
    deliverables: ["a.txt", "b.txt"],
    budget: { maxCalls: 24 },
    checks,
  });
  clearTimeout(timer);
  assert.deepEqual(
    [...arrivals].sort(),
    ["a.txt", "b.txt"],
    JSON.stringify({ dispatches, blocker: state.blocker }),
  );
  assert.equal(peak, 2, "Both HTTP requests must be in flight before either can finish");
  assert.equal(run.code, 0, run.stderr + " " + state.blocker);
  assert.equal(state.status, "completed", state.blocker);
  assert.ok(f.calls.every(({ body }) => body.model === "main"));
  assert.equal(rejected.length, 2);
  for (const denial of rejected) assert.match(denial, /accept_change.*not found/i);
  const [task] = listTasks(f.home);
  assert.equal(new Set(task.members.map((m) => m.memberId)).size, 2);
  assert.equal(new Set(task.members.map((m) => m.sessionFile)).size, 2);
  assert.equal(new Set(task.members.map((m) => m.changeId)).size, 2);
  assert.ok(task.work.capacity.every((c) => c.active >= 0 && c.active <= 2));
  assert.equal(task.work.capacity.at(-1).active, 0);
  const beforeView = f.calls.length;
  const [status, details] = await Promise.all([
    invoke(f, ["project", "status"], "", repo.project),
    invoke(f, ["show", task.id, "--all"], "", repo.project),
  ]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(details.code, 0, details.stderr);
  assert.equal(f.calls.length, beforeView, "Reading status and details must not send requests");
  for (const m of task.members) {
    const a = state.staffAssignments[m.memberId];
    assert.ok(a.workId && m.understandingCallId);
    const fields = ["fixture/main", m.staffId, a.workId, m.memberId, m.understandingCallId];
    for (const view of [status, details])
      assert.ok(
        view.stdout.split("\n").some((line) => fields.every((id) => line.includes(id))),
        "Expected one human-readable line linking " + fields.join(" / "),
      );
    assert.equal(m.status, "accepted");
    assert.ok(m.sessionFile && !m.tools.includes("accept_change") && !m.tools.includes("project_staff"));
    assert.equal(git(repo.project, "show", state.version + ":" + m.scope[0]), "delivered " + m.scope[0]);
  }
});

test("same-model employee cannot write a sibling file by claiming to be main", async (t) => {
  const repo = repository(t);
  let root = 0,
    memberId,
    denial;
  const f = await fixture(t, ({ body }) => {
    const names = body.tools.map((t) => t.function.name);
    const result = body.messages.findLast((m) => m.role === "tool")?.content;
    if (names.includes("accept_change")) {
      switch (++root) {
        case 1:
          return tool("project_staff", {
            action: "appoint",
            input: {
              id: "frontend",
              responsibility: "Edit a.txt",
              models: ["fixture/main"],
              scope: ["a.txt"],
              need: "deliverable",
              reason: "Own frontend file",
            },
          });
        case 2:
          return tool("delegate", {
            staffId: "frontend",
            model: "fixture/main",
            scope: ["a.txt"],
            assignment: "Edit a.txt",
            reason: "Frontend owns this file",
          });
        case 3:
          memberId = JSON.parse(result).memberId;
          return tool("collect", { memberId });
        default:
          return { text: "The writer did not deliver its file." };
      }
    }
    if (!names.includes("write")) return { text: "Respect the assigned file boundary." };
    if (!result) return tool("write", { path: "b.txt", content: "intrusion", actor: "main" });
    denial = result;
    return { text: "I could not modify the sibling file." };
  });
  const { run, state } = await runRoleProject(f, repo, {
    goal: "Have a worker edit a.txt",
    scope: ["a.txt", "b.txt"],
    deliverables: ["a.txt"],
    budget: { maxCalls: 10 },
    checks: [
      {
        command: "node",
        args: ["-e", "if (require('fs').readFileSync('b.txt','utf8') !== 'base B\\n') process.exit(1)"],
      },
    ],
  });
  assert.ok(memberId);
  assert.match(denial, /scope|authority|additional propert|unknown propert/i);
  assert.equal(run.code, 1);
  assert.notEqual(state.status, "completed");
  assert.equal(git(repo.project, "show", state.version + ":b.txt"), "base B");
});

test("same-model supervisor cannot collect or return feedback to another group", async (t) => {
  const repo = repository(t);
  const denied = [];
  let rootTurn = 0,
    supervisorTurn = 0,
    writerId,
    supervisorId;
  const f = await fixture(t, ({ body }) => {
    const names = body.tools.map((t) => t.function.name);
    const result = body.messages.findLast((m) => m.role === "tool")?.content;
    if (names.includes("accept_change")) {
      switch (++rootTurn) {
        case 1:
        case 2: {
          const [id, path] = rootTurn === 1 ? ["writer", "a.txt"] : ["supervisor", "b.txt"];
          return tool("project_staff", {
            action: "appoint",
            input: {
              id,
              responsibility: "Own " + path,
              scope: [path],
              models: ["fixture/main"],
              need: "deliverable",
              reason: "Separate work area",
            },
          });
        }
        case 3:
          return tool("project_staff", {
            action: "promote",
            input: { id: "supervisor", subgoal: "Coordinate B", models: ["fixture/main"] },
          });
        case 4:
          return tool("delegate", {
            staffId: "writer",
            model: "fixture/main",
            assignment: "Update A",
            reason: "Owns A",
            scope: ["a.txt"],
          });
        case 5:
          writerId = JSON.parse(result).memberId;
          return tool("collect", { memberId: writerId });
        case 6:
          return tool("delegate", {
            staffId: "supervisor",
            model: "fixture/main",
            assignment: "Coordinate B",
            reason: "Owns B",
            readOnly: true,
            readScope: ["b.txt"],
          });
        case 7:
          supervisorId = JSON.parse(result).memberId;
          return tool("collect", { memberId: supervisorId });
        case 8:
          return tool("accept_change", { memberId: writerId });
        default:
          return { text: "Root accepted its writer's candidate." };
      }
    }
    if (names.includes("delegate")) {
      if (++supervisorTurn === 1) return tool("collect", { memberId: writerId });
      denied.push(JSON.parse(result));
      if (supervisorTurn === 2)
        return tool("feedback", { memberId: writerId, feedback: "Overwrite A with a different value." });
      return { text: "The writer is outside my group." };
    }
    if (!names.includes("write")) return { text: "Inspect the original file scope." };
    if (!result) return tool("read", { path: "a.txt" });
    if (result.includes("base A")) return tool("write", { path: "a.txt", content: "authorized A\n" });
    return { text: "The A candidate is ready for root." };
  });
  const { run, state } = await runRoleProject(f, repo, {
    goal: "Update A and verify B",
    scope: ["a.txt", "b.txt"],
    deliverables: ["a.txt", "b.txt"],
    budget: { maxCalls: 24 },
    checks: [
      {
        command: "node",
        args: ["-e", "if (require('fs').readFileSync('a.txt','utf8') !== 'authorized A\\n') process.exit(1)"],
      },
    ],
  });
  assert.equal(run.code, 0, run.stderr + state.blocker);
  assert.deepEqual(
    denied.map((r) => r.error?.code),
    ["GROUP_OWNERSHIP", "GROUP_OWNERSHIP"],
  );
  assert.ok(denied.every((r) => !r.memberId && !r.members));
  assert.equal(state.status, "completed");
  assert.equal(git(repo.project, "show", state.version + ":a.txt"), "authorized A");
  assert.deepEqual(listTasks(f.home)[0].members.find((m) => m.memberId === writerId).feedback, []);
});
