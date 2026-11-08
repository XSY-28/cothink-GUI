import test from "node:test";
import assert from "node:assert/strict";
import { createProjectStaff } from "../src/project-staff.js";

function roster() {
  const state = {
    scope: ["src"],
    status: "running",
    staff: [],
    staffAssignments: {},
  };
  const staff = createProjectStaff({
    read: () => state,
    update(fn) {
      const copy = structuredClone(state);
      const result = fn(copy);
      Object.assign(state, copy);
      return result;
    },
  });
  const appoint = (id, options = {}) =>
    staff.change("appoint", {
      id,
      responsibility: id,
      scope: ["src"],
      ...options,
    });
  const assign = (id, options = {}) =>
    staff.begin({
      staffId: id,
      dispatchId: id + "-run",
      identity: id,
      model: "local/" + id,
      role: "member:" + id + "-run",
      taskId: "task-1",
      actor: "root",
      scope: [],
      readScope: ["."],
      readOnly: true,
      ...options,
    });
  return { state, staff, appoint, assign };
}

test("transfer freezes new work; uncertain sent request survives renaming and task restart", () => {
  const { staff, appoint, assign } = roster();
  appoint("old");
  appoint("new");
  assign("old", { identity: "m" });
  staff.reconcile(
    {
      id: "task-1",
      status: "partial",
      members: [{ memberId: "old-run", status: "cancelled" }],
    },
    [{ id: "call", role: "member:old-run", sent: true, status: "in_flight" }],
  );
  staff.change("transfer", {
    id: "old",
    supervisorId: "root",
    reason: "handover",
    pending: "unverified export",
    version: "v1",
  });
  assert.throws(() => staff.change("finish", { id: "old" }), /old-run/);
  assert.throws(() => assign("new", { identity: "m", taskId: "task-2", model: "alias/m" }), /old-run/);
  assert.equal(staff.list().find((p) => p.id === "old").handoff.pending, "unverified export");
});

test("automatic appointment reuses existing coverage; supervisor cannot expand scope or add layers", async () => {
  const { staff, appoint } = roster();
  appoint("compat");
  staff.change("promote", {
    id: "compat",
    subgoal: "deliver legacy export",
    models: ["local/read"],
  });
  const tool = staff.tools("compat")[0];
  const input = {
    id: "reader",
    responsibility: "inspect",
    scope: ["src/input"],
    models: ["local/read"],
    need: "deliverable",
    reason: "sample migration",
  };
  const change = (action, p) => tool.execute("call", { action, input: p });
  await change("appoint", input);
  await change("appoint", { ...input, id: "duplicate" });
  assert.deepEqual(
    staff.list().map((p) => p.id),
    ["compat", "reader"],
  );
  await assert.rejects(change("appoint", { ...input, id: "bad", scope: ["../outside"] }));
  await assert.rejects(
    change("promote", {
      id: "reader",
      subgoal: "extra layer",
      models: ["local/read"],
    }),
  );
  assert.throws(
    () => staff.change("retire", { id: "compat", reason: "done" }) && staff.change("finish", { id: "compat" }),
    /reader/,
  );
});

