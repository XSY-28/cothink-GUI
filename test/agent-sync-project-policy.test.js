import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { execution, managed } from "./helpers/agent-sync-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { saveConfig } from "../src/config.js";
import { createProjectPolicy, recordRouteObservation } from "../src/project-policy.js";

import {project,tool,checks,review} from './project-policy.fixture.js';

function responses(c, n) {
  const turns = [
    tool("write", { path: "export.json", content: '{"version":1}' }),
    tool("accept_change"),
    tool("write", { path: "export.json", content: '{"version":2}' }),
    tool("accept_change"),
    { text: "The export is available." },
  ];
  return turns[n - 1] ?? { text: "Stop." };
}

test("project CLI blocks repeated modifications after the first failed normal entry, even when an internal fixture assertion passed", async (t) => {
  const internal = {
    command: "node",
    args: ["-e", "JSON.parse(require('fs').readFileSync('export.json','utf8'))"],
  };
  const { state, f } = await project(t, { spec: { checks: [internal, ...checks] }, handler: responses });
  const step = state.steps[0],
    route = step.route;
  assert.equal(route.status, "paused", JSON.stringify(step));
  assert.deepEqual(
    route.evidence.checks.map((c) => c.exitCode),
    [0, 1],
  );
  assert.equal(f.calls.length, 3, "only one read-only judgment followed the failed entry");
  assert.equal(step.attempts.length, 1);
  assert.equal(state.usage.calls, 3);
  assert.equal(state.usage.actualCost, null);
});

test("project CLI automatically runs a bound discriminator, admits one corresponding edit and verifies the resulting version", async (t) => {
  const { state, f, reply } = await project(t, { spec: { review }, handler: responses });
  const step = state.steps[0],
    route = step.route;
  assert.equal(reply.code, 0, JSON.stringify(step));
  assert.equal(route.status, "resolved");
  assert.equal(route.probe.present, true);
  assert.equal(route.probe.decision, "repair");
  assert.deepEqual(route.edit.paths, ["export.json"]);
  assert.equal(route.recheck.checks[0].exitCode, 0);
  assert.equal(f.calls.length, 5);
  assert.equal(readFileSync(join(step.attempts[0].resultWorkspace, "export.json"), "utf8"), '{"version":2}');
});

test("project CLI with a hard price cap emits zero requests; a catalog price or localhost address cannot stand in for a bill", async (t) => {
  const { state, f } = await project(t, { budget: { maxCost: 100 }, handler: responses });
  assert.equal(f.calls.length, 0);
  assert.equal(state.status, "blocked");
  assert.match(JSON.stringify(state), /hard cost cap/);
});

test("a route pause gates actual managed workspace side effects and keeps an unrelated step's revision usable", async (t) => {
  const m = await managed(t, { scope: ["a.txt"] });
  const id = m.task.record.id,
    step = { id: "s", scope: ["a.txt"], status: "running", revision: 2, attempts: [{ taskId: id }] };
  const state = { id: "p", status: "active", revision: 4, scope: ["."], steps: [step], budget: {} };
  const host = { read: () => structuredClone(state), update: (fn) => fn(state), assertOwned() {} };
  const binding = { projectId: "p", stepId: "s", revision: 2, taskId: id };
  m.task.projectPolicy = createProjectPolicy({ host, binding, home: m.home });
  await m.call("read", "read", { path: "a.txt" });
  await m.call("write", "allowed", { path: "a.txt", content: "first edit" });
  const frozen = m.binding.current.privateVersion;
  assert.equal(
    Buffer.from((await m.v.read({ version: frozen, path: "a.txt" })).contentBase64, "base64").toString(),
    "first edit",
  );
  recordRouteObservation(state, "s", { candidate: frozen, kind: "failed", evidence: { exitCode: 1 } });
  await assert.rejects(
    m.call("write", "blind", { path: "a.txt", content: "blind replacement" }),
    /Route is paused/,
  );
  await assert.rejects(m.call("bash", "blind-shell", { command: "echo blind > a.txt" }), /Route is paused/);
  assert.equal((await m.v.inspect({ changeId: m.binding.current.changeId })).privateVersion, frozen);
  state.status = "paused";
  await assert.rejects(m.call("write", "paused", { path: "a.txt", content: "ignored" }), /User paused/);
});

