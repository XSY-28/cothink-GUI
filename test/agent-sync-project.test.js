import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config.js";
import { repository } from "./helpers/git-fixture.js";
import { fixture } from "./helpers/pi-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";

test("changing a delivery criterion rechecks the selected version without rerunning independent work", async (t) => {
  const repo = repository(t),
    f = await fixture(t, () => ({ text: "Everything is complete." }));
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution } });
  const file = join(f.home, "contract.json");
  const check = (path) => ({
    command: "node",
    args: ["-e", `require('fs').accessSync(${JSON.stringify(path)})`],
  });
  const plan = {
    goal: "Verify the existing application inputs.",
    scope: ["a.txt", "b.txt"],
    steps: ["a", "b"].map((id) => ({
      id,
      goal: "Verify " + id,
      deliverables: [id + ".txt"],
      checks: [check(id + ".txt")],
    })),
  };
  writeFileSync(file, JSON.stringify(plan));
  const run = async (...args) => {
    const r = await invoke(f, ["project", ...args, "--json"], "", repo.project);
    assert.ok(r.stdout, r.stderr);
    return { state: JSON.parse(r.stdout), code: r.code };
  };
  let r = await run("start", "--file", file);
  assert.equal(r.state.status, "completed", JSON.stringify(r.state));
  const [first, second] = r.state.steps;
  assert.equal(f.calls.length, 2);
  plan.goal = "Verify the existing inputs including the new entry requirement.";
  plan.steps[1].goal = "Check the changed entry contract";
  plan.steps[1].checks = [check("missing-entry")];
  writeFileSync(file, JSON.stringify(plan));
  r = await run("revise", "--goal", plan.goal, "--step", "b", "--file", file);
  assert.equal(r.code, 0);
  assert.equal(r.state.steps[0].revision, 1);
  assert.equal(r.state.steps[1].revision, 2);
  assert.deepEqual(
    r.state.revisions[0].previousDefinitions[0].checks,
    second.checks,
  );
  assert.equal(f.calls.length, 2);
  r = await run("resume");
  assert.equal(r.code, 1);
  assert.deepEqual(r.state.steps[0].attempts, first.attempts);
  assert.equal(r.state.steps[1].attempts.length, 2);
  assert.equal(r.state.steps[1].attempts[0].taskId, second.attempts[0].taskId);
  assert.notEqual(r.state.steps[1].status, "completed");
  assert.equal(f.calls.length, 3);
});

test("project plan rejects dependency cycles before creating any task", async (t) => {
  const repo = repository(t),
    f = await fixture(t);
  const file = join(f.home, "cyclic.json");
  writeFileSync(
    file,
    JSON.stringify({
      goal: "Check the entry",
      scope: ["a.txt"],
      steps: [
        {
          id: "a",
          goal: "Check",
          dependsOn: ["a"],
          deliverables: ["a.txt"],
          checks: [{ command: "node", args: ["--version"] }],
        },
      ],
    }),
  );
  const r = await invoke(
    f,
    ["project", "start", "--file", file],
    "",
    repo.project,
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cyclic/);
  assert.equal(f.calls.length, 0);
});