test("independent review rejects decision participant, alias and write scope", () => {
  const { staff, appoint, assign } = roster();
  appoint("author");
  appoint("reviewer");
  assign("author");
  staff.update("author-run", { status: "result", candidate: "v1" });
  assert.throws(() => assign("reviewer", { identity: "author", reviewOf: "author-run" }));
  assert.throws(() =>
    assign("reviewer", {
      reviewOf: "author-run",
      readOnly: false,
      scope: ["src"],
    }),
  );
  assert.equal(assign("reviewer", { reviewOf: "author-run" }).reviewOf, "author-run");
  staff.update("reviewer-run", { status: "result" });
  staff.update("reviewer-run", { status: "disposed" });
  assert.throws(() => staff.change("retain", { id: "reviewer", reason: "cheaper than handover" }));
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { saveConfig } from "../src/config.js";

test("project CLI reuses its temporary employee in two tasks, then retains, promotes, transfers and retires it", async (t) => {
  const repo = repository(t);
  const tool = (name, args) => ({ toolCalls: [{ name, args }] });
  let leaderTurns = 0,
    memberTurns = 0;
  const f = await fixture(t, ({ body }) => {
    if (body.model !== "main") {
      memberTurns++;
      return { text: "Checked the authorized project inputs." };
    }
    const approved = {
      id: "reader",
      responsibility: "Inspect the accepted text inputs",
      scope: [],
      readScope: ["."],
      models: ["fixture/r1"],
      need: "deliverable",
      reason: "The independent text inspection currently has no owner.",
    };
    const dispatch = {
      staffId: "reader",
      model: "fixture/r1",
      assignment: "Inspect text input",
      reason: "Use configured secondary reader",
      readOnly: true,
      scope: [],
      readScope: ["."],
    };
    switch (++leaderTurns) {
      case 1:
        return tool("project_staff", { action: "appoint", input: approved });
      case 2:
      case 5:
        return tool("delegate", dispatch);
      case 3:
      case 6:
        return tool("collect", {});
      default:
        return { text: "Returned checked input." };
    }
  });
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution } });
  const checks = [
    {
      command: "node",
      args: ["-e", "if(!require('fs').readFileSync('a.txt','utf8').includes('base A'))process.exit(1)"],
    },
  ];
  const plan = {
    goal: "Check both tracked text files",
    scope: ["."],
    budget: { maxCalls: 16 },
    steps: [
      { id: "first", goal: "Inspect A", deliverables: ["a.txt"], checks },
      {
        id: "second",
        goal: "Inspect B",
        dependsOn: ["first"],
        deliverables: ["b.txt"],
        checks,
      },
    ],
  };
  const file = join(repo.root, "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  const run = async (args) => {
    const r = await invoke(f, ["project", ...args, "--json"], "", repo.project);
    assert.equal(r.code, 0, r.stderr + " " + r.stdout);
    return JSON.parse(r.stdout);
  };
  const project = await run(["start", "--file", file]);
  assert.equal(project.status, "completed", project.blocker);
  assert.equal(project.staff.find((p) => p.id === "reader").source, "automatic");
  assert.equal(memberTurns, 4);
  const jobs = Object.values(project.staffAssignments);
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map((j) => j.taskId)).size, 2);
  assert.ok(
    jobs.every((j) => j.status === "disposed" && j.calls.every((c) => c.sent && c.status === "completed")),
  );
  const before = f.calls.length;
  const manage = (action, input) => run(["staff", action, JSON.stringify(input)]);
  await manage("retain", {
    id: "reader",
    reason: "Preserve two rounds of input knowledge",
  });
  await manage("appoint", {
    id: "compat",
    responsibility: "Lead input compatibility",
    models: ["fixture/r1"],
  });
  await manage("promote", {
    id: "compat",
    subgoal: "Preserve input compatibility",
    models: ["fixture/r1"],
  });
  await manage("transfer", {
    id: "reader",
    supervisorId: "compat",
    reason: "Move under compatibility staff",
    version: project.version,
    pending: "No remaining drafts",
  });
  const transferred = await manage("finish", { id: "reader" });
  assert.equal(transferred.staff.find((p) => p.id === "reader").supervisorId, "compat");
  await manage("retire", { id: "reader", reason: "Input checks delivered" });
  await manage("finish", { id: "reader" });
  const history = await run(["status"]);
  const retired = history.staff.find((p) => p.id === "reader");
  assert.equal(retired.retained, true);
  assert.equal(retired.status, "retired");
  assert.equal(retired.handoff.version, project.version);
  assert.equal(f.calls.length, before);
});