test("a passing explicit checkpoint still holds dependent work until one host-observed continue decision", async (t) => {
  const repo = repository(t);
  const f = await fixture(t, () => ({ text: "Read existing artifact." }));
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution, checks } });
  const step = (id, file) => ({
    id,
    goal: "Check " + file,
    deliverables: [file],
    checks: [
      {
        command: "node",
        args: ["-e", `if(!require('fs').readFileSync('${file}','utf8').startsWith('base'))process.exit(1)`],
      },
    ],
  });
  const input = join(f.home, "checkpoint-plan.json");
  writeFileSync(
    input,
    JSON.stringify({
      goal: "Verify the two existing outputs.",
      scope: ["."],
      budget: { maxCalls: 4 },
      steps: [
        { ...step("first", "a.txt"), checkpoint: true },
        { ...step("next", "b.txt"), dependsOn: ["first"] },
      ],
    }),
  );
  const projectCommand = async (...args) =>
    JSON.parse((await invoke(f, ["project", ...args, "--json"], "", repo.project)).stdout);
  const initial = await projectCommand("start", "--file", input);
  assert.equal(initial.status, "blocked");
  assert.equal(f.calls.length, 1);
  const route = initial.steps[0].route;
  assert.equal(route.status, "paused");
  assert.equal(initial.steps[1].attempts.length, 0);
  const binding = { stepId: "first", revision: 1, candidate: route.candidate };
  await projectCommand(
    "route",
    "judge",
    JSON.stringify({
      ...binding,
      path: "a.txt",
      contains: "base A",
      reason: "Expected exact legacy prefix allows dependent check.",
      ifPresent: "continue",
      ifAbsent: "blocked",
    }),
  );
  const result = await projectCommand("route", "experiment", JSON.stringify(binding));
  assert.equal(result.steps[0].route.status, "resolved");
  assert.equal(result.steps[0].route.probe.decision, "continue");
  const delivered = await projectCommand("resume");
  assert.equal(delivered.status, "completed");
  assert.equal(f.calls.length, 2);
});

test("without a configured review plan the live project leader can diagnose a failed precheck and repair the original private draft", async (t) => {
  const { state, f } = await project(t, {
    handler: (c, n) =>
      [
        tool("write", { path: "export.json", content: '{"version":1}' }),
        tool("prepare_change", { check: true }),
        tool("project_route_judge", review),
        tool("write", { path: "export.json", content: '{"version":2}' }),
        tool("accept_change"),
        { text: "Delivered the corrected export." },
      ][n - 1] ?? { text: "Stop." },
  });
  const step = state.steps[0];
  assert.equal(state.status, "completed", JSON.stringify(step));
  assert.ok(step.route.judgmentCall);
  assert.equal(step.route.probe.decision, "repair");
  assert.equal(step.route.status, "resolved");
  assert.equal(f.calls.length, 6);
});

