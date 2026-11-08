// These dispatch contracts execute real Linux Docker commands and checks.
// Keep them in the Linux source glob and the explicit installed-Linux suite.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { resolve, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execution } from "./helpers/agent-sync-fixture.js";
const productRoot = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const load = path => import(pathToFileURL(join(productRoot, path)));
const { runTurn } = await load("src/discussion.js");
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
function outputs(body) {
  return body.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => {
      try {
        return [JSON.parse(m.content)];
      } catch {
        return [];
      }
    });
}
function isPreparation(body) {
  const user = body.messages.findLast(m => m.role === 'user');
  return JSON.stringify(user?.content).includes('Independent task preparation');
}
function memberExecutionInfo(body) {
  const content = body.messages.findLast((m) => m.role === "user").content;
  const text = typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const material = JSON.parse(text);
  return { ...material.execution, reason: material.reason?.text };

}

async function projectDispatch(t, repo, f, {secondary=f.models.secondary, staffRows, scope=["a.txt"], workExecution, ...options} = {}) {
  const {createProjectStaff} = await load("src/project-staff.js");
  const {createProjectPolicy} = await load("src/project-policy.js");
  const taskId = randomUUID(), projectId = randomUUID();
  const binding = {projectId, stepId:"reader", revision:1, taskId, startVersion:repo.baseVersion};
  const state = {id:projectId, scope, status:"active",
    steps:[{id:"reader", revision:1, status:"running", scope, checks:[], attempts:[{taskId}]}],
    staff:staffRows ?? [
    {id:"compat", supervisorId:"root", canDelegate:true, subgoal:"Read old records", responsibility:"Coordinate compatibility", models:["fixture/r1","fixture/r2"], scope:["a.txt"], readScope:["."], status:"active"},
    {id:"reader", supervisorId:"compat", canDelegate:false, responsibility:"Repair reader", models:["fixture/r2"], scope:["a.txt"], readScope:["."], status:"active"},
  ]};
  const host = {read:()=>state, update:fn=>fn(state), assertOwned(){}};
  const staff = createProjectStaff(host);
  const projectPolicy = createProjectPolicy({host, binding, staff, home:f.home});
  const task = await runTurn({home:f.home,cwd:repo.project,input:"Repair the compatibility reader",
    id:taskId, submissionId:randomUUID(), project:{...binding,goal:"Open old records",subgoal:"Repair reader"},
    projectPolicy,config:{formatVersion:2,...f.models,secondary,work:{checks:[],execution:workExecution}},...options});
  return {task,state};
}
test("project employee cannot enumerate ungranted files or read another actor's command output", async t => {
  const repo = repository(t);
  let root = 0, reader = 0, outputRef, files, log;
  const f = await fixture(t, ({body}) => {
    if (isPreparation(body)) return {text:"Inspect only my authorized input."};
    const lastTool = () => body.messages.filter(m => m.role === "tool").at(-1)?.content;
    if (body.model === "r1") {
      if (++reader === 1) return tool("find", {path:".", pattern:"*.txt"});
      if (reader === 2) {
        files = lastTool();
        return tool("read", {path:"output:" + outputRef});
      }
      log = lastTool();
      return {text:"Only the reader input is accessible."};
    }
    if (++root === 1) return tool("next_change", {scope:["b.txt"], reason:"Run a bounded check for the leader"});
    if (root === 2) return tool("bash", {command:"printf root-only-private-result"});
    if (root === 3) {
      outputRef = lastTool()?.match(/output:([a-f0-9-]{36})/)?.[1];
      return tool("abandon_change",{reason:"Command completed without changing the source."});
    }
    if (root === 4) return tool("delegate", {staffId:"reader", model:"fixture/r1", readOnly:true, readScope:["a.txt"],
      assignment:"Inspect reader inputs", reason:"Owns this file."});
    if (root === 5) return tool("collect");
    return {text:"Inspection concluded."};
  });
  const {task} = await projectDispatch(t,repo,f,{workExecution:execution, scope:["a.txt","b.txt"], staffRows:[
    {id:"reader",supervisorId:"root",responsibility:"Inspect reader",status:"active",
      models:["fixture/r1"],scope:[],readScope:["a.txt"]}]});
  assert.equal(task.record.status,"completed",JSON.stringify(task.record.error));
  assert.ok(outputRef,"test must use a real root Docker command's output reference");
  assert.match(files,/a\.txt/);
  assert.doesNotMatch(files,/b\.txt/);
  assert.doesNotMatch(log,/root-only-private-result/);
  assert.match(log,/日志不属于/);
});