test("ordinary project review observes the candidate before comparing the proposed conclusion", async (t) => {
  const repo = repository(t),
    goal = "Deliver a checked export marker.";
  const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
  const counts = { main: 0, r1: 0, r2: 0 };
  let authorId, reviewerId;
  function latestResult(body) {
    return JSON.parse(body.messages.filter((m) => m.role === "tool").at(-1).content);
  }
  const f = await fixture(t, ({ body }) => {
    const n = ++counts[body.model];
    if (body.model === "r1") {
      if (n === 2)
        return tool("write", {
          path: "export.txt",
          content: "verified-marker\n",
        });
      return {
        text: n === 1 ? "I understand the original export task." : "The export marker is ready for review.",
      };
    }
    if (body.model === "r2") return { text: "The candidate contains the export marker." };
    switch (n) {
      case 1:
        return tool("project_staff", {
          action: "appoint",
          input: {
            id: "author",
            responsibility: "Write export marker",
            need: "deliverable",
            reason: "No writer exists.",
            scope: ["export.txt"],
          },
        });
      case 2:
        return tool("project_staff", {
          action: "appoint",
          input: {
            id: "verify",
            responsibility: "Review the written export",
            need: "review",
            reason: "The writer cannot independently review their own export.",
            scope: [],
            readScope: ["export.txt"],
          },
        });
      case 3:
        return tool("delegate", {
          staffId: "author",
          model: "fixture/r1",
          scope: ["export.txt"],
          assignment: "Write export.txt",
          reason: "Owned export implementation",
        });
      case 4:
        authorId = latestResult(body).memberId;
        return tool("collect", { memberId: authorId });
      case 5:
        return tool("delegate", {
          staffId: "verify",
          model: "fixture/r2",
          reviewOf: authorId,
          reviewKind: "ordinary",
          scope: [],
          readScope: ["export.txt"],
          readOnly: true,
          assignment: "Review the marker",
          implementationAdvice: "WITHHELD_REVIEW_OPINION",
          reason: "Separate model from author",
        });
      case 6:
        reviewerId = latestResult(body).memberId;
        return tool("collect", { memberId: reviewerId });
      case 7:
        return tool("accept_change", { memberId: authorId });
      default:
        return { text: "The reviewed export is complete." };
    }
  });
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution } });
  const file = join(repo.root, "review.json");
  writeFileSync(
    file,
    JSON.stringify({
      goal,
      scope: ["export.txt"],
      budget: { maxCalls: 20 },
      steps: [
        {
          id: "export",
          goal,
          deliverables: ["export.txt"],
          checks: [
            {
              command: "node",
              args: [
                "-e",
                "if(require('fs').readFileSync('export.txt','utf8').trim() !== 'verified-marker')process.exit(1)",
              ],
            },
          ],
        },
      ],
    }),
  );
  const run = await invoke(f, ["project", "start", "--file", file, "--json"], "", repo.project);
  assert.equal(
    run.code,
    0,
    run.stderr +
      " " +
      run.stdout +
      " last host result: " +
      JSON.stringify(
        f.calls
          .at(-1)
          ?.body.messages.filter((m) => m.role === "tool")
          .at(-1),
      ),
  );
  const state = JSON.parse(run.stdout);
  assert.equal(state.status, "completed", state.blocker);
  const seen = f.calls.filter((c) => c.body.model === "r2").map((c) => JSON.stringify(c.body.messages));
  assert.equal(seen.length, 2);
  const author = state.staffAssignments[authorId];
  assert.ok(author.candidate && author.baseVersion);
  assert.ok(
    seen[0].includes(goal) && seen[0].includes(author.candidate) && seen[0].includes("verified-marker"),
  );
  assert.ok(seen[0].includes("Record your own observations") && !seen[0].includes("WITHHELD_REVIEW_OPINION"));
  assert.ok(seen[1].includes("The candidate contains the export marker.") && seen[1].includes("WITHHELD_REVIEW_OPINION"));
  assert.ok(seen[1].includes("Compare your recorded observations"));
  assert.equal(state.staffAssignments[reviewerId].reviewOf, authorId);
  assert.equal(state.staffAssignments[reviewerId].status, "disposed");
});

test("project sends and edits use the live employee identity, scope and handover state", () => {
  const { staff, appoint, assign } = roster();
  appoint("reader", { scope: ["src/input"] });
  assign("reader");
  const work = { taskId: "task-1", role: "member:reader-run" };
  assert.throws(() => staff.checkIdentity({ ...work, model: { id: "other" } }));
  assert.throws(() => staff.checkWork({ ...work, scope: ["src/output"] }));
  assert.equal(staff.checkWork({ ...work, scope: ["src/input"] }), true);
  staff.change("retire", { id: "reader", reason: "handover" });
  assert.throws(() => staff.checkIdentity({ ...work, model: { id: "reader" } }));
  assert.throws(() => staff.checkWork({ ...work, scope: ["src/input"] }));
});