test("shortening an unnecessary format conversion rechecks current, invalid and saved inputs through the same executable", async (t) => {
  const repo = repository(t);
  const entry = "export.cjs";
  const direct =
    "const arg=process.argv[2]; if(!['saved','current'].includes(arg))process.exit(2); console.log(arg);";
  const longer = direct.replace(
    "console.log(arg)",
    "const forceCurrent = true; console.log(forceCurrent ? 'current' : arg)",
  );
  const checks = [
    ["current", 0, "current"],
    ["invalid", 2, ""],
    ["saved", 0, "saved"],
  ].map(([input, code, output]) => ({
    command: "node",
    args: [
      "-e",
      `const r=require('child_process').spawnSync('node',['${entry}','${input}'],{encoding:'utf8'});if(r.status!==${code}||r.stdout.trim()!=='${output}')process.exit(1)`,
    ],
  }));
  const script = [
    tool("write", { path: entry, content: longer }),
    tool("accept_change"),
    tool("write", { path: entry, content: direct }),
    tool("accept_change"),
    { text: "Verified." },
  ];
  const f = await fixture(t, (_c, n) => script[n - 1] ?? { text: "Stop." });
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution, checks } });
  const input = join(f.home, "shorten.json");
  writeFileSync(
    input,
    JSON.stringify({
      goal: "Keep the incoming format for current and legacy records.",
      scope: [entry],
      budget: { maxCalls: 6 },
      steps: [
        {
          id: "compat",
          goal: "Preserve the original value, refuse invalid inputs.",
          deliverables: [entry],
          checks,
          review: {
            path: entry,
            contains: "forceCurrent",
            ifPresent: "shorten",
            ifAbsent: "blocked",
            repairScope: [entry],
            reason: "An unconditional conversion would explain why only the saved input changes.",
          },
        },
      ],
    }),
  );
  const run = await invoke(f, ["project", "start", "--file", input, "--json"], "", repo.project);
  const state = JSON.parse(run.stdout);
  assert.equal(state.status, "completed", JSON.stringify(state.steps[0]));
  const { route } = state.steps[0];
  assert.equal(route.probe.decision, "shorten");
  assert.deepEqual(
    route.evidence.checks.map((c) => c.exitCode),
    [0, 0, 1],
  );
  assert.deepEqual(
    route.recheck.checks.map((c) => c.exitCode),
    [0, 0, 0],
  );
  assert.deepEqual(
    route.evidence.checks.map((c) => c.args),
    route.recheck.checks.map((c) => c.args),
  );
  assert.equal(readFileSync(join(state.steps[0].attempts.at(-1).resultWorkspace, entry), "utf8"), direct);
});

test("a failed bounded repair keeps both check receipts and does not repeat the experiment on a renamed draft", async (t) => {
  const { state, f } = await project(t, {
    spec: { review },
    handler: (_c, n) =>
      [
        tool("write", { path: "export.json", content: '{"version":1}' }),
        tool("accept_change"),
        tool("write", { path: "export.json", content: '{"version":3}' }),
        tool("accept_change"),
        tool("next_change", { scope: ["export.json"], reason: "renamed repair" }),
      ][n - 1] ?? { text: "Stop." },
  });
  const { route } = state.steps[0];
  assert.equal(route.status, "blocked");
  assert.equal(f.calls.length, 4);
  assert.equal(route.evidence.checks.at(-1).exitCode, 1);
  assert.equal(route.recheck.evidence.checks.at(-1).exitCode, 1);
  assert.notEqual(route.candidate, route.recheck.candidate);
});

test("an unavailable fixed entry command stops the route without business-logic edits to compensate", async (t) => {
  const { state, f } = await project(t, {
    spec: { checks: [{ command: "sh", args: ["-c", "exec /missing-app-runtime"] }], review },
    handler: responses,
  });
  const { route } = state.steps[0];
  assert.equal(route.status, "blocked");
  assert.equal(route.kind, "environment");
  assert.equal(route.evidence.checks.at(-1).exitCode, 127);
  assert.equal(route.probe, undefined);
  assert.equal(f.calls.length, 2);
});

test("expanding a writable grant stops first, then imports only the exact diagnosed extra file on an unchanged draft", async (t) => {
  const repo = repository(t);
  const checks = [
    {
      command: "node",
      args: [
        "-e",
        "if(!require('./export.json').needsMetadata || require('./meta.json').format !== 1)process.exit(1)",
      ],
    },
  ];
  const expand = tool("refresh_change", {
    scope: ["export.json", "meta.json"],
    reason: "The export requests a metadata file.",
  });
  const sequence = [
    tool("write", { path: "export.json", content: '{"needsMetadata":true}' }),
    expand,
    expand,
    tool("write", { path: "meta.json", content: '{"format":1}' }),
    tool("accept_change"),
    { text: "Delivered." },
  ];
  const f = await fixture(t, (_c, n) => sequence[n - 1] ?? { text: "Stop." });
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { checks, execution } });
  const input = join(f.home, "scope-plan.json");
  writeFileSync(
    input,
    JSON.stringify({
      goal: "Provide metadata requested by this export.",
      scope: ["export.json", "meta.json"],
      budget: { maxCalls: 7 },
      steps: [
        {
          id: "metadata",
          goal: "Export and include metadata when requested.",
          deliverables: ["export.json", "meta.json"],
          checks,
          review: {
            path: "export.json",
            contains: '"needsMetadata":true',
            ifPresent: "repair",
            ifAbsent: "blocked",
            repairScope: ["meta.json"],
            reason: "Only the declared metadata flag warrants adding the metadata file.",
          },
        },
      ],
    }),
  );
  const cmd = await invoke(f, ["project", "start", "--file", input, "--json"], "", repo.project),
    state = JSON.parse(cmd.stdout);
  const step = state.steps[0];
  assert.equal(state.status, "completed", JSON.stringify(step));
  assert.equal(step.route.kind, "scope_expansion");
  assert.ok(step.attempts[0].kernelRequests.some(receipt => receipt.status === "not_sent"));
  assert.ok(step.route.expansion.confirmedVersion);
  assert.deepEqual(step.route.edit.paths, ["meta.json"]);
  assert.equal(step.route.status, "resolved");
});