for (const sameModel of [false, true]) test(
  `project CLI returns a failed employee candidate to its original supervisor for one diagnosed repair (${sameModel ? "all A" : "different models"})`, async t => {
  const {invoke} = await import("./helpers/cli-fixture.js");
  const {saveConfig} = await load("src/config.js");
  const {readTask} = await load("src/task.js");
  const repo = repository(t), path = "output.json";
  const managerModel = sameModel ? "fixture/main" : "fixture/r1";
  const writerModel = sameModel ? "fixture/main" : "fixture/r2";
  const models = [...new Set([managerModel, writerModel])];
  let root=0, manager=0, employee=0, managerId, childId, coordinationTools, routeAtFailure, supervisorDiagnosis, employeeDiagnosis;
  const traces = [];
  const f=await fixture(t,({body})=>{
    const last=outputs(body).at(-1);
    if (last?.error) traces.push([body.model,last.error]);
    if(isPreparation(body)) return {text:"Verify the original output contract."};
    const isRoot = body.tools.some(t => t.function.name === "accept_change");
    if (!isRoot && memberExecutionInfo(body).directReports) {
      switch(++manager) {
        case 1: return tool("delegate",{staffId:"writer",model:writerModel,assignment:"Produce export version two",reason:"Writer owns export",scope:[path]});
        case 2: childId=last?.memberId; return tool("collect",{memberId:childId});
        case 3: return {text:"Initial candidate "+childId+" reviewed for root."};
        case 4:
          coordinationTools=body.tools.map(t=>t.function.name);
          supervisorDiagnosis=memberExecutionInfo(body).diagnosis;
          return tool("feedback",{memberId:childId,feedback:"The normal reader rejected version one. The frozen candidate contains version one; use version two."});
        case 5: return tool("collect",{memberId:childId});
        default: return {text:"Repaired candidate reviewed for final acceptance."};
      }
    }
    if (!isRoot) {
      switch(++employee) {
        case 1: return tool("write",{path,content:'{"version":1}'});
        case 3: employeeDiagnosis=memberExecutionInfo(body).diagnosis; return tool("read",{path});
        case 4: return tool("edit",{path,edits:[{oldText:'"version":1',newText:'"version":2'}]});
        default: return {text:"Export candidate ready."};
      }
    }
    switch(++root) {
      case 1: return tool("project_staff",{action:"appoint",input:{id:"compat",responsibility:"Compatibility",scope:[path],models,need:"deliverable",reason:"Own the independently tested reader."}});
      case 2: return tool("project_staff",{action:"promote",input:{id:"compat",subgoal:"Reader opens version two",models}});
      case 3: return tool("project_staff",{action:"appoint",input:{id:"writer",supervisorId:"compat",responsibility:"Produce export",scope:[path],models:[writerModel],need:"deliverable",reason:"A separate writer is required."}});
      case 4: return tool("delegate",{staffId:"compat",model:managerModel,assignment:"Coordinate export delivery",reason:"Owns reader compatibility",readOnly:true});
      case 5: managerId=last?.memberId;return managerId ? tool("collect",{memberId:managerId}) : {text:"Manager dispatch rejected."};
      case 6: case 7: case 10: case 11: return tool("accept_change",{memberId:childId});
      case 8: routeAtFailure=last?.route; return tool("feedback",{memberId:managerId,coordinateMemberId:childId,feedback:"Resume only to return the failed normal entry and probe to its original writer."});
      case 9: return tool("collect",{memberId:managerId});
      default:return {text:"The corrected candidate passed the original normal reader."};
    }
  });
  saveConfig(f.home,{formatVersion:2,...f.models,work:{execution}});
  const checks=[{command:"node",args:["-e",`if(require('./${path}').version!==2)process.exit(1)`]}];
  const step={id:"reader", goal:"Reader must reopen output version two", deliverables:[path], checks,
    review:{reason:"A stale format field would explain the failure.",path,contains:'"version":1',ifPresent:"repair",ifAbsent:"blocked",repairScope:[path]}};
  const file=join(repo.root,"plan.json");
  writeFileSync(file,JSON.stringify({goal:"Produce a readable version two export",scope:[path],budget:{maxCalls:32},steps:[step]}));
  const run=await invoke(f,["project","start","--file",file,"--json"],"",repo.project);
  const project=JSON.parse(run.stdout), done=project.steps[0];
  assert.equal(project.status,"completed",JSON.stringify({root,manager,employee,requests:f.calls.map(c=>c.body.model),traces,blocker:project.blocker,route:done.route,attempt:done.attempts[0]?.error}));
  assert.equal(done.attempts.length,1);
  assert.equal(routeAtFailure?.probe?.decision,"repair");
  assert.equal(supervisorDiagnosis?.candidate,done.route.candidate);
  assert.deepEqual(employeeDiagnosis, supervisorDiagnosis);
  assert.equal(supervisorDiagnosis.observation.contentHash,done.route.probe.contentHash);
  assert.equal(supervisorDiagnosis.checks[0].exitCode,1);
  assert.equal(done.route.coordination.role,"member:"+managerId);
  assert.equal(done.route.feedback.dispatchId,childId);
  assert.equal(done.route.status,"resolved");
  assert.ok(!coordinationTools.includes("delegate") && !coordinationTools.includes("write") && coordinationTools.includes("feedback"));
  assert.deepEqual(done.route.recheck.checks.map(c=>c.exitCode),[0]);
  assert.equal(readFileSync(join(done.attempts[0].resultWorkspace,path),"utf8"),'{"version":2}');
  const task=readTask(f.home,done.attempts[0].taskId);
  const supervisor = task.members.find(m=>m.memberId===managerId);
  const writer = task.members.find(m=>m.memberId===childId);
  assert.equal(writer.supervisorMemberId, managerId);
  assert.ok(supervisor.sessionFile && writer.sessionFile && supervisor.sessionFile !== writer.sessionFile);
  assert.equal(writer.status, "accepted");
  assert.equal(writer.feedback.length, 1);
  if (sameModel) assert.ok(f.calls.every(({body}) => body.model === "main"));
  assert.equal(supervisor.previousChanges.length,1);
  assert.equal(task.work.changes.filter(c=>c.actor==="member:"+childId).length,1);
  assert.ok(task.work.capacity.every(c=>c.active>=0 && c.active<=2));
  assert.equal(task.work.capacity.at(-1).active,0);
});