test("only original kernel receipts settle an uncertain draft, and its result still needs disposal", () => {
  const { staff, appoint, assign } = roster();
  appoint("reader");
  assign("reader");
  const task = {
    id: "task-1",
    status: "partial",
    members: [
      {
        memberId: "reader-run",
        changeId: "draft",
        status: "outcome_unknown",
        kernelUnknownRequestId: "origin",
      },
    ],
    work: {
      requests: [{ requestId: "origin", changeId: "draft", status: "unknown" }],
    },
  };
  staff.reconcile(task, []);
  staff.reconcile(task, [], [{ requestId: "another", status: "applied" }]);
  assert.equal(staff.assignment("reader-run").status, "unknown");
  staff.reconcile(task, [], [{ requestId: "origin", status: "applied" }]);
  assert.equal(staff.assignment("reader-run").status, "result");
  staff.change("retire", { id: "reader", reason: "handover" });
  assert.throws(() => staff.change("finish", { id: "reader" }));
});

test("a transfer checks the destination before freezing and keeps the previous group and version", () => {
  const { staff, appoint } = roster();
  appoint("lead", { scope: ["src/input"] });
  staff.change("promote", {
    id: "lead",
    subgoal: "Read exports",
    models: ["local/reader"],
  });
  appoint("writer");
  assert.throws(() =>
    staff.change("transfer", {
      id: "writer",
      reason: "move",
      supervisorId: "lead",
    }),
  );
  assert.equal(staff.list().find((p) => p.id === "writer").status, "active");
  appoint("reader", { scope: ["src/input"] });
  staff.change("transfer", {
    id: "reader",
    reason: "move",
    supervisorId: "lead",
    version: "v1",
  });
  staff.change("finish", { id: "reader" });
  staff.change("retire", { id: "reader", reason: "done", version: "v2" });
  const row = staff.change("finish", { id: "reader" });
  assert.equal(row.transitions[0].handoff.version, "v1");
  assert.equal(row.transitions[0].from, "root");
});

test("changing the supervisor's available roster stops an old grant before its next send or edit", () => {
  const { staff, appoint, assign } = roster();
  appoint("lead");
  staff.change("promote", {
    id: "lead",
    subgoal: "Inspect text",
    models: ["local/reader", "local/next"],
  });
  appoint("reader", { supervisorId: "lead", models: ["local/reader"] });
  assign("reader", { actor: "lead" });
  staff.change("promote", {
    id: "lead",
    subgoal: "Inspect text",
    models: ["local/next"],
  });
  const work = { taskId: "task-1", role: "member:reader-run" };
  assert.throws(() => staff.checkIdentity({ ...work, model: { id: "reader" } }));
  assert.throws(() => staff.checkWork(work));
});

test("a former project leader cannot reappear as the independent reviewer of its decision under a new Team", () => {
  const { staff, state, appoint, assign } = roster();
  state.callIntents = [{ taskId: "task-1", role: "main", identity: "former-leader" }];
  appoint("author");
  appoint("reviewer");
  assign("author");
  staff.update("author-run", { status: "result", candidate: "v1" });
  assert.throws(() =>
    assign("reviewer", {
      taskId: "task-2",
      identity: "former-leader",
      reviewOf: "author-run",
    }),
  );
});