test("delivery reruns the earlier entry check when a later step breaks its unchanged output", async (t) => {
  const repo = repository(t);
  const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
  const f = await fixture(
    t,
    (_, n) =>
      [
        { text: "Inputs verified" },
        tool("read", { path: "b.txt" }),
        tool("edit", {
          path: "b.txt",
          edits: [{ oldText: "base B", newText: "changed B" }],
        }),
        tool("accept_change"),
        { text: "Updated B" },
      ][n - 1] ?? { text: "Finished" },
  );
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution } });
  const file = join(f.home, "contract.json");
  const check = (pattern) => ({
    command: "node",
    args: [
      "-e",
      `const fs=require('fs');fs.accessSync('a.txt');if(!fs.readFileSync('b.txt','utf8').includes('${pattern}'))process.exit(1)`,
    ],
  });
  writeFileSync(
    file,
    JSON.stringify({
      goal: "Verify A with its configuration and change B",
      scope: ["a.txt", "b.txt"],
      steps: [
        {
          id: "first",
          goal: "Verify A's entry",
          deliverables: ["a.txt"],
          checks: [check("base B")],
        },
        {
          id: "second",
          goal: "Change B",
          dependsOn: ["first"],
          deliverables: ["b.txt"],
          checks: [check("changed B")],
        },
      ],
    }),
  );
  const r = await invoke(
    f,
    ["project", "start", "--file", file, "--json"],
    "",
    repo.project,
  );
  assert.equal(r.code, 1, r.stderr || r.stdout);
  const state = JSON.parse(r.stdout);
  assert.deepEqual(
    state.steps.map((x) => x.status),
    ["completed", "completed"],
    JSON.stringify(state),
  );
  assert.equal(state.status, "blocked");
  assert.equal(state.finalChecks[0].check.status, "check_failed");
  assert.equal(state.finalChecks[0].check.version, state.version);
  assert.equal(state.delivery, undefined);
  const again = await invoke(
    f,
    ["project", "resume", "--json"],
    "",
    repo.project,
  );
  const reopened = JSON.parse(again.stdout);
  assert.equal(again.code, 1);
  assert.equal(reopened.finalChecks.length, 1);
  assert.equal(
    reopened.finalChecks[0].requestId,
    state.finalChecks[0].requestId,
  );
  assert.equal(f.calls.length, 5);
});

test("a simple contract uses one worker turn and returns its existing checked entry", async (t) => {
  const repo = repository(t),
    f = await fixture(t, () => ({ text: "The entry exists." }));
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution } });
  const file = join(f.home, "simple.json");
  writeFileSync(
    file,
    JSON.stringify({
      goal: "Verify A",
      scope: ["a.txt"],
      deliverables: ["a.txt"],
      checks: [
        { command: "node", args: ["-e", "require('fs').accessSync('a.txt')"] },
      ],
    }),
  );
  const r = await invoke(
    f,
    ["project", "start", "--file", file, "--json"],
    "",
    repo.project,
  );
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const state = JSON.parse(r.stdout);
  assert.equal(state.status, "completed");
  assert.equal(state.steps[0].id, "main");
  assert.deepEqual(state.delivery.requestIds, [
    state.steps[0].attempts[0].check.requestId,
  ]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(state.staff, []);
});

