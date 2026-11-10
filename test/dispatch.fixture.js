import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export const { runTurn } = await import(process.env.COTHINK_TEST_PACKAGE_ROOT
  ? pathToFileURL(resolve(process.env.COTHINK_TEST_PACKAGE_ROOT, "src/discussion.js")).href
  : new URL("../src/discussion.js", import.meta.url).href);
export const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
export function outputs(body) {
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
export function isPreparation(body) {
  const user = body.messages.findLast(m => m.role === 'user');
  return JSON.stringify(user?.content).includes('Independent task preparation');
}
export function memberExecutionInfo(body) {
  const content = body.messages.findLast((m) => m.role === "user").content;
  const text = typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const material = JSON.parse(text);
  return { ...material.execution, reason: material.reason?.text };

}
export function latest(body, predicate) {
  return outputs(body).findLast(predicate);
}

export async function projectDispatch(t, repo, f, {secondary=f.models.secondary, staffRows, scope=["a.txt"], workExecution, ...options} = {}) {
  const {createProjectStaff} = await import("../src/project-staff.js");
  const {createProjectPolicy} = await import("../src/project-policy.js");
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