test("a project reviewer sees the root's real prepared candidate; fabricated and out-of-scope sources never dispatch", async (t) => {
  const repo = repository(t);
  const goal = "Deliver and independently verify the root's export.";
  const tool = (name, args) => ({ toolCalls: [{ name, args }] });
  let turn = 0,
    candidate,
    reference,
    member,
    forgedResult,
    scopeResult,
    nextTurn = 0,
    currentSelfResult,
    formerSelfResult;
  const proposal = {
    staffId: "verify",
    model: "fixture/r2",
    readOnly: true,
    scope: [],
    readScope: ["export.txt"],
    assignment: "Check export text",
    reason: "Independent reader",
    implementationAdvice: "WITHHELD_ROOT_OPINION",
  };
  const f = await fixture(t, ({ body }) => {
    if (body.model === "r2") return { text: "The original task and export candidate are consistent." };
    const latest = () => JSON.parse(body.messages.filter((m) => m.role === "tool").at(-1).content);
    if (body.model === "r1") {
      // The new root can also serve in a separate read-only role on a candidate
      // it did not create. Its reviewer runtime cannot control the team.
      if (!body.tools.some(t => t.function.name === "delegate"))
        return {text:"I examined the exact earlier candidate."};
      switch (++nextTurn) {
        case 1:
          return tool("delegate", { ...proposal, model: "fixture/r1", reviewOf: reference });
        case 2:
          currentSelfResult = latest();
          return tool("collect", { memberId: currentSelfResult.memberId });
        case 3:
          return tool("delegate", { ...proposal, model: "fixture/main", reviewOf: reference });
        case 4:
          formerSelfResult = latest();
          return tool("delegate", { ...proposal, reviewOf: reference });
        case 5:
          return tool("collect", { memberId: latest().memberId });
        default:
          return { text: "Historical candidate verified by the independent reviewer." };
      }
    }
    switch (++turn) {
      case 1:
        return tool("next_change", { reason: "Write the export marker", scope: ["export.txt"] });
      case 2:
        return tool("write", { path: "export.txt", content: "ROOT-CANDIDATE-MARKER\n" });
      case 3:
        return tool("prepare_change");
      case 4: {
        const prepared = latest();
        candidate = prepared.candidateVersion;
        reference = prepared.reviewOf;
        return tool("project_staff", {
          action: "appoint",
          input: {
            id: "verify",
            responsibility: "Verify export",
            scope: [],
            need: "review",
            reason: "The root wrote this export and cannot review independently.",
          },
        });
      }
      case 5:
        return tool("project_staff", {
          action: "promote",
          input: {
            id: "verify",
            subgoal: "Coordinate export inspection",
            models: ["fixture/r2", "fixture/main", "fixture/r1"],
          },
        });
      case 6:
        return tool("delegate", {
          ...proposal,
          reviewOf: (reference ?? "root:missing").replace(/[^:]+$/, "f".repeat(40)),
        });
      case 7:
        forgedResult = latest();
        return tool("delegate", { ...proposal, readScope: ["a.txt"], reviewOf: reference ?? "root:missing" });
      case 8:
        scopeResult = latest();
        return tool("delegate", { ...proposal, reviewOf: reference ?? "root:missing" });
      case 9:
        member = latest().memberId;
        return tool("collect", { memberId: member });
      case 10:
        return tool("accept_change");
      default:
        saveConfig(f.home, {
          formatVersion: 2,
          main: f.models.secondary[0],
          secondary: [f.models.main, f.models.secondary[1]],
          work: { execution },
        });
        return { text: "The independently checked export is delivered." };
    }
  });
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution } });
  const file = join(repo.root, "root-review.json");
  writeFileSync(
    file,
    JSON.stringify({
      goal,
      scope: ["export.txt"],
      budget: { maxCalls: 24 },
      steps: [
        {
          id: "export",
          goal,
          deliverables: ["export.txt"],
          checks: [
            {
              command: "node",
              args: [
                "-e",
                "if(require('fs').readFileSync('export.txt','utf8').trim()!=='ROOT-CANDIDATE-MARKER')process.exit(1)",
              ],
            },
          ],
        },
        {
          id: "historical",
          goal: "Independently review the earlier candidate under the new team.",
          dependsOn: ["export"],
          deliverables: ["export.txt"],
          checks: [
            {
              command: "node",
              args: [
                "-e",
                "if(require('fs').readFileSync('export.txt','utf8').trim()!=='ROOT-CANDIDATE-MARKER')process.exit(1)",
              ],
            },
          ],
        },
      ],
    }),
  );
  const run = await invoke(f, ["project", "start", "--file", file, "--json"], "", repo.project);
  assert.equal(run.code, 0, (run.stdout && JSON.parse(run.stdout).blocker) || run.stderr);
  assert.ok(
    reference && reference.endsWith(candidate),
    "prepare_change must identify its exact root-owned candidate",
  );
  assert.equal(forgedResult.error?.code, "REVIEW_SOURCE");
  assert.equal(scopeResult.error?.code, "REVIEW_SOURCE");
  const state = JSON.parse(run.stdout);
  assert.equal(state.staffAssignments[currentSelfResult.memberId].model, "fixture/r1");
  assert.equal(formerSelfResult.error?.code, "PROJECT_STAFF");
  assert.equal(Object.keys(state.staffAssignments).length, 3);
  assert.equal(state.staffAssignments[member].reviewOf, reference);
  const seen = f.calls.filter((c) => c.body.model === "r2").map((c) => JSON.stringify(c.body.messages));
  assert.equal(seen.length, 4);
  for (const call of f.calls.filter((c) => c.body.model === "r2")) {
    assert.ok(
      !call.body.tools.some((t) => ["delegate", "feedback", "project_staff"].includes(t.function.name)),
      "Independent review must remain read-only even for a normally promoted position",
    );
  }
  assert.ok(seen[2].includes(candidate) && seen[2].includes("+ROOT-CANDIDATE-MARKER"));
  assert.ok(
    seen[0].includes(goal) && seen[0].includes(candidate) && seen[0].includes("+ROOT-CANDIDATE-MARKER"),
  );
  assert.ok(!seen[0].includes("WITHHELD_ROOT_OPINION") && !seen[1].includes("WITHHELD_ROOT_OPINION"));
});