test("PROJECT chat drafts from a goal, starts only on confirmation, and opens the same CLI project", async t => {
  const {projectChat} = await import("../src/project-chat.js");
  const repo = repository(t);
  const proposal = {
    scope:["answer.txt"], deliverables:["answer.txt"], budget:{maxCalls:0},
    checks:[{command:"node",args:["-e","require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8').trim(),'ok')"]}]
  };
  const f = await fixture(t, () => ({text:JSON.stringify(proposal)}));
  const config = {formatVersion:2,...f.models,work:{execution}};
  saveConfig(f.home, config);
  const goal = "Create answer.txt containing ok with no execution calls";
  let draft = null;
  const input = text => projectChat({home:f.home,cwd:repo.project,config,text,draft,signal:new AbortController().signal,
    report:()=>{}, saveDraft:value=>{draft=value;}, onTask:()=>{}, chooseStep:()=>{ throw Error("unexpected step choice"); }});
  assert.match(await input("状态"), /尚未启动/);
  assert.equal(f.calls.length, 0);
  assert.match(await input(goal), /待确认/);
  assert.equal(draft.plan.goal,goal);
  assert.match(await input("状态"), /尚未启动/);
  assert.equal(f.calls.length, 1);
  const output = await input("开始");
  assert.match(output,/项目/);
  const result = await invoke(f, ["project","status","--json","--repo",repo.project]);
  assert.equal(result.code,0,result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.goal, goal);
  assert.equal(state.steps[0].id, "main");
  assert.equal(state.budget.maxCalls, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(draft,null);
  await assert.rejects(input("开始"),/先输入项目目标/);
  await input("暂停");
  assert.match(await input("写入新的内容"), /待确认/);
  assert.equal(draft.action, "revise");
  await input("开始");
  const revised = JSON.parse((await invoke(f, ["project", "status", "--json", "--repo", repo.project])).stdout);
  assert.equal(revised.status, "paused");
  assert.equal(revised.steps[0].goal, "写入新的内容");
  assert.deepEqual(revised.steps[0].checks, state.steps[0].checks);
  assert.equal(f.calls.length, 1, "editing an existing goal does not pay for another plan");
  await input("这个修改即将取消");
  assert.match(await input("取消计划"), /已取消/);
  assert.equal(draft, null);
  assert.equal(JSON.parse((await invoke(f, ["project", "status", "--json", "--repo", repo.project])).stdout).goal, revised.goal);

});

test("confirmed chat plan delivers through the real project engine and Docker checks", async t => {
  const {projectChat} = await import("../src/project-chat.js");
  const repo = repository(t);
  const proposal = {
    scope:["a.txt"], deliverables:["a.txt"], budget:{maxCalls:2},
    checks:[{command:"node",args:["-e","require('fs').accessSync('a.txt')"]}]
  };
  const f = await fixture(t, call => ({
    text:call.body.messages.some(message => JSON.stringify(message).includes("Draft a CoThink project plan"))
      ? JSON.stringify(proposal) : "The existing entry is ready.",
  }));
  const config = {formatVersion:2,...f.models,work:{execution}};
  saveConfig(f.home, config);
  let draft = null;
  const recorded = [];
  const send = text => projectChat({home:f.home,cwd:repo.project,config,text,draft,
    signal:new AbortController().signal, report:()=>{},saveDraft:value=>{draft=value;},
    onTask:id=>recorded.push(id),chooseStep:()=>{throw Error("unexpected step choice");}});
  await send("Verify the existing a.txt file");
  assert.equal(f.calls.length,1);
  assert.equal(draft.action,"start");
  const result = await send("开始");
  const state = JSON.parse((await invoke(f,["project","status","--json","--repo",repo.project])).stdout);
  assert.equal(state.status,"completed",result);
  assert.equal(state.delivery.revision,state.revision);
  assert.equal(state.steps[0].attempts[0].check.status,"passed");
  assert.equal(f.calls.length,2);
  assert.equal(recorded.length,2,"planning and executed task both appear in chat history");
});

test("a frozen independent review cannot disappear in a chat draft, start, or revision", async t => {
  const {projectChat} = await import("../src/project-chat.js");
  const repo = repository(t);
  const proposal = {
    scope:["a.txt"], deliverables:["a.txt"],
    checks:[{command:"node",args:["-e","require('fs').accessSync('a.txt')"]}],
    independentReview:true,
  };
  const f = await fixture(t, call => ({
    text:call.body.messages.some(message => JSON.stringify(message).includes("Draft a CoThink project plan"))
      ? JSON.stringify(proposal) : "Verified. Everything passes.",
  }));
  const config = {formatVersion:2,...f.models,work:{execution}};
  saveConfig(f.home, config);
  let draft;
  const chat = text => projectChat({home:f.home,cwd:repo.project,config,text,draft,
    signal:new AbortController().signal,report:()=>{},saveDraft:value=>{draft=value;},
    onTask:()=>{},chooseStep:()=>{throw Error("unexpected step choice");}});
  await chat("Verify a.txt. Require independent review.");
  assert.equal(draft.plan.independentReview, true);
  await chat("开始");
  const status = async () => JSON.parse((await invoke(f,["project","status","--json"],"",repo.project)).stdout);
  const frozen = await status();
  assert.equal(frozen.status,"blocked");
  assert.equal(frozen.steps[0].works[0].id,"main:a.txt");
  assert.equal(frozen.steps[0].works[0].independentReview,true);
  assert.match(frozen.steps[0].error,/独立评审未完成/);
  await chat("Also verify the file is readable");
  assert.deepEqual(draft.plan.steps[0].works,frozen.steps[0].works);
  await chat("开始");
  const revised = await status();
  assert.deepEqual(revised.steps[0].works,frozen.steps[0].works);
  assert.equal(f.calls.length,2,"manual revisions do not create new model calls");
});

test("ambiguous or wrongly attributed independent-review drafts need clarification; ordinary work stays ordinary", async () => {
  const {preserveReviewRequest} = await import("../src/project.js");
  const plan = {steps:[{deliverables:["notes.txt"]},{deliverables:["answer.txt"]}]};
  const request = "要求对 answer.txt 进行独立评审。";
  assert.throws(() => preserveReviewRequest(request,plan),/未指定受审步骤/);
  const single = {deliverables:["answer.txt"]};
  for (const goal of ["实现功能并进行独立评审。","Implement X, then obtain an independent review."])
    assert.equal(preserveReviewRequest(goal,single).independentReview,true);
  assert.equal(preserveReviewRequest("Explain how to obtain an independent review.",single),single);
  const wrong = structuredClone(plan);
  wrong.steps[0].independentReview = true;
  assert.equal(preserveReviewRequest("所有步骤必须独立评审。",wrong).independentReview,true);
  assert.throws(() => preserveReviewRequest(request,wrong),/没有绑定这个交付物/);
  assert.throws(() => preserveReviewRequest("notes.txt 不需要独立评审。",wrong),/冲突/);
  for (const text of ["不需要独立评审。","There is no need for an independent review.","Just verify the entry."])
    assert.equal(preserveReviewRequest(text,plan),plan);
});

test("a revision may replace an ordinary deliverable without reusing the retired work ID", async t => {
  const {project} = repository(t), f = await fixture(t);
  const file = join(f.home,"replace.json");
  const plan = {goal:"Check one file",scope:["."],budget:{maxCalls:0},
    deliverables:["a.txt"],checks:[{command:"node",args:["--version"]}]};
  const run = async (...args) => {
    writeFileSync(file,JSON.stringify(plan));
    return invoke(f,["project",...args,"--file",file,"--json"],"",project);
  };
  const original = await run("start");
  assert.equal(JSON.parse(original.stdout).steps[0].works[0].id,"main:a.txt");
  plan.deliverables = ["b.txt"];
  const updated = await run("revise","--goal",plan.goal,"--step","main");
  assert.equal(updated.code,0,updated.stderr);
  const state = JSON.parse(updated.stdout);
  assert.equal(state.steps[0].works[0].id,"main:b.txt");
  assert.equal(state.revisions[0].previousDefinitions[0].works[0].id,"main:a.txt");
  plan.works = [{id:"renamed-old-target",scope:["a.txt"]},state.steps[0].works[0]];
  const invalid = await run("revise","--goal",plan.goal,"--step","main");
  assert.equal(invalid.code,2);
  assert.match(invalid.stderr,/cannot rename/);
  assert.equal(f.calls.length,0);
});

test("case aliases across step or work boundaries cannot acquire independent grants", async () => {
  const {validateChatPlan} = await import("../src/project.js");
  const plan = {goal:"Prepare files",scope:["."],steps:["Source/A","source/B"].map((path,i) => ({
    id:"step"+i,goal:"Prepare file",deliverables:[path],checks:[{command:"node",args:["--version"]}],
  }))};
  assert.throws(() => validateChatPlan(plan),/project path alias/);
  plan.steps[1].deliverables = ["Source/A"];
  assert.doesNotThrow(() => validateChatPlan(plan), "the same exact target can be scheduled sequentially");
  plan.steps[1].works = [{id:"work",scope:["Source/A","SOURCE/new"]}];
  assert.throws(() => validateChatPlan(plan),/project path alias/);
});