test("the same root prompt has one send identity and a completed text result; only its recorded tool continuation has another", () => {
  const taskId = "14a38bc5-56b1-42db-abba-b8dace10be32";
  const step = {id:"s", scope:["."], revision:1, attempts:[{taskId}]};
  const state = {id:"p", status:"active", steps:[step]};
  const host = {read:()=>structuredClone(state), update:fn=>fn(state), assertOwned(){}};
  const policy = createProjectPolicy({host, binding:{projectId:"p",stepId:"s",revision:1,taskId}});
  const model = {provider:"mock",id:"A"};
  const stage = {id:"stage",role:"main",phase:"work",sessionId:"session",modelRef:{provider:"mock",modelId:"A"}};
  const repeated = {...stage,id:"host-reentered-stage"};
  const calls = [];
  const task = {record:{id:taskId,stages:[stage,repeated]},requests:()=>calls};
  const locate = (phase, messages = []) => policy.locateSend({task,stage:phase,context:{messages},model});
  const first = locate(stage);
  const retry = locate(repeated);
  assert.equal(first.requestId, retry.requestId);
  assert.throws(() => policy.admit("send", {...retry,requestId:"relabelled"}), /host-issued/);
  policy.admit("prepareSend", first);
  policy.admit("prepareSend", retry);
  assert.equal(state.callIntents, undefined);
  policy.admit("send", first);
  assert.throws(() => policy.admit("send", retry), /original project send/);
  const saved = {id:first.requestId,displayId:"first-message",role:"main",status:"completed",sent:true,
    projectSend:{sessionId:stage.sessionId},text:"recorded",response:{stopReason:"stop",content:[]}};
  calls.push(saved);
  assert.equal(policy.originalResult(retry, task), saved);
  saved.response = {stopReason:"toolUse", content:[{type:"toolCall", id:"observed"}]};
  assert.throws(() => policy.originalResult(retry, task), /no replay/);

  const originalContext = [
    {role:"assistant", cothinkMessageId:saved.displayId, content:saved.response.content},
    {role:"toolResult",toolCallId:"observed"},
  ];
  const continuation = locate(stage, originalContext);
  calls.push({...saved, id:"later-request", displayId:"later-message"});
  assert.equal(locate(stage, originalContext).requestId, continuation.requestId,
    "a provider reusing a tool ID in a later message cannot change the original continuation");
  assert.equal(continuation.cause, "tools:" + first.requestId);
  assert.notEqual(continuation.requestId, first.requestId);
  assert.throws(() => locate(stage,[{role:"toolResult",toolCallId:"unknown"}]), /no recorded parent/);
  repeated.sessionId = "different-pi-session";
  assert.throws(() => locate(repeated), /session bound/);
});

test("a transferred session cannot read live project material through its former role", async () => {
  const { createProjectStaff } = await import("../src/project-staff.js");
  const taskId = "ceec1448-1540-4b93-bca6-b85c9eb3b1c2";
  const role = "member:old";
  const state = {id:"p",status:"active",steps:[{id:"s",scope:["."],revision:1,attempts:[{taskId}]}],
    staff:[{id:"engineer",supervisorId:"root",status:"active",models:[],scope:["."],readScope:["."]}],
    staffAssignments:{old:{dispatchId:"old",staffId:"engineer",actor:"root",role,taskId,model:"mock/A",
      status:"active",readScope:["."],scope:["."],grantEpoch:0}}};
  const host = {read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}};
  const policy = createProjectPolicy({host,staff:createProjectStaff(host),binding:{projectId:"p",stepId:"s",revision:1,taskId}});
  policy.admit("read",{actor:role});
  state.staff[0].transitions = [{action:"transfer"}];
  assert.throws(() => policy.admit("read",{actor:role}), /handed off/);
});