test("missing kernel receipt stays unknown until the original journal proves the begin was never sent", () => {
  const { staff, appoint, assign } = roster();
  appoint("reader");
  assign("reader");
  const record = {
    id: "task-1",
    status: "partial",
    members: [
      {
        memberId: "reader-run",
        beginRequestId: "original",
        kernelUnknownRequestId: "original",
        status: "outcome_unknown",
      },
    ],
    work: { requests: [{ requestId: "original", status: "preparing" }] },
  };
  staff.reconcile(record, [], [{ requestId: "original", status: "not_found" }]);
  assert.equal(staff.assignment("reader-run").status, "unknown");
  staff.reconcile(record, [], [{ requestId: "original", status: "not_sent" }]);
  assert.equal(staff.assignment("reader-run").outcome, "not_sent");
  assert.equal(staff.assignment("reader-run").status, "disposed");
});

test("the writer claims work and position separately, reuses lost replies, and keeps root edits bound", () => {
  const {state, staff, appoint} = roster();
  state.steps = [{id:"delivery", attempts:[{taskId:"task"}], scope:["src"], works:[
    {id:"front",scope:["src/ui"]}, {id:"math",scope:["src/math"]},
  ]}];
  for (const id of ["first", "second", "third"]) appoint(id);
  const claim = (id, work, changes = {}) => staff.begin({
    taskId:"task", staffId:id, actor:"root", actorRole:"main", model:"local/A", identity:"a",
    assignment:"Implement " + work, workId:work, scope:[work === "front" ? "src/ui" : "src/math"],
    readScope:["."], ...changes,
  });
  const front = claim("first", "front");
  assert.equal(claim("first", "front").dispatchId, front.dispatchId);
  assert.equal(claim("first", "front").reused, true);
  assert.throws(() => claim("second","front", {assignment:"renamed"}));
  assert.throws(() => claim("first","math"));
  staff.update(front.dispatchId, {status:"unknown", requestId:"pending"});
  const math = claim("second","math");
  assert.notEqual(math.dispatchId,front.dispatchId);
  assert.equal(Object.keys(state.staffAssignments).length,2);
  assert.throws(() => staff.claimWrite({role:"main",taskId:"task",scope:["src/ui/code"]}));
  assert.throws(() => staff.claimWrite({role:math.role,taskId:"task",scope:["src/ui/code"]}));
  assert.doesNotThrow(() => staff.claimWrite({role:math.role,taskId:"task",scope:["src/math/code"]}));
  assert.throws(() => staff.checkIdentity({taskId:"task",role:math.role,model:{provider:"other",id:"A"}}));
  assert.throws(() => staff.begin({...front, dispatchId:undefined, staffId:"third", actorRole:math.role}));
});

test("legacy uncertain work is recovered from original task scope and cannot be renamed or reassigned", () => {
  const {state, staff, appoint} = roster();
  state.steps = [{id:"step",attempts:[{taskId:"old"},{taskId:"next"}], scope:["src"],
    deliverables:["src/old","src/new"]}];
  for (const id of ["old", "renamed"]) appoint(id);
  state.staffAssignments.original = {staffId:"old",actor:"root",taskId:"old",dispatchId:"original",
    role:"member:original",identity:"a",model:"local/A",status:"unknown",unknownRequestIds:["sent"]};
  staff.reconcile({id:"old",status:"outcome_unknown",members:[
    {memberId:"original",scope:["src/old"],readScope:["."],status:"outcome_unknown"},
  ]}, [{id:"sent",role:"member:original",sent:true,status:"outcome_unknown"}]);
  assert.equal(staff.assignment("original").workId,"step:src/old");
  const claim = (path, model) => staff.begin({staffId:"renamed",actorRole:"main",actor:"root",taskId:"next",
    workId:"step:" + path,model:"local/" + model,identity:model,scope:[path],readScope:["."],assignment:"new title"});
  assert.throws(() => claim("src/old","b"));
  const separate = claim("src/new","a");
  assert.equal(separate.workId,"step:src/new");
  assert.equal(staff.assignment("original").status,"unknown");
});

test("feedback and live edits stay inside the original work even when a position covers both products", () => {
  const {state, staff, appoint} = roster();
  state.steps = [{id:"p",attempts:[{taskId:"task"}], scope:["src"],
    works:[{id:"ui",scope:["src/ui"]},{id:"api",scope:["src/api"]}]}];
  appoint("worker");
  const assignment = staff.begin({taskId:"task",staffId:"worker",actor:"root",actorRole:"main",
    identity:"a",model:"local/A",workId:"ui",scope:["src/ui"],readScope:["."],assignment:"Implement UI"});
  staff.update(assignment.dispatchId, {status:"result"});
  assert.throws(() => staff.resume({...assignment, scope:["src/api"]}), /work scope/);
  staff.resume({...assignment});
  assert.throws(() => staff.checkWork({taskId:"task",role:assignment.role,scope:["src/api"]}), /work scope/);
  assert.throws(() => staff.claimWrite({taskId:"task",role:assignment.role,scope:["src/api"]}));
});

test("read inspection must reach the named target and cannot occupy its writable delivery", () => {
  const {state, staff, appoint} = roster();
  state.steps = [{id:"p", attempts:[{taskId:"t"}], works:[
    {id:"api",scope:["src/api"]}, {id:"ui",scope:["src/ui"]},
  ]}];
  for (const id of ["reader","writer","renamed"]) appoint(id);
  const input = {taskId:"t",actor:"root",actorRole:"main",workId:"api",model:"local/a",identity:"a"};
  const inspect = {...input,staffId:"reader",readOnly:true,scope:[],readScope:["src/ui"]};
  assert.throws(() => staff.begin(inspect));
  const read = staff.begin({...inspect,readScope:["src/api"]});
  assert.notEqual(read.workId,"api");
  staff.update(read.dispatchId,{status:"unknown",requestId:"sent"});
  assert.throws(() => staff.begin({...inspect,staffId:"renamed",assignment:"another title",readScope:["src/api"]}));
  const write = staff.begin({...input,staffId:"writer",scope:["src/api"]});
  assert.equal(write.workId,"api");
});

test("ambiguous legacy work locks its bounded area but does not reserve a model for a disjoint step", () => {
  const {state,staff,appoint} = roster();
  state.steps = [
    {id:"old",scope:["src/Résumé"],attempts:[{taskId:"old"}],deliverables:["src/Résumé/x","src/Résumé/y"]},
    {id:"next",scope:["src"],attempts:[{taskId:"new"}],works:[
      {id:"other",scope:["src/new"]},{id:"alias",scope:["src/re\u0301sume\u0301"]},
    ]},
  ];
  for (const id of ["old","worker","alias"]) appoint(id);
  state.staffAssignments.unknown = {taskId:"old",actor:"root",dispatchId:"unknown",staffId:"old",
    scope:["src/Résumé"],readScope:[],identity:"a",model:"local/a",role:"member:unknown",status:"unknown"};
  const take = (id, work, path) => staff.begin({taskId:"new",actorRole:"main",actor:"root",staffId:id,
    identity:"a",model:"local/a",scope:[path],readScope:[],workId:work});
  const other = take("worker","other","src/new");
  assert.doesNotThrow(() => staff.checkIdentity({taskId:"new",role:other.role,model:{provider:"local",id:"a"}}));
  assert.throws(() => take("alias","alias","src/re\u0301sume\u0301"));
});