test('native helpers keep distinct host-bound sessions, share one call budget, and cannot forge a formal creator',()=>{
  const taskId='native-task',modelRef={provider:'fixture',modelId:'main'},model={provider:'fixture',id:'main',api:'openai-completions'};
  const state={id:'p',status:'active',budget:{maxCalls:1,maxCost:null},steps:[{id:'s',scope:['a.txt'],revision:1,status:'running',works:[{id:'a',scope:['a.txt']}],attempts:[{taskId}]}],rootWorkClaims:[{taskId,role:'main',changeId:'change',workId:'a',scope:['a.txt']}],callIntents:[]};
  const host={read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}};
  const policy=createProjectPolicy({host,binding:{projectId:'p',stepId:'s',revision:1,taskId,scope:['a.txt'],plugins:['native']}});
  const controller=new AbortController(),calls=[];
  const task={record:{id:taskId,status:'running',models:{main:modelRef,secondary:[]},stages:[],members:[]},signal:controller.signal,requests:()=>calls};
  const source={selection:'native',actor:'main',sessionId:'parent',changeId:'change',inputVersion:'v1',sourceDigest:'source',registrationVersion:'schema',scope:['a.txt'],readScope:['a.txt'],readOnly:false};
  const pluginCapability=policy.issuePluginCapability(source);
  const spec={task,...source,pluginCapability,creatorRole:'main',creatorSessionId:'parent',modelRef};
  assert.throws(()=>policy.issueNativeHelper({...spec,launchId:'forged',creatorRole:'member:other'}),{code:'PROJECT_NATIVE_UNBOUND'});
  const grants=['one','two'].map(launchId=>{const cap=policy.issueNativeHelper({...spec,launchId});const stage={id:launchId,role:'helper:'+launchId,phase:'project-native-helper',modelRef};task.record.stages.push(stage);policy.bindNativeHelperSession(cap,{task,stage,sessionId:'child-'+launchId});return {cap,stage};});
  assert.notEqual(grants[0].stage.sessionId,grants[1].stage.sessionId);
  const sends=grants.map(({stage})=>policy.locateSend({task,stage,context:{messages:[{role:'user',content:'task'}]},model}));
  for(const send of sends)policy.admit('prepareSend',send);
  policy.admit('send',sends[0]);calls.push({id:sends[0].requestId,role:'helper:one',sent:true,status:'in_flight'});
  assert.throws(()=>policy.admit('send',sends[1]),{code:'PROJECT_BUDGET'});
  assert.equal(state.callIntents.length,1);assert.equal(state.callIntents[0].role,'helper:one');assert.equal(state.callIntents[0].creatorRole,'main');
  const clonedStage={...grants[0].stage};task.record.stages.push(clonedStage);assert.throws(()=>policy.locateSend({task,stage:clonedStage,context:{messages:[]},model}),{code:'PROJECT_NATIVE_UNBOUND'});
  state.status='paused';assert.throws(()=>policy.admitNativeHelper(grants[0].cap,{operation:'read'}),{code:'PROJECT_PAUSED'});
  assert.equal(policy.admitNativeCleanup(grants[0].cap,{operation:'terminal'}).projectActive,false);
  assert.throws(()=>policy.admitNativeCleanup(grants[0].cap,{operation:'model'}),{code:'PROJECT_NATIVE_UNBOUND'});
  assert.throws(()=>policy.admitNativeCleanup({}, {operation:'finished'}),{code:'PROJECT_NATIVE_UNBOUND'});
  state.status='active';policy.closeNativeHelper(grants[0].cap);assert.throws(()=>policy.admitNativeHelper(grants[0].cap,{operation:'model'}),{code:'PROJECT_NATIVE_STALE'});
  assert.equal(policy.admitNativeCleanup(grants[0].cap,{operation:'finished'}).creatorRole,'main');
});