test("registered subitems are reusable bounded targets and cannot split an existing claim or frozen effect", async () => {
  const {state,staff,appoint} = roster();
  state.steps=[{id:"deliver",scope:["src"],attempts:[{taskId:"t"}],works:[
    {id:"system",scope:["src/component"]},{id:"sample",scope:["src/data"],effect:{target:"rows",action:"sample",round:1}},
  ]}];
  const tool=staff.tools("root", () => {}, "t")[0];
  const register=async (scope) => JSON.parse((await tool.execute("call",{action:"register_work",input:{scope}})).content[0].text);
  const ui=await register(["src/component/ui"]);
  assert.equal((await register(["src/component/ui","src/component/ui/icons"])).id,ui.id);
  await assert.rejects(register(["src/data/one"]));
  await assert.rejects(register(["src/COMPONENT/UI/icons"]));
  appoint("worker");
  staff.begin({taskId:"t",staffId:"worker",workId:ui.id,model:"local/a",identity:"a",actor:"root",
    actorRole:"main",scope:["src/component/ui"],readScope:["."]});
  await assert.rejects(register(["src/component/ui/src"]));
  assert.notEqual((await register(["src/component/api"])).id,ui.id);
});

test("only settled abandonment and completed handoff allow a new owner; the old session cannot resume", () => {
  const {state,staff,appoint} = roster();
  state.steps=[{id:"p",scope:["src"],attempts:[{taskId:"t"}],deliverables:["src/x"]}];
  appoint("old"); appoint("next");
  const claim = (staffId) => staff.begin({staffId,taskId:"t",actor:"root",actorRole:"main",
    identity:"a",model:"local/a",scope:["src/x"],readScope:[],assignment:"Write x"});
  const original=claim("old");
  assert.doesNotThrow(() => staff.checkWork({taskId:"t",role:original.role,scope:["src/x"]}));
  const rec = {id:"t",status:"running",members:[{memberId:original.dispatchId,status:"abandoned",
    changeId:"draft",scope:["src/x"]}],work:{requests:[{action:"abandonChange",changeId:"draft",requestId:"stop"}]}};
  staff.reconcile(rec, []);
  assert.notEqual(staff.assignment(original.dispatchId).status, "disposed");
  staff.reconcile(rec, [], [{requestId:"stop",status:"abandoned"}]);
  assert.throws(() => claim("next"));
  staff.change("transfer",{id:"old",supervisorId:"root",reason:"Handoff source work",version:"v1"});
  staff.change("finish",{id:"old"});
  const newer=claim("next");
  assert.notEqual(newer.dispatchId,original.dispatchId);
  assert.throws(() => staff.resume(original));
  assert.throws(() => staff.checkOwner({taskId:"t",actorRole:"main",dispatchId:original.dispatchId}));
  assert.throws(() => staff.claimWrite({taskId:"t",role:original.role,scope:["src/x"]}));
});

test("two supervisors competing for one work cannot obtain each other's handle, result, or feedback authority", () => {
  const {state,staff,appoint} = roster();
  state.steps=[{id:"p",scope:["src"],attempts:[{taskId:"t"}],works:[
    {id:"one",scope:["src/one"]},{id:"two",scope:["src/two"]},{id:"shared",scope:["src/shared"]},
  ]}];
  const model = "local/a";
  const base = {identity:"a",model,taskId:"t",readScope:["src"]};
  const lead = (id,workId) => {
    appoint(id);
    staff.change("promote",{id,models:[model],subgoal:"Coordinate " + workId});
    appoint(id+"-report",{supervisorId:id,models:[model]});
    return staff.begin({...base,workId,actor:"root",actorRole:"main",staffId:id,scope:[],readOnly:true});
  };
  const first=lead("lead-one","one"), second=lead("lead-two","two");
  const delegate = (owner) => staff.begin({...base,workId:"shared",scope:["src/shared"],
    actor:owner.staffId,actorRole:owner.role,supervisorMemberId:owner.dispatchId,staffId:owner.staffId+"-report"});
  const original=delegate(first);
  assert.throws(() => delegate(second), (error) => error.code==="PROJECT_STAFF" && !error.message.includes(original.dispatchId));
  assert.throws(() => staff.checkOwner({taskId:"t",actorRole:second.role,dispatchId:original.dispatchId}));
  staff.update(original.dispatchId,{status:"result",candidate:"version"});
  assert.throws(() => staff.resume({...original,actor:second.staffId,actorRole:second.role,supervisorMemberId:second.dispatchId}));
  assert.equal(staff.assignment(original.dispatchId).candidate,"version");
});