test('a native helper cannot widen or retain a model route outside its actual employee roster',async()=>{
  const {createProjectStaff}=await import('../src/project-staff.js');
  const taskId='native-roster',role='member:employee',main={provider:'fixture',modelId:'main'},worker={provider:'fixture',modelId:'worker'};
  const state={id:'p',status:'active',scope:['a.txt'],steps:[{id:'s',revision:1,status:'running',scope:['a.txt'],works:[{id:'a',scope:['a.txt']}],attempts:[{taskId}]}],
    staff:[{id:'employee',supervisorId:'root',status:'active',scope:['a.txt'],readScope:['a.txt'],models:['fixture/worker']}],
    staffAssignments:{employee:{dispatchId:'employee',staffId:'employee',actor:'root',role,taskId,workId:'a',model:'fixture/worker',identity:'worker',status:'active',scope:['a.txt'],readScope:['a.txt'],grantEpoch:0}}};
  const host={read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}};
  const policy=createProjectPolicy({host,staff:createProjectStaff(host),binding:{projectId:'p',stepId:'s',revision:1,taskId,scope:['a.txt'],plugins:['native']}});
  const task={record:{id:taskId,status:'running',models:{main,secondary:[worker]},stages:[]},signal:new AbortController().signal};
  const source={selection:'native',actor:role,sessionId:'employee-session',changeId:'change',inputVersion:'v1',sourceDigest:'source',registrationVersion:'schema',scope:['a.txt'],readScope:['a.txt'],readOnly:false};
  const pluginCapability=policy.issuePluginCapability(source),spec={task,...source,pluginCapability,creatorRole:role,creatorSessionId:source.sessionId,modelRef:main};
  assert.throws(()=>policy.issueNativeHelper({...spec,launchId:'not-allowed'}),{code:'PROJECT_STAFF'});
  state.staff[0].models.push('fixture/main');const cap=policy.issueNativeHelper({...spec,launchId:'allowed'});
  policy.admitNativeHelper(cap,{operation:'start'});state.staff[0].models=['fixture/worker'];
  assert.throws(()=>policy.admitNativeHelper(cap,{operation:'read'}),{code:'PROJECT_STAFF'});
});

test('stopping one MCP job cannot stop other current jobs in its shared container without project pause',()=>{
  const taskId='task',proof='a'.repeat(64),common={kind:'external',taskId,role:'main',sessionId:'session',sourceDigest:'source',server:'local',containerProofDigest:proof,status:'outcome_unknown'};
  const state={id:'p',status:'active',steps:[{id:'s',revision:1,attempts:[{taskId,revision:1}]}],callIntents:[{...common,id:'one'},{...common,id:'two'}]};
  const policy=createProjectPolicy({host:{read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}},binding:{projectId:'p',stepId:'s',taskId,revision:1}});
  const spec={server:'local',actor:'main',sessionId:'session',sourceDigest:'source',changeId:'change',inputVersion:'v1',registrationVersion:'schema',readOnly:false,scope:['a.txt'],readScope:['a.txt'],localNoNetwork:true,cleanupOnly:true,containerProofDigest:proof};
  const capability=policy.issueMcpRecoveryCapability(spec,'one'),detail={...spec,capability,localProcessCleanup:true,original:state.callIntents[0]};
  policy.admitMcp({...detail,kind:'query'});
  assert.throws(()=>policy.admitMcp({...detail,kind:'cancel'}),{code:'PROJECT_MCP_SHARED_RUNTIME'});
  state.status='paused';policy.admitMcp({...detail,kind:'cancel'});
  state.status='active';state.steps[0].revision=2;policy.admitMcp({...detail,kind:'cancel'});
  assert.throws(()=>policy.admitMcp({...detail,kind:'cancel',tool:'start'}),{code:'PROJECT_MCP_RECOVERY'});
  assert.equal(state.callIntents.length,2,'Process cleanup must not create model or service requests');
});

test("a redirect cannot forward a managed generation as an unrecorded second POST", async (t) => {
  const {state, f} = await project(t, {budget:{maxCalls:1}, handler:(_call, _n, _req, res) => {
    res.writeHead(307, {Location:"/v1/forwarded"});
    res.end();
    return null;
  }});
  assert.equal(f.calls.length, 1);
  assert.notEqual(f.calls[0].url, "/v1/forwarded");
  assert.equal(state.callIntents.length, 1);
  assert.equal(state.status, "blocked");
});
